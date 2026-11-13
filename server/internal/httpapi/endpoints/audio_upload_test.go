package endpoints

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func audioFixture(t *testing.T, name string) []byte {
	t.Helper()
	data, err := os.ReadFile(filepath.Join("..", "..", "jobs", "testdata", "audio", name))
	if err != nil {
		t.Fatal(err)
	}
	return data
}

func TestAudioUploadIsAcceptedPerFormat(t *testing.T) {
	cases := []struct {
		file, input, output, mime, name string
	}{
		{"tone.wav", "wav", "mp3", "audio/mpeg", "privat.mp3"},
		{"tone.mp3", "mp3", "wav", "audio/wav", "privat.wav"},
		{"tone.flac", "flac", "ogg", "audio/ogg", "privat.ogg"},
		{"tone.opus", "ogg", "flac", "audio/flac", "privat.flac"},
		{"tone.ogg", "ogg", "ogg", "audio/ogg", "privat-konvertiert.ogg"},
	}
	for _, c := range cases {
		f := fixture(t)
		payload, content := body(t, `{"tool":"audio-convert","format":"`+c.output+`"}`, audioFixture(t, c.file))
		response := f.request("POST", "/jobs", payload, content)
		if response.Code != 202 {
			t.Fatalf("%s: %d %s", c.file, response.Code, response.Body.String())
		}
		var job struct {
			Tool  string `json:"tool"`
			Input struct {
				Format string `json:"format"`
				Width  *int   `json:"width"`
			} `json:"input"`
			Results []struct {
				Mime         string  `json:"mime"`
				DownloadName string  `json:"downloadName"`
				Level        *string `json:"level"`
			} `json:"results"`
		}
		if err := json.Unmarshal(response.Body.Bytes(), &job); err != nil {
			t.Fatal(err)
		}
		if job.Tool != "audio-convert" || job.Input.Format != c.input || job.Input.Width != nil ||
			len(job.Results) != 1 || job.Results[0].Mime != c.mime || job.Results[0].DownloadName != c.name ||
			job.Results[0].Level != nil {
			t.Errorf("%s: %+v", c.file, job)
		}
	}
}

func TestAudioUploadRejectsWrongBytes(t *testing.T) {
	f := fixture(t)
	cases := []struct {
		options string
		data    []byte
		status  int
		code    string
	}{
		{`{"tool":"audio-convert","format":"mp3"}`, pngBytes(t), 415, "unsupported-type"},
		{`{"tool":"audio-convert","format":"mp3"}`, []byte("%PDF-1.7\n"), 415, "unsupported-type"},
		{`{"tool":"image-convert","format":"png"}`, audioFixture(t, "tone.wav"), 415, "unsupported-type"},
		{`{"tool":"pdf-compress"}`, audioFixture(t, "tone.mp3"), 415, "not-pdf"},
		{`{"tool":"audio-convert","format":"m4a"}`, audioFixture(t, "tone.wav"), 422, "invalid-options"},
	}
	for _, c := range cases {
		payload, content := body(t, c.options, c.data)
		response := f.request("POST", "/jobs", payload, content)
		var problem struct {
			Error struct {
				Code string `json:"code"`
			} `json:"error"`
		}
		json.Unmarshal(response.Body.Bytes(), &problem)
		if response.Code != c.status || problem.Error.Code != c.code {
			t.Errorf("%s: %d %s", c.options, response.Code, response.Body.String())
		}
	}
	var reserved, count int64
	f.pool.QueryRow(t.Context(), "SELECT reserved_bytes FROM storage_usage WHERE id=1").Scan(&reserved)
	f.pool.QueryRow(t.Context(), "SELECT count(*) FROM upload_reservations").Scan(&count)
	if reserved != 0 || count != 0 {
		t.Fatalf("Reservierung bleibt: %d Bytes, %d Einträge", reserved, count)
	}
}

func TestAudioUploadLimitUsesAudioMaximum(t *testing.T) {
	f := fixture(t)
	if f.api.cfg.AudioMaxInputBytes <= f.api.cfg.ImageMaxInputBytes {
		t.Fatal("Testannahme: Audio-Grenze liegt über der Bildgrenze")
	}
	// Größer als das Bildlimit, kleiner als das Audiolimit: muss angenommen werden.
	wav := audioFixture(t, "tone.wav")
	big := make([]byte, f.api.cfg.ImageMaxInputBytes+1)
	copy(big, wav)
	payload, content := body(t, `{"tool":"audio-convert","format":"flac"}`, big)
	if response := f.request("POST", "/jobs", payload, content); response.Code != 202 {
		t.Fatalf("%d %s", response.Code, response.Body.String())
	}
}
