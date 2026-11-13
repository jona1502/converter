package endpoints

import (
	"encoding/json"
	"path/filepath"
	"slices"
	"testing"
	"time"

	"miconverter/server/internal/contracttest"
	"miconverter/server/internal/converter"
)

func TestCapabilitiesReportAudio(t *testing.T) {
	f := fixture(t)
	report := converter.Report{SchemaVersion: converter.ReportSchemaVersion, ProtocolVersion: converter.ProtocolVersion,
		GeneratedAt: time.Now().UTC(), InputFormats: converter.RequiredInputFormats, OutputFormats: converter.RequiredOutputFormats,
		PDF: true, Audio: converter.AudioReport{InputFormats: []string{"ogg", "flac", "wav", "mp3"}, OutputFormats: converter.RequiredAudioFormats},
		Versions: converter.Versions{Python: "3.13.17", Pillow: "13.0.0", Pikepdf: "10.17.0", Qpdf: "12.4.2",
			Soundfile: "0.14.0", Libsndfile: "1.2.2", Numpy: "2.5.4"}}
	if err := converter.WriteReport(filepath.Join(f.api.cfg.StorageDir, converter.ReportFile), report); err != nil {
		t.Fatal(err)
	}
	response := f.request("GET", "/capabilities", nil, "")
	if response.Code != 200 {
		t.Fatalf("%d %s", response.Code, response.Body.String())
	}
	var caps struct {
		Tools []string        `json:"tools"`
		Audio json.RawMessage `json:"audio"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &caps); err != nil {
		t.Fatal(err)
	}
	if !slices.Contains(caps.Tools, "audio-convert") {
		t.Fatalf("tools = %v", caps.Tools)
	}
	if err := contracttest.MustLoad(t).ValidateComponent("AudioCapabilities", caps.Audio); err != nil {
		t.Fatalf("audio: %v (%s)", err, caps.Audio)
	}
	want := `{"inputFormats":["mp3","wav","flac","ogg"],"outputFormats":["mp3","wav","flac","ogg"],` +
		`"qualityFormats":["mp3","ogg"],"defaultQuality":0.8,"maxFileBytes":104857600,"maxDurationSeconds":1800,` +
		`"maxChannels":8,"maxSampleRate":192000,"maxOutputBytes":419430400}`
	if string(caps.Audio) != want {
		t.Fatalf("audio:\n%s\n%s", caps.Audio, want)
	}
}
