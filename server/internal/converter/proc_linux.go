//go:build linux

package converter

import (
	"os"
	"os/exec"
	"syscall"
)

// sysProcAttr: eigene Prozessgruppe (Kill der ganzen Gruppe) und
// Parent-Death-Signal. Pdeathsig hängt am erzeugenden OS-Thread, daher
// läuft Start in einer per runtime.LockOSThread gebundenen Goroutine, die
// den Thread bis nach Wait hält.
func sysProcAttr() *syscall.SysProcAttr {
	return &syscall.SysProcAttr{Setpgid: true, Pdeathsig: syscall.SIGKILL}
}

// killGroup beendet die ganze Prozessgruppe des Kindes (inklusive Enkel).
func killGroup(cmd *exec.Cmd) error {
	if cmd.Process == nil {
		return nil
	}
	err := syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
	if err == syscall.ESRCH {
		return os.ErrProcessDone
	}
	return err
}

// exitSignal liefert das beendende Signal, falls der Prozess durch eines endete.
func exitSignal(state *os.ProcessState) (syscall.Signal, bool) {
	if state == nil {
		return 0, false
	}
	ws, ok := state.Sys().(syscall.WaitStatus)
	if !ok || !ws.Signaled() {
		return 0, false
	}
	return ws.Signal(), true
}

// signalCode bildet Signale wie backend/app/worker/runner.py ab.
func signalCode(sig syscall.Signal, killedByUs bool) string {
	switch sig {
	case syscall.SIGALRM, syscall.SIGXCPU:
		return CodeTimeout
	case syscall.SIGKILL, syscall.SIGSEGV:
		if !killedByUs {
			return CodeMemoryLimit
		}
	}
	return CodeWorkerFailed
}

// oNoFollow: Bericht nie über einen Symlink lesen.
const oNoFollow = syscall.O_NOFOLLOW
