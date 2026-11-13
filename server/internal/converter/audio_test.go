package converter

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"

	"miconverter/server/internal/config"
	"miconverter/server/internal/jobs"
)

func audioRequest(t *testing.T) Request {
	t.Helper()
	dir := t.TempDir()
	return Request{
		Source:      newTarget(t, dir, "input"),
		Options:     json.RawMessage(`{"channels":"original","format":"mp3","quality":0.8,"tool":"audio-convert"}`),
		Results:     []ResultTarget{{ID: idA, Path: newTarget(t, dir, "result")}},
		Limits:      DefaultLimits(),
		MemoryBytes: 1 << 30,
		Timeout:     300 * time.Second,
		OutputLimit: 419_430_400,
	}
}

func TestAudioRequestSendsAudioLimits(t *testing.T) {
	payload, err := audioRequest(t).encode()
	if err != nil {
		t.Fatal(err)
	}
	var wire struct {
		Limits  map[string]int64 `json:"limits"`
		Results []struct {
			Level *string `json:"level"`
		} `json:"results"`
	}
	if err := json.Unmarshal(payload, &wire); err != nil {
		t.Fatal(err)
	}
	want := map[string]int64{"audioMaxInputBytes": 104_857_600, "audioMaxDurationSeconds": 1800,
		"audioMaxChannels": 8, "audioMaxSampleRate": 192_000, "audioMaxOutputBytes": 419_430_400}
	for k, v := range want {
		if wire.Limits[k] != v {
			t.Errorf("%s = %d, erwartet %d", k, wire.Limits[k], v)
		}
	}
	if len(wire.Limits) != 12 || len(wire.Results) != 1 || wire.Results[0].Level != nil {
		t.Fatalf("Anfrage = %s", payload)
	}
}

func TestAudioRequestRejectsLevelsAndInvalidLimits(t *testing.T) {
	req := audioRequest(t)
	req.Results[0].Level = "high"
	if _, err := req.encode(); !errors.Is(err, ErrInvalidRequest) {
		t.Fatalf("Stufe bei Audio: %v", err)
	}
	req = audioRequest(t)
	req.Limits.AudioMaxChannels = 0
	if _, err := req.encode(); !errors.Is(err, ErrInvalidRequest) {
		t.Fatalf("Grenzwert 0: %v", err)
	}
	for _, code := range []string{"duration-too-long", "unsupported-audio"} {
		if !resultCodes[code] {
			t.Errorf("%s fehlt in resultCodes", code)
		}
	}
}

func TestAdapterPassesAudioLimitsToImageAndPDFRequests(t *testing.T) {
	processor := NewProcessor(nil, audioConfig())
	req, err := processor.request(jobs.Task{Tool: "image-convert", InputPath: "/data/input",
		Options: json.RawMessage(`{"tool":"image-convert","format":"png"}`),
		Results: []jobs.TaskResult{{ID: [16]byte{1}, Path: "/data/result"}}})
	if err != nil {
		t.Fatal(err)
	}
	if req.Limits.AudioMaxDurationSeconds != 1800 || req.Limits.AudioMaxOutputBytes != 419430400 {
		t.Fatalf("Grenzen = %+v", req.Limits)
	}
	if _, err := req.encode(); err != nil {
		t.Fatalf("Bildanfrage mit Audiogrenzen ungültig: %v", err)
	}
}

func audioConfig() *config.Config {
	return &config.Config{ImageMaxInputBytes: 52428800, ImageMaxPixels: 40000000, ImageMaxEdge: 16384,
		ImageMaxOutputBytes: 104857600, PdfMaxInputBytes: 100000000, PdfMaxResultsTotalBytes: 300000000,
		PdfImageMaxPixels: 40000000, ImageTimeout: 120 * time.Second, PdfTimeout: 300 * time.Second,
		AudioMaxInputBytes: 104857600, AudioMaxDurationSeconds: 1800, AudioMaxChannels: 8,
		AudioMaxSampleRate: 192000, AudioMaxOutputBytes: 419430400, AudioTimeout: 300 * time.Second}
}

func TestValidateAudioDetails(t *testing.T) {
	limits := DefaultLimits()
	ok := `{"format":"flac","durationSeconds":12.345,"sampleRate":48000,"channels":2,"qualityApplied":false}`
	got, err := ValidateAudioDetails([]byte(ok), limits)
	if err != nil || string(got) != ok {
		t.Fatalf("%s %v", got, err)
	}
	for name, raw := range map[string]string{
		"Format":         `{"format":"m4a","durationSeconds":1,"sampleRate":48000,"channels":2,"qualityApplied":false}`,
		"Dauer zu lang":  `{"format":"mp3","durationSeconds":1800.5,"sampleRate":48000,"channels":2,"qualityApplied":true}`,
		"Dauer negativ":  `{"format":"mp3","durationSeconds":-1,"sampleRate":48000,"channels":2,"qualityApplied":true}`,
		"Dauer als Text": `{"format":"mp3","durationSeconds":"1","sampleRate":48000,"channels":2,"qualityApplied":true}`,
		"Rate":           `{"format":"mp3","durationSeconds":1,"sampleRate":192001,"channels":2,"qualityApplied":true}`,
		"Rate gebrochen": `{"format":"mp3","durationSeconds":1,"sampleRate":44100.5,"channels":2,"qualityApplied":true}`,
		"Kanäle":         `{"format":"mp3","durationSeconds":1,"sampleRate":48000,"channels":0,"qualityApplied":true}`,
		"Zusatzfeld":     `{"format":"mp3","durationSeconds":1,"sampleRate":48000,"channels":2,"qualityApplied":true,"path":"/x"}`,
		"Feld fehlt":     `{"format":"mp3","durationSeconds":1,"sampleRate":48000,"channels":2}`,
		"null":           `{"format":"mp3","durationSeconds":null,"sampleRate":48000,"channels":2,"qualityApplied":true}`,
		"Bilddetails":    imageDetails,
	} {
		if _, err := ValidateAudioDetails([]byte(raw), limits); err == nil {
			t.Errorf("%s akzeptiert", name)
		}
	}
}

func TestRunnerValidatesAudioDetailsAndOutputLimit(t *testing.T) {
	var events []Event
	out, err := helperRunner("audio").Run(context.Background(), audioRequest(t), func(e Event) error { events = append(events, e); return nil })
	if err != nil || out.ErrorCode != "" || len(events) != 2 || events[1].Kind != KindResult ||
		string(events[1].Details) != `{"format":"mp3","durationSeconds":1.5,"sampleRate":44100,"channels":2,"qualityApplied":true}` {
		t.Fatalf("out=%+v err=%v events=%+v", out, err, events)
	}
	out, err = helperRunner("audio-bad").Run(context.Background(), audioRequest(t), func(Event) error { return nil })
	if err != nil || out.ErrorCode != CodeWorkerFailed {
		t.Fatalf("ungültige Details: out=%+v err=%v", out, err)
	}
	// Bilddetails sind für Audio ein Protokollverstoß.
	out, err = helperRunner("valid").Run(context.Background(), audioRequest(t), func(Event) error { return nil })
	if err != nil || out.ErrorCode != CodeWorkerFailed {
		t.Fatalf("Bilddetails bei Audio: out=%+v err=%v", out, err)
	}
	req := audioRequest(t)
	req.Limits.AudioMaxOutputBytes = 1024
	events = nil
	out, err = helperRunner("audio-large").Run(context.Background(), req, func(e Event) error { events = append(events, e); return nil })
	if err != nil || len(events) != 2 || events[1].Kind != KindError || events[1].Code != "result-too-large" {
		t.Fatalf("Ausgabegrenze: out=%+v err=%v events=%+v", out, err, events)
	}
}

func TestAdapterUsesAudioTimeoutAndOutputLimit(t *testing.T) {
	cfg := audioConfig()
	cfg.AudioTimeout = 299 * time.Second
	req, err := NewProcessor(nil, cfg).request(jobs.Task{Tool: "audio-convert", InputPath: "/data/input",
		Options: json.RawMessage(`{"channels":"mono","format":"wav","quality":0.8,"tool":"audio-convert"}`),
		Results: []jobs.TaskResult{{ID: [16]byte{1}, Path: "/data/result"}}})
	if err != nil {
		t.Fatal(err)
	}
	if req.Timeout != 299*time.Second || req.OutputLimit != 419430400 || !req.isAudio() || req.isPDF() {
		t.Fatalf("request=%+v", req)
	}
}
