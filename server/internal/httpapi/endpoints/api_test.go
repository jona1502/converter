package endpoints

import (
	"bytes"
	"context"
	"encoding/json"
	"image"
	"image/png"
	"io"
	"mime/multipart"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"miconverter/server/internal/config"
	"miconverter/server/internal/httpapi"
	"miconverter/server/internal/storage"
	"miconverter/server/internal/store"
	"miconverter/server/internal/testdb"
	"miconverter/server/migrations"
)

type apiFixture struct {
	api          *API
	router       *httpapi.Router
	pool         *pgxpool.Pool
	cookie, csrf string
	key          string // abweichender Idempotency-Key
}

func fixture(t *testing.T) *apiFixture {
	t.Helper()
	pool, _ := testdb.NewPool(t)
	if _, err := store.Migrate(t.Context(), pool, migrations.FS); err != nil {
		t.Fatal(err)
	}
	cfg, err := config.Load(func(k string) (string, bool) {
		values := map[string]string{"CONVERTER_ENVIRONMENT": "test", "CONVERTER_STORAGE_DIR": t.TempDir(), "CONVERTER_SESSION_COOKIE_SECURE": "false", "CONVERTER_ALLOWED_ORIGINS": "http://testserver"}
		v, ok := values[k]
		return v, ok
	})
	if err != nil {
		t.Fatal(err)
	}
	files, err := storage.NewLocal(cfg.StorageDir)
	if err != nil {
		t.Fatal(err)
	}
	api, err := New(cfg, pool, files, nil)
	if err != nil {
		t.Fatal(err)
	}
	router := httpapi.NewRouter(nil)
	api.Register(router)
	f := &apiFixture{api: api, router: router, pool: pool}
	response := f.request("GET", "/session", nil, "")
	if response.Code != 200 {
		t.Fatal(response.Body.String())
	}
	f.cookie = strings.Split(response.Header().Get("Set-Cookie"), ";")[0]
	var session struct {
		Csrf string `json:"csrfToken"`
	}
	json.Unmarshal(response.Body.Bytes(), &session)
	f.csrf = session.Csrf
	return f
}
func (f *apiFixture) request(method, path string, body []byte, content string) *httptest.ResponseRecorder {
	r := httptest.NewRequest(method, "http://testserver/api/v1"+path, bytes.NewReader(body))
	r.Header.Set("Cookie", f.cookie)
	r.Header.Set("Origin", "http://testserver")
	r.Header.Set("X-CSRF-Token", f.csrf)
	if content != "" {
		r.Header.Set("Content-Type", content)
	}
	key := "stable-request-key-123456"
	if f.key != "" {
		key = f.key
	}
	r.Header.Set("Idempotency-Key", key)
	w := httptest.NewRecorder()
	f.router.ServeHTTP(w, r)
	return w
}
func pngBytes(t *testing.T) []byte {
	t.Helper()
	var b bytes.Buffer
	if err := png.Encode(&b, image.NewRGBA(image.Rect(0, 0, 2, 3))); err != nil {
		t.Fatal(err)
	}
	return b.Bytes()
}
func body(t *testing.T, options string, data []byte) ([]byte, string) {
	t.Helper()
	var b bytes.Buffer
	writer := multipart.NewWriter(&b)
	part, err := writer.CreateFormField("options")
	if err != nil {
		t.Fatal(err)
	}
	io.WriteString(part, options)
	part, err = writer.CreateFormFile("file", "privat.png")
	if err != nil {
		t.Fatal(err)
	}
	part.Write(data)
	writer.Close()
	return b.Bytes(), writer.FormDataContentType()
}

func TestUploadReplayOwnerCancellationAndDelete(t *testing.T) {
	f := fixture(t)
	payload, content := body(t, `{"tool":"image-convert","format":"webp","quality":0}`, pngBytes(t))
	response := f.request("POST", "/jobs", payload, content)
	if response.Code != 202 {
		t.Fatalf("accept %d: %s", response.Code, response.Body.String())
	}
	var job struct {
		ID    string `json:"id"`
		Input struct {
			Name string `json:"name"`
		} `json:"input"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &job); err != nil {
		t.Fatal(err)
	}
	if job.Input.Name != "privat.png" {
		t.Fatal(job.Input.Name)
	}
	again := f.request("POST", "/jobs", payload, content)
	if again.Code != 200 || again.Header().Get("Idempotent-Replayed") != "true" {
		t.Fatalf("replay %d %s", again.Code, again.Body.String())
	}
	different, differentContent := body(t, `{"tool":"image-convert","format":"png"}`, pngBytes(t))
	conflict := f.request("POST", "/jobs", different, differentContent)
	if conflict.Code != 409 {
		t.Fatalf("conflict=%d: %s", conflict.Code, conflict.Body.String())
	}
	original := f.cookie
	f.cookie = ""
	session := f.request("GET", "/session", nil, "")
	f.cookie = strings.Split(session.Header().Get("Set-Cookie"), ";")[0]
	if got := f.request("GET", "/jobs/"+job.ID, nil, "").Code; got != 404 {
		t.Fatalf("foreign=%d", got)
	}
	f.cookie = original
	cancel := f.request("POST", "/jobs/"+job.ID+"/cancel", nil, "")
	if cancel.Code != 200 || !strings.Contains(cancel.Body.String(), `"cancellation":"completed"`) {
		t.Fatal(cancel.Body.String())
	}
	if got := f.request("DELETE", "/jobs/"+job.ID, nil, "").Code; got != 204 {
		t.Fatal(got)
	}
	if got := f.request("GET", "/jobs/"+job.ID, nil, "").Code; got != 404 {
		t.Fatal(got)
	}
	var reserved int64
	if err := f.pool.QueryRow(t.Context(), "SELECT reserved_bytes FROM storage_usage WHERE id=1").Scan(&reserved); err != nil || reserved <= 0 {
		t.Fatalf("storage still retained until cleanup: %d %v", reserved, err)
	}
}

func TestBadUploadsReleaseReservations(t *testing.T) {
	f := fixture(t)
	cases := []struct {
		options string
		data    []byte
		status  int
	}{
		{`{"tool":"image-convert","format":"webp","quality":"0.5"}`, pngBytes(t), 422},
		{`{"tool":"image-convert","format":"webp","unknown":true}`, pngBytes(t), 422},
		{`{"tool":"image-convert","format":"webp"}`, []byte("bad"), 415},
		{`{"tool":"pdf-compress"}`, []byte("bad"), 415},
	}
	for _, tc := range cases {
		payload, content := body(t, tc.options, tc.data)
		response := f.request("POST", "/jobs", payload, content)
		if response.Code != tc.status {
			t.Fatalf("%d !=%d: %s", response.Code, tc.status, response.Body.String())
		}
	}
	payload, content := body(t, `{"tool":"image-convert","format":"webp"}`, pngBytes(t))
	response := f.request("POST", "/jobs", payload[:len(payload)-8], content)
	if response.Code < 400 {
		t.Fatal("accepted truncated multipart")
	}
	var reserved, count int64
	f.pool.QueryRow(t.Context(), "SELECT reserved_bytes FROM storage_usage WHERE id=1").Scan(&reserved)
	f.pool.QueryRow(t.Context(), "SELECT count(*) FROM upload_reservations").Scan(&count)
	if reserved != 0 || count != 0 {
		t.Fatalf("leak %d %d", reserved, count)
	}
	entries, _ := os.ReadDir(filepath.Join(f.api.cfg.StorageDir, "spool"))
	if len(entries) != 0 {
		t.Fatal("spool remains")
	}
}

func TestSuccessfulDownloadLeaseHeadersAndExpiry(t *testing.T) {
	f := fixture(t)
	payload, content := body(t, `{"tool":"image-convert","format":"png"}`, pngBytes(t))
	response := f.request("POST", "/jobs", payload, content)
	if response.Code != 202 {
		t.Fatal(response.Body.String())
	}
	var value struct {
		ID      string `json:"id"`
		Results []struct {
			ID string `json:"id"`
		} `json:"results"`
	}
	json.Unmarshal(response.Body.Bytes(), &value)
	id, _ := parseID(value.ID)
	rid, _ := parseID(value.Results[0].ID)
	key := storage.ResultKey(id, rid, store.NewID())
	writer, err := f.api.files.Create(key)
	if err != nil {
		t.Fatal(err)
	}
	data := pngBytes(t)
	writer.Write(data)
	writer.Close()
	_, err = f.pool.Exec(t.Context(), "UPDATE job_results SET state='succeeded',storage_key=$1,size=$2 WHERE id=$3", key, len(data), rid)
	if err != nil {
		t.Fatal(err)
	}
	download := f.request("GET", "/jobs/"+value.ID+"/results/"+value.Results[0].ID, nil, "")
	if download.Code != 200 || !bytes.Equal(download.Body.Bytes(), data) {
		t.Fatalf("download%d: %s", download.Code, download.Body.String())
	}
	if download.Header().Get("Content-Security-Policy") != "sandbox" || !strings.Contains(download.Header().Get("Content-Disposition"), "attachment") {
		t.Fatal(download.Header())
	}
	var lease time.Time
	f.pool.QueryRow(t.Context(), "SELECT download_until FROM jobs WHERE id=$1", id).Scan(&lease)
	if !lease.After(time.Now()) {
		t.Fatal("lease missing")
	}
	f.pool.Exec(context.Background(), "UPDATE jobs SET expires_at=now()-interval '1 second' WHERE id=$1", id)
	if got := f.request("GET", "/jobs/"+value.ID+"/results/"+value.Results[0].ID, nil, "").Code; got != 410 {
		t.Fatal(got)
	}
}

func TestOptionsCanonicalMatchesPythonGolden(t *testing.T) {
	raw, err := os.ReadFile("../../jobs/testdata/python_golden.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixture struct {
		Options []struct{ Input, Canonical string }
	}
	if err = json.Unmarshal(raw, &fixture); err != nil {
		t.Fatal(err)
	}
	for _, tc := range fixture.Options {
		value, err := parseOptions([]byte(tc.Input))
		if err != nil {
			t.Fatalf("%s: %v", tc.Input, err)
		}
		if string(value.canonical) != tc.Canonical {
			t.Fatalf("%s\n%s\n%s", tc.Input, value.canonical, tc.Canonical)
		}
	}
}

type deadlineWriter struct {
	*httptest.ResponseRecorder
	reads, writes []time.Time
}

func (w *deadlineWriter) SetReadDeadline(value time.Time) error {
	w.reads = append(w.reads, value)
	return nil
}
func (w *deadlineWriter) SetWriteDeadline(value time.Time) error {
	w.writes = append(w.writes, value)
	return nil
}

func TestUploadRestoresConnectionReadDeadline(t *testing.T) {
	f := fixture(t)
	payload, content := body(t, `{"tool":"image-convert","format":"png"}`, pngBytes(t))
	r := httptest.NewRequest("POST", "http://testserver/api/v1/jobs", bytes.NewReader(payload))
	r.Header.Set("Content-Type", content)
	r.Header.Set("Cookie", f.cookie)
	r.Header.Set("X-CSRF-Token", f.csrf)
	r.Header.Set("Origin", "http://testserver")
	w := &deadlineWriter{ResponseRecorder: httptest.NewRecorder()}
	f.router.ServeHTTP(w, r)
	if w.Code != 202 {
		t.Fatal(w.Body.String())
	}
	if len(w.reads) != 2 || w.reads[0].IsZero() || !w.reads[1].IsZero() {
		t.Fatal(w.reads)
	}
}
