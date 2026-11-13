package jobs_test

import (
	"crypto/sha256"
	"encoding/json"
	"testing"

	"miconverter/server/internal/jobs"
)

func TestAudioDownloadName(t *testing.T) {
	cases := []struct{ original, input, output, want string }{
		{"Mein Lied.wav", "wav", "mp3", "Mein Lied.mp3"},
		{"Mein Lied.mp3", "mp3", "mp3", "Mein Lied-konvertiert.mp3"},
		{"take.FLAC", "flac", "ogg", "take.ogg"},
		{"", "ogg", "flac", "audio.flac"},
		{"con.wav", "wav", "wav", "_con-konvertiert.wav"},
		{"a/b\\c.ogg", "ogg", "wav", "a_b_c.wav"},
	}
	for _, c := range cases {
		if got := jobs.AudioDownloadName(c.original, c.input, c.output); got != c.want {
			t.Errorf("AudioDownloadName(%q, %s→%s) = %q, erwartet %q", c.original, c.input, c.output, got, c.want)
		}
	}
	want := map[string]string{"mp3": "audio/mpeg", "wav": "audio/wav", "flac": "audio/flac", "ogg": "audio/ogg"}
	for format, mime := range want {
		if jobs.AudioMIME[format] != mime || jobs.AudioExtensions[format] != format {
			t.Errorf("%s: MIME %q, Endung %q", format, jobs.AudioMIME[format], jobs.AudioExtensions[format])
		}
	}
	if len(jobs.AudioMIME) != len(want) {
		t.Errorf("AudioMIME = %v", jobs.AudioMIME)
	}
}

func audioUpload(data []byte, input, output string) jobs.Upload {
	return jobs.Upload{
		Tool: "audio-convert", Options: json.RawMessage(`{"channels":"original","format":"` + output + `","quality":0.8,"tool":"audio-convert"}`),
		OriginalName: "", Size: int64(len(data)), SHA256: sha256.Sum256(data), InputFormat: input, OutputFormat: output,
	}
}

func TestFinalizeAudioCreatesSingleResult(t *testing.T) {
	e := newEnv(t, defaultLimits())
	sess := e.session(t)
	r, err := e.svc.Admit(e.ctx, sess)
	if err != nil {
		t.Fatal(err)
	}
	data := []byte("RIFF\x24\x00\x00\x00WAVE")
	e.spool(t, r, data)
	acc, err := e.svc.Finalize(e.ctx, sess, r, audioUpload(data, "wav", "mp3"), "")
	if err != nil {
		t.Fatal(err)
	}
	j, res := acc.Job.Job, acc.Job.Results
	if j.Tool != "audio-convert" || j.InputFormat != "wav" || j.InputName != "audio" || j.State != "queued" {
		t.Fatalf("Auftrag = %+v", j)
	}
	if len(res) != 1 || res[0].Level != nil || res[0].MIME != "audio/mpeg" || res[0].DownloadName != "audio.mp3" {
		t.Fatalf("Ergebnisse = %+v", res)
	}
}

func TestFinalizeAudioRejectsImageTarget(t *testing.T) {
	e := newEnv(t, defaultLimits())
	sess := e.session(t)
	r, _ := e.svc.Admit(e.ctx, sess)
	e.spool(t, r, []byte("x"))
	if _, err := e.svc.Finalize(e.ctx, sess, r, audioUpload([]byte("x"), "wav", "png"), ""); err == nil {
		t.Fatal("Bildformat als Audioziel akzeptiert")
	}
	if b, n := e.reserved(t); b != 0 || n != 0 {
		t.Fatalf("Budget %d, Reservierungen %d", b, n)
	}
}
