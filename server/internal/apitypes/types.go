package apitypes

import (
	"bytes"
	"encoding/json"
	"errors"
	"time"
)

// --- Hilfstypen --------------------------------------------------------------

// TimestampLayout: ISO 8601 in UTC mit Millisekunden und "Z" (wie Python
// isoformat(timespec="milliseconds")).
const TimestampLayout = "2006-01-02T15:04:05.000Z"

// Timestamp serialisiert immer in UTC nach TimestampLayout.
type Timestamp struct{ time.Time }

func NewTimestamp(t time.Time) Timestamp { return Timestamp{t} }

func (t Timestamp) MarshalJSON() ([]byte, error) {
	return json.Marshal(t.UTC().Format(TimestampLayout))
}

func (t *Timestamp) UnmarshalJSON(data []byte) error {
	var s string
	if err := json.Unmarshal(data, &s); err != nil {
		return err
	}
	parsed, err := time.Parse(time.RFC3339Nano, s)
	if err != nil {
		return errors.New("ungültiger Zeitstempel")
	}
	t.Time = parsed
	return nil
}

// JSONObject: freies JSON-Objekt oder null (OpenAPI: object mit
// additionalProperties: true | null), z. B. details, progress, analysis.
// Leer bzw. nil wird als null serialisiert.
type JSONObject json.RawMessage

func (o JSONObject) MarshalJSON() ([]byte, error) {
	trimmed := bytes.TrimSpace(o)
	if len(trimmed) == 0 {
		return []byte("null"), nil
	}
	if trimmed[0] != '{' && !bytes.Equal(trimmed, []byte("null")) {
		return nil, errors.New("JSONObject ist kein Objekt")
	}
	return json.RawMessage(o).MarshalJSON()
}

func (o *JSONObject) UnmarshalJSON(data []byte) error {
	if bytes.Equal(bytes.TrimSpace(data), []byte("null")) {
		*o = nil
		return nil
	}
	*o = append((*o)[:0], data...)
	return nil
}

// ObjectOf serialisiert v (Struktur oder Map) als JSONObject.
func ObjectOf(v any) (JSONObject, error) {
	data, err := json.Marshal(v)
	if err != nil {
		return nil, err
	}
	return JSONObject(data), nil
}

// --- Fehler (Vertrag §2) --------------------------------------------------

// FieldError: ein ungültiges Feld, nur Pfad und Fehlerart, nie der Wert.
type FieldError struct {
	Path string `json:"path"`
	Code string `json:"code"`
}

type ErrorDetail struct {
	Code    ApiErrorCode `json:"code"`
	Message string       `json:"message"`
	// Nur bei 429/503, zusätzlich als Retry-After-Header.
	RetryAfterSeconds *int `json:"retryAfterSeconds,omitempty"`
	// Nur bei Validierungsfehlern.
	Fields []FieldError `json:"fields,omitempty"`
}

type ErrorResponse struct {
	Error     ErrorDetail `json:"error"`
	RequestID string      `json:"requestId"`
}

// --- Health (Vertrag §4) ------------------------------------------------

type LiveResponse struct {
	Status string `json:"status"`
}

type ReadyResponse struct {
	Status ReadyStatus            `json:"status"`
	Checks map[string]CheckStatus `json:"checks"`
}

func (r ReadyResponse) MarshalJSON() ([]byte, error) {
	type plain ReadyResponse
	if r.Checks == nil {
		r.Checks = map[string]CheckStatus{}
	}
	return json.Marshal(plain(r))
}

// --- Sitzung (Vertrag §3) --------------------------------------------------

type SessionResponse struct {
	CsrfToken string    `json:"csrfToken"`
	ExpiresAt Timestamp `json:"expiresAt"`
	Created   bool      `json:"created"`
}

// --- Aufträge (Vertrag §5) -------------------------------------------------

// JobErrorCode: ProcessingErrorCode oder ApiErrorCode.
type JobErrorCode string

type JobError struct {
	Code JobErrorCode `json:"code"`
}

type JobInput struct {
	Name   string      `json:"name"`
	Size   int64       `json:"size"`
	Format InputFormat `json:"format"`
	// Abmessungen aus der Header-Probe; bei PDF immer null.
	Width  *int `json:"width"`
	Height *int `json:"height"`
}

type JobResultView struct {
	ID    string      `json:"id"`
	Level *PdfLevel   `json:"level"`
	State ResultState `json:"state"`
	Size  *int64      `json:"size"`
	Mime  string      `json:"mime"`
	// Bereinigter Anzeigename, nie ein Storagepfad.
	DownloadName string `json:"downloadName"`
	// Nur bei veröffentlichtem, nicht abgelaufenem Ergebnis.
	DownloadURL *string    `json:"downloadUrl"`
	Details     JSONObject `json:"details"`
	Error       *JobError  `json:"error"`
}

type JobView struct {
	ID              string          `json:"id"`
	Tool            Tool            `json:"tool"`
	State           JobState        `json:"state"`
	Phase           *JobPhase       `json:"phase"`
	CreatedAt       Timestamp       `json:"createdAt"`
	UpdatedAt       Timestamp       `json:"updatedAt"`
	ExpiresAt       Timestamp       `json:"expiresAt"`
	Input           JobInput        `json:"input"`
	Progress        JSONObject      `json:"progress"`
	Analysis        JSONObject      `json:"analysis"`
	Results         []JobResultView `json:"results"`
	Error           *JobError       `json:"error"`
	CancelRequested bool            `json:"cancelRequested"`
}

// MarshalJSON: results ist nie null.
func (j JobView) MarshalJSON() ([]byte, error) {
	type plain JobView
	if j.Results == nil {
		j.Results = []JobResultView{}
	}
	return json.Marshal(plain(j))
}

// CancelResponse: POST /jobs/{id}/cancel (im OpenAPI freies Objekt).
type CancelResponse struct {
	Cancellation Cancellation `json:"cancellation"`
	Job          JobView      `json:"job"`
}

// --- Capabilities (Vertrag §4, im OpenAPI freies Objekt) -------------------

type Capabilities struct {
	APIVersion string               `json:"apiVersion"`
	Tools      []Tool               `json:"tools"`
	Image      ImageCapabilities    `json:"image"`
	Pdf        PdfCapabilities      `json:"pdf"`
	Audio      AudioCapabilities    `json:"audio"`
	Jobs       JobCapabilities      `json:"jobs"`
	Markdown   MarkdownCapabilities `json:"markdown"`
	PdfRotate  RotateCapabilities   `json:"pdfRotate"`
	PdfSplit   PdfSplitCapabilities `json:"pdfSplit"`
	PdfMerge   PdfMergeCapabilities `json:"pdfMerge"`
	ImagePdf   ImagePdfCapabilities `json:"imagePdf"`
}

// AudioDetails: details eines audio-convert-Ergebnisses (OpenAPI-Komponente
// AudioDetails). channels ist die Kanalzahl des Ergebnisses.
type AudioDetails struct {
	Format          AudioFormat `json:"format"`
	DurationSeconds float64     `json:"durationSeconds"`
	SampleRate      int64       `json:"sampleRate"`
	Channels        int64       `json:"channels"`
	QualityApplied  bool        `json:"qualityApplied"`
}

// AudioCapabilities: capabilities.audio (OpenAPI-Komponente AudioCapabilities).
// Formatlisten aus der Probe, alle übrigen Werte aus der Konfiguration.
type AudioCapabilities struct {
	InputFormats       []AudioFormat `json:"inputFormats"`
	OutputFormats      []AudioFormat `json:"outputFormats"`
	QualityFormats     []AudioFormat `json:"qualityFormats"`
	DefaultQuality     float64       `json:"defaultQuality"`
	MaxFileBytes       int64         `json:"maxFileBytes"`
	MaxDurationSeconds int           `json:"maxDurationSeconds"`
	MaxChannels        int           `json:"maxChannels"`
	MaxSampleRate      int           `json:"maxSampleRate"`
	MaxOutputBytes     int64         `json:"maxOutputBytes"`
}

// MarshalJSON: Formatlisten sind nie null.
func (a AudioCapabilities) MarshalJSON() ([]byte, error) {
	type plain AudioCapabilities
	for _, list := range []*[]AudioFormat{&a.InputFormats, &a.OutputFormats, &a.QualityFormats} {
		if *list == nil {
			*list = []AudioFormat{}
		}
	}
	return json.Marshal(plain(a))
}

type ImageCapabilities struct {
	InputFormats    []InputFormat  `json:"inputFormats"`
	OutputFormats   []OutputFormat `json:"outputFormats"`
	QualityFormats  []OutputFormat `json:"qualityFormats"`
	IcoSizes        []int          `json:"icoSizes"`
	DefaultIcoSizes []int          `json:"defaultIcoSizes"`
	MaxFileBytes    int64          `json:"maxFileBytes"`
	MaxPixels       int64          `json:"maxPixels"`
	MaxEdge         int            `json:"maxEdge"`
	MaxOutputBytes  int64          `json:"maxOutputBytes"`
}

type PdfCapabilities struct {
	MaxFileBytes        int64                `json:"maxFileBytes"`
	MaxResultBytesTotal int64                `json:"maxResultBytesTotal"`
	MaxImagePixels      int64                `json:"maxImagePixels"`
	Levels              []PdfLevelCapability `json:"levels"`
}

type PdfLevelCapability struct {
	Level              PdfLevel `json:"level"`
	TargetDpi          int      `json:"targetDpi"`
	MaxImageEdge       int      `json:"maxImageEdge"`
	Quality            float64  `json:"quality"`
	MinDownscaleFactor float64  `json:"minDownscaleFactor"`
}

type JobCapabilities struct {
	TTLSeconds          int `json:"ttlSeconds"`
	MaxActivePerSession int `json:"maxActivePerSession"`
	MaxBatchFiles       int `json:"maxBatchFiles"`
	CreatePerMinute     int `json:"createPerMinute"`
}

// MarkdownCapabilities reports renderer availability and configured bounds.
type MarkdownCapabilities struct {
	Available      bool  `json:"available"`
	MaxFileBytes   int64 `json:"maxFileBytes"`
	MaxOutputBytes int64 `json:"maxOutputBytes"`
	MaxPages       int64 `json:"maxPages"`
}

// MarkdownDetails describes the single generated PDF.
type MarkdownDetails struct {
	PageCount int64 `json:"pageCount"`
}
