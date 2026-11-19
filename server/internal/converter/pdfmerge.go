package converter

import (
	"encoding/json"

	"miconverter/server/internal/apitypes"
)

// isPdfMerge: options.tool ist pdf-merge (Optionen sind bereits geprüft).
func (r Request) isPdfMerge() bool {
	var head struct {
		Tool string `json:"tool"`
	}
	return json.Unmarshal(r.Options, &head) == nil && head.Tool == "pdf-merge"
}

// ValidatePdfMergeDetails akzeptiert nur Seiten- und Quellenzahl in den
// vertraglichen Grenzen. Zusätzliche Felder aus dem Kindprozess werden nicht
// durchgereicht.
func ValidatePdfMergeDetails(raw json.RawMessage) (json.RawMessage, error) {
	o, err := parseObject(raw, []string{"pageCount", "sourceCount"}, nil)
	if err != nil {
		return nil, detailsErr(err)
	}
	pages, err := o.integer("pageCount", 1, apitypes.PdfMergeMaxPages)
	if err != nil {
		return nil, detailsErr(err)
	}
	sources, err := o.integer("sourceCount", apitypes.PdfMergeMinFiles, apitypes.PdfMergeMaxFiles)
	if err != nil {
		return nil, detailsErr(err)
	}
	return json.Marshal(apitypes.PdfMergeDetails{PageCount: pages, SourceCount: sources})
}
