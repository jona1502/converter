package endpoints

import (
	"archive/zip"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"

	"miconverter/server/internal/apitypes"
	"miconverter/server/internal/httpapi"
	"miconverter/server/internal/storage"
	"miconverter/server/internal/store"
)

// Obergrenze angefragter Aufträge je Archiv; entspricht jobs.maxBatchFiles der Capabilities.
const maxArchiveJobs = 30

// archiveSkippedName listet Aufträge, die nicht im Archiv gelandet sind.
const archiveSkippedName = "_uebersprungen.txt"

var skipReasons = map[string]string{
	store.SkipNotFound: "Auftrag nicht gefunden",
	store.SkipExpired:  "Auftrag abgelaufen",
	store.SkipFailed:   "Konvertierung fehlgeschlagen",
	store.SkipPending:  "noch in Verarbeitung",
	"file-missing":     "Ergebnisdatei nicht mehr vorhanden",
}

type archiveFile struct {
	name string
	size int64
	file *os.File
}

// uniqueArchiveName macht Namen ohne Beachtung der Groß-/Kleinschreibung
// eindeutig ("a.mp3", "a-2.mp3", ...), wie makeUniqueFileNames im Frontend.
func uniqueArchiveName(taken map[string]bool, name string) string {
	candidate := name
	if taken[strings.ToLower(candidate)] {
		stem, ext := name, ""
		if dot := strings.LastIndexByte(name, '.'); dot > 0 {
			stem, ext = name[:dot], name[dot:]
		}
		for n := 2; taken[strings.ToLower(candidate)]; n++ {
			candidate = fmt.Sprintf("%s-%d%s", stem, n, ext)
		}
	}
	taken[strings.ToLower(candidate)] = true
	return candidate
}

// archive streamt die Ergebnisse mehrerer eigener Aufträge als ZIP
// (GET /jobs/archive?job_id=…&job_id=…). Nicht fertige, fehlgeschlagene,
// abgelaufene oder fremde Aufträge werden übersprungen und in
// _uebersprungen.txt aufgeführt. Lease und Zeitlimit wie beim Einzeldownload.
func (a *API) archive(w http.ResponseWriter, r *http.Request) error {
	session, err := a.auth.RequireSession(r.Context(), r)
	if err != nil {
		return err
	}
	owner, _ := parseID(session.ID)
	raw := r.URL.Query()["job_id"]
	if len(raw) == 0 || len(raw) > maxArchiveJobs {
		return httpapi.NewError(400, apitypes.CodeInvalidRequest, fmt.Sprintf("Es sind 1 bis %d Aufträge erforderlich.", maxArchiveJobs))
	}
	ids := make([][16]byte, 0, len(raw))
	seen := map[[16]byte]bool{}
	for _, s := range raw {
		id, err := parseID(s)
		if err != nil {
			return err
		}
		if !seen[id] {
			seen[id] = true
			ids = append(ids, id)
		}
	}
	items, err := store.LeaseArchive(r.Context(), a.pool, owner, ids, a.cfg.DownloadMax)
	if err != nil {
		return err
	}
	var files []archiveFile
	defer func() {
		for _, f := range files {
			f.file.Close()
		}
	}()
	var skipped []string
	taken := map[string]bool{strings.ToLower(archiveSkippedName): true}
	for _, item := range items {
		reason := item.Skipped
		for _, res := range item.Results {
			file, err := a.files.Open(res.StorageKey)
			if errors.Is(err, os.ErrNotExist) {
				reason = "file-missing"
				continue
			}
			if err != nil {
				return err
			}
			files = append(files, archiveFile{uniqueArchiveName(taken, res.DownloadName), res.Size, file})
		}
		if reason != "" && (item.Skipped != "" || len(item.Results) > 0) {
			name := item.InputName
			if name == "" {
				name = storage.FormatUUID(item.ID)
			}
			skipped = append(skipped, fmt.Sprintf("%s: %s", name, skipReasons[reason]))
		}
	}
	if len(files) == 0 {
		return store.ErrResultNotFound
	}
	h := w.Header()
	h.Set("Content-Type", "application/zip")
	h.Set("Content-Disposition", `attachment; filename="ergebnisse.zip"`)
	h.Set("Content-Security-Policy", "sandbox")
	h.Set("Cache-Control", "private, no-store")
	controller := http.NewResponseController(w)
	if err = controller.SetWriteDeadline(time.Now().Add(a.cfg.DownloadMax)); err != nil && !errors.Is(err, http.ErrNotSupported) {
		return err
	}
	defer controller.SetWriteDeadline(time.Time{})
	zw := zip.NewWriter(w)
	// Ergebnisse sind bereits komprimierte Formate; Store spart CPU.
	for _, f := range files {
		entry, err := zw.CreateHeader(&zip.FileHeader{Name: f.name, Method: zip.Store, Modified: time.Now()})
		if err == nil {
			_, err = io.Copy(entry, io.LimitReader(f.file, f.size))
		}
		if err != nil {
			panic(http.ErrAbortHandler)
		}
	}
	if len(skipped) > 0 {
		entry, err := zw.CreateHeader(&zip.FileHeader{Name: archiveSkippedName, Method: zip.Deflate, Modified: time.Now()})
		if err == nil {
			_, err = io.WriteString(entry, "Nicht im Archiv enthalten:\n"+strings.Join(skipped, "\n")+"\n")
		}
		if err != nil {
			panic(http.ErrAbortHandler)
		}
	}
	if err = zw.Close(); err != nil {
		panic(http.ErrAbortHandler)
	}
	return nil
}
