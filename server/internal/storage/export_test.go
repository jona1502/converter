package storage

// SetBeforeMkdirHook setzt testHookBeforeMkdir und liefert eine Funktion,
// die den vorherigen Zustand wiederherstellt.
func SetBeforeMkdirHook(hook func(dir string)) (restore func()) {
	previous := testHookBeforeMkdir
	testHookBeforeMkdir = hook
	return func() { testHookBeforeMkdir = previous }
}
