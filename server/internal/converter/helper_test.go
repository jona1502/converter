package converter

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"runtime"
	"strings"
	"syscall"
	"testing"
	"time"
)

// Fake-Konverter: Der Testbinary startet sich selbst als Kindprozess
// (GO_WANT_HELPER_PROCESS). Das Szenario steht in FAKE_SCENARIO; beide
// Variablen setzt nur der Test über das unexportierte Runner-Feld env.

// helperModes erlaubt weiteren Testdateien (z. B. Integration) eigene Modi.
var helperModes = map[string]func() int{}

func TestMain(m *testing.M) {
	if os.Getenv("GO_WANT_HELPER_PROCESS") == "1" {
		if mode, ok := helperModes[os.Getenv("HELPER_MODE")]; ok {
			os.Exit(mode())
		}
		os.Exit(fakeMain(os.Args[1:]))
	}
	os.Exit(m.Run())
}

const (
	imageDetails = `{"format":"jpeg","width":160,"height":100,"sourceWidth":320,"sourceHeight":200,` +
		`"upscaled":false,"transparencyFlattened":false,"qualityApplied":true}`
	pdfDetails = `{"originalSize":1000,"imagesRecompressed":1,"imagesResized":0,"imagesSkipped":0,` +
		`"imagesNotSmaller":0,"streamsCompressed":2,"objectsRemoved":0,"notes":[{"code":"image-size-unknown","count":1}]}`
	pdfAnalysis = `{"fileSize":1000,"pdfVersion":"1.7","pageCount":1,"encrypted":false,"images":{"total":1,` +
		`"recompressible":1,"skipped":{},"byFilter":{"dct":0,"flate":1,"none":0,"other":0},"bytes":500,` +
		`"recompressibleBytes":500,"maskCount":0},"fontBytes":0,"limitations":[{"code":"image-size-unknown","count":1}]}`
	probeOK = `{"protocolVersion":1,"inputFormats":["jpeg","png","webp","gif","bmp","ico","avif"],` +
		`"outputFormats":["jpeg","png","webp","bmp","ico"],"pdf":true,` +
		`"audio":{"inputFormats":["mp3","wav","flac","ogg"],"outputFormats":["mp3","wav","flac","ogg"]},` +
		`"markdown":{"available":true},"versions":{"python":"3.13.17","pillow":"13.0.0","pikepdf":"10.17.0","qpdf":"12.4.2",` +
		`"soundfile":"0.14.0","libsndfile":"1.2.2","numpy":"2.5.4"}}`
)

func emit(line string) { _, _ = os.Stdout.WriteString(line + "\n") }

func writeResult(path string, n int) {
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_TRUNC, 0)
	if err != nil {
		os.Exit(70)
	}
	_, _ = f.Write([]byte(strings.Repeat("x", n)))
	_ = f.Close()
}

func selfSignal(name string) int {
	// Go-Laufzeit fängt viele Signale ab; /bin/sh beendet sich echt per Signal.
	_ = syscall.Exec("/bin/sh", []string{"sh", "-c", "kill -" + name + " $$"}, nil)
	return 71
}

func fakeMain(args []string) int {
	scenario := os.Getenv("FAKE_SCENARIO")
	if len(args) == 1 && args[0] == "probe" {
		switch scenario {
		case "probe-ok":
			emit(probeOK)
		case "probe-missing":
			emit(strings.Replace(probeOK, `,"avif"`, "", 1))
		case "probe-fatal":
			emit(`{"kind":"fatal","code":"sandbox-failed"}`)
			return 1
		case "probe-two-lines":
			emit(probeOK)
			emit(probeOK)
		case "probe-unknown-field":
			emit(strings.Replace(probeOK, `"pdf":true`, `"pdf":true,"extra":1`, 1))
		case "probe-exit":
			emit(probeOK)
			return 3
		}
		return 0
	}
	if len(args) != 1 || args[0] != "run" {
		return 2
	}
	raw, _ := io.ReadAll(io.LimitReader(os.Stdin, MaxRequestBytes+1))
	var req wireRequest
	if err := json.Unmarshal(raw, &req); err != nil || req.ProtocolVersion != 1 {
		emit(`{"kind":"fatal","code":"protocol-error"}`)
		return 1
	}
	if os.Getenv("FAKE_ECHO_REQUEST") != "" {
		_ = os.WriteFile(os.Getenv("FAKE_ECHO_REQUEST"), raw, 0o600)
	}
	first := req.Results[0]
	result := func(r wireResult, details string) {
		emit(fmt.Sprintf(`{"kind":"result","id":%q,"details":%s}`, r.ID, details))
	}
	progress := func(level string, cur, total int) {
		emit(fmt.Sprintf(`{"kind":"progress","phase":"variant","progress":{"step":"variant","level":%q,"current":%d,"total":%d}}`, level, cur, total))
	}
	switch scenario {
	case "image":
		emit(`{"kind":"progress","phase":"encode"}`)
		writeResult(first.Path, 100)
		result(first, imageDetails)
	case "image-error":
		emit(`{"kind":"progress","phase":"encode"}`)
		emit(fmt.Sprintf(`{"kind":"error","id":%q,"code":"decode-failed"}`, first.ID))
	case "pdf", "pdf-partial":
		emit(`{"kind":"analysis","analysis":` + pdfAnalysis + `}`)
		for i, r := range req.Results {
			progress(*r.Level, 0, 1)
			progress(*r.Level, 1, 1)
			if scenario == "pdf-partial" && i == 1 {
				emit(fmt.Sprintf(`{"kind":"error","id":%q,"code":"save-failed"}`, r.ID))
				continue
			}
			writeResult(r.Path, 1000)
			result(r, pdfDetails)
		}
	case "pdf-no-analysis":
		writeResult(first.Path, 10)
		result(first, pdfDetails)
	case "pdf-analysis-twice":
		emit(`{"kind":"analysis","analysis":` + pdfAnalysis + `}`)
		emit(`{"kind":"analysis","analysis":` + pdfAnalysis + `}`)
	case "pdf-wrong-level":
		emit(`{"kind":"analysis","analysis":` + pdfAnalysis + `}`)
		progress("small", 0, 1)
	case "pdf-out-of-order":
		emit(`{"kind":"analysis","analysis":` + pdfAnalysis + `}`)
		writeResult(req.Results[1].Path, 10)
		result(req.Results[1], pdfDetails)
	case "pdf-duplicate":
		emit(`{"kind":"analysis","analysis":` + pdfAnalysis + `}`)
		writeResult(first.Path, 10)
		result(first, pdfDetails)
		result(first, pdfDetails)
	case "pdf-budget":
		emit(`{"kind":"analysis","analysis":` + pdfAnalysis + `}`)
		for _, r := range req.Results {
			writeResult(r.Path, 600)
			result(r, pdfDetails)
		}
	case "after-last":
		writeResult(first.Path, 10)
		result(first, imageDetails)
		emit(`{"kind":"progress","phase":"encode"}`)
	case "long-line":
		emit(strings.Repeat("a", MaxLineBytes+10))
	case "no-newline":
		_, _ = os.Stdout.WriteString(`{"kind":"progress","phase":"encode"}`)
	case "invalid-json":
		emit("nope")
	case "unknown-kind":
		emit(`{"kind":"hello"}`)
	case "unknown-field":
		emit(`{"kind":"progress","phase":"encode","x":1}`)
	case "case-field":
		emit(`{"Kind":"progress","phase":"encode"}`)
	case "unknown-id":
		emit(`{"kind":"result","id":"00000000-0000-4000-8000-000000000999","details":` + imageDetails + `}`)
	case "bad-details":
		writeResult(first.Path, 10)
		result(first, strings.Replace(imageDetails, `"format":"jpeg"`, `"format":"jpeg","name":"/etc/x"`, 1))
	case "bad-code":
		emit(fmt.Sprintf(`{"kind":"error","id":%q,"code":"/etc/passwd"}`, first.ID))
	case "empty-result":
		result(first, imageDetails)
	case "symlink":
		_ = os.Remove(first.Path)
		_ = os.Symlink("/etc/hostname", first.Path)
		result(first, imageDetails)
	case "oversize":
		writeResult(first.Path, 5000)
		result(first, imageDetails)
	case "flood":
		for {
			emit(`{"kind":"progress","phase":"encode"}`)
		}
	case "stderr-flood":
		chunk := strings.Repeat("e", 64*1024)
		for {
			_, _ = os.Stderr.WriteString(chunk)
		}
	case "fatal":
		emit(`{"kind":"fatal","code":"encrypted"}`)
		return 1
	case "fatal-internal":
		emit(`{"kind":"fatal","code":"sandbox-failed"}`)
		return 1
	case "after-fatal":
		emit(`{"kind":"fatal","code":"encrypted"}`)
		emit(`{"kind":"progress","phase":"encode"}`)
		return 1
	case "sigalrm":
		return selfSignal("ALRM")
	case "sigxcpu":
		return selfSignal("XCPU")
	case "sigkill":
		return selfSignal("KILL")
	case "sigsegv":
		return selfSignal("SEGV")
	case "exit3":
		return 3
	case "silent":
		return 0
	case "hang", "hang-after-progress":
		if scenario == "hang-after-progress" {
			emit(`{"kind":"progress","phase":"encode"}`)
		}
		grandchild := exec.Command(os.Args[0])
		grandchild.Env = []string{"GO_WANT_HELPER_PROCESS=1", "FAKE_SCENARIO=sleep"}
		if err := grandchild.Start(); err != nil {
			return 72
		}
		_ = os.WriteFile(os.Getenv("FAKE_PIDFILE"), []byte(fmt.Sprint(grandchild.Process.Pid)), 0o600)
		time.Sleep(time.Hour)
	case "sleep":
		time.Sleep(time.Hour)
	}
	return 0
}

// --- Testhilfen ---------------------------------------------------------------

func fakeRunner(scenario string, env ...string) *Runner {
	r := NewRunner()
	r.python = os.Args[0]
	r.args = nil
	r.env = append([]string{"GO_WANT_HELPER_PROCESS=1", "FAKE_SCENARIO=" + scenario}, env...)
	r.waitDelay = 500 * time.Millisecond
	return r
}

const (
	idA = "00000000-0000-4000-8000-00000000000a"
	idB = "00000000-0000-4000-8000-00000000000b"
	idC = "00000000-0000-4000-8000-00000000000c"
)

func newTarget(t *testing.T, dir, name string) string {
	t.Helper()
	path := dir + "/" + name
	f, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		t.Fatal(err)
	}
	_ = f.Close()
	return path
}

func imageRequest(t *testing.T) Request {
	t.Helper()
	dir := t.TempDir()
	source := newTarget(t, dir, "input")
	return Request{
		Source:      source,
		Options:     json.RawMessage(`{"tool":"image-convert","format":"jpeg"}`),
		Results:     []ResultTarget{{ID: idA, Path: newTarget(t, dir, "result")}},
		Limits:      DefaultLimits(),
		MemoryBytes: 1 << 30,
		Timeout:     30 * time.Second,
		OutputLimit: 104_857_600,
	}
}

func pdfRequest(t *testing.T) Request {
	t.Helper()
	dir := t.TempDir()
	return Request{
		Source:  newTarget(t, dir, "input"),
		Options: json.RawMessage(`{"tool":"pdf-compress"}`),
		Results: []ResultTarget{
			{ID: idA, Level: "high", Path: newTarget(t, dir, "high")},
			{ID: idB, Level: "balanced", Path: newTarget(t, dir, "balanced")},
			{ID: idC, Level: "small", Path: newTarget(t, dir, "small")},
		},
		Limits:      DefaultLimits(),
		MemoryBytes: 1 << 30,
		Timeout:     30 * time.Second,
		OutputLimit: 300_000_000,
	}
}

// noLeak prüft nach dem Test, dass keine Goroutinen übrig bleiben.
func noLeak(t *testing.T) {
	t.Helper()
	before := runtime.NumGoroutine()
	t.Cleanup(func() {
		deadline := time.Now().Add(5 * time.Second)
		for runtime.NumGoroutine() > before && time.Now().Before(deadline) {
			time.Sleep(10 * time.Millisecond)
		}
		if n := runtime.NumGoroutine(); n > before {
			buf := make([]byte, 1<<16)
			t.Errorf("Goroutine-Leck: vorher %d, nachher %d\n%s", before, n, buf[:runtime.Stack(buf, true)])
		}
	})
}

// gone meldet, ob ein Prozess beendet ist (nicht vorhanden oder Zombie).
func gone(pid int) bool {
	data, err := os.ReadFile(fmt.Sprintf("/proc/%d/stat", pid))
	if err != nil {
		return true
	}
	s := string(data)
	i := strings.LastIndexByte(s, ')')
	return i < 0 || i+2 >= len(s) || s[i+2] == 'Z' || s[i+2] == 'X'
}

func waitGone(t *testing.T, pid int) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for !gone(pid) {
		if time.Now().After(deadline) {
			t.Fatalf("Prozess %d lebt noch", pid)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func readPid(t *testing.T, path string) int {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for {
		data, err := os.ReadFile(path)
		if err == nil && len(data) > 0 {
			var pid int
			if _, err := fmt.Sscan(string(data), &pid); err == nil {
				return pid
			}
		}
		if time.Now().After(deadline) {
			t.Fatal("keine PID-Datei")
		}
		time.Sleep(20 * time.Millisecond)
	}
}
