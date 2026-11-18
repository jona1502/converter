package apitypes

import (
	"encoding/json"
	"errors"

	"miconverter/server/internal/validation"
)

// Auftragsoptionen (Vertrag §4, Multipart-Teil "options").
//
// Diese Typen bilden nur die Struktur ab; validation.DecodeStrict lehnt
// unbekannte Felder, falsche Typen und null bei `strict:"notnull"` ab.
// Wertebereiche und Kombinationsregeln (quality 0..1, ICO nur mit resize
// none, keine Duplikate …) prüft die fachliche Validierung danach.

type ImageOptions struct {
	Tool       Tool                               `json:"tool"`
	Format     ImageFormatOption                  `json:"format"`
	Quality    validation.Optional[float64]       `json:"quality,omitzero" strict:"notnull"`
	Background validation.Optional[string]        `json:"background,omitzero" strict:"notnull"`
	Resize     validation.Optional[ResizeOptions] `json:"resize,omitzero" strict:"notnull"`
	IcoSizes   validation.Optional[[]int]         `json:"icoSizes,omitzero"`
}

type MarkdownOptions struct {
	Tool        Tool                                     `json:"tool"`
	PageSize    validation.Optional[MarkdownPageSize]    `json:"pageSize,omitzero" strict:"notnull"`
	Orientation validation.Optional[MarkdownOrientation] `json:"orientation,omitzero" strict:"notnull"`
}

type PdfOptions struct {
	Tool   Tool                            `json:"tool"`
	Levels validation.Optional[[]PdfLevel] `json:"levels,omitzero" strict:"notnull"`
}

type AudioOptions struct {
	Tool     Tool                               `json:"tool"`
	Format   AudioFormat                        `json:"format"`
	Quality  validation.Optional[float64]       `json:"quality,omitzero" strict:"notnull"`
	Channels validation.Optional[AudioChannels] `json:"channels,omitzero" strict:"notnull"`
}

// JobOptions: ImageOptions, PdfOptions, AudioOptions oder MarkdownOptions,
// unterschieden über "tool". Value ist ein Zeiger auf die jeweilige Variante.
type JobOptions struct {
	Value any
}

func (JobOptions) UnionDiscriminator() string { return "tool" }

func (JobOptions) UnionVariant(tag string) any {
	switch Tool(tag) {
	case ToolImageConvert, ToolImageCompress, ToolImageResize:
		return new(ImageOptions)
	case ToolMarkdownPDF:
		return new(MarkdownOptions)
	case ToolImagePDF:
		return new(ImagePdfOptions)
	case ToolPDFCompress:
		return new(PdfOptions)
	case ToolAudioConvert:
		return new(AudioOptions)
	case ToolPDFRotate:
		return new(PdfRotateOptions)
	case ToolPDFSplit:
		return new(SplitOptions)
	case ToolPDFMerge:
		return new(PdfMergeOptions)
	}
	return nil
}

func (o *JobOptions) UnmarshalJSON(data []byte) error {
	v, err := unmarshalUnion(data, *o)
	o.Value = v
	return err
}

func (o JobOptions) MarshalJSON() ([]byte, error) { return json.Marshal(o.Value) }

// Image liefert die Bildoptionen, falls gesetzt.
func (o JobOptions) Image() (*ImageOptions, bool) {
	v, ok := o.Value.(*ImageOptions)
	return v, ok
}

// Pdf liefert die PDF-Optionen, falls gesetzt.
func (o JobOptions) Pdf() (*PdfOptions, bool) {
	v, ok := o.Value.(*PdfOptions)
	return v, ok
}

// Audio liefert die Audiooptionen, falls gesetzt.
func (o JobOptions) Audio() (*AudioOptions, bool) {
	v, ok := o.Value.(*AudioOptions)
	return v, ok
}

// --- Resize ----------------------------------------------------------------

type ResizeMode string

const (
	ResizeModeNone       ResizeMode = "none"
	ResizeModePercent    ResizeMode = "percent"
	ResizeModeDimensions ResizeMode = "dimensions"
	ResizeModeMaxEdge    ResizeMode = "maxEdge"
)

type ResizeNone struct {
	Mode ResizeMode `json:"mode"`
}

type ResizePercent struct {
	Mode         ResizeMode `json:"mode"`
	Percent      float64    `json:"percent"`
	AllowUpscale bool       `json:"allowUpscale"`
}

type ResizeDimensions struct {
	Mode            ResizeMode               `json:"mode"`
	Width           validation.Optional[int] `json:"width,omitzero"`
	Height          validation.Optional[int] `json:"height,omitzero"`
	KeepAspectRatio bool                     `json:"keepAspectRatio"`
	AllowUpscale    bool                     `json:"allowUpscale"`
}

type ResizeMaxEdge struct {
	Mode    ResizeMode `json:"mode"`
	MaxEdge int        `json:"maxEdge"`
}

// ResizeOptions: eine der vier Varianten, unterschieden über "mode".
// Value ist *ResizeNone, *ResizePercent, *ResizeDimensions oder *ResizeMaxEdge.
type ResizeOptions struct {
	Value any
}

func (ResizeOptions) UnionDiscriminator() string { return "mode" }

func (ResizeOptions) UnionVariant(tag string) any {
	switch ResizeMode(tag) {
	case ResizeModeNone:
		return new(ResizeNone)
	case ResizeModePercent:
		return new(ResizePercent)
	case ResizeModeDimensions:
		return new(ResizeDimensions)
	case ResizeModeMaxEdge:
		return new(ResizeMaxEdge)
	}
	return nil
}

func (r *ResizeOptions) UnmarshalJSON(data []byte) error {
	v, err := unmarshalUnion(data, *r)
	r.Value = v
	return err
}

func (r ResizeOptions) MarshalJSON() ([]byte, error) { return json.Marshal(r.Value) }

// Mode liefert den Modus der gesetzten Variante.
func (r ResizeOptions) Mode() ResizeMode {
	switch v := r.Value.(type) {
	case *ResizeNone:
		return v.Mode
	case *ResizePercent:
		return v.Mode
	case *ResizeDimensions:
		return v.Mode
	case *ResizeMaxEdge:
		return v.Mode
	}
	return ""
}

var errUnionTag = errors.New("unbekannte Variante")

func unmarshalUnion(data []byte, u validation.Union) (any, error) {
	var head map[string]json.RawMessage
	if err := json.Unmarshal(data, &head); err != nil {
		return nil, err
	}
	var tag string
	if err := json.Unmarshal(head[u.UnionDiscriminator()], &tag); err != nil {
		return nil, errUnionTag
	}
	v := u.UnionVariant(tag)
	if v == nil {
		return nil, errUnionTag
	}
	if err := json.Unmarshal(data, v); err != nil {
		return nil, err
	}
	return v, nil
}
