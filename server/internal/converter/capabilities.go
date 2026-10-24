package converter

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"regexp"
	"slices"
	"time"

	"miconverter/server/internal/storage"
)

// ReportSchemaVersion ist die Version von capabilities.json.
const ReportSchemaVersion = 1

// ReportFile ist der Dateiname des Berichts im privaten Volume.
const ReportFile = "capabilities.json"

const maxReportBytes = 64 * 1024

// Pflichtformate (Plan §5/§6: Fehlen ist ein Abnahmefehler), in Vertragsreihenfolge.
var (
	RequiredInputFormats  = []string{"jpeg", "png", "webp", "gif", "bmp", "ico", "avif"}
	RequiredOutputFormats = []string{"jpeg", "png", "webp", "bmp", "ico"}
)

var (
	ErrProbeFailed    = errors.New("converter: Probe gescheitert")
	ErrReportMissing  = errors.New("converter: Capabilities-Bericht fehlt")
	ErrReportInvalid  = errors.New("converter: Capabilities-Bericht ungültig")
	ErrReportStale    = errors.New("converter: Capabilities-Bericht veraltet")
	ErrMissingFormats = errors.New("converter: Pflichtformat fehlt")
)

var versionRe = regexp.MustCompile(`^[0-9A-Za-z.+-]{1,32}$`)

// Versions: Bibliotheksversionen aus der Probe (nur Betrieb/Diagnose).
type Versions struct {
	Python  string `json:"python"`
	Pillow  string `json:"pillow"`
	Pikepdf string `json:"pikepdf"`
	Qpdf    string `json:"qpdf"`
}

// Report ist der versionierte Capabilities-Bericht (capabilities.json).
type Report struct {
	SchemaVersion   int       `json:"schemaVersion"`
	ProtocolVersion int       `json:"protocolVersion"`
	GeneratedAt     time.Time `json:"generatedAt"`
	InputFormats    []string  `json:"inputFormats"`
	OutputFormats   []string  `json:"outputFormats"`
	PDF             bool      `json:"pdf"`
	Versions        Versions  `json:"versions"`
}

// ImageFormats liefert die Formatlisten für GET /capabilities
// (image.inputFormats/outputFormats, Vertragsreihenfolge). Alle übrigen Felder
// der Antwort (qualityFormats, icoSizes, Grenzwerte, pdf.levels, jobs)
// kommen wie in backend/app/api/capabilities.py aus fester Konfiguration.
func (r Report) ImageFormats() (input, output []string) {
	for _, f := range RequiredInputFormats {
		if slices.Contains(r.InputFormats, f) {
			input = append(input, f)
		}
	}
	for _, f := range RequiredOutputFormats {
		if slices.Contains(r.OutputFormats, f) {
			output = append(output, f)
		}
	}
	return input, output
}

func knownList(values, known []string) bool {
	seen := map[string]bool{}
	for _, v := range values {
		if seen[v] || !slices.Contains(known, v) {
			return false
		}
		seen[v] = true
	}
	return true
}

// Validate prüft Version, Formate, Pflichtformate und Versionsangaben.
func (r Report) Validate() error {
	if r.SchemaVersion != ReportSchemaVersion || r.ProtocolVersion != ProtocolVersion || r.GeneratedAt.IsZero() {
		return fmt.Errorf("%w: Version", ErrReportInvalid)
	}
	if !knownList(r.InputFormats, RequiredInputFormats) || !knownList(r.OutputFormats, RequiredOutputFormats) {
		return fmt.Errorf("%w: Formatliste", ErrReportInvalid)
	}
	for _, v := range []string{r.Versions.Python, r.Versions.Pillow, r.Versions.Pikepdf, r.Versions.Qpdf} {
		if !versionRe.MatchString(v) {
			return fmt.Errorf("%w: Versionsangabe", ErrReportInvalid)
		}
	}
	for _, f := range RequiredInputFormats {
		if !slices.Contains(r.InputFormats, f) {
			return fmt.Errorf("%w: Eingabe %s", ErrMissingFormats, f)
		}
	}
	for _, f := range RequiredOutputFormats {
		if !slices.Contains(r.OutputFormats, f) {
			return fmt.Errorf("%w: Ausgabe %s", ErrMissingFormats, f)
		}
	}
	if !r.PDF {
		return fmt.Errorf("%w: pdf", ErrMissingFormats)
	}
	return nil
}

func decodeVersions(o object) (Versions, error) {
	v, err := o.nested("versions", []string{"python", "pillow", "pikepdf", "qpdf"}, nil)
	if err != nil {
		return Versions{}, err
	}
	var out Versions
	fields := []*string{&out.Python, &out.Pillow, &out.Pikepdf, &out.Qpdf}
	for i, k := range []string{"python", "pillow", "pikepdf", "qpdf"} {
		if *fields[i], err = v.str(k, 32); err != nil {
			return Versions{}, err
		}
	}
	return out, nil
}

func decodeFormats(o object, key string) ([]string, error) {
	items, err := o.array(key, 16)
	if err != nil {
		return nil, err
	}
	return stringList(items, 16)
}

// parseProbe dekodiert die Probezeile des Konverters streng.
func parseProbe(data []byte, now time.Time) (Report, error) {
	o, err := parseObject(data, []string{"protocolVersion", "inputFormats", "outputFormats", "pdf", "versions"}, nil)
	if err != nil {
		return Report{}, err
	}
	version, err := o.integer("protocolVersion", 0, 1<<31)
	if err != nil || version != ProtocolVersion {
		return Report{}, errors.New("protocolVersion")
	}
	rep := Report{SchemaVersion: ReportSchemaVersion, ProtocolVersion: ProtocolVersion, GeneratedAt: now.UTC()}
	if rep.InputFormats, err = decodeFormats(o, "inputFormats"); err != nil {
		return Report{}, err
	}
	if rep.OutputFormats, err = decodeFormats(o, "outputFormats"); err != nil {
		return Report{}, err
	}
	if rep.PDF, err = o.boolean("pdf"); err != nil {
		return Report{}, err
	}
	if rep.Versions, err = decodeVersions(o); err != nil {
		return Report{}, err
	}
	return rep, nil
}

// Probe führt `converter.cli probe` isoliert aus (echte Rundreise kleiner
// Fixtures) und liefert den geprüften Bericht. Fehlende Pflichtformate sind
// ErrMissingFormats; der Bericht wird dann trotzdem zur Diagnose geliefert.
func (r *Runner) Probe(ctx context.Context) (Report, error) {
	var (
		got   []byte
		fatal bool
	)
	res, err := r.execute(ctx, "probe", nil, r.probeTimeout, func(data []byte) error {
		if got != nil || fatal {
			return violated("mehr als eine Probezeile")
		}
		if _, err := parseObject(data, []string{"kind", "code"}, nil); err == nil {
			fatal = true
			return nil
		}
		got = data
		return nil
	})
	if err != nil {
		return Report{}, err
	}
	switch {
	case ctx.Err() != nil:
		return Report{}, ctx.Err()
	case res.cause != nil:
		return Report{}, fmt.Errorf("%w: %w", ErrProbeFailed, res.cause)
	case fatal:
		return Report{}, fmt.Errorf("%w: fatal", ErrProbeFailed)
	case res.waitErr != nil || res.state.ExitCode() != 0 || got == nil:
		return Report{}, fmt.Errorf("%w: Exit %d", ErrProbeFailed, res.state.ExitCode())
	}
	rep, err := parseProbe(got, r.now())
	if err != nil {
		return Report{}, fmt.Errorf("%w: Ausgabe: %w", ErrProbeFailed, err)
	}
	return rep, rep.Validate()
}

// WriteReport schreibt einen gültigen Bericht atomar (Temp-Datei, fsync,
// rename, fsync des Verzeichnisses) mit 0600.
func WriteReport(path string, rep Report) error {
	if err := rep.Validate(); err != nil {
		return err
	}
	rep.GeneratedAt = rep.GeneratedAt.UTC()
	data, err := json.Marshal(rep)
	if err != nil {
		return err
	}
	return storage.WriteFileAtomic(path, append(data, '\n'))
}

// LoadReport liest den Bericht für API und Readiness. Fehlend,
// inkompatibel, in der Zukunft (über 1 min), älter als maxAge oder ohne
// Pflichtformat ist ein Fehler – Formate werden nie erfunden.
func LoadReport(path string, now time.Time, maxAge time.Duration) (Report, error) {
	f, err := os.OpenFile(path, os.O_RDONLY|oNoFollow, 0)
	if errors.Is(err, os.ErrNotExist) {
		return Report{}, ErrReportMissing
	}
	if err != nil {
		return Report{}, fmt.Errorf("%w: %w", ErrReportInvalid, err)
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Size() > maxReportBytes {
		return Report{}, fmt.Errorf("%w: Datei", ErrReportInvalid)
	}
	data, err := io.ReadAll(io.LimitReader(f, maxReportBytes+1))
	if err != nil || len(data) > maxReportBytes {
		return Report{}, fmt.Errorf("%w: lesen", ErrReportInvalid)
	}
	o, err := parseObject(data, []string{"schemaVersion", "protocolVersion", "generatedAt",
		"inputFormats", "outputFormats", "pdf", "versions"}, nil)
	if err != nil {
		return Report{}, fmt.Errorf("%w: %w", ErrReportInvalid, err)
	}
	var rep Report
	schema, err1 := o.integer("schemaVersion", 0, 1<<31)
	proto, err2 := o.integer("protocolVersion", 0, 1<<31)
	stamp, err3 := o.str("generatedAt", 64)
	if errors.Join(err1, err2, err3) != nil {
		return Report{}, fmt.Errorf("%w: Kopf", ErrReportInvalid)
	}
	rep.SchemaVersion, rep.ProtocolVersion = int(schema), int(proto)
	if rep.GeneratedAt, err = time.Parse(time.RFC3339Nano, stamp); err != nil {
		return Report{}, fmt.Errorf("%w: generatedAt", ErrReportInvalid)
	}
	if rep.InputFormats, err = decodeFormats(o, "inputFormats"); err != nil {
		return Report{}, fmt.Errorf("%w: %w", ErrReportInvalid, err)
	}
	if rep.OutputFormats, err = decodeFormats(o, "outputFormats"); err != nil {
		return Report{}, fmt.Errorf("%w: %w", ErrReportInvalid, err)
	}
	if rep.PDF, err = o.boolean("pdf"); err != nil {
		return Report{}, fmt.Errorf("%w: %w", ErrReportInvalid, err)
	}
	if rep.Versions, err = decodeVersions(o); err != nil {
		return Report{}, fmt.Errorf("%w: %w", ErrReportInvalid, err)
	}
	if err := rep.Validate(); err != nil {
		return Report{}, err
	}
	if rep.GeneratedAt.After(now.Add(time.Minute)) || now.Sub(rep.GeneratedAt) > maxAge {
		return Report{}, ErrReportStale
	}
	return rep, nil
}
