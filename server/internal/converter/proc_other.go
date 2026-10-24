//go:build !linux

package converter

import (
	"os"
	"os/exec"
	"syscall"
)

// Nur damit das Paket auf Entwicklungsrechnern kompiliert. Der Konverter
// läuft ausschließlich im Linux-Workerimage; ohne Prozessgruppen und
// Pdeathsig fehlt hier die Isolation.

func sysProcAttr() *syscall.SysProcAttr { return nil }

func killGroup(cmd *exec.Cmd) error {
	if cmd.Process == nil {
		return nil
	}
	return cmd.Process.Kill()
}

func exitSignal(*os.ProcessState) (syscall.Signal, bool) { return 0, false }

func signalCode(syscall.Signal, bool) string { return CodeWorkerFailed }

const oNoFollow = 0
