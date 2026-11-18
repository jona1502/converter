package converter

import (
	"encoding/json"
	"errors"

	"miconverter/server/internal/apitypes"
)

// isPDFImage: options.tool ist pdf-to-image (Optionen sind bereits geprüft).
func (r Request) isPDFImage() bool {
	var head struct {
		Tool string `json:"tool"`
	}
	return json.Unmarshal(r.Options, &head) == nil && head.Tool == "pdf-to-image"
}

// ValidatePdfImageDetails prüft details des einzigen pdf-to-image-Ergebnisses:
// gerenderte Seiten bis zur Seitengrenze, nie mehr als das Dokument hat.
func ValidatePdfImageDetails(raw []byte, limits Limits) (json.RawMessage, error) {
	if len(raw) > MaxDetailsBytes {
		return nil, detailsErr(errors.New("zu groß"))
	}
	o, err := parseObject(raw, []string{"pageCount", "sourcePageCount", "archive"}, nil)
	if err != nil {
		return nil, detailsErr(err)
	}
	var d apitypes.PdfImageDetails
	if d.PageCount, err = o.integer("pageCount", 1, limits.PdfRenderMaxPages); err != nil {
		return nil, detailsErr(err)
	}
	if d.SourcePageCount, err = o.integer("sourcePageCount", d.PageCount, maxJSONInt); err != nil {
		return nil, detailsErr(err)
	}
	if d.Archive, err = o.boolean("archive"); err != nil {
		return nil, detailsErr(err)
	}
	return json.Marshal(d)
}

// PdfImageReport ist durch eine echte PDFium-Rundreise bestätigt. Fehlt der
// Abschnitt (älterer Bericht), gilt das Werkzeug als nicht verfügbar.
type PdfImageReport struct {
	Available bool `json:"available"`
}

func decodePdfImage(o object) (PdfImageReport, error) {
	raw, present := o["pdfImage"]
	if !present {
		return PdfImageReport{}, nil
	}
	m, err := parseObject(raw, []string{"available"}, nil)
	if err != nil {
		return PdfImageReport{}, err
	}
	available, err := m.boolean("available")
	return PdfImageReport{Available: available}, err
}
