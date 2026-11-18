package converter

import (
	"encoding/json"

	"miconverter/server/internal/apitypes"
)

// maxRotatePages begrenzt pageCount defensiv; die PDF-Größe begrenzt Seiten real viel früher.
const maxRotatePages = 1 << 24

// isRotate: options.tool ist pdf-rotate (Optionen sind bereits geprüft).
func (r Request) isRotate() bool {
	var head struct {
		Tool string `json:"tool"`
	}
	return json.Unmarshal(r.Options, &head) == nil && head.Tool == "pdf-rotate"
}

// ValidatePdfRotateDetails akzeptiert nur pageCount und rotatedPages
// (1 <= rotatedPages <= pageCount) und kodiert sie neu.
func ValidatePdfRotateDetails(raw json.RawMessage) (json.RawMessage, error) {
	o, err := parseObject(raw, []string{"pageCount", "rotatedPages"}, nil)
	if err != nil {
		return nil, detailsErr(err)
	}
	pages, err := o.integer("pageCount", 1, maxRotatePages)
	if err != nil {
		return nil, detailsErr(err)
	}
	rotated, err := o.integer("rotatedPages", 1, pages)
	if err != nil {
		return nil, detailsErr(err)
	}
	return json.Marshal(apitypes.PdfRotateDetails{PageCount: pages, RotatedPages: rotated})
}
