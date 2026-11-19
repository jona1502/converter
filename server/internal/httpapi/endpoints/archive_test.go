package endpoints

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"io"
	"strings"
	"testing"

	"miconverter/server/internal/storage"
	"miconverter/server/internal/store"
)

// uploadJob legt einen Auftrag an; mit data wird das Ergebnis als fertig markiert.
func (f *apiFixture) uploadJob(t *testing.T, data []byte) string {
	t.Helper()
	payload, content := body(t, `{"tool":"image-convert","format":"png"}`, pngBytes(t))
	f.key = "archive-key-" + storage.FormatUUID(store.NewID())
	response := f.request("POST", "/jobs", payload, content)
	f.key = ""
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
	if data == nil {
		return value.ID
	}
	id, _ := parseID(value.ID)
	rid, _ := parseID(value.Results[0].ID)
	key := storage.ResultKey(id, rid, store.NewID())
	writer, err := f.api.files.Create(key)
	if err != nil {
		t.Fatal(err)
	}
	writer.Write(data)
	writer.Close()
	if _, err = f.pool.Exec(t.Context(), `UPDATE job_results SET state='succeeded',storage_key=$1,size=$2,download_name='bild.png' WHERE id=$3`, key, len(data), rid); err != nil {
		t.Fatal(err)
	}
	if _, err = f.pool.Exec(t.Context(), `UPDATE jobs SET state='succeeded' WHERE id=$1`, id); err != nil {
		t.Fatal(err)
	}
	return value.ID
}

func TestArchiveZipsFinishedJobsAndListsSkipped(t *testing.T) {
	f := fixture(t)
	one, two := []byte("eins"), []byte("zwei")
	a, b := f.uploadJob(t, one), f.uploadJob(t, two)
	pending := f.uploadJob(t, nil)
	response := f.request("GET", "/jobs/archive?job_id="+a+"&job_id="+b+"&job_id="+a+"&job_id="+pending, nil, "")
	if response.Code != 200 || response.Header().Get("Content-Type") != "application/zip" {
		t.Fatalf("%d %s", response.Code, response.Body.String())
	}
	zr, err := zip.NewReader(bytes.NewReader(response.Body.Bytes()), int64(response.Body.Len()))
	if err != nil {
		t.Fatal(err)
	}
	got := map[string]string{}
	for _, file := range zr.File {
		rc, _ := file.Open()
		data, _ := io.ReadAll(rc)
		rc.Close()
		got[file.Name] = string(data)
	}
	if len(got) != 3 || got["bild.png"] != "eins" || got["bild-2.png"] != "zwei" ||
		!strings.Contains(got[archiveSkippedName], "privat.png: noch in Verarbeitung") {
		t.Fatalf("Archiv = %v", got)
	}
}

func TestArchiveRejectsBadRequestsAndEmptyArchives(t *testing.T) {
	f := fixture(t)
	if got := f.request("GET", "/jobs/archive", nil, "").Code; got != 400 {
		t.Errorf("ohne Aufträge: %d", got)
	}
	if got := f.request("GET", "/jobs/archive?job_id=x", nil, "").Code; got != 404 {
		t.Errorf("ungültige ID: %d", got)
	}
	many := strings.Repeat("&job_id="+"00000000-0000-4000-8000-000000000000", maxArchiveJobs+1)
	if got := f.request("GET", "/jobs/archive?"+many[1:], nil, "").Code; got != 400 {
		t.Errorf("zu viele: %d", got)
	}
	pending := f.uploadJob(t, nil)
	if got := f.request("GET", "/jobs/archive?job_id="+pending, nil, "").Code; got != 404 {
		t.Errorf("nichts fertig: %d", got)
	}
}

// Das Archiv ist werkzeugunabhängig: Namen aus Bild-, PDF- und Audioaufträgen
// werden gemeinsam und ohne Beachtung der Groß-/Kleinschreibung eindeutig.
func TestUniqueArchiveNameAcrossToolOutputs(t *testing.T) {
	taken := map[string]bool{strings.ToLower(archiveSkippedName): true}
	got := []string{}
	for _, name := range []string{"foto.webp", "Foto.WEBP", "bericht-high.pdf", "bericht-high.pdf", "ton.mp3", "foto.webp", archiveSkippedName} {
		got = append(got, uniqueArchiveName(taken, name))
	}
	want := []string{"foto.webp", "Foto-2.WEBP", "bericht-high.pdf", "bericht-high-2.pdf", "ton.mp3", "foto-3.webp", "_uebersprungen-2.txt"}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("name %d = %q, want %q", i, got[i], want[i])
		}
	}
}
