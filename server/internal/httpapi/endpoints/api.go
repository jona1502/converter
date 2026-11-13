// Package endpoints wires the domain services to the stable HTTP contract.
package endpoints

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"mime"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	"miconverter/server/internal/apitypes"
	"miconverter/server/internal/auth"
	"miconverter/server/internal/config"
	"miconverter/server/internal/converter"
	"miconverter/server/internal/httpapi"
	"miconverter/server/internal/jobs"
	"miconverter/server/internal/ratelimit"
	"miconverter/server/internal/storage"
	"miconverter/server/internal/store"
)

type API struct {
	cfg   *config.Config
	pool  *pgxpool.Pool
	files *storage.Local
	jobs  *jobs.Service
	auth  *auth.Auth
	rate  *ratelimit.Limiter
}
type sessions struct {
	pool *pgxpool.Pool
	ttl  time.Duration
}

func (s sessions) FindSession(ctx context.Context, h auth.TokenHash) (auth.StoredSession, bool, error) {
	value, err := store.FindSession(ctx, s.pool, [32]byte(h), s.ttl)
	if errors.Is(err, store.ErrSessionNotFound) {
		return auth.StoredSession{}, false, nil
	}
	return auth.StoredSession{ID: storage.FormatUUID(value.ID), ExpiresAt: value.ExpiresAt}, err == nil, err
}
func (s sessions) CreateSession(ctx context.Context, h auth.TokenHash) (auth.StoredSession, error) {
	value, err := store.CreateSession(ctx, s.pool, [32]byte(h), s.ttl)
	return auth.StoredSession{ID: storage.FormatUUID(value.ID), ExpiresAt: value.ExpiresAt}, err
}

func New(cfg *config.Config, pool *pgxpool.Pool, files *storage.Local, limiter *ratelimit.Limiter) (*API, error) {
	service, err := jobs.New(pool, files, jobs.Limits{ImageMaxInputBytes: cfg.ImageMaxInputBytes, PDFMaxInputBytes: cfg.PdfMaxInputBytes, AudioMaxInputBytes: cfg.AudioMaxInputBytes, StorageBudgetBytes: cfg.StorageBudgetBytes, SessionMaxActiveJobs: cfg.SessionMaxActiveJobs, GlobalMaxActiveJobs: cfg.GlobalMaxActiveJobs, UploadMax: cfg.UploadMax, JobTTL: cfg.JobTTL, JobMaxAttempts: cfg.JobMaxAttempts})
	if err != nil {
		return nil, err
	}
	return &API{cfg: cfg, pool: pool, files: files, jobs: service, auth: auth.New(cfg, sessions{pool, cfg.SessionTTL}), rate: limiter}, nil
}

func (a *API) Register(router *httpapi.Router) {
	for _, route := range []struct {
		method, path string
		handler      func(http.ResponseWriter, *http.Request) error
	}{
		{"GET", "/session", a.session}, {"GET", "/capabilities", a.capabilities}, {"POST", "/jobs", a.create},
		{"GET", "/jobs/{job_id}", a.get}, {"POST", "/jobs/{job_id}/cancel", a.cancel}, {"DELETE", "/jobs/{job_id}", a.remove},
		{"GET", "/jobs/{job_id}/results/{result_id}", a.download},
	} {
		handler := route.handler
		router.HandleFunc(route.method, httpapi.Prefix+route.path, func(w http.ResponseWriter, r *http.Request) error {
			timeout := 10 * time.Second
			if route.method == http.MethodPost && route.path == "/jobs" {
				timeout = a.cfg.UploadMax + 15*time.Second
			} else if strings.Contains(route.path, "/results/") {
				timeout = a.cfg.DownloadMax + 5*time.Second
			}
			ctx, cancel := context.WithTimeout(r.Context(), timeout)
			defer cancel()
			r = r.WithContext(ctx)
			if route.path != "/capabilities" && a.pool == nil {
				return httpapi.ServiceUnavailable()
			}
			if route.path != "/jobs" && route.path != "/jobs/{job_id}/results/{result_id}" {
				ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
				defer cancel()
				r = r.WithContext(ctx)
			}
			err := handler(w, r)
			if err != nil {
				return mapError(err)
			}
			return nil
		})
	}
}

func mapError(err error) error {
	var api *httpapi.Error
	if errors.As(err, &api) {
		return api
	}
	var domain *jobs.Error
	if errors.As(err, &domain) {
		value := httpapi.NewError(domain.Status, apitypes.ApiErrorCode(domain.Code), domain.Message)
		if domain.RetryAfter > 0 {
			value = value.WithRetryAfter(domain.RetryAfter)
		}
		return value
	}
	switch {
	case errors.Is(err, store.ErrJobNotFound):
		return httpapi.NewError(404, apitypes.CodeJobNotFound, "Auftrag nicht gefunden.")
	case errors.Is(err, store.ErrResultNotFound):
		return httpapi.NewError(404, apitypes.CodeResultNotFound, "Ergebnis nicht gefunden.")
	case errors.Is(err, store.ErrJobExpired):
		return httpapi.NewError(410, apitypes.CodeJobExpired, "Auftrag abgelaufen.")
	case errors.Is(err, ratelimit.ErrLimited):
		return httpapi.NewError(429, apitypes.CodeRateLimited, "Zu viele Anfragen.").WithRetryAfter(60)
	case errors.Is(err, ratelimit.ErrBusy):
		return httpapi.NewError(429, apitypes.CodeRateLimited, "Anfrage läuft bereits.").WithRetryAfter(1)
	case errors.Is(err, ratelimit.ErrUnavailable):
		return httpapi.NewError(503, apitypes.CodeServerBusy, "Annahme derzeit nicht verfügbar.").WithRetryAfter(5)
	}
	slog.Error("API-Dienstfehler", "errorType", fmt.Sprintf("%T", err))
	var connect *pgconn.ConnectError
	var network net.Error
	if errors.As(err, &connect) || errors.As(err, &network) || errors.Is(err, context.DeadlineExceeded) {
		return httpapi.ServiceUnavailable()
	}
	return httpapi.Internal()
}

func (a *API) check(ctx context.Context, limits ...ratelimit.Limit) error {
	if a.rate == nil && a.cfg.Environment == config.Test {
		return nil
	}
	return a.rate.Check(ctx, limits...)
}
func (a *API) session(w http.ResponseWriter, r *http.Request) error {
	session, err := a.auth.OptionalSession(r.Context(), r)
	if err != nil {
		return err
	}
	if session == nil {
		if err = a.check(r.Context(), ratelimit.Limit{Kind: "new-session", Identity: a.auth.ClientIP(r), PerMinute: a.cfg.SessionNewPerMinute}); err != nil {
			return err
		}
		session, err = a.auth.NewSession(r.Context())
		if err != nil {
			return err
		}
	}
	a.auth.SetCookie(w, session)
	httpapi.WriteJSON(w, 200, apitypes.SessionResponse{CsrfToken: a.auth.CSRFToken(session), ExpiresAt: apitypes.NewTimestamp(session.ExpiresAt), Created: session.Created})
	return nil
}
func parseID(s string) ([16]byte, error) {
	var id [16]byte
	if len(s) != 36 || s[8] != '-' || s[13] != '-' || s[18] != '-' || s[23] != '-' {
		return id, store.ErrJobNotFound
	}
	raw, err := hex.DecodeString(strings.ReplaceAll(s, "-", ""))
	if err != nil || len(raw) != 16 {
		return id, store.ErrJobNotFound
	}
	copy(id[:], raw)
	return id, nil
}
func jobView(value store.LoadedJob) apitypes.JobView {
	v := value.View(time.Now().UTC())
	out := apitypes.JobView{ID: storage.FormatUUID(v.ID), Tool: apitypes.Tool(v.Tool), State: apitypes.JobState(v.State), CreatedAt: apitypes.NewTimestamp(v.CreatedAt), UpdatedAt: apitypes.NewTimestamp(v.UpdatedAt), ExpiresAt: apitypes.NewTimestamp(v.ExpiresAt), Progress: apitypes.JSONObject(v.Progress), Analysis: apitypes.JSONObject(v.Analysis), CancelRequested: v.CancelRequested}
	out.Input = apitypes.JobInput{Name: v.InputName, Size: v.InputSize, Format: apitypes.InputFormat(v.InputFormat)}
	if v.InputWidth != nil {
		x := int(*v.InputWidth)
		out.Input.Width = &x
	}
	if v.InputHeight != nil {
		x := int(*v.InputHeight)
		out.Input.Height = &x
	}
	if v.Phase != nil {
		x := apitypes.JobPhase(*v.Phase)
		out.Phase = &x
	}
	if v.ErrorCode != nil {
		out.Error = &apitypes.JobError{Code: apitypes.JobErrorCode(*v.ErrorCode)}
	}
	for _, result := range v.Results {
		row := apitypes.JobResultView{ID: storage.FormatUUID(result.ID), State: apitypes.ResultState(result.State), Size: result.Size, Mime: result.MIME, DownloadName: result.DownloadName, Details: apitypes.JSONObject(result.Details)}
		if result.Level != nil {
			x := apitypes.PdfLevel(*result.Level)
			row.Level = &x
		}
		if result.Downloadable {
			x := httpapi.Prefix + "/jobs/" + out.ID + "/results/" + row.ID
			row.DownloadURL = &x
		}
		if result.ErrorCode != nil {
			row.Error = &apitypes.JobError{Code: apitypes.JobErrorCode(*result.ErrorCode)}
		}
		out.Results = append(out.Results, row)
	}
	return out
}
func (a *API) get(w http.ResponseWriter, r *http.Request) error {
	session, err := a.auth.RequireSession(r.Context(), r)
	if err != nil {
		return err
	}
	owner, _ := parseID(session.ID)
	id, err := parseID(r.PathValue("job_id"))
	if err != nil {
		return err
	}
	value, err := store.LoadJob(r.Context(), a.pool, id, owner)
	if err != nil {
		return err
	}
	httpapi.WriteJSON(w, 200, jobView(value))
	return nil
}
func (a *API) cancel(w http.ResponseWriter, r *http.Request) error {
	session, err := a.auth.RequireWrite(r.Context(), r)
	if err != nil {
		return err
	}
	owner, _ := parseID(session.ID)
	id, err := parseID(r.PathValue("job_id"))
	if err != nil {
		return err
	}
	status, value, err := store.Cancel(r.Context(), a.pool, owner, id)
	if err != nil {
		return err
	}
	httpapi.WriteJSON(w, 200, apitypes.CancelResponse{Cancellation: apitypes.Cancellation(status), Job: jobView(value)})
	return nil
}
func (a *API) remove(w http.ResponseWriter, r *http.Request) error {
	session, err := a.auth.RequireWrite(r.Context(), r)
	if err != nil {
		return err
	}
	owner, _ := parseID(session.ID)
	id, err := parseID(r.PathValue("job_id"))
	if err != nil {
		return err
	}
	if err = store.MarkDeleted(r.Context(), a.pool, owner, id); err != nil {
		return err
	}
	w.WriteHeader(204)
	return nil
}
func (a *API) download(w http.ResponseWriter, r *http.Request) error {
	session, err := a.auth.RequireSession(r.Context(), r)
	if err != nil {
		return err
	}
	owner, _ := parseID(session.ID)
	id, err := parseID(r.PathValue("job_id"))
	if err != nil {
		return err
	}
	result, err := parseID(r.PathValue("result_id"))
	if err != nil {
		return store.ErrResultNotFound
	}
	info, err := store.LeaseDownload(r.Context(), a.pool, owner, id, result, a.cfg.DownloadMax)
	if err != nil {
		return err
	}
	file, err := a.files.Open(info.StorageKey)
	if errors.Is(err, os.ErrNotExist) {
		return store.ErrResultNotFound
	}
	if err != nil {
		return err
	}
	defer file.Close()
	ascii := strings.Map(func(c rune) rune {
		if c < 32 || c >= 127 || c == '"' || c == '\\' {
			return '_'
		}
		return c
	}, info.DownloadName)
	w.Header().Set("Content-Disposition", fmt.Sprintf("attachment; filename=\"%s\"; filename*=UTF-8''%s", ascii, strings.ReplaceAll(url.QueryEscape(info.DownloadName), "+", "%20")))
	w.Header().Set("Content-Type", info.MIME)
	w.Header().Set("Content-Length", strconv.FormatInt(info.Size, 10))
	w.Header().Set("Content-Security-Policy", "sandbox")
	w.Header().Set("Cache-Control", "private, no-store")
	controller := http.NewResponseController(w)
	if err = controller.SetWriteDeadline(time.Now().Add(a.cfg.DownloadMax)); err != nil && !errors.Is(err, http.ErrNotSupported) {
		return err
	}
	defer controller.SetWriteDeadline(time.Time{})
	if _, err = io.Copy(w, io.LimitReader(file, info.Size)); err != nil {
		panic(http.ErrAbortHandler)
	}
	return nil
}

func (a *API) capabilities(w http.ResponseWriter, r *http.Request) error {
	report, err := converter.LoadReport(filepath.Join(a.cfg.StorageDir, converter.ReportFile), time.Now().UTC(), 15*time.Minute)
	if err != nil {
		return httpapi.ServiceUnavailable()
	}
	inputs, outputs := report.ImageFormats()
	out := apitypes.Capabilities{APIVersion: "1", Tools: []apitypes.Tool{"image-convert", "image-compress", "image-resize", "pdf-compress"}, Image: apitypes.ImageCapabilities{QualityFormats: []apitypes.OutputFormat{"jpeg", "webp"}, IcoSizes: []int{16, 32, 48, 64, 128, 256}, DefaultIcoSizes: []int{16, 32, 48, 256}, MaxFileBytes: a.cfg.ImageMaxInputBytes, MaxPixels: a.cfg.ImageMaxPixels, MaxEdge: a.cfg.ImageMaxEdge, MaxOutputBytes: a.cfg.ImageMaxOutputBytes}, Pdf: apitypes.PdfCapabilities{MaxFileBytes: a.cfg.PdfMaxInputBytes, MaxResultBytesTotal: a.cfg.PdfMaxResultsTotalBytes, MaxImagePixels: a.cfg.PdfImageMaxPixels}, Jobs: apitypes.JobCapabilities{TTLSeconds: int(a.cfg.JobTTL / time.Second), MaxActivePerSession: a.cfg.SessionMaxActiveJobs, MaxBatchFiles: 30, CreatePerMinute: a.cfg.SessionCreatesPerMinute}}
	for _, f := range inputs {
		out.Image.InputFormats = append(out.Image.InputFormats, apitypes.InputFormat(f))
	}
	for _, f := range outputs {
		out.Image.OutputFormats = append(out.Image.OutputFormats, apitypes.OutputFormat(f))
	}
	for _, level := range []struct {
		name      string
		dpi, edge int
		quality   float64
	}{{"high", 300, 3600, .85}, {"balanced", 150, 2000, .72}, {"small", 100, 1300, .55}} {
		out.Pdf.Levels = append(out.Pdf.Levels, apitypes.PdfLevelCapability{Level: apitypes.PdfLevel(level.name), TargetDpi: level.dpi, MaxImageEdge: level.edge, Quality: level.quality, MinDownscaleFactor: .9})
	}
	httpapi.WriteJSON(w, 200, out)
	return nil
}

func (a *API) create(w http.ResponseWriter, r *http.Request) error {
	session, err := a.auth.RequireWrite(r.Context(), r)
	if err != nil {
		return err
	}
	owner, _ := parseID(session.ID)
	key := r.Header.Get("Idempotency-Key")
	if key != "" && !idempotencyPattern.MatchString(key) {
		return httpapi.NewError(422, apitypes.CodeInvalidIdempotencyKey, "Idempotency-Key ist ungültig.")
	}
	if key != "" && a.rate != nil {
		release, err := a.rate.IdempotencyLock(r.Context(), session.ID, key, a.cfg.UploadMax)
		if err != nil {
			return err
		}
		defer release()
	}
	replay := false
	if key != "" {
		replay, err = a.jobs.LookupReplay(r.Context(), owner, key)
		if err != nil {
			return err
		}
	}
	if replay && a.rate != nil {
		release, err := a.rate.ReplayGuard(r.Context(), session.ID, a.cfg.SessionReplaysPerMinute, a.cfg.UploadMax)
		if err != nil {
			return err
		}
		defer release()
	}
	if !replay {
		if err = a.check(r.Context(), ratelimit.Limit{Kind: "create-session", Identity: session.ID, PerMinute: a.cfg.SessionCreatesPerMinute}, ratelimit.Limit{Kind: "create-ip", Identity: a.auth.ClientIP(r), PerMinute: a.cfg.IPCreatesPerMinute}); err != nil {
			return err
		}
	}
	ctx, cancel := context.WithTimeout(r.Context(), a.cfg.UploadMax)
	defer cancel()
	r = r.WithContext(ctx)
	_ = http.NewResponseController(w).SetReadDeadline(time.Now().Add(a.cfg.UploadMax))
	defer http.NewResponseController(w).SetReadDeadline(time.Time{})
	maximum := a.cfg.MaxUploadInputBytes() + 32768
	r.Body = http.MaxBytesReader(w, r.Body, maximum)
	defer r.Body.Close()
	media, params, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil || media != "multipart/form-data" || params["boundary"] == "" || len(params["boundary"]) > 200 {
		return httpapi.NewError(400, apitypes.CodeInvalidRequest, "Multipart erwartet.")
	}
	var reservation jobs.Reservation
	if !replay {
		reservation, err = a.jobs.Admit(ctx, owner)
		if err != nil {
			return err
		}
		defer func() { _ = a.jobs.Release(ctx, reservation) }()
	}
	r.Body = struct {
		io.Reader
		io.Closer
	}{guardHeaders(ctx, r.Body, params["boundary"]), r.Body}
	multipart, err := r.MultipartReader()
	if err != nil {
		return bodyError(err)
	}
	part, err := multipart.NextPart()
	if err != nil {
		return bodyError(err)
	}
	if part.FormName() != "options" || part.FileName() != "" || !smallHeaders(part.Header) {
		return httpapi.NewError(422, apitypes.CodeInvalidRequest, "Erster Teil muss options sein.")
	}
	raw, err := io.ReadAll(io.LimitReader(part, 8193))
	if err != nil {
		return bodyError(err)
	}
	if len(raw) > 8192 {
		return httpapi.NewError(422, apitypes.CodeInvalidRequest, "Optionsfeld ist zu groß.")
	}
	opts, err := parseOptions(raw)
	if err != nil {
		return err
	}
	part, err = multipart.NextPart()
	if err != nil {
		return httpapi.NewError(422, apitypes.CodeMissingFile, "Genau eine Datei erwartet.")
	}
	if part.FormName() != "file" || part.FileName() == "" || !smallHeaders(part.Header) {
		return httpapi.NewError(422, apitypes.CodeMissingFile, "Genau eine Datei erwartet.")
	}
	originalName := part.FileName()
	var writer *storage.Writer
	if !replay {
		writer, err = a.files.Create(reservation.SpoolKey)
		if err != nil {
			return err
		}
		defer writer.Close()
	}
	limit := a.cfg.ImageMaxInputBytes
	switch opts.tool {
	case "pdf-compress":
		limit = a.cfg.PdfMaxInputBytes
	case "audio-convert":
		limit = a.cfg.AudioMaxInputBytes
	}
	hash := sha256.New()
	var sink io.Writer = hash
	if writer != nil {
		sink = io.MultiWriter(writer, hash)
	}
	size, err := io.CopyBuffer(sink, io.LimitReader(part, limit+1), make([]byte, 64*1024))
	if err != nil {
		return bodyError(err)
	}
	if size > limit {
		return httpapi.NewError(413, apitypes.CodeFileTooLarge, "Datei überschreitet das Limit.")
	}
	if size == 0 {
		return httpapi.NewError(415, apitypes.CodeUnsupportedType, "Datei ist leer.")
	}
	if _, err = multipart.NextPart(); !errors.Is(err, io.EOF) {
		if err != nil {
			return bodyError(err)
		}
		return httpapi.NewError(422, apitypes.CodeMissingFile, "Genau eine Datei erwartet.")
	}
	var digest [32]byte
	copy(digest[:], hash.Sum(nil))
	var accepted jobs.Acceptance
	if replay {
		fingerprint, err := jobs.Fingerprint(opts.tool, opts.canonical, digest, size)
		if err != nil {
			return err
		}
		accepted, err = a.jobs.ResolveReplay(ctx, owner, key, fingerprint)
		if err != nil {
			return err
		}
	} else {
		if err = writer.Close(); err != nil {
			return err
		}
		file, err := a.files.Open(reservation.SpoolKey)
		if err != nil {
			return err
		}
		defer file.Close()
		head := make([]byte, min(size, jobs.SniffBytes))
		if _, err = io.ReadFull(file, head); err != nil {
			return err
		}
		format := "pdf"
		switch opts.tool {
		case "pdf-compress":
			if !jobs.IsPDF(head) {
				return httpapi.NewError(415, apitypes.CodeNotPDF, "Keine erkennbare PDF.")
			}
		case "audio-convert":
			// Dauer, Kanäle und Abtastrate prüft der Worker (soundfile).
			format = jobs.DetectAudioFormat(head)
			if format == "" {
				return httpapi.NewError(415, apitypes.CodeUnsupportedType, "Audioformat nicht unterstützt.")
			}
		default:
			format = jobs.DetectImageFormat(head)
			if format == "" {
				return httpapi.NewError(415, apitypes.CodeUnsupportedType, "Dateityp nicht unterstützt.")
			}
			if err = probeImage(ctx, file, size, format, a.cfg); err != nil {
				var api *httpapi.Error
				if errors.As(err, &api) {
					return api
				}
				return httpapi.NewError(415, apitypes.CodeUnsupportedType, "Bildkopf ist beschädigt.")
			}
		}
		output := opts.format
		if output == "original" {
			output = format
		}
		if opts.tool == "audio-convert" {
			if _, ok := jobs.AudioMIME[output]; !ok {
				return invalidOptions()
			}
		} else if opts.tool != "pdf-compress" {
			if _, ok := jobs.OutputMIME[output]; !ok {
				return httpapi.NewError(422, apitypes.CodeOriginalFormatUnsupported, "Originalformat nicht erzeugbar.")
			}
			if output == "ico" && opts.resizeMode != "none" {
				return invalidOptions()
			}
		}
		accepted, err = a.jobs.Finalize(ctx, owner, reservation, jobs.Upload{Tool: opts.tool, Options: opts.canonical, OriginalName: originalName, Size: size, SHA256: digest, InputFormat: format, OutputFormat: output, PDFLevels: opts.levels}, key)
		if err != nil {
			return err
		}
	}
	status := 202
	if accepted.Replayed {
		status = 200
		w.Header().Set("Idempotent-Replayed", "true")
	}
	value := jobView(accepted.Job)
	w.Header().Set("Location", httpapi.Prefix+"/jobs/"+value.ID)
	httpapi.WriteJSON(w, status, value)
	return nil
}

func smallHeaders(headers map[string][]string) bool {
	n := 0
	for key, values := range headers {
		n += len(key)
		for _, v := range values {
			n += len(v)
		}
	}
	return n <= 8192
}
func bodyError(err error) error {
	var limit *http.MaxBytesError
	if errors.As(err, &limit) {
		return httpapi.NewError(413, apitypes.CodeFileTooLarge, "Anfrage ist zu groß.")
	}
	return httpapi.NewError(400, apitypes.CodeInvalidRequest, "Multipart-Daten unvollständig oder beschädigt.")
}
