package jobs

import (
	"encoding/json"
	"errors"
	"strconv"

	"miconverter/server/internal/pagerange"
)

// ZIPMIME ist der Medientyp mehrteiliger pdf-split-Ergebnisse.
const ZIPMIME = "application/zip"

// splitOptions ist der für die Benennung relevante Teil der kanonischen
// pdf-split-Optionen (bereits von der API geprüft).
type splitOptions struct {
	Mode   string `json:"mode"`
	Ranges string `json:"ranges"`
}

// splitResultRow beschreibt das einzige Ergebnis von pdf-split: genau ein
// Bereich ergibt eine PDF "<name>-seite-5.pdf" bzw. "<name>-seiten-2-4.pdf"
// ("-ende" bei offenem Bereich), alles andere ein ZIP "<name>-geteilt.zip".
// Die Entscheidung folgt allein aus den Optionen und deckt sich mit dem
// Konverter (options.single_pdf).
func splitResultRow(originalName string, options json.RawMessage) (resultRow, error) {
	var opts splitOptions
	if err := json.Unmarshal(options, &opts); err != nil {
		return resultRow{}, err
	}
	base := CleanBase(originalName, PDFFallbackBase)
	switch opts.Mode {
	case "each":
		return resultRow{mime: ZIPMIME, name: base + "-geteilt.zip"}, nil
	case "ranges":
		ranges, err := pagerange.Parse(opts.Ranges)
		if err != nil {
			return resultRow{}, err
		}
		if len(ranges) != 1 {
			return resultRow{mime: ZIPMIME, name: base + "-geteilt.zip"}, nil
		}
		r := ranges[0]
		suffix := "seite-" + strconv.Itoa(r.Start)
		switch {
		case r.Open():
			suffix = "seiten-" + strconv.Itoa(r.Start) + "-ende"
		case r.End != r.Start:
			suffix = "seiten-" + strconv.Itoa(r.Start) + "-" + strconv.Itoa(r.End)
		}
		return resultRow{mime: PDFMIME, name: base + "-" + suffix + ".pdf"}, nil
	}
	return resultRow{}, errors.New("jobs: unbekannter pdf-split-Modus")
}
