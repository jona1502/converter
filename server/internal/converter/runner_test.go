package converter

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"miconverter/server/internal/config"
	"miconverter/server/internal/jobs"
)

const resultID = "a7b5ad82-759d-4e3d-ab02-3eae25e2c1f3"

// TestProcessHelper is executed as a child test binary, never as a test in the
// parent. This exercises real pipes/process lifetime without a Python runtime.
func TestProcessHelper(t *testing.T) {
	mode := os.Getenv("CONVERTER_HELPER")
	if mode == "" {
		return
	}
	data, _ := io.ReadAll(os.Stdin)
	if mode == "sleep" {
		time.Sleep(20 * time.Second)
		os.Exit(0)
	}
	if mode == "flood" {
		fmt.Println(strings.Repeat("x", MaxLineBytes+1))
		os.Exit(0)
	}
	if mode == "stderr" {
		_, _ = os.Stderr.Write(make([]byte, 4096))
		os.Exit(0)
	}
	if mode == "bad" {
		fmt.Println(`{"kind":"result","id":"unknown"}`)
		os.Exit(0)
	}
	var req wireRequest
	_ = json.Unmarshal(data, &req)
	if mode == "incomplete" {
		os.Exit(0)
	}
	if mode == "valid" || mode == "extra" {
		_ = os.WriteFile(req.Results[0].Path, []byte("output"), 0600)
		fmt.Println(`{"kind":"progress","phase":"encode"}`)
		fmt.Printf("{\"kind\":\"result\",\"id\":%q,\"details\":{\"format\":\"png\",\"width\":1,\"height\":1,\"sourceWidth\":1,\"sourceHeight\":1,\"upscaled\":false,\"transparencyFlattened\":false,\"qualityApplied\":false}}\n", req.Results[0].ID)
		if mode == "extra" {
			fmt.Println(`{"kind":"progress","phase":"encode"}`)
		}
	}
	if mode == "audio" || mode == "audio-bad" || mode == "audio-large" {
		size := 6
		if mode == "audio-large" {
			size = 2048
		}
		_ = os.WriteFile(req.Results[0].Path, make([]byte, size), 0600)
		fmt.Println(`{"kind":"progress","phase":"encode"}`)
		channels := 2
		if mode == "audio-bad" {
			channels = 9
		}
		fmt.Printf("{\"kind\":\"result\",\"id\":%q,\"details\":{\"format\":\"mp3\",\"durationSeconds\":1.5,\"sampleRate\":44100,\"channels\":%d,\"qualityApplied\":true}}\n", req.Results[0].ID, channels)
	}
	os.Exit(0)
}

func helperRunner(mode string) *Runner {
	r := NewRunner()
	r.python = os.Args[0]
	r.args = []string{"-test.run=^TestProcessHelper$", "--"}
	r.env = []string{"CONVERTER_HELPER=" + mode, "PATH=" + os.Getenv("PATH"), "GORACE=atexit_sleep_ms=0"}
	r.dir = ""
	r.waitDelay = 100 * time.Millisecond
	return r
}

func requestFor(t *testing.T) Request {
	t.Helper()
	root := t.TempDir()
	source, target := filepath.Join(root, "input"), filepath.Join(root, "result")
	if err := os.WriteFile(source, []byte("input"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(target, nil, 0600); err != nil {
		t.Fatal(err)
	}
	return Request{Source: source, Options: json.RawMessage(`{"tool":"image-convert","format":"png"}`),
		Results: []ResultTarget{{ID: resultID, Path: target}}, Limits: DefaultLimits(),
		MemoryBytes: 1 << 30, Timeout: time.Second, OutputLimit: 104857600}
}

func TestRunnerRealSubprocessValidatesAndMeasuresResult(t *testing.T) {
	req := requestFor(t)
	var events []Event
	out, err := helperRunner("valid").Run(context.Background(), req, func(event Event) error { events = append(events, event); return nil })
	if err != nil || out.ErrorCode != "" || len(events) != 2 || events[1].Size != 6 || out.ExitCode != 0 {
		t.Fatalf("out=%+v err=%v events=%+v", out, err, events)
	}
}

func TestRunnerRejectsMalformedFloodAndIncompleteSubprocess(t *testing.T) {
	for _, mode := range []string{"bad", "flood", "incomplete", "extra", "stderr"} {
		t.Run(mode, func(t *testing.T) {
			r := helperRunner(mode)
			r.stderrLimit = 512
			out, err := r.Run(context.Background(), requestFor(t), func(Event) error { return nil })
			if err != nil || out.ErrorCode != CodeWorkerFailed {
				t.Fatalf("out=%+v err=%v", out, err)
			}
		})
	}
}

func TestRunnerTimeoutCancellationAndCallbackStop(t *testing.T) {
	t.Run("timeout", func(t *testing.T) {
		req := requestFor(t)
		out, err := helperRunner("sleep").Run(context.Background(), req, func(Event) error { return nil })
		if err != nil || out.ErrorCode != CodeTimeout || out.Duration > 3*time.Second {
			t.Fatalf("out=%+v err=%v", out, err)
		}
	})
	t.Run("cancel", func(t *testing.T) {
		ctx, cancel := context.WithTimeout(context.Background(), 40*time.Millisecond)
		defer cancel()
		_, err := helperRunner("sleep").Run(ctx, requestFor(t), func(Event) error { return nil })
		if !errors.Is(err, context.DeadlineExceeded) {
			t.Fatal(err)
		}
	})
	t.Run("callback", func(t *testing.T) {
		_, err := helperRunner("valid").Run(context.Background(), requestFor(t), func(Event) error { return errors.New("lease lost") })
		if !errors.Is(err, ErrCallback) {
			t.Fatal(err)
		}
	})
}

func TestCheckResultRejectsSymlinkEmptyAndOversize(t *testing.T) {
	req := requestFor(t)
	path := req.Results[0].Path
	if _, err := CheckResult(path, 10); !errors.Is(err, ErrEmptyResult) {
		t.Fatal(err)
	}
	_ = os.WriteFile(path, []byte("123456"), 0600)
	if _, err := CheckResult(path, 5); !errors.Is(err, ErrResultTooLarge) {
		t.Fatal(err)
	}
	link := filepath.Join(t.TempDir(), "link")
	if err := os.Symlink(path, link); err == nil {
		if _, err := CheckResult(link, 10); !errors.Is(err, ErrNotRegular) {
			t.Fatal(err)
		}
	}
}

func TestReportRoundtripRejectsStaleFutureAndSymlink(t *testing.T) {
	now := time.Now().UTC()
	report := Report{SchemaVersion: ReportSchemaVersion, ProtocolVersion: ProtocolVersion, GeneratedAt: now,
		InputFormats: RequiredInputFormats, OutputFormats: RequiredOutputFormats, PDF: true,
		Versions: Versions{Python: "3.13.17", Pillow: "13.0.0", Pikepdf: "10.17.0", Qpdf: "12.3"}}
	path := filepath.Join(t.TempDir(), ReportFile)
	if err := WriteReport(path, report); err != nil {
		t.Fatal(err)
	}
	if _, err := LoadReport(path, now, 15*time.Minute); err != nil {
		t.Fatal(err)
	}
	if _, err := LoadReport(path, now.Add(16*time.Minute), 15*time.Minute); !errors.Is(err, ErrReportStale) {
		t.Fatal(err)
	}
	if _, err := LoadReport(path, now.Add(-2*time.Minute), 15*time.Minute); !errors.Is(err, ErrReportStale) {
		t.Fatal(err)
	}
	link := filepath.Join(t.TempDir(), "link")
	if err := os.Symlink(path, link); err == nil {
		if _, err := LoadReport(link, now, time.Minute); !errors.Is(err, ErrReportInvalid) {
			t.Fatal(err)
		}
	}
}

func TestAdapterRetryRestrictsLevelsAndRemainingPDFBudget(t *testing.T) {
	cfg := &config.Config{ImageMaxInputBytes: 52428800, ImageMaxPixels: 40000000, ImageMaxEdge: 16384,
		ImageMaxOutputBytes: 104857600, PdfMaxInputBytes: 100000000, PdfMaxResultsTotalBytes: 300000000,
		PdfImageMaxPixels: 40000000, ImageTimeout: 120 * time.Second, PdfTimeout: 300 * time.Second,
		AudioMaxInputBytes: 104857600, AudioMaxDurationSeconds: 1800, AudioMaxChannels: 8,
		AudioMaxSampleRate: 192000, AudioMaxOutputBytes: 419430400, AudioTimeout: 300 * time.Second}
	processor := NewProcessor(nil, cfg)
	req, err := processor.request(jobs.Task{Tool: "pdf-compress", InputPath: "/data/input", OutputBudget: 250000000,
		Options: json.RawMessage(`{"tool":"pdf-compress","levels":["high","balanced","small"]}`),
		Results: []jobs.TaskResult{{ID: [16]byte{1}, Level: "small", Path: "/data/result"}}})
	if err != nil {
		t.Fatal(err)
	}
	var opts struct {
		Levels []string `json:"levels"`
	}
	_ = json.Unmarshal(req.Options, &opts)
	if len(opts.Levels) != 1 || opts.Levels[0] != "small" || req.OutputLimit != 250000000 || req.Limits.PdfMaxResultsTotalBytes != 250000000 {
		t.Fatalf("request=%+v options=%s", req, req.Options)
	}
}

func TestPublishLoopHonorsCancellation(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	start := time.Now()
	PublishLoop(ctx, helperRunner("sleep"), filepath.Join(t.TempDir(), "capabilities.json"), slog.New(slog.DiscardHandler))
	if time.Since(start) > time.Second {
		t.Fatal("publisher ignored cancellation")
	}
}
