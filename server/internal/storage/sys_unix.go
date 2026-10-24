//go:build unix

package storage

import (
	"fmt"
	"os"
	"syscall"
)

const oNoFollow = syscall.O_NOFOLLOW

// fsyncDir macht unter POSIX erst ein rename/unlink im Verzeichnis dauerhaft.
func fsyncDir(dir string) error {
	f, err := os.Open(dir)
	if err != nil {
		return fmt.Errorf("storage: Verzeichnis öffnen: %w", err)
	}
	syncErr := f.Sync()
	closeErr := f.Close()
	if syncErr != nil {
		return fmt.Errorf("storage: Verzeichnis-fsync: %w", syncErr)
	}
	return closeErr
}
