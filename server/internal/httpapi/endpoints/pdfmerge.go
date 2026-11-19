package endpoints

import (
	"context"
	"crypto/sha256"
	"errors"
	"io"
	"mime/multipart"
	"net/http"
	"path/filepath"
	"time"

	"miconverter/server/internal/apitypes"
	"miconverter/server/internal/converter"
	"miconverter/server/internal/httpapi"
	"miconverter/server/internal/jobs"
	"miconverter/server/internal/storage"
)

// mergeUpload beschreibt die gelesenen Teile eines pdf-merge-Uploads.
type mergeUpload struct {
	firstName  string
	files      int
	payload    int64 // Summe der PDF-Bytes
	bundleSize int64 // Größe der gespeicherten Eingabe (Payload plus Rahmen)
}

// readMergeParts liest alle "file"-Teile nach dem Optionsteil, prüft jedes
// als PDF und schreibt sie als Bündel nach sink. Jede Datei wird gestreamt;
// weder Anzahl noch Größe können die Grenzen überschreiten, bevor abgelehnt
// wird. maxBundle begrenzt die gespeicherte Eingabe (Reservierung).
func readMergeParts(mr *multipart.Reader, sink io.Writer, maxPayload, maxBundle int64) (mergeUpload, error) {
	bundle := jobs.NewBundleWriter(sink)
	var up mergeUpload
	for {
		part, err := mr.NextPart()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return up, bodyError(err)
		}
		if part.FormName() != "file" || part.FileName() == "" || !smallHeaders(part.Header) {
			return up, httpapi.NewError(422, apitypes.CodeMissingFile, "Nur PDF-Dateien als file erwartet.")
		}
		if up.files >= apitypes.PdfMergeMaxFiles {
			return up, httpapi.NewError(422, apitypes.CodeInvalidRequest, "Zu viele Dateien.")
		}
		size, head, err := bundle.AddFile(part, maxPayload-up.payload, jobs.SniffBytes)
		switch {
		case errors.Is(err, jobs.ErrBundleFile) && size == 0:
			return up, httpapi.NewError(415, apitypes.CodeUnsupportedType, "Datei ist leer.")
		case errors.Is(err, jobs.ErrBundleFile):
			return up, httpapi.NewError(413, apitypes.CodeFileTooLarge, "Dateien überschreiten das Limit.")
		case err != nil:
			return up, bodyError(err)
		}
		if !jobs.IsPDF(head) {
			return up, httpapi.NewError(415, apitypes.CodeNotPDF, "Keine erkennbare PDF.")
		}
		if bundle.Written() > maxBundle {
			return up, httpapi.NewError(413, apitypes.CodeFileTooLarge, "Dateien überschreiten das Limit.")
		}
		if up.files == 0 {
			up.firstName = part.FileName()
		}
		up.files++
		up.payload += size
	}
	if up.files < apitypes.PdfMergeMinFiles {
		return up, httpapi.NewError(422, apitypes.CodeMissingFile, "Mindestens zwei PDF-Dateien erwartet.")
	}
	if err := bundle.Close(); err != nil {
		return up, err
	}
	up.bundleSize = bundle.Written()
	if up.bundleSize > maxBundle {
		return up, httpapi.NewError(413, apitypes.CodeFileTooLarge, "Dateien überschreiten das Limit.")
	}
	return up, nil
}

// mergeBundleLimit ist die größte Bündelgröße zu maxPayload Nutzbytes:
// Rahmen von 4 Bytes je 64-KiB-Block und je Datei, Kopf und Ende.
func mergeBundleLimit(maxPayload int64) int64 {
	return maxPayload + (maxPayload/(64*1024)+1+apitypes.PdfMergeMaxFiles)*4 + 64
}

// createMergeJob nimmt einen pdf-merge-Auftrag an. Es ersetzt den Einzeldatei-
// Teil von createJob; Sitzung, Ratenlimits, Reservierung und Idempotenz sind
// bereits geprüft.
func (a *API) createMergeJob(ctx context.Context, w http.ResponseWriter, mr *multipart.Reader, opts options,
	owner [16]byte, key string, replay bool, reservation jobs.Reservation) error {
	report, err := converter.LoadReport(filepath.Join(a.cfg.StorageDir, converter.ReportFile), time.Now().UTC(), 15*time.Minute)
	if err != nil || !report.PDF {
		return httpapi.NewError(503, apitypes.CodeServiceUnavailable, "PDF-Verarbeitung ist nicht verfügbar.")
	}
	hash := sha256.New()
	var sink io.Writer = hash
	var writer *storage.Writer
	if !replay {
		if writer, err = a.files.Create(reservation.SpoolKey); err != nil {
			return err
		}
		defer writer.Close()
		sink = io.MultiWriter(writer, hash)
	}
	// Gespeichert wird höchstens die Reservierung; ohne Reservierung (Replay)
	// gilt dieselbe Rahmenreserve wie beim Erstaufruf, damit Hash und Größe gleich bleiben.
	maxBundle := reservation.Bytes
	if replay {
		maxBundle = mergeBundleLimit(a.cfg.PdfMaxInputBytes)
	}
	up, err := readMergeParts(mr, sink, a.cfg.PdfMaxInputBytes, maxBundle)
	if err != nil {
		return err
	}
	var digest [32]byte
	copy(digest[:], hash.Sum(nil))
	var accepted jobs.Acceptance
	if replay {
		fingerprint, err := jobs.Fingerprint(opts.tool, opts.canonical, digest, up.bundleSize)
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
		accepted, err = a.jobs.Finalize(ctx, owner, reservation, jobs.Upload{Tool: opts.tool, Options: opts.canonical,
			OriginalName: up.firstName, Size: up.bundleSize, SHA256: digest, InputFormat: "pdf", OutputFormat: "pdf"}, key)
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

// mergeCapabilities meldet Verfügbarkeit und Grenzen für GET /capabilities.
// Verfügbar ist das Zusammenführen, wenn die PDF-Bibliothek in der Probe lief.
func (a *API) mergeCapabilities(report converter.Report) apitypes.PdfMergeCapabilities {
	return apitypes.PdfMergeCapabilities{
		Available: report.PDF, MinFiles: apitypes.PdfMergeMinFiles, MaxFiles: apitypes.PdfMergeMaxFiles,
		MaxTotalBytes: a.cfg.PdfMaxInputBytes, MaxOutputBytes: a.cfg.PdfMaxInputBytes, MaxPages: apitypes.PdfMergeMaxPages,
	}
}
