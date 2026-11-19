package endpoints

import (
	"slices"

	"miconverter/server/internal/apitypes"
	"miconverter/server/internal/jobs"
	"miconverter/server/internal/pagerange"
)

// parseSplitOptions prüft pdf-split streng: mode "each" erlaubt kein ranges,
// mode "ranges" verlangt eine fehlerfreie Angabe (siehe Paket pagerange). Die
// Angabe wird unverändert kanonisiert; Seitenzahlgrenzen prüft erst der
// Konverter, weil nur er das Dokument kennt.
func parseSplitOptions(split *apitypes.SplitOptions) (options, error) {
	if !slices.Contains(apitypes.SplitModes(), split.Mode) {
		return options{}, invalidOptions()
	}
	canonical := map[string]any{"tool": "pdf-split", "mode": string(split.Mode)}
	switch split.Mode {
	case apitypes.SplitModeEach:
		if split.Ranges.Set() {
			return options{}, invalidOptions()
		}
	case apitypes.SplitModeRanges:
		spec, ok := split.Ranges.Value()
		if !ok {
			return options{}, invalidOptions()
		}
		if _, err := pagerange.Parse(spec); err != nil {
			return options{}, invalidOptions()
		}
		canonical["ranges"] = spec
	}
	raw, err := jobs.CanonicalJSON(canonical)
	return options{tool: "pdf-split", canonical: raw, format: "pdf"}, err
}
