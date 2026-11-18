package endpoints

import (
	"slices"

	"miconverter/server/internal/apitypes"
	"miconverter/server/internal/jobs"
)

// parseImagePdfOptions prüft image-pdf und liefert das kanonische JSON mit
// Standardwerten (A4, automatische Ausrichtung, kleiner Rand). Bei pageSize
// fit bestimmt das Bild die Seitenform, daher ist nur orientation auto
// zulässig; ein Widerspruch wird abgelehnt statt still ignoriert.
func parseImagePdfOptions(o *apitypes.ImagePdfOptions) (options, error) {
	pageSize := o.PageSize.Or(apitypes.ImagePdfPageA4)
	orientation := o.Orientation.Or(apitypes.ImagePdfOrientationAuto)
	margin := o.Margin.Or(apitypes.ImagePdfMarginSmall)
	if !slices.Contains(apitypes.ImagePdfPageSizes(), pageSize) ||
		!slices.Contains(apitypes.ImagePdfOrientations(), orientation) ||
		!slices.Contains(apitypes.ImagePdfMargins(), margin) ||
		(pageSize == apitypes.ImagePdfPageFit && orientation != apitypes.ImagePdfOrientationAuto) {
		return options{}, invalidOptions()
	}
	canonical, err := jobs.CanonicalJSON(map[string]any{
		"tool": "image-pdf", "pageSize": string(pageSize),
		"orientation": string(orientation), "margin": string(margin),
	})
	return options{tool: "image-pdf", canonical: canonical, format: "pdf"}, err
}
