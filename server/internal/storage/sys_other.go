//go:build !unix

package storage

// Nur für Entwicklung außerhalb von Linux: kein O_NOFOLLOW, und Windows kann
// Verzeichnisse nicht für fsync öffnen. Symlinks prüft Local.Path trotzdem.
const oNoFollow = 0

func fsyncDir(string) error { return nil }
