// Package storage ist die private Dateiablage auf einem lokalen Verzeichnis
// (Docker-Volume), Portierung von backend/app/storage/local.py.
//
// Regeln (Vertrag §7):
//   - Dateien werden nur über interne Schlüssel angesprochen
//     (spool/<id>, jobs/<job_id>/input,
//     jobs/<job_id>/results/<result_id>/<lease_token>). Benutzereingaben wie
//     Dateinamen landen nie in einem Pfad.
//   - Verzeichnisse 0700, Dateien 0600, neue Dateien exklusiv (O_EXCL).
//   - Kein Pfad folgt einem symbolischen Link innerhalb des Speichers.
//   - Fertige Dateien entstehen atomar: Temp-Datei schreiben, fsync, rename,
//     fsync des Verzeichnisses.
package storage

import (
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"syscall"
)

const (
	DirMode  fs.FileMode = 0o700
	FileMode fs.FileMode = 0o600
)

// ErrInvalidKey: Schlüssel entspricht keinem erlaubten Muster oder verlässt
// das Speicherverzeichnis (z. B. über einen Symlink).
var ErrInvalidKey = errors.New("storage: ungültiger Speicherschlüssel")

const uuidPattern = `[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}`

var keyPattern = regexp.MustCompile(
	`^(?:spool/` + uuidPattern + `|jobs/` + uuidPattern + `(?:/input|/results/` + uuidPattern + `/` + uuidPattern + `)?)$`)

// FormatUUID liefert die kanonische Kleinschreibung (wie Pythons str(uuid)).
func FormatUUID(id [16]byte) string {
	var b [36]byte
	hex.Encode(b[0:8], id[0:4])
	b[8] = '-'
	hex.Encode(b[9:13], id[4:6])
	b[13] = '-'
	hex.Encode(b[14:18], id[6:8])
	b[18] = '-'
	hex.Encode(b[19:23], id[8:10])
	b[23] = '-'
	hex.Encode(b[24:36], id[10:16])
	return string(b[:])
}

func SpoolKey(reservationID [16]byte) string { return "spool/" + FormatUUID(reservationID) }

func JobKey(jobID [16]byte) string { return "jobs/" + FormatUUID(jobID) }

func InputKey(jobID [16]byte) string { return JobKey(jobID) + "/input" }

func ResultKey(jobID, resultID, leaseToken [16]byte) string {
	return JobKey(jobID) + "/results/" + FormatUUID(resultID) + "/" + FormatUUID(leaseToken)
}

// ValidateKey prüft einen Schlüssel gegen die internen Muster.
func ValidateKey(key string) error {
	if !keyPattern.MatchString(key) {
		return ErrInvalidKey
	}
	return nil
}

// Local ist der Speicher unterhalb eines Wurzelverzeichnisses.
type Local struct {
	root string // absolut, ohne Symlinks
}

// NewLocal öffnet ein bestehendes Wurzelverzeichnis. Ein Symlink als Wurzel
// selbst (z. B. Volume-Mount) ist erlaubt; darunter nicht.
func NewLocal(root string) (*Local, error) {
	abs, err := filepath.Abs(root)
	if err != nil {
		return nil, fmt.Errorf("storage: Wurzel: %w", err)
	}
	resolved, err := filepath.EvalSymlinks(abs)
	if err != nil {
		return nil, fmt.Errorf("storage: Wurzel: %w", err)
	}
	info, err := os.Stat(resolved)
	if err != nil {
		return nil, fmt.Errorf("storage: Wurzel: %w", err)
	}
	if !info.IsDir() {
		return nil, errors.New("storage: Wurzel ist kein Verzeichnis")
	}
	return &Local{root: resolved}, nil
}

// Root liefert das aufgelöste Wurzelverzeichnis.
func (s *Local) Root() string { return s.root }

// Path liefert den absoluten Pfad eines Schlüssels. Existierende
// Pfadbestandteile dürfen keine Symlinks sein.
func (s *Local) Path(key string) (string, error) {
	if err := ValidateKey(key); err != nil {
		return "", err
	}
	parts := strings.Split(key, "/")
	current := s.root
	for _, part := range parts {
		current = filepath.Join(current, part)
		info, err := os.Lstat(current)
		if errors.Is(err, fs.ErrNotExist) {
			break // der Rest existiert noch nicht und entsteht ohne Symlinks
		}
		if err != nil {
			return "", fmt.Errorf("storage: %w", err)
		}
		if info.Mode()&fs.ModeSymlink != 0 {
			return "", ErrInvalidKey
		}
	}
	return filepath.Join(s.root, filepath.FromSlash(key)), nil
}

// ensureParent legt fehlende Elternverzeichnisse mit 0700 an und sichert
// jeden neuen Eintrag per fsync des übergeordneten Verzeichnisses.
func (s *Local) ensureParent(path string) error {
	var missing []string
	for dir := filepath.Dir(path); dir != s.root; dir = filepath.Dir(dir) {
		info, err := os.Lstat(dir)
		if err == nil {
			if !info.IsDir() || info.Mode()&fs.ModeSymlink != 0 {
				return ErrInvalidKey
			}
			break
		}
		if !errors.Is(err, fs.ErrNotExist) {
			return fmt.Errorf("storage: %w", err)
		}
		missing = append(missing, dir)
		if len(missing) > 8 {
			return ErrInvalidKey // Schlüssel sind höchstens fünf Ebenen tief
		}
	}
	for i := len(missing) - 1; i >= 0; i-- {
		dir := missing[i]
		if err := os.Mkdir(dir, DirMode); err != nil && !errors.Is(err, fs.ErrExist) {
			return fmt.Errorf("storage: Verzeichnis anlegen: %w", err)
		}
		info, err := os.Lstat(dir)
		if err != nil {
			return fmt.Errorf("storage: %w", err)
		}
		if !info.IsDir() || info.Mode()&fs.ModeSymlink != 0 {
			return ErrInvalidKey
		}
		// Mkdir-Modus wird durch die umask gefiltert.
		if err := os.Chmod(dir, DirMode); err != nil {
			return fmt.Errorf("storage: %w", err)
		}
		if err := fsyncDir(filepath.Dir(dir)); err != nil {
			return err
		}
	}
	return nil
}

// Writer schreibt eine neue Datei; erst Close macht sie dauerhaft.
type Writer struct {
	f    *os.File
	path string
}

// retryOnVanishedDir wiederholt op, falls ein paralleles Delete ein gerade
// angelegtes, noch leeres Elternverzeichnis wieder entfernt hat.
func (s *Local) retryOnVanishedDir(path string, op func() error) error {
	var err error
	for range 3 {
		if err = s.ensureParent(path); err != nil {
			return err
		}
		if err = op(); !errors.Is(err, fs.ErrNotExist) {
			return err
		}
	}
	return err
}

// Create legt die Datei zu key exklusiv mit 0600 an (Fehler, falls sie schon
// existiert) und folgt keinem Symlink.
func (s *Local) Create(key string) (*Writer, error) {
	path, err := s.Path(key)
	if err != nil {
		return nil, err
	}
	var f *os.File
	err = s.retryOnVanishedDir(path, func() error {
		var openErr error
		f, openErr = os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL|oNoFollow, FileMode)
		return openErr
	})
	if err != nil {
		return nil, fmt.Errorf("storage: Datei anlegen: %w", err)
	}
	// Modus unabhängig von der umask.
	if err := f.Chmod(FileMode); err != nil {
		_ = f.Close()
		_ = os.Remove(path)
		return nil, fmt.Errorf("storage: %w", err)
	}
	return &Writer{f: f, path: path}, nil
}

// ErrClosed meldet Schreiben auf einen bereits geschlossenen Writer.
var ErrClosed = errors.New("storage: Datei ist bereits geschlossen")

func (w *Writer) Write(p []byte) (int, error) {
	if w.f == nil {
		return 0, ErrClosed
	}
	return w.f.Write(p)
}

// ReadFrom erlaubt io.Copy ohne Zwischenpuffer-Umweg.
func (w *Writer) ReadFrom(r io.Reader) (int64, error) {
	if w.f == nil {
		return 0, ErrClosed
	}
	return io.Copy(w.f, r)
}

// Path ist der Dateipfad (z. B. für den Konverter-Kindprozess).
func (w *Writer) Path() string { return w.path }

// Close sichert den Inhalt per fsync und schließt die Datei. Mehrfacher
// Aufruf ist erlaubt.
func (w *Writer) Close() error {
	if w.f == nil {
		return nil
	}
	f := w.f
	w.f = nil
	syncErr := f.Sync()
	closeErr := f.Close()
	if syncErr != nil {
		return fmt.Errorf("storage: fsync: %w", syncErr)
	}
	if closeErr != nil {
		return fmt.Errorf("storage: %w", closeErr)
	}
	return nil
}

// Discard schließt ohne fsync und entfernt die angefangene Datei.
func (w *Writer) Discard() error {
	if w.f != nil {
		_ = w.f.Close()
		w.f = nil
	}
	if err := os.Remove(w.path); err != nil && !errors.Is(err, fs.ErrNotExist) {
		return fmt.Errorf("storage: %w", err)
	}
	return nil
}

// Promote verschiebt eine fertige Datei atomar an einen neuen Schlüssel
// (rename, danach fsync beider Verzeichnisse). Ein vorhandenes Ziel wird
// ersetzt.
func (s *Local) Promote(sourceKey, targetKey string) error {
	source, err := s.Path(sourceKey)
	if err != nil {
		return err
	}
	target, err := s.Path(targetKey)
	if err != nil {
		return err
	}
	info, err := os.Lstat(source)
	if err != nil {
		return fmt.Errorf("storage: Quelle: %w", err)
	}
	if !info.Mode().IsRegular() {
		return ErrInvalidKey
	}
	if err := s.retryOnVanishedDir(target, func() error { return os.Rename(source, target) }); err != nil {
		return fmt.Errorf("storage: verschieben: %w", err)
	}
	if err := fsyncDir(filepath.Dir(target)); err != nil {
		return err
	}
	if filepath.Dir(source) != filepath.Dir(target) {
		return fsyncDir(filepath.Dir(source))
	}
	return nil
}

// WriteAtomic schreibt r vollständig unter key: Temp-Datei im Zielverzeichnis,
// fsync, rename, fsync des Verzeichnisses. Leser sehen nie eine halbe Datei.
func (s *Local) WriteAtomic(key string, r io.Reader) (int64, error) {
	path, err := s.Path(key)
	if err != nil {
		return 0, err
	}
	if err := s.ensureParent(path); err != nil {
		return 0, err
	}
	return writeAtomic(path, r)
}

// WriteFileAtomic schreibt eine Datei außerhalb des Schlüsselschemas (z. B.
// einen Bericht im Volume) atomar mit 0600. Das Verzeichnis muss existieren.
func WriteFileAtomic(path string, data []byte) error {
	_, err := writeAtomic(path, bytes.NewReader(data))
	return err
}

func writeAtomic(path string, r io.Reader) (int64, error) {
	dir := filepath.Dir(path)
	suffix := make([]byte, 8)
	if _, err := rand.Read(suffix); err != nil {
		return 0, err
	}
	tmp := filepath.Join(dir, ".tmp-"+hex.EncodeToString(suffix))
	f, err := os.OpenFile(tmp, os.O_WRONLY|os.O_CREATE|os.O_EXCL|oNoFollow, FileMode)
	if err != nil {
		return 0, fmt.Errorf("storage: Temp-Datei: %w", err)
	}
	cleanup := func() { _ = f.Close(); _ = os.Remove(tmp) }
	if err := f.Chmod(FileMode); err != nil {
		cleanup()
		return 0, fmt.Errorf("storage: %w", err)
	}
	n, err := io.Copy(f, r)
	if err != nil {
		cleanup()
		return 0, fmt.Errorf("storage: schreiben: %w", err)
	}
	if err := f.Sync(); err != nil {
		cleanup()
		return 0, fmt.Errorf("storage: fsync: %w", err)
	}
	if err := f.Close(); err != nil {
		_ = os.Remove(tmp)
		return 0, fmt.Errorf("storage: %w", err)
	}
	if err := os.Rename(tmp, path); err != nil {
		_ = os.Remove(tmp)
		return 0, fmt.Errorf("storage: veröffentlichen: %w", err)
	}
	if err := fsyncDir(dir); err != nil {
		return n, err
	}
	return n, nil
}

// Sync macht vom Konverter geschriebene Bytes vor der Veröffentlichung in
// der Datenbank dauerhaft (Datei und Verzeichnis).
func (s *Local) Sync(key string) error {
	path, err := s.Path(key)
	if err != nil {
		return err
	}
	f, err := os.OpenFile(path, os.O_RDWR|oNoFollow, 0)
	if err != nil {
		return fmt.Errorf("storage: %w", err)
	}
	syncErr := f.Sync()
	closeErr := f.Close()
	if syncErr != nil {
		return fmt.Errorf("storage: fsync: %w", syncErr)
	}
	if closeErr != nil {
		return fmt.Errorf("storage: %w", closeErr)
	}
	return fsyncDir(filepath.Dir(path))
}

// Open öffnet eine Datei nur lesend und ohne Symlinks zu folgen.
func (s *Local) Open(key string) (*os.File, error) {
	path, err := s.Path(key)
	if err != nil {
		return nil, err
	}
	f, err := os.OpenFile(path, os.O_RDONLY|oNoFollow, 0)
	if err != nil {
		return nil, fmt.Errorf("storage: %w", err)
	}
	info, err := f.Stat()
	if err != nil || !info.Mode().IsRegular() {
		_ = f.Close()
		return nil, ErrInvalidKey
	}
	return f, nil
}

// Size liefert die Größe aus dem Dateisystem; Angaben des Konverters zählen
// nicht.
func (s *Local) Size(key string) (int64, error) {
	path, err := s.Path(key)
	if err != nil {
		return 0, err
	}
	info, err := os.Lstat(path)
	if err != nil {
		return 0, fmt.Errorf("storage: %w", err)
	}
	if !info.Mode().IsRegular() {
		return 0, ErrInvalidKey
	}
	return info.Size(), nil
}

// Exists meldet, ob unter key eine reguläre Datei liegt.
func (s *Local) Exists(key string) (bool, error) {
	path, err := s.Path(key)
	if err != nil {
		return false, err
	}
	info, err := os.Lstat(path)
	if errors.Is(err, fs.ErrNotExist) {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("storage: %w", err)
	}
	return info.Mode().IsRegular(), nil
}

// Delete entfernt die Datei zu key und danach leer gewordene
// Elternverzeichnisse bis unterhalb von spool/ bzw. jobs/. Idempotent.
func (s *Local) Delete(key string) error {
	path, err := s.Path(key)
	if err != nil {
		return err
	}
	err = os.Remove(path)
	switch {
	case errors.Is(err, fs.ErrNotExist):
	case err != nil:
		return fmt.Errorf("storage: löschen: %w", err)
	default:
		if err := fsyncDir(filepath.Dir(path)); err != nil && !errors.Is(err, fs.ErrNotExist) {
			return err
		}
	}
	s.pruneEmpty(filepath.Dir(path))
	return nil
}

// RemoveJob entfernt jobs/<job_id> samt Inhalt. Idempotent; Symlinks darin
// werden als Einträge gelöscht, nicht verfolgt.
func (s *Local) RemoveJob(jobID [16]byte) error {
	path, err := s.Path(JobKey(jobID))
	if err != nil {
		return err
	}
	if err := os.RemoveAll(path); err != nil {
		return fmt.Errorf("storage: löschen: %w", err)
	}
	if err := fsyncDir(filepath.Dir(path)); err != nil && !errors.Is(err, fs.ErrNotExist) {
		return err
	}
	return nil
}

// pruneEmpty entfernt leere Verzeichnisse aufwärts; spool/ und jobs/ selbst
// bleiben stehen. Ein nicht leeres Verzeichnis beendet den Lauf.
func (s *Local) pruneEmpty(dir string) {
	for {
		rel, err := filepath.Rel(s.root, dir)
		if err != nil || !strings.Contains(filepath.ToSlash(rel), "/") {
			return
		}
		if err := syscallRmdir(dir); err != nil {
			return
		}
		parent := filepath.Dir(dir)
		_ = fsyncDir(parent)
		dir = parent
	}
}

// syscallRmdir entfernt nur leere Verzeichnisse (os.Remove würde auch eine
// Datei entfernen, falls der Pfad parallel ersetzt wurde).
func syscallRmdir(dir string) error {
	err := syscall.Rmdir(dir)
	if err != nil {
		return &fs.PathError{Op: "rmdir", Path: dir, Err: err}
	}
	return nil
}

// FreeBytes liefert den für unprivilegierte Prozesse freien Platz.
func (s *Local) FreeBytes() (uint64, error) { return freeBytes(s.root) }

// CheckWritable prüft für Readiness, dass dir existiert und wirklich
// beschreibbar ist: os.Access allein erkennt weder schreibgeschützte Mounts
// noch volle Datenträger. Eine Probedatei wird geschrieben, synchronisiert
// und sofort entfernt.
func CheckWritable(dir string) error {
	info, err := os.Stat(dir)
	if err != nil {
		return fmt.Errorf("storage: nicht bereit: %w", err)
	}
	if !info.IsDir() {
		return errors.New("storage: nicht bereit: kein Verzeichnis")
	}
	suffix := make([]byte, 8)
	if _, err := rand.Read(suffix); err != nil {
		return err
	}
	probe := filepath.Join(dir, ".ready-"+hex.EncodeToString(suffix))
	f, err := os.OpenFile(probe, os.O_WRONLY|os.O_CREATE|os.O_EXCL|oNoFollow, FileMode)
	if err != nil {
		return fmt.Errorf("storage: nicht bereit: %w", err)
	}
	defer func() { _ = os.Remove(probe) }()
	_, werr := f.Write([]byte("ok"))
	serr := f.Sync()
	cerr := f.Close()
	if err := errors.Join(werr, serr, cerr); err != nil {
		return fmt.Errorf("storage: nicht bereit: %w", err)
	}
	return nil
}
