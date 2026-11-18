// Package apitypes enthält die JSON-Typen der API v1 (Vertrag: api/openapi.json).
//
// Regeln: Feldnamen in camelCase, nullable Felder als Zeiger (bzw.
// JSONObject), damit null ausdrücklich serialisiert wird. Optionale
// Anfragefelder nutzen validation.Optional, damit fehlend, null und Wert
// unterscheidbar bleiben. Die Vertragstests in internal/contracttest prüfen
// jede Struktur gegen das Schema.
package apitypes

// ApiErrorCode: stabile Fehlercodes in HTTP-Fehlerantworten.
type ApiErrorCode string

const (
	CodeInvalidRequest            ApiErrorCode = "invalid-request"
	CodeInvalidOptions            ApiErrorCode = "invalid-options"
	CodeMissingFile               ApiErrorCode = "missing-file"
	CodeUnsupportedType           ApiErrorCode = "unsupported-type"
	CodeNotPDF                    ApiErrorCode = "not-pdf"
	CodeFileTooLarge              ApiErrorCode = "file-too-large"
	CodeDimensionsTooLarge        ApiErrorCode = "dimensions-too-large"
	CodeAnimatedUnsupported       ApiErrorCode = "animated-unsupported"
	CodeOriginalFormatUnsupported ApiErrorCode = "original-format-unsupported"
	CodeInvalidIdempotencyKey     ApiErrorCode = "invalid-idempotency-key"
	CodeIdempotencyConflict       ApiErrorCode = "idempotency-conflict"
	CodeSessionRequired           ApiErrorCode = "session-required"
	CodeCSRFFailed                ApiErrorCode = "csrf-failed"
	CodeJobNotFound               ApiErrorCode = "job-not-found"
	CodeResultNotFound            ApiErrorCode = "result-not-found"
	CodeJobExpired                ApiErrorCode = "job-expired"
	CodeRateLimited               ApiErrorCode = "rate-limited"
	CodeSessionJobLimit           ApiErrorCode = "session-job-limit"
	CodeServerBusy                ApiErrorCode = "server-busy"
	CodeStorageFull               ApiErrorCode = "storage-full"
	CodeServiceUnavailable        ApiErrorCode = "service-unavailable"
	CodeInternalError             ApiErrorCode = "internal-error"
	// Routing (nicht in der Vertragstabelle, für unbekannte Pfade/Methoden).
	CodeNotFound         ApiErrorCode = "not-found"
	CodeMethodNotAllowed ApiErrorCode = "method-not-allowed"
)

// ApiErrorCodes listet alle Werte (Reihenfolge wie im Vertrag).
func ApiErrorCodes() []ApiErrorCode {
	return []ApiErrorCode{
		CodeInvalidRequest, CodeInvalidOptions, CodeMissingFile, CodeUnsupportedType,
		CodeNotPDF, CodeFileTooLarge, CodeDimensionsTooLarge, CodeAnimatedUnsupported,
		CodeOriginalFormatUnsupported, CodeInvalidIdempotencyKey, CodeIdempotencyConflict,
		CodeSessionRequired, CodeCSRFFailed, CodeJobNotFound, CodeResultNotFound,
		CodeJobExpired, CodeRateLimited, CodeSessionJobLimit, CodeServerBusy,
		CodeStorageFull, CodeServiceUnavailable, CodeInternalError, CodeNotFound,
		CodeMethodNotAllowed,
	}
}

// ProcessingErrorCode: Fehlercodes in job.error.code bzw. result.error.code.
type ProcessingErrorCode string

const (
	ProcDecodeFailed        ProcessingErrorCode = "decode-failed"
	ProcEncodeFailed        ProcessingErrorCode = "encode-failed"
	ProcSaveFailed          ProcessingErrorCode = "save-failed"
	ProcEncrypted           ProcessingErrorCode = "encrypted"
	ProcParseFailed         ProcessingErrorCode = "parse-failed"
	ProcResultTooLarge      ProcessingErrorCode = "result-too-large"
	ProcTimeout             ProcessingErrorCode = "timeout"
	ProcMemoryLimit         ProcessingErrorCode = "memory-limit"
	ProcWorkerFailed        ProcessingErrorCode = "worker-failed"
	ProcStorageFull         ProcessingErrorCode = "storage-full"
	ProcDimensionsTooLarge  ProcessingErrorCode = "dimensions-too-large"
	ProcAnimatedUnsupported ProcessingErrorCode = "animated-unsupported"
	ProcUnsupportedType     ProcessingErrorCode = "unsupported-type"
	ProcDurationTooLong     ProcessingErrorCode = "duration-too-long"
	ProcUnsupportedAudio    ProcessingErrorCode = "unsupported-audio"
)

func ProcessingErrorCodes() []ProcessingErrorCode {
	return []ProcessingErrorCode{
		ProcDecodeFailed, ProcEncodeFailed, ProcSaveFailed, ProcEncrypted, ProcParseFailed,
		ProcResultTooLarge, ProcTimeout, ProcMemoryLimit, ProcWorkerFailed, ProcStorageFull,
		ProcDimensionsTooLarge, ProcAnimatedUnsupported, ProcUnsupportedType,
		ProcDurationTooLong, ProcUnsupportedAudio, ProcPageRangeInvalid,
	}
}

type Tool string

const (
	ToolImageConvert  Tool = "image-convert"
	ToolImageCompress Tool = "image-compress"
	ToolImageResize   Tool = "image-resize"
	ToolPDFCompress   Tool = "pdf-compress"
	ToolAudioConvert  Tool = "audio-convert"
	ToolMarkdownPDF   Tool = "markdown-pdf"
	ToolPDFRotate     Tool = "pdf-rotate"
)

func Tools() []Tool {
	return []Tool{ToolImageConvert, ToolImageCompress, ToolImageResize, ToolPDFCompress, ToolAudioConvert, ToolMarkdownPDF, ToolPDFRotate, ToolPDFSplit}
}

// IsImage: image-convert, image-compress und image-resize.
func (t Tool) IsImage() bool {
	return t == ToolImageConvert || t == ToolImageCompress || t == ToolImageResize
}

type JobState string

const (
	JobQueued             JobState = "queued"
	JobRunning            JobState = "running"
	JobSucceeded          JobState = "succeeded"
	JobPartiallySucceeded JobState = "partially_succeeded"
	JobFailed             JobState = "failed"
	JobCancelled          JobState = "cancelled"
	JobExpired            JobState = "expired"
)

func JobStates() []JobState {
	return []JobState{JobQueued, JobRunning, JobSucceeded, JobPartiallySucceeded, JobFailed, JobCancelled, JobExpired}
}

type JobPhase string

const (
	PhaseAnalyze JobPhase = "analyze"
	PhaseVariant JobPhase = "variant"
	PhaseEncode  JobPhase = "encode"
	PhaseSave    JobPhase = "save"
)

func JobPhases() []JobPhase {
	return []JobPhase{PhaseAnalyze, PhaseVariant, PhaseEncode, PhaseSave}
}

type ResultState string

const (
	ResultPending   ResultState = "pending"
	ResultRunning   ResultState = "running"
	ResultSucceeded ResultState = "succeeded"
	ResultFailed    ResultState = "failed"
	ResultCancelled ResultState = "cancelled"
)

func ResultStates() []ResultState {
	return []ResultState{ResultPending, ResultRunning, ResultSucceeded, ResultFailed, ResultCancelled}
}

type PdfLevel string

const (
	LevelHigh     PdfLevel = "high"
	LevelBalanced PdfLevel = "balanced"
	LevelSmall    PdfLevel = "small"
)

func PdfLevels() []PdfLevel {
	return []PdfLevel{LevelHigh, LevelBalanced, LevelSmall}
}

// InputFormat: anhand der Bytes erkanntes Eingabeformat.
type InputFormat string

const (
	InputJPEG     InputFormat = "jpeg"
	InputPNG      InputFormat = "png"
	InputWebP     InputFormat = "webp"
	InputGIF      InputFormat = "gif"
	InputBMP      InputFormat = "bmp"
	InputICO      InputFormat = "ico"
	InputAVIF     InputFormat = "avif"
	InputPDF      InputFormat = "pdf"
	InputMarkdown InputFormat = "markdown"
	InputMP3      InputFormat = "mp3"
	InputWAV      InputFormat = "wav"
	InputFLAC     InputFormat = "flac"
	InputOGG      InputFormat = "ogg"
)

func InputFormats() []InputFormat {
	return []InputFormat{InputJPEG, InputPNG, InputWebP, InputGIF, InputBMP, InputICO, InputAVIF, InputPDF,
		InputMP3, InputWAV, InputFLAC, InputOGG, InputMarkdown}
}

// AudioFormat: Ein- und Ausgabeformate von audio-convert (Inline-Enum).
type AudioFormat string

const (
	AudioMP3  AudioFormat = "mp3"
	AudioWAV  AudioFormat = "wav"
	AudioFLAC AudioFormat = "flac"
	AudioOGG  AudioFormat = "ogg"
)

func AudioFormats() []AudioFormat { return []AudioFormat{AudioMP3, AudioWAV, AudioFLAC, AudioOGG} }

// AudioChannels: Feld channels der Audiooptionen (Inline-Enum).
type AudioChannels string

const (
	ChannelsOriginal AudioChannels = "original"
	ChannelsMono     AudioChannels = "mono"
)

func AudioChannelModes() []AudioChannels { return []AudioChannels{ChannelsOriginal, ChannelsMono} }

// MarkdownPageSize: Feld pageSize der Markdown-Optionen (Inline-Enum).
type MarkdownPageSize string

const (
	PageSizeA4     MarkdownPageSize = "a4"
	PageSizeLetter MarkdownPageSize = "letter"
)

func MarkdownPageSizes() []MarkdownPageSize { return []MarkdownPageSize{PageSizeA4, PageSizeLetter} }

// MarkdownOrientation: Feld orientation der Markdown-Optionen (Inline-Enum).
type MarkdownOrientation string

const (
	OrientationPortrait  MarkdownOrientation = "portrait"
	OrientationLandscape MarkdownOrientation = "landscape"
)

func MarkdownOrientations() []MarkdownOrientation {
	return []MarkdownOrientation{OrientationPortrait, OrientationLandscape}
}

// OutputFormat: erzeugbare Bildformate (keine eigene OpenAPI-Komponente).
type OutputFormat string

const (
	OutputJPEG OutputFormat = "jpeg"
	OutputPNG  OutputFormat = "png"
	OutputWebP OutputFormat = "webp"
	OutputBMP  OutputFormat = "bmp"
	OutputICO  OutputFormat = "ico"
)

func OutputFormats() []OutputFormat {
	return []OutputFormat{OutputJPEG, OutputPNG, OutputWebP, OutputBMP, OutputICO}
}

// ImageFormatOption: Feld format der Bildoptionen (Ausgabeformat oder "original").
type ImageFormatOption string

const (
	FormatJPEG     ImageFormatOption = "jpeg"
	FormatPNG      ImageFormatOption = "png"
	FormatWebP     ImageFormatOption = "webp"
	FormatBMP      ImageFormatOption = "bmp"
	FormatICO      ImageFormatOption = "ico"
	FormatOriginal ImageFormatOption = "original"
)

func ImageFormatOptions() []ImageFormatOption {
	return []ImageFormatOption{FormatJPEG, FormatPNG, FormatWebP, FormatBMP, FormatICO, FormatOriginal}
}

// CheckStatus: Ergebnis einer Readiness-Prüfung.
type CheckStatus string

const (
	CheckOK   CheckStatus = "ok"
	CheckFail CheckStatus = "fail"
)

func CheckStatuses() []CheckStatus { return []CheckStatus{CheckOK, CheckFail} }

type ReadyStatus string

const (
	ReadyOK          ReadyStatus = "ok"
	ReadyUnavailable ReadyStatus = "unavailable"
)

func ReadyStatuses() []ReadyStatus { return []ReadyStatus{ReadyOK, ReadyUnavailable} }

// Cancellation: Ergebnis von POST /jobs/{id}/cancel (Vertrag §4).
type Cancellation string

const (
	CancellationCompleted     Cancellation = "completed"
	CancellationRequested     Cancellation = "requested"
	CancellationNotApplicable Cancellation = "not-applicable"
)

func Cancellations() []Cancellation {
	return []Cancellation{CancellationCompleted, CancellationRequested, CancellationNotApplicable}
}
