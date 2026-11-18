package contracttest

import (
	"reflect"

	"miconverter/server/internal/apitypes"
)

// APITypes liefert die Zuordnung aller Vertragskomponenten zu den DTOs in
// internal/apitypes. Eine neue Komponente im Vertrag ohne Eintrag hier
// lässt TestEveryComponentHasGoType scheitern.
func APITypes() *Types {
	ts := NewTypes()

	Enum(ts, "ApiErrorCode", apitypes.ApiErrorCodes())
	Enum(ts, "ProcessingErrorCode", apitypes.ProcessingErrorCodes())
	Enum(ts, "Tool", apitypes.Tools())
	Enum(ts, "JobState", apitypes.JobStates())
	Enum(ts, "JobPhase", apitypes.JobPhases())
	Enum(ts, "ResultState", apitypes.ResultStates())
	Enum(ts, "PdfLevel", apitypes.PdfLevels())
	Enum(ts, "InputFormat", apitypes.InputFormats())
	// Inline-Enums ohne eigene Komponente.
	Enum(ts, "", apitypes.ImageFormatOptions())
	Enum(ts, "", apitypes.AudioFormats())
	Enum(ts, "", apitypes.AudioChannelModes())
	Enum(ts, "", apitypes.MarkdownPageSizes())
	Enum(ts, "", apitypes.MarkdownOrientations())
	Enum(ts, "", apitypes.SplitModes())
	Enum(ts, "", apitypes.ImagePdfPageSizes())
	Enum(ts, "", apitypes.ImagePdfOrientations())
	Enum(ts, "", apitypes.ImagePdfMargins())
	Enum(ts, "", apitypes.PdfImageFormats())
	Enum(ts, "", apitypes.CheckStatuses())
	Enum(ts, "", apitypes.ReadyStatuses())
	Enum(ts, "", []apitypes.ResizeMode{
		apitypes.ResizeModeNone, apitypes.ResizeModePercent,
		apitypes.ResizeModeDimensions, apitypes.ResizeModeMaxEdge,
	})

	// job.error.code / result.error.code: ProcessingErrorCode oder ApiErrorCode.
	jobErrorCode := reflect.TypeFor[apitypes.JobErrorCode]()
	ts.Alias("ProcessingErrorCode", jobErrorCode)
	ts.Alias("ApiErrorCode", jobErrorCode)

	ts.StringType(reflect.TypeFor[apitypes.Timestamp]())
	ts.ObjectType(reflect.TypeFor[apitypes.JSONObject]())

	for name, t := range map[string]reflect.Type{
		"ErrorResponse":        reflect.TypeFor[apitypes.ErrorResponse](),
		"ErrorDetail":          reflect.TypeFor[apitypes.ErrorDetail](),
		"FieldError":           reflect.TypeFor[apitypes.FieldError](),
		"LiveResponse":         reflect.TypeFor[apitypes.LiveResponse](),
		"ReadyResponse":        reflect.TypeFor[apitypes.ReadyResponse](),
		"SessionResponse":      reflect.TypeFor[apitypes.SessionResponse](),
		"JobView":              reflect.TypeFor[apitypes.JobView](),
		"JobInput":             reflect.TypeFor[apitypes.JobInput](),
		"JobResultView":        reflect.TypeFor[apitypes.JobResultView](),
		"JobError":             reflect.TypeFor[apitypes.JobError](),
		"JobOptions":           reflect.TypeFor[apitypes.JobOptions](),
		"ImageOptions":         reflect.TypeFor[apitypes.ImageOptions](),
		"PdfOptions":           reflect.TypeFor[apitypes.PdfOptions](),
		"MarkdownOptions":      reflect.TypeFor[apitypes.MarkdownOptions](),
		"MarkdownCapabilities": reflect.TypeFor[apitypes.MarkdownCapabilities](),
		"MarkdownDetails":      reflect.TypeFor[apitypes.MarkdownDetails](),
		"SplitOptions":         reflect.TypeFor[apitypes.SplitOptions](),
		"PdfSplitCapabilities": reflect.TypeFor[apitypes.PdfSplitCapabilities](),
		"SplitDetails":         reflect.TypeFor[apitypes.SplitDetails](),
		"PdfMergeOptions":      reflect.TypeFor[apitypes.PdfMergeOptions](),
		"PdfMergeCapabilities": reflect.TypeFor[apitypes.PdfMergeCapabilities](),
		"PdfMergeDetails":      reflect.TypeFor[apitypes.PdfMergeDetails](),
		"ImagePdfOptions":      reflect.TypeFor[apitypes.ImagePdfOptions](),
		"ImagePdfCapabilities": reflect.TypeFor[apitypes.ImagePdfCapabilities](),
		"ImagePdfDetails":      reflect.TypeFor[apitypes.ImagePdfDetails](),
		"PdfImageOptions":      reflect.TypeFor[apitypes.PdfImageOptions](),
		"AudioOptions":         reflect.TypeFor[apitypes.AudioOptions](),
		"PdfImageCapabilities": reflect.TypeFor[apitypes.PdfImageCapabilities](),
		"PdfImageDetails":      reflect.TypeFor[apitypes.PdfImageDetails](),
		"AudioCapabilities":    reflect.TypeFor[apitypes.AudioCapabilities](),
		"AudioDetails":         reflect.TypeFor[apitypes.AudioDetails](),
		"ResizeNone":           reflect.TypeFor[apitypes.ResizeNone](),
		"ResizePercent":        reflect.TypeFor[apitypes.ResizePercent](),
		"ResizeDimensions":     reflect.TypeFor[apitypes.ResizeDimensions](),
		"ResizeMaxEdge":        reflect.TypeFor[apitypes.ResizeMaxEdge](),
	} {
		ts.Component(name, t)
	}
	ts.Component("PdfRotateOptions", reflect.TypeFor[apitypes.PdfRotateOptions]())
	ts.Component("PdfRotateCapabilities", reflect.TypeFor[apitypes.RotateCapabilities]())
	ts.Component("PdfRotateDetails", reflect.TypeFor[apitypes.PdfRotateDetails]())
	// ResizeOptions ist im Vertrag keine eigene Komponente, sondern das
	// Inline-oneOf ImageOptions.resize; geprüft über compareType.
	return ts
}
