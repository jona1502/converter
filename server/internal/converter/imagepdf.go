package converter

import (
	"encoding/json"

	"miconverter/server/internal/apitypes"
)

// isImagePdf: options.tool ist image-pdf (Optionen sind bereits geprüft).
func (r Request) isImagePdf() bool {
	var head struct {
		Tool string `json:"tool"`
	}
	return json.Unmarshal(r.Options, &head) == nil && head.Tool == "image-pdf"
}

// ValidateImagePdfDetails akzeptiert nur eine begrenzte Seitenzahl; mehr
// Seiten als Bilder im Bündel kann es nie geben.
func ValidateImagePdfDetails(raw json.RawMessage, limits Limits) (json.RawMessage, error) {
	o, err := parseObject(raw, []string{"pageCount"}, nil)
	if err != nil {
		return nil, detailsErr(err)
	}
	pages, err := o.integer("pageCount", 1, limits.ImagePdfMaxImages)
	if err != nil {
		return nil, detailsErr(err)
	}
	return json.Marshal(apitypes.ImagePdfDetails{PageCount: pages})
}
