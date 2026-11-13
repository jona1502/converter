package contracttest

import (
	"encoding/json"
	"reflect"
	"slices"
	"strings"
	"testing"
	"time"

	"miconverter/server/internal/apitypes"
	"miconverter/server/internal/validation"
)

func TestEveryComponentHasGoType(t *testing.T) {
	spec := MustLoad(t)
	ts := APITypes()
	names := spec.ComponentNames()
	slices.Sort(names)
	for _, name := range names {
		if _, ok := ts.Registered(name); !ok {
			t.Errorf("Komponente %s hat keinen Go-Typ in APITypes", name)
		}
	}
}

func TestDTOsMatchContract(t *testing.T) {
	spec := MustLoad(t)
	ts := APITypes()
	names := spec.ComponentNames()
	slices.Sort(names)
	for _, name := range names {
		t.Run(name, func(t *testing.T) {
			for _, p := range spec.CheckComponent(ts, name) {
				t.Error(p)
			}
		})
	}
}

// Der Abgleich muss Abweichungen tatsächlich erkennen.
func TestCheckDetectsDrift(t *testing.T) {
	spec := MustLoad(t)

	type missingField struct {
		Path string `json:"path"`
	}
	type extraField struct {
		Path  string `json:"path"`
		Code  string `json:"code"`
		Value string `json:"value"`
	}
	type wrongType struct {
		Path string `json:"path"`
		Code int    `json:"code"`
	}
	type optionalButRequired struct {
		Path string `json:"path"`
		Code string `json:"code,omitempty"`
	}
	type notNullable struct {
		Name   string               `json:"name"`
		Size   int64                `json:"size"`
		Format apitypes.InputFormat `json:"format"`
		Width  int                  `json:"width"`
		Height *int                 `json:"height"`
	}
	cases := map[string]struct {
		component string
		typ       reflect.Type
		want      string
	}{
		"fehlendes Feld":   {"FieldError", reflect.TypeFor[missingField](), "Feld fehlt"},
		"zusätzliches":     {"FieldError", reflect.TypeFor[extraField](), "fehlt im Vertrag"},
		"falscher Typ":     {"FieldError", reflect.TypeFor[wrongType](), "string erwartet"},
		"Pflicht/optional": {"FieldError", reflect.TypeFor[optionalButRequired](), "Pflichtfeld"},
		"Nullbarkeit":      {"JobInput", reflect.TypeFor[notNullable](), "nullable"},
	}
	for name, tc := range cases {
		ts := APITypes()
		ts.Component(tc.component, tc.typ)
		ts.byName[tc.component] = tc.typ
		problems := strings.Join(spec.CheckComponent(ts, tc.component), "; ")
		if !strings.Contains(problems, tc.want) {
			t.Errorf("%s: erwartet %q, erhalten %q", name, tc.want, problems)
		}
	}

	// Enum-Abweichung
	ts := APITypes()
	type shortTool string
	Enum(ts, "Tool", []shortTool{"image-convert"})
	if p := spec.CheckComponent(ts, "Tool"); len(p) == 0 {
		t.Error("abweichende Enum-Werte nicht erkannt")
	}
}

func mustJSON(t *testing.T, v any) []byte {
	t.Helper()
	data, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return data
}

func sampleJob() apitypes.JobView {
	now := apitypes.NewTimestamp(time.Date(2026, 10, 24, 12, 0, 0, 0, time.UTC))
	level := apitypes.LevelHigh
	size := int64(1000)
	url := "/api/v1/jobs/6f0c1d5e-8a3b-4c2d-9e1f-0a1b2c3d4e5f/results/7f0c1d5e-8a3b-4c2d-9e1f-0a1b2c3d4e5f"
	phase := apitypes.PhaseVariant
	details, _ := apitypes.ObjectOf(map[string]any{"originalSize": 1234567, "notes": []string{}})
	return apitypes.JobView{
		ID:        "6f0c1d5e-8a3b-4c2d-9e1f-0a1b2c3d4e5f",
		Tool:      apitypes.ToolPDFCompress,
		State:     apitypes.JobRunning,
		Phase:     &phase,
		CreatedAt: now, UpdatedAt: now, ExpiresAt: now,
		Input: apitypes.JobInput{Name: "Bericht.pdf", Size: 1234567, Format: apitypes.InputPDF},
		Results: []apitypes.JobResultView{
			{ID: "7f0c1d5e-8a3b-4c2d-9e1f-0a1b2c3d4e5f", Level: &level, State: apitypes.ResultSucceeded,
				Size: &size, Mime: "application/pdf", DownloadName: "Bericht-high.pdf", DownloadURL: &url, Details: details},
			{ID: "8f0c1d5e-8a3b-4c2d-9e1f-0a1b2c3d4e5f", State: apitypes.ResultFailed, Mime: "application/pdf",
				DownloadName: "Bericht-small.pdf", Error: &apitypes.JobError{Code: apitypes.JobErrorCode(apitypes.ProcResultTooLarge)}},
		},
	}
}

func TestSerializedDTOsValidate(t *testing.T) {
	spec := MustLoad(t)
	job := sampleJob()
	data := mustJSON(t, job)
	if err := spec.ValidateComponent("JobView", data); err != nil {
		t.Fatalf("JobView: %v\n%s", err, data)
	}
	// null-Felder werden ausdrücklich serialisiert, Zeitstempel in UTC mit "Z".
	for _, want := range []string{`"progress":null`, `"analysis":null`, `"error":null`, `"width":null`, `"createdAt":"2026-10-24T12:00:00.000Z"`} {
		if !strings.Contains(string(data), want) {
			t.Errorf("JobView ohne %s: %s", want, data)
		}
	}
	// results ist nie null.
	empty := mustJSON(t, apitypes.JobView{ID: job.ID, Tool: apitypes.ToolImageConvert, State: apitypes.JobQueued, Input: apitypes.JobInput{Format: apitypes.InputPNG}})
	if err := spec.ValidateComponent("JobView", empty); err != nil {
		t.Fatalf("leerer JobView: %v", err)
	}

	cancel := mustJSON(t, apitypes.CancelResponse{Cancellation: apitypes.CancellationRequested, Job: job})
	schema, err := spec.ResponseSchema("/api/v1/jobs/{job_id}/cancel", "POST", 200)
	if err != nil {
		t.Fatal(err)
	}
	if err := spec.Validate(schema, cancel); err != nil {
		t.Fatalf("Cancel: %v", err)
	}

	session := mustJSON(t, apitypes.SessionResponse{CsrfToken: "x", ExpiresAt: job.CreatedAt, Created: true})
	if err := spec.ValidateComponent("SessionResponse", session); err != nil {
		t.Fatalf("Session: %v", err)
	}

	caps := mustJSON(t, apitypes.Capabilities{APIVersion: "1", Tools: apitypes.Tools()})
	schema, err = spec.ResponseSchema("/api/v1/capabilities", "GET", 200)
	if err != nil {
		t.Fatal(err)
	}
	if err := spec.Validate(schema, caps); err != nil {
		t.Fatalf("Capabilities: %v", err)
	}
}

func TestOptionsRoundTripValidates(t *testing.T) {
	spec := MustLoad(t)
	for _, in := range []string{
		`{"tool":"image-convert","format":"webp","quality":0,"resize":{"mode":"percent","percent":50,"allowUpscale":false},"icoSizes":null}`,
		`{"tool":"image-resize","format":"png","resize":{"mode":"dimensions","width":10,"keepAspectRatio":true,"allowUpscale":true}}`,
		`{"tool":"image-compress","format":"jpeg","background":"#00ff00","resize":{"mode":"maxEdge","maxEdge":100}}`,
		`{"tool":"pdf-compress","levels":["small","high"]}`,
		`{"tool":"pdf-compress"}`,
		`{"tool":"audio-convert","format":"mp3","quality":0.5,"channels":"mono"}`,
		`{"tool":"audio-convert","format":"flac"}`,
	} {
		var o apitypes.JobOptions
		if err := validation.DecodeStrictBytes([]byte(in), validation.Limits{MaxBytes: 8192}, "options", &o); err != nil {
			t.Fatalf("%s: %v", in, err)
		}
		out := mustJSON(t, o)
		if err := spec.ValidateComponent("JobOptions", out); err != nil {
			t.Errorf("%s → %s: %v", in, out, err)
		}
		if string(out) != in {
			t.Errorf("Rundreise verändert Optionen:\n%s\n%s", in, out)
		}
	}
}

func TestValidatorRejectsViolations(t *testing.T) {
	spec := MustLoad(t)
	cases := map[string]struct{ component, data string }{
		"fehlendes Pflichtfeld":   {"ErrorResponse", `{"error":{"code":"not-found","message":"x"}}`},
		"unbekanntes Feld":        {"ErrorResponse", `{"error":{"code":"not-found","message":"x"},"requestId":"a","x":1}`},
		"falscher Enum":           {"ErrorResponse", `{"error":{"code":"nope","message":"x"},"requestId":"a"}`},
		"integer statt Zahl":      {"ErrorDetail", `{"code":"server-busy","message":"x","retryAfterSeconds":1.5}`},
		"null nicht erlaubt":      {"JobInput", `{"name":null,"size":1,"format":"png","width":null,"height":null}`},
		"keine UUID":              {"JobResultView", `{"id":"x","level":null,"state":"pending","size":null,"mime":"a","downloadName":"a","downloadUrl":null,"details":null,"error":null}`},
		"pattern":                 {"ImageOptions", `{"tool":"image-convert","format":"png","background":"red"}`},
		"maximum":                 {"ImageOptions", `{"tool":"image-convert","format":"png","quality":1.5}`},
		"exclusiveMinimum":        {"ResizeMaxEdge", `{"mode":"maxEdge","maxEdge":0}`},
		"minItems":                {"PdfOptions", `{"tool":"pdf-compress","levels":[]}`},
		"oneOf ohne Treffer":      {"JobOptions", `{"tool":"video"}`},
		"Audioformat":             {"AudioOptions", `{"tool":"audio-convert","format":"m4a"}`},
		"Audiokanäle":             {"AudioOptions", `{"tool":"audio-convert","format":"mp3","channels":"stereo"}`},
		"Audio ohne Bildfelder":   {"AudioOptions", `{"tool":"audio-convert","format":"mp3","resize":{"mode":"none"}}`},
		"const":                   {"LiveResponse", `{"status":"nein"}`},
		"additionalProperties":    {"ReadyResponse", `{"status":"ok","checks":{"db":"vielleicht"}}`},
		"ready status":            {"ReadyResponse", `{"status":"kaputt","checks":{}}`},
		"Array-Element falsch":    {"ImageOptions", `{"tool":"image-convert","format":"ico","icoSizes":[17]}`},
		"Objekt statt null/Liste": {"ErrorDetail", `{"code":"invalid-request","message":"x","fields":{}}`},
	}
	for name, tc := range cases {
		if err := spec.ValidateComponent(tc.component, []byte(tc.data)); err == nil {
			t.Errorf("%s: Verstoß nicht erkannt", name)
		}
	}
	if err := spec.ValidateComponent("ErrorResponse", []byte(`{"error":{"code":"not-found","message":"x"},"requestId":"a"}`)); err != nil {
		t.Errorf("gültige Antwort abgelehnt: %v", err)
	}
	if err := spec.Validate(Schema{"type": "string", "unbekannt": true}, []byte(`"x"`)); err == nil {
		t.Error("unbekanntes Schlüsselwort muss scheitern")
	}
}
