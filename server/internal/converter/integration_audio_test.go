package converter

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"math"
	"os"
	"testing"
	"time"

	"miconverter/server/internal/jobs"
)

// toneWAV erzeugt ein PCM-16-WAV (Sinus 440 Hz) ohne externe Werkzeuge.
func toneWAV(rate, channels int, seconds float64) []byte {
	frames := int(float64(rate) * seconds)
	data := make([]byte, 0, frames*channels*2)
	for i := range frames {
		v := int16(12000 * math.Sin(2*math.Pi*440*float64(i)/float64(rate)))
		for range channels {
			data = binary.LittleEndian.AppendUint16(data, uint16(v))
		}
	}
	h := []byte("RIFF")
	h = binary.LittleEndian.AppendUint32(h, uint32(36+len(data)))
	h = append(h, "WAVEfmt "...)
	h = binary.LittleEndian.AppendUint32(h, 16)
	h = binary.LittleEndian.AppendUint16(h, 1)
	h = binary.LittleEndian.AppendUint16(h, uint16(channels))
	h = binary.LittleEndian.AppendUint32(h, uint32(rate))
	h = binary.LittleEndian.AppendUint32(h, uint32(rate*channels*2))
	h = binary.LittleEndian.AppendUint16(h, uint16(channels*2))
	h = binary.LittleEndian.AppendUint16(h, 16)
	h = append(h, "data"...)
	h = binary.LittleEndian.AppendUint32(h, uint32(len(data)))
	return append(h, data...)
}

func runAudio(t *testing.T, r *Runner, source []byte, options string, limits func(*Limits)) (string, json.RawMessage, []byte) {
	t.Helper()
	req := requestFor(t)
	req.Options = json.RawMessage(options)
	req.Timeout = 60 * time.Second
	req.OutputLimit = req.Limits.AudioMaxOutputBytes
	if limits != nil {
		limits(&req.Limits)
	}
	if err := os.WriteFile(req.Source, source, 0600); err != nil {
		t.Fatal(err)
	}
	var code string
	var details json.RawMessage
	out, err := r.Run(context.Background(), req, func(event Event) error {
		switch event.Kind {
		case KindResult:
			details = event.Details
		case KindError:
			code = event.Code
		}
		return nil
	})
	if err != nil || out.ErrorCode != "" {
		t.Fatalf("out=%+v err=%v", out, err)
	}
	data, err := os.ReadFile(req.Results[0].Path)
	if err != nil {
		t.Fatal(err)
	}
	return code, details, data
}

func TestRealPythonAudioPipeline(t *testing.T) {
	r := realRunner(t)
	report, err := r.Probe(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if in, out := report.AudioFormats(); len(in) != 4 || len(out) != 4 {
		t.Fatalf("Probe-Audioformate %v %v", in, out)
	}
	wav := toneWAV(44100, 2, 0.5)
	var mp3 []byte
	for _, format := range []string{"mp3", "flac", "ogg", "wav"} {
		t.Run(format, func(t *testing.T) {
			code, details, data := runAudio(t, r, wav, `{"tool":"audio-convert","format":"`+format+`","quality":0.8,"channels":"mono"}`, nil)
			if code != "" || jobs.DetectAudioFormat(data[:min(len(data), jobs.SniffBytes)]) != format {
				t.Fatalf("code=%q Format=%q", code, jobs.DetectAudioFormat(data))
			}
			var d struct {
				Format          string  `json:"format"`
				DurationSeconds float64 `json:"durationSeconds"`
				SampleRate      int     `json:"sampleRate"`
				Channels        int     `json:"channels"`
			}
			if err := json.Unmarshal(details, &d); err != nil || d.Format != format || d.SampleRate != 44100 ||
				d.Channels != 1 || math.Abs(d.DurationSeconds-0.5) > 0.06 {
				t.Fatalf("details=%s", details)
			}
			if format == "mp3" {
				mp3 = data
			}
		})
	}
	t.Run("mp3-zu-wav", func(t *testing.T) {
		if mp3 == nil {
			t.Skip("MP3-Fall fehlgeschlagen")
		}
		code, details, data := runAudio(t, r, mp3, `{"tool":"audio-convert","format":"wav"}`, nil)
		if code != "" || jobs.DetectAudioFormat(data) != "wav" {
			t.Fatalf("code=%q details=%s", code, details)
		}
	})
	t.Run("dauergrenze", func(t *testing.T) {
		long := toneWAV(8000, 1, 2.5)
		code, _, data := runAudio(t, r, long, `{"tool":"audio-convert","format":"flac"}`, func(l *Limits) { l.AudioMaxDurationSeconds = 2 })
		if code != "duration-too-long" || len(data) != 0 {
			t.Fatalf("code=%q bytes=%d", code, len(data))
		}
	})
	t.Run("kaputt", func(t *testing.T) {
		code, _, _ := runAudio(t, r, []byte("RIFF$\x00\x00\x00WAVEjunkjunkjunk"), `{"tool":"audio-convert","format":"mp3"}`, nil)
		if code != "decode-failed" {
			t.Fatalf("code=%q", code)
		}
	})
}
