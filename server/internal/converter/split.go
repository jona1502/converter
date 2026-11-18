package converter

import (
	"encoding/json"

	"miconverter/server/internal/apitypes"
	"miconverter/server/internal/pagerange"
)

// isSplit: options.tool ist pdf-split (Optionen sind bereits geprüft). Wie
// Markdown und Audio hat das Werkzeug genau ein Ergebnis ohne Level; mehrere
// Teile verpackt der Konverter selbst in ein ZIP.
func (r Request) isSplit() bool {
	var head struct {
		Tool string `json:"tool"`
	}
	return json.Unmarshal(r.Options, &head) == nil && head.Tool == "pdf-split"
}

// ValidateSplitDetails akzeptiert nur begrenzte Seiten- und Teilezahlen.
func ValidateSplitDetails(raw json.RawMessage) (json.RawMessage, error) {
	o, err := parseObject(raw, []string{"pageCount", "partCount"}, nil)
	if err != nil {
		return nil, detailsErr(err)
	}
	pages, err := o.integer("pageCount", 1, maxJSONInt)
	if err != nil {
		return nil, detailsErr(err)
	}
	parts, err := o.integer("partCount", 1, pagerange.MaxRanges)
	if err != nil {
		return nil, detailsErr(err)
	}
	return json.Marshal(apitypes.SplitDetails{PageCount: pages, PartCount: parts})
}
