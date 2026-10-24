// Machbarkeitslauf G01: Go startet den isolierten Python-Konverter direkt
// (ohne Shell), liest begrenzte JSONL-Ereignisse und prüft die erzeugte
// Datei unabhängig mit dem Go-JPEG-Decoder. Wegwerfcode, kein Produktcode.
package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"image"
	"image/color"
	"image/jpeg"
	"image/png"
	"os"
	"os/exec"
	"path/filepath"
	"syscall"
	"time"
)

const maxLine = 64 * 1024

type event struct {
	Kind     string          `json:"kind"`
	ID       string          `json:"id"`
	Code     string          `json:"code"`
	Size     int64           `json:"size"`
	Details  json.RawMessage `json:"details"`
	Phase    string          `json:"phase"`
	Progress json.RawMessage `json:"progress"`
	Analysis json.RawMessage `json:"analysis"`
}

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "FEHLER:", err)
		os.Exit(1)
	}
	fmt.Println("GO->PYTHON: OK")
}

func run() error {
	dir, err := os.MkdirTemp("", "g01-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(dir)

	source := filepath.Join(dir, "input")
	if err := writePNG(source, 320, 200); err != nil {
		return err
	}
	resultID := "00000000-0000-4000-8000-000000000001"
	output := filepath.Join(dir, "result")
	// Ergebnisdatei erzeugt Go exklusiv und privat; der Parser schreibt nur hinein.
	f, err := os.OpenFile(output, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	f.Close()

	request := map[string]any{
		"source": source,
		"options": map[string]any{
			"tool": "image-resize", "format": "jpeg", "quality": 0.8,
			"resize": map[string]any{"mode": "percent", "percent": 50, "allowUpscale": false},
		},
		"results": []map[string]any{{"id": resultID, "level": nil, "path": output}},
		"limits": map[string]any{
			"image_max_input_bytes": 52428800, "image_max_pixels": 40000000,
			"image_max_edge": 16384, "image_max_output_bytes": 104857600,
			"pdf_max_input_bytes": 100000000, "pdf_max_results_total_bytes": 300000000,
			"pdf_image_max_pixels": 40000000,
		},
		"memory": 1 << 30, "timeout": 30, "outputLimit": 104857600,
	}
	payload, err := json.Marshal(request)
	if err != nil {
		return err
	}

	ctx, cancel := context.WithTimeout(context.Background(), 40*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "/opt/venv/bin/python", "-m", "app.worker.child")
	cmd.Dir = "/app"
	cmd.Env = []string{"PATH=/opt/venv/bin:/usr/bin:/bin", "LANG=C.UTF-8"}
	cmd.Stdin = bytes.NewReader(payload)
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true, Pdeathsig: syscall.SIGKILL}
	// Beim Abbruch ganze Prozessgruppe beenden, nicht nur den direkten Kindprozess.
	cmd.Cancel = func() error { return syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL) }
	cmd.WaitDelay = 5 * time.Second
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return err
	}
	if err := cmd.Start(); err != nil {
		return err
	}

	var got *event
	scanner := bufio.NewScanner(stdout)
	scanner.Buffer(make([]byte, 0, 4096), maxLine)
	events := 0
	for scanner.Scan() {
		events++
		if events > 1000 {
			return errors.New("zu viele Ereignisse")
		}
		var ev event
		dec := json.NewDecoder(bytes.NewReader(scanner.Bytes()))
		dec.DisallowUnknownFields()
		if err := dec.Decode(&ev); err != nil {
			return fmt.Errorf("ungültiges Ereignis: %w", err)
		}
		fmt.Printf("Ereignis: %s\n", ev.Kind)
		switch ev.Kind {
		case "progress":
		case "result":
			if ev.ID != resultID {
				return errors.New("fremde result-ID")
			}
			got = &ev
		default:
			return fmt.Errorf("unerwartetes Ereignis %q (%s)", ev.Kind, ev.Code)
		}
	}
	if err := scanner.Err(); err != nil {
		return err
	}
	if err := cmd.Wait(); err != nil {
		return fmt.Errorf("Kindprozess: %w", err)
	}
	if got == nil {
		return errors.New("kein Ergebnis")
	}

	// Vertrauensgrenze: Größe aus dem Dateisystem, Format per unabhängigem Decoder.
	info, err := os.Stat(output)
	if err != nil {
		return err
	}
	in, err := os.Open(output)
	if err != nil {
		return err
	}
	defer in.Close()
	cfg, format, err := image.DecodeConfig(in)
	if err != nil {
		return fmt.Errorf("Ausgabe nicht dekodierbar: %w", err)
	}
	fmt.Printf("Ausgabe: %s %dx%d, %d Bytes (Parser meldete %d), details=%s\n",
		format, cfg.Width, cfg.Height, info.Size(), got.Size, got.Details)
	if format != "jpeg" || cfg.Width != 160 || cfg.Height != 100 {
		return errors.New("falsches Format oder falsche Abmessungen")
	}
	return nil
}

func writePNG(path string, w, h int) error {
	img := image.NewNRGBA(image.Rect(0, 0, w, h))
	for y := range h {
		for x := range w {
			img.Set(x, y, color.NRGBA{uint8(x), uint8(y), 128, 255})
		}
	}
	f, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	defer f.Close()
	return png.Encode(f, img)
}

var _ = jpeg.Decode // registriert den JPEG-Decoder für image.DecodeConfig
