package storage_test

import (
	"bytes"
	"crypto/rand"
	"errors"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"

	"miconverter/server/internal/storage"
)

func newID(t *testing.T) [16]byte {
	t.Helper()
	var id [16]byte
	if _, err := rand.Read(id[:]); err != nil {
		t.Fatal(err)
	}
	return id
}

func newStorage(t *testing.T) *storage.Local {
	t.Helper()
	s, err := storage.NewLocal(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	return s
}

func mode(t *testing.T, path string) fs.FileMode {
	t.Helper()
	info, err := os.Lstat(path)
	if err != nil {
		t.Fatal(err)
	}
	return info.Mode().Perm()
}

func skipOnWindows(t *testing.T) {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("POSIX-Rechte/Symlinks")
	}
}

func TestKeyHelpersMatchPythonFormat(t *testing.T) {
	id := [16]byte{0x12, 0x34, 0x56, 0x78, 0x9a, 0xbc, 0xde, 0xf0, 0x01, 0x23, 0x45, 0x67, 0x89, 0xab, 0xcd, 0xef}
	const u = "12345678-9abc-def0-0123-456789abcdef"
	cases := map[string]string{
		storage.SpoolKey(id):          "spool/" + u,
		storage.JobKey(id):            "jobs/" + u,
		storage.InputKey(id):          "jobs/" + u + "/input",
		storage.ResultKey(id, id, id): "jobs/" + u + "/results/" + u + "/" + u,
	}
	for got, want := range cases {
		if got != want {
			t.Errorf("%q != %q", got, want)
		}
		if err := storage.ValidateKey(got); err != nil {
			t.Errorf("ValidateKey(%q) = %v", got, err)
		}
	}
}

func TestInvalidKeysAreRejected(t *testing.T) {
	s := newStorage(t)
	u := storage.FormatUUID(newID(t))
	for _, key := range []string{
		"", "../secret", "/etc/passwd", "spool/../secret", "jobs/../../secret",
		"spool/not-a-uuid", "jobs/" + u + "/../../secret", "jobs/" + u + "/input/",
		"spool/" + strings.ToUpper(u), "jobs/" + u + "/results/" + u,
		"jobs/" + u + "/other", "spool/" + u + "\x00", "spool\\" + u, "./spool/" + u,
	} {
		if _, err := s.Create(key); !errors.Is(err, storage.ErrInvalidKey) {
			t.Errorf("Create(%q) = %v", key, err)
		}
		if err := s.Delete(key); !errors.Is(err, storage.ErrInvalidKey) {
			t.Errorf("Delete(%q) = %v", key, err)
		}
	}
}

func TestCreatePromoteDeleteLifecycle(t *testing.T) {
	s := newStorage(t)
	job := newID(t)
	source, target := storage.SpoolKey(newID(t)), storage.InputKey(job)

	w, err := s.Create(source)
	if err != nil {
		t.Fatal(err)
	}
	for _, chunk := range []string{"first", "second"} {
		if _, err := w.Write([]byte(chunk)); err != nil {
			t.Fatal(err)
		}
	}
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
	if err := w.Close(); err != nil {
		t.Fatal("zweites Close muss erlaubt sein")
	}
	if _, err := w.Write([]byte("x")); !errors.Is(err, storage.ErrClosed) {
		t.Fatalf("Write nach Close = %v", err)
	}
	if err := s.Promote(source, target); err != nil {
		t.Fatal(err)
	}
	if ok, _ := s.Exists(source); ok {
		t.Fatal("Quelle existiert nach Promote")
	}
	path, _ := s.Path(target)
	data, err := os.ReadFile(path)
	if err != nil || string(data) != "firstsecond" {
		t.Fatalf("Inhalt = %q, %v", data, err)
	}
	if size, err := s.Size(target); err != nil || size != int64(len("firstsecond")) {
		t.Fatalf("Size = %d, %v", size, err)
	}
	if runtime.GOOS != "windows" {
		if m := mode(t, path); m != storage.FileMode {
			t.Fatalf("Dateimodus %v", m)
		}
		if m := mode(t, filepath.Dir(path)); m != storage.DirMode {
			t.Fatalf("Verzeichnismodus %v", m)
		}
	}

	if err := s.Delete(target); err != nil {
		t.Fatal(err)
	}
	if err := s.Delete(target); err != nil {
		t.Fatalf("zweites Delete: %v", err)
	}
	// Leeres jobs/<id> ist mit entfernt, jobs/ selbst bleibt.
	if _, err := os.Lstat(filepath.Dir(path)); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("leeres Auftragsverzeichnis blieb: %v", err)
	}
	if _, err := os.Lstat(filepath.Join(s.Root(), "jobs")); err != nil {
		t.Fatalf("jobs/ entfernt: %v", err)
	}
	if _, err := os.Lstat(filepath.Join(s.Root(), "spool")); err != nil {
		t.Fatalf("spool/ entfernt: %v", err)
	}
}

func TestDeleteKeepsNonEmptyDirectories(t *testing.T) {
	s := newStorage(t)
	job := newID(t)
	resultA := storage.ResultKey(job, newID(t), newID(t))
	input := storage.InputKey(job)
	for _, key := range []string{resultA, input} {
		w, err := s.Create(key)
		if err != nil {
			t.Fatal(err)
		}
		_ = w.Close()
	}
	if err := s.Delete(resultA); err != nil {
		t.Fatal(err)
	}
	if ok, _ := s.Exists(input); !ok {
		t.Fatal("Eingabe wurde mitgelöscht")
	}
	if _, err := os.Lstat(filepath.Join(s.Root(), "jobs", storage.FormatUUID(job), "results")); !errors.Is(err, fs.ErrNotExist) {
		t.Fatal("leeres results/ blieb stehen")
	}
	if err := s.RemoveJob(job); err != nil {
		t.Fatal(err)
	}
	if err := s.RemoveJob(job); err != nil {
		t.Fatal(err)
	}
	if ok, _ := s.Exists(input); ok {
		t.Fatal("RemoveJob hat nicht gelöscht")
	}
}

func TestCreateIsExclusive(t *testing.T) {
	s := newStorage(t)
	key := storage.SpoolKey(newID(t))
	w, err := s.Create(key)
	if err != nil {
		t.Fatal(err)
	}
	_ = w.Close()
	if _, err := s.Create(key); !errors.Is(err, fs.ErrExist) {
		t.Fatalf("zweites Create = %v", err)
	}
}

func TestDiscardRemovesPartialFile(t *testing.T) {
	s := newStorage(t)
	key := storage.SpoolKey(newID(t))
	w, err := s.Create(key)
	if err != nil {
		t.Fatal(err)
	}
	_, _ = w.Write([]byte("partial"))
	if err := w.Discard(); err != nil {
		t.Fatal(err)
	}
	if ok, _ := s.Exists(key); ok {
		t.Fatal("Datei nach Discard vorhanden")
	}
	if _, err := w.Write([]byte("more")); !errors.Is(err, storage.ErrClosed) {
		t.Fatalf("Write nach Discard = %v", err)
	}
}

func TestWriteAtomicAndOpen(t *testing.T) {
	s := newStorage(t)
	key := storage.ResultKey(newID(t), newID(t), newID(t))
	n, err := s.WriteAtomic(key, bytes.NewReader([]byte("result")))
	if err != nil || n != 6 {
		t.Fatalf("WriteAtomic = %d, %v", n, err)
	}
	// Erneutes Schreiben ersetzt atomar.
	if _, err := s.WriteAtomic(key, strings.NewReader("replaced")); err != nil {
		t.Fatal(err)
	}
	f, err := s.Open(key)
	if err != nil {
		t.Fatal(err)
	}
	data, _ := io.ReadAll(f)
	_ = f.Close()
	if string(data) != "replaced" {
		t.Fatalf("Inhalt = %q", data)
	}
	path, _ := s.Path(key)
	entries, _ := os.ReadDir(filepath.Dir(path))
	if len(entries) != 1 {
		t.Fatalf("Temp-Dateien übrig: %v", entries)
	}
	if runtime.GOOS != "windows" && mode(t, path) != storage.FileMode {
		t.Fatalf("Modus %v", mode(t, path))
	}
	if err := s.Sync(key); err != nil {
		t.Fatal(err)
	}
}

func TestWriteFileAtomic(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "capabilities.json")
	if err := storage.WriteFileAtomic(path, []byte(`{"a":1}`)); err != nil {
		t.Fatal(err)
	}
	if err := storage.WriteFileAtomic(path, []byte(`{"a":2}`)); err != nil {
		t.Fatal(err)
	}
	data, _ := os.ReadFile(path)
	if string(data) != `{"a":2}` {
		t.Fatalf("Inhalt = %q", data)
	}
	if entries, _ := os.ReadDir(dir); len(entries) != 1 {
		t.Fatalf("Temp-Dateien übrig: %v", entries)
	}
}

func TestSymlinkEscapeIsRejected(t *testing.T) {
	skipOnWindows(t)
	s := newStorage(t)
	outside := t.TempDir()
	job := newID(t)

	// Auftragsverzeichnis als Symlink nach außen.
	if err := os.MkdirAll(filepath.Join(s.Root(), "jobs"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(s.Root(), "jobs", storage.FormatUUID(job))); err != nil {
		t.Fatal(err)
	}
	key := storage.InputKey(job)
	if _, err := s.Create(key); !errors.Is(err, storage.ErrInvalidKey) {
		t.Fatalf("Create über Symlink = %v", err)
	}
	if _, err := s.WriteAtomic(key, strings.NewReader("x")); !errors.Is(err, storage.ErrInvalidKey) {
		t.Fatalf("WriteAtomic über Symlink = %v", err)
	}
	if entries, _ := os.ReadDir(outside); len(entries) != 0 {
		t.Fatalf("außerhalb geschrieben: %v", entries)
	}
	// Löschen über den Symlink darf außerhalb nichts entfernen.
	victim := filepath.Join(outside, "input")
	if err := os.WriteFile(victim, []byte("keep"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := s.Delete(key); !errors.Is(err, storage.ErrInvalidKey) {
		t.Fatalf("Delete über Symlink = %v", err)
	}
	if _, err := s.Open(key); !errors.Is(err, storage.ErrInvalidKey) {
		t.Fatalf("Open über Symlink = %v", err)
	}
	if _, err := s.Size(key); !errors.Is(err, storage.ErrInvalidKey) {
		t.Fatalf("Size über Symlink = %v", err)
	}
	if _, err := os.Stat(victim); err != nil {
		t.Fatal("Datei außerhalb wurde entfernt")
	}
	// RemoveJob verweigert den Symlink ebenfalls.
	if err := s.RemoveJob(job); !errors.Is(err, storage.ErrInvalidKey) {
		t.Fatalf("RemoveJob über Symlink = %v", err)
	}
	if _, err := os.Stat(victim); err != nil {
		t.Fatal("Datei außerhalb wurde entfernt")
	}
}

func TestSymlinkAsFinalComponentIsRejected(t *testing.T) {
	skipOnWindows(t)
	s := newStorage(t)
	outside := filepath.Join(t.TempDir(), "secret")
	if err := os.WriteFile(outside, []byte("secret"), 0o600); err != nil {
		t.Fatal(err)
	}
	key := storage.SpoolKey(newID(t))
	if err := os.MkdirAll(filepath.Join(s.Root(), "spool"), 0o700); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(s.Root(), filepath.FromSlash(key))
	if err := os.Symlink(outside, path); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Open(key); !errors.Is(err, storage.ErrInvalidKey) {
		t.Fatalf("Open = %v", err)
	}
	if ok, err := s.Exists(key); ok || !errors.Is(err, storage.ErrInvalidKey) {
		t.Fatalf("Exists = %v, %v", ok, err)
	}
	if err := s.Promote(key, storage.InputKey(newID(t))); !errors.Is(err, storage.ErrInvalidKey) {
		t.Fatalf("Promote = %v", err)
	}
}

func TestRootMayBeSymlink(t *testing.T) {
	skipOnWindows(t)
	real := t.TempDir()
	link := filepath.Join(t.TempDir(), "volume")
	if err := os.Symlink(real, link); err != nil {
		t.Fatal(err)
	}
	s, err := storage.NewLocal(link)
	if err != nil {
		t.Fatal(err)
	}
	w, err := s.Create(storage.SpoolKey(newID(t)))
	if err != nil {
		t.Fatal(err)
	}
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(w.Path(), s.Root()) {
		t.Fatalf("Pfad %s außerhalb %s", w.Path(), s.Root())
	}
}

func TestNewLocalRejectsMissingRoot(t *testing.T) {
	if _, err := storage.NewLocal(filepath.Join(t.TempDir(), "fehlt")); err == nil {
		t.Fatal("fehlende Wurzel akzeptiert")
	}
}

func TestConcurrentCreateAndDeleteInSameJob(t *testing.T) {
	s := newStorage(t)
	job := newID(t)
	var wg sync.WaitGroup
	errs := make(chan error, 64)
	for range 16 {
		wg.Go(func() {
			key := storage.ResultKey(job, newID(t), newID(t))
			w, err := s.Create(key)
			if err != nil {
				errs <- err
				return
			}
			if err := w.Close(); err != nil {
				errs <- err
				return
			}
			if err := s.Delete(key); err != nil {
				errs <- err
			}
		})
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		t.Error(err)
	}
}

// Ein paralleles Delete kann das Jobverzeichnis entfernen, nachdem Create es
// gesehen hat, aber bevor das darunterliegende Verzeichnis angelegt ist. Create
// muss die Elternkette dann erneut anlegen statt mit ENOENT zu scheitern
// (CI-Fehler in TestConcurrentCreateAndDeleteInSameJob).
func TestCreateRetriesWhenParentVanishesDuringMkdir(t *testing.T) {
	s := newStorage(t)
	job := newID(t)
	jobDir, err := s.Path(storage.JobKey(job))
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(jobDir, storage.DirMode); err != nil {
		t.Fatal(err)
	}
	removed := false
	restore := storage.SetBeforeMkdirHook(func(string) {
		if !removed {
			removed = true
			if err := os.RemoveAll(jobDir); err != nil {
				t.Error(err)
			}
		}
	})
	defer restore()

	w, err := s.Create(storage.ResultKey(job, newID(t), newID(t)))
	if err != nil {
		t.Fatalf("Create nach verschwundenem Jobverzeichnis: %v", err)
	}
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
	if !removed {
		t.Fatal("Hook wurde nicht ausgelöst")
	}
}

func TestFreeBytes(t *testing.T) {
	s := newStorage(t)
	free, err := s.FreeBytes()
	if runtime.GOOS != "linux" {
		if !errors.Is(err, errors.ErrUnsupported) {
			t.Fatalf("FreeBytes = %v", err)
		}
		return
	}
	if err != nil || free == 0 {
		t.Fatalf("FreeBytes = %d, %v", free, err)
	}
}

func TestCheckWritable(t *testing.T) {
	dir := t.TempDir()
	if err := storage.CheckWritable(dir); err != nil {
		t.Fatal(err)
	}
	if entries, _ := os.ReadDir(dir); len(entries) != 0 {
		t.Fatalf("Probedatei blieb: %v", entries)
	}
	if err := storage.CheckWritable(filepath.Join(dir, "fehlt")); err == nil {
		t.Fatal("fehlendes Verzeichnis gilt als bereit")
	}
	file := filepath.Join(dir, "datei")
	_ = os.WriteFile(file, nil, 0o600)
	if err := storage.CheckWritable(file); err == nil {
		t.Fatal("Datei gilt als bereit")
	}
	if runtime.GOOS != "windows" && os.Geteuid() != 0 {
		ro := t.TempDir()
		if err := os.Chmod(ro, 0o500); err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = os.Chmod(ro, 0o700) })
		if err := storage.CheckWritable(ro); err == nil {
			t.Fatal("schreibgeschütztes Verzeichnis gilt als bereit")
		}
	}
}
