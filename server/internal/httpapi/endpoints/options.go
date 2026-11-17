package endpoints

import (
	"encoding/json"
	"math"
	"regexp"
	"slices"

	"miconverter/server/internal/apitypes"
	"miconverter/server/internal/httpapi"
	"miconverter/server/internal/jobs"
	"miconverter/server/internal/validation"
)

var backgroundPattern = regexp.MustCompile(`^#[0-9a-fA-F]{6}$`)
var idempotencyPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{16,128}$`)

type options struct {
	tool       string
	canonical  json.RawMessage
	format     string
	levels     []string
	resizeMode string
}

func invalidOptions() error {
	return httpapi.NewError(422, apitypes.CodeInvalidOptions, "Einstellungen sind ungültig.")
}

func parseOptions(raw []byte) (options, error) {
	var input apitypes.JobOptions
	if err := validation.DecodeStrictBytes(raw, validation.Limits{MaxBytes: 8192}, "options", &input); err != nil {
		return options{}, httpapi.InvalidRequest(err)
	}
	if markdown, ok := input.Value.(*apitypes.MarkdownOptions); ok {
		return parseMarkdownOptions(markdown)
	}
	if pdf, ok := input.Pdf(); ok {
		levels := pdf.Levels.Or([]apitypes.PdfLevel{"high", "balanced", "small"})
		if len(levels) == 0 || len(levels) > 3 {
			return options{}, invalidOptions()
		}
		names := make([]string, 0, len(levels))
		values := make([]any, 0, len(levels))
		for _, level := range levels {
			if !slices.Contains([]apitypes.PdfLevel{"high", "balanced", "small"}, level) || slices.Contains(names, string(level)) {
				return options{}, invalidOptions()
			}
			names = append(names, string(level))
			values = append(values, string(level))
		}
		canonical, err := jobs.CanonicalJSON(map[string]any{"tool": "pdf-compress", "levels": values})
		return options{tool: "pdf-compress", canonical: canonical, levels: names}, err
	}
	if audio, ok := input.Audio(); ok {
		return parseAudioOptions(audio)
	}
	image, ok := input.Image()
	if !ok {
		return options{}, invalidOptions()
	}
	target := string(image.Format)
	if !slices.Contains([]string{"jpeg", "png", "webp", "bmp", "ico", "original"}, target) {
		return options{}, invalidOptions()
	}
	quality := image.Quality.Or(.85)
	background := image.Background.Or("#ffffff")
	if math.IsNaN(quality) || math.IsInf(quality, 0) || quality < 0 || quality > 1 || !backgroundPattern.MatchString(background) {
		return options{}, invalidOptions()
	}
	resize := map[string]any{"mode": "none"}
	mode := "none"
	if value, present := image.Resize.Value(); present {
		switch v := value.Value.(type) {
		case *apitypes.ResizeNone:
		case *apitypes.ResizePercent:
			if math.IsNaN(v.Percent) || math.IsInf(v.Percent, 0) || v.Percent <= 0 || (v.Percent > 100 && !v.AllowUpscale) {
				return options{}, invalidOptions()
			}
			mode = "percent"
			resize = map[string]any{"mode": mode, "percent": v.Percent, "allowUpscale": v.AllowUpscale}
		case *apitypes.ResizeDimensions:
			width, wok := v.Width.Value()
			height, hok := v.Height.Value()
			if (wok && width <= 0) || (hok && height <= 0) || (v.KeepAspectRatio && !wok && !hok) || (!v.KeepAspectRatio && (!wok || !hok)) {
				return options{}, invalidOptions()
			}
			var w, h any
			if wok {
				w = width
			}
			if hok {
				h = height
			}
			mode = "dimensions"
			resize = map[string]any{"mode": mode, "width": w, "height": h, "keepAspectRatio": v.KeepAspectRatio, "allowUpscale": v.AllowUpscale}
		case *apitypes.ResizeMaxEdge:
			if v.MaxEdge <= 0 {
				return options{}, invalidOptions()
			}
			mode = "maxEdge"
			resize = map[string]any{"mode": mode, "maxEdge": v.MaxEdge}
		default:
			return options{}, invalidOptions()
		}
	}
	var ico any
	if sizes, present := image.IcoSizes.Value(); present {
		if (target != "ico" && target != "original") || len(sizes) == 0 || len(sizes) > 6 {
			return options{}, invalidOptions()
		}
		seen := map[int]bool{}
		values := make([]any, 0, len(sizes))
		for _, size := range sizes {
			if !slices.Contains([]int{16, 32, 48, 64, 128, 256}, size) || seen[size] {
				return options{}, invalidOptions()
			}
			seen[size] = true
			values = append(values, size)
		}
		ico = values
	}
	if target == "ico" && mode != "none" {
		return options{}, invalidOptions()
	}
	canonical, err := jobs.CanonicalJSON(map[string]any{"tool": string(image.Tool), "format": target, "quality": quality, "background": background, "resize": resize, "icoSizes": ico})
	return options{tool: string(image.Tool), canonical: canonical, format: target, resizeMode: mode}, err
}

// parseAudioOptions prüft audio-convert (Vertrag §4 „Optionen Audio“) und
// liefert das kanonische JSON mit Standardwerten. quality ist auch bei
// WAV/FLAC zulässig, wirkt dort aber nicht.
func parseAudioOptions(audio *apitypes.AudioOptions) (options, error) {
	target := string(audio.Format)
	if !slices.Contains(apitypes.AudioFormats(), audio.Format) {
		return options{}, invalidOptions()
	}
	quality := audio.Quality.Or(.8)
	channels := audio.Channels.Or(apitypes.ChannelsOriginal)
	if math.IsNaN(quality) || math.IsInf(quality, 0) || quality < 0 || quality > 1 ||
		!slices.Contains(apitypes.AudioChannelModes(), channels) {
		return options{}, invalidOptions()
	}
	canonical, err := jobs.CanonicalJSON(map[string]any{"tool": "audio-convert", "format": target, "quality": quality, "channels": string(channels)})
	return options{tool: "audio-convert", canonical: canonical, format: target}, err
}

// parseMarkdownOptions prüft markdown-pdf; Standard ist A4 im Hochformat.
func parseMarkdownOptions(markdown *apitypes.MarkdownOptions) (options, error) {
	pageSize := markdown.PageSize.Or(apitypes.PageSizeA4)
	orientation := markdown.Orientation.Or(apitypes.OrientationPortrait)
	if !slices.Contains(apitypes.MarkdownPageSizes(), pageSize) ||
		!slices.Contains(apitypes.MarkdownOrientations(), orientation) {
		return options{}, invalidOptions()
	}
	canonical, err := jobs.CanonicalJSON(map[string]any{"tool": "markdown-pdf", "pageSize": string(pageSize), "orientation": string(orientation)})
	return options{tool: "markdown-pdf", canonical: canonical, format: "pdf"}, err
}
