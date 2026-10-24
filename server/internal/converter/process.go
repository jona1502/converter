package converter

import (
	"bufio"
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"runtime"
	"sync/atomic"
	"time"
)

// DefaultPython ist der feste Interpreter im Workerimage.
const DefaultPython = "/opt/venv/bin/python"

// Runner startet den Konverter mit fester Konfiguration. Interpreter,
// Argumente und Umgebung sind nicht von außen steuerbar; Tests setzen die
// unexportierten Felder im eigenen Paket.
type Runner struct {
	python string
	args   []string // vor dem Unterbefehl run|probe
	env    []string
	dir    string

	waitDelay    time.Duration // Nachlauf nach Kill/Exit für Pipes
	stderrLimit  int64         // darüber gilt stderr als Flut
	maxEvents    int           // absolute Obergrenze je Lauf
	eventBurst   float64       // Ereignis-Budget (Token-Bucket)
	eventRate    float64       // nachgefüllte Ereignisse pro Sekunde
	probeTimeout time.Duration
	now          func() time.Time
}

// NewRunner liefert den Runner für das Workerimage: `python -I -m
// converter.cli`, Umgebung nur PATH und LANG (keine DB-/Broker-Secrets).
func NewRunner() *Runner {
	return &Runner{
		python:       DefaultPython,
		args:         []string{"-I", "-m", "converter.cli"},
		env:          []string{"PATH=/opt/venv/bin:/usr/local/bin:/usr/bin:/bin", "LANG=C.UTF-8"},
		dir:          "/",
		waitDelay:    5 * time.Second,
		stderrLimit:  1 << 20,
		maxEvents:    100_000,
		eventBurst:   512,
		eventRate:    64,
		probeTimeout: 2 * time.Minute,
		now:          time.Now,
	}
}

var (
	errDeadline    = errors.New("converter: Zeitlimit")
	errStderrFlood = errors.New("converter: stderr-Flut")
	errEventFlood  = errors.New("converter: Ereignisflut")
)

// violation: der Kindprozess hat das Protokoll verletzt (ohne Pfade/Inhalte).
type violation struct{ reason string }

func (v *violation) Error() string { return "converter: Protokollverletzung: " + v.reason }

func violated(format string, args ...any) error {
	return &violation{reason: fmt.Sprintf(format, args...)}
}

// callbackError kapselt einen Fehler des Aufrufer-Callbacks.
type callbackError struct{ err error }

func (c *callbackError) Error() string { return "converter: Callback: " + c.err.Error() }
func (c *callbackError) Unwrap() error { return c.err }

type execResult struct {
	waitErr     error
	state       *os.ProcessState
	cause       error // nil, wenn der Prozess nicht von uns beendet wurde
	stderrBytes int64
	lines       int
	duration    time.Duration
}

type line struct {
	data []byte
	err  error
}

// execute startet `python <args> <command>`, schreibt stdin, liest stdout
// zeilenweise (≤ MaxLineBytes) und ruft handle je Zeile auf. Jeder Fehler aus
// handle, Ereignisflut, stderr-Flut, Zeitlimit oder ctx-Abbruch beendet die
// gesamte Prozessgruppe. execute kehrt erst zurück, wenn der Prozess
// ge-Wait-et ist und alle Lese-Goroutinen beendet sind.
func (r *Runner) execute(ctx context.Context, command string, stdin []byte, timeout time.Duration,
	handle func([]byte) error,
) (execResult, error) {
	// Pdeathsig gilt für den Thread, der fork ausführt: Thread bis nach Wait binden.
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()

	started := r.now()
	runCtx, cancel := context.WithCancelCause(ctx)
	defer cancel(nil)
	procCtx, stop := context.WithTimeoutCause(runCtx, timeout, errDeadline)
	defer stop()

	outR, outW, err := os.Pipe()
	if err != nil {
		return execResult{}, fmt.Errorf("converter: pipe: %w", err)
	}
	errR, errW, err := os.Pipe()
	if err != nil {
		_ = outR.Close()
		_ = outW.Close()
		return execResult{}, fmt.Errorf("converter: pipe: %w", err)
	}
	args := append(append([]string{}, r.args...), command)
	cmd := exec.CommandContext(procCtx, r.python, args...)
	cmd.Env = append([]string{}, r.env...)
	cmd.Dir = r.dir
	cmd.Stdin = bytes.NewReader(stdin)
	cmd.Stdout = outW
	cmd.Stderr = errW
	cmd.SysProcAttr = sysProcAttr()
	cmd.Cancel = func() error { return killGroup(cmd) }
	cmd.WaitDelay = r.waitDelay
	startErr := cmd.Start()
	// Schreibenden Enden gehören jetzt dem Kind; ohne Schließen käme nie EOF.
	_ = outW.Close()
	_ = errW.Close()
	if startErr != nil {
		_ = outR.Close()
		_ = errR.Close()
		return execResult{}, fmt.Errorf("converter: start: %w", startErr)
	}

	// stderr: parallel lesen, nur zählen, nie Inhalte übernehmen.
	var stderrBytes atomic.Int64
	stderrDone := make(chan struct{})
	go func() {
		defer close(stderrDone)
		buf := make([]byte, 32*1024)
		for {
			n, err := errR.Read(buf)
			if stderrBytes.Add(int64(n)) > r.stderrLimit {
				cancel(errStderrFlood)
			}
			if err != nil {
				return
			}
		}
	}()

	// stdout: Zeilen mit Längengrenze; Kanal wird immer geschlossen.
	lines := make(chan line, 16)
	go func() {
		defer close(lines)
		reader := bufio.NewReaderSize(outR, MaxLineBytes)
		for {
			data, err := reader.ReadSlice('\n')
			switch {
			case err == nil:
				lines <- line{data: bytes.Clone(data[:len(data)-1])}
				continue
			case errors.Is(err, bufio.ErrBufferFull):
				lines <- line{err: violated("Zeile länger als %d Bytes", MaxLineBytes)}
			case errors.Is(err, io.EOF) && len(data) > 0:
				lines <- line{err: violated("letzte Zeile ohne Zeilenende")}
			case errors.Is(err, io.EOF), errors.Is(err, os.ErrClosed):
			default:
				lines <- line{err: violated("stdout nicht lesbar")}
			}
			return
		}
	}()

	waitDone := make(chan error, 1)
	go func() { waitDone <- cmd.Wait() }()

	var (
		res       execResult
		stopped   bool
		tokens    = r.eventBurst
		lastToken = r.now()
		grace     <-chan time.Time
		waited    bool
		linesOpen = true
		errOpen   = true
	)
	stopWith := func(cause error) {
		if !stopped {
			stopped = true
			cancel(cause)
		}
	}
	for linesOpen || !waited || errOpen {
		select {
		case l, ok := <-lines:
			if !ok {
				linesOpen, lines = false, nil
				continue
			}
			// Nach Abbruch (eigener Stopp, Zeitlimit, ctx, stderr-Flut) keine
			// Ereignisse mehr ausliefern, nur noch leeren.
			if stopped || procCtx.Err() != nil {
				continue
			}
			if l.err != nil {
				stopWith(l.err)
				continue
			}
			res.lines++
			now := r.now()
			tokens = min(r.eventBurst, tokens+now.Sub(lastToken).Seconds()*r.eventRate)
			lastToken = now
			if res.lines > r.maxEvents || tokens < 1 {
				stopWith(errEventFlood)
				continue
			}
			tokens--
			if err := handle(l.data); err != nil {
				stopWith(err)
			}
		case <-stderrDone:
			errOpen, stderrDone = false, nil
		case err := <-waitDone:
			waited, waitDone = true, nil
			res.waitErr = err
			// Hält ein entkommener Prozess die Pipes offen, nach kurzer Frist
			// Gruppe beenden und Lesen abbrechen.
			grace = time.After(r.waitDelay)
		case <-grace:
			grace = nil
			_ = killGroup(cmd)
			_ = outR.Close()
			_ = errR.Close()
		}
	}
	_ = outR.Close()
	_ = errR.Close()
	res.state = cmd.ProcessState
	res.stderrBytes = stderrBytes.Load()
	res.duration = r.now().Sub(started)
	if procCtx.Err() != nil {
		res.cause = context.Cause(procCtx)
	}
	return res, nil
}
