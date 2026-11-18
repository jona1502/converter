package jobs

import (
	"bytes"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
)

// PDF-Zusammenführen bekommt mehrere Dateien, ein Auftrag kennt aber genau
// eine Eingabedatei. Die Teile werden deshalb beim Upload zu einem Bündel in
// der Spooldatei zusammengefasst, das der Python-Prozess wieder zerlegt.
//
// Format (Python-Gegenstück: converter/processing/pdf_merge/bundle.py):
//
//	"MIPDFMRG1\n"
//	je Datei: Blöcke [uint32 BE n > 0][n Bytes] ..., dann [uint32 0]
//	Ende: eine Datei ohne Blöcke (zweimal hintereinander uint32 0)
//
// Die Blockform erlaubt gestreamtes Schreiben ohne vorab bekannte Länge.
// Leere Dateien sind nie gültig, daher ist die leere Datei ein eindeutiges Ende.
const (
	BundleMagic     = "MIPDFMRG1\n"
	bundleChunkSize = 64 * 1024
)

// ErrBundleFile kennzeichnet eine einzelne unbrauchbare Datei (leer oder zu groß).
var ErrBundleFile = errors.New("jobs: ungültige PDF im Bündel")

// BundleWriter schreibt Dateien nacheinander als Bündel.
type BundleWriter struct {
	w       io.Writer
	written int64
	buf     []byte
	started bool
	closed  bool
}

// NewBundleWriter schreibt nichts, bis die erste Datei oder Close folgt.
func NewBundleWriter(w io.Writer) *BundleWriter {
	return &BundleWriter{w: w, buf: make([]byte, bundleChunkSize)}
}

// Written ist die Anzahl der bisher geschriebenen Bündelbytes.
func (b *BundleWriter) Written() int64 { return b.written }

func (b *BundleWriter) write(p []byte) error {
	n, err := b.w.Write(p)
	b.written += int64(n)
	return err
}

func (b *BundleWriter) start() error {
	if b.started {
		return nil
	}
	b.started = true
	return b.write([]byte(BundleMagic))
}

// AddFile kopiert höchstens limit Bytes von r als eine Datei. Es liefert die
// Dateigröße und die ersten Bytes (bis head Bytes) für die Formatprüfung.
// Mehr als limit Bytes ergeben ErrBundleFile; die Quelle wird dann nicht
// weitergelesen. Leere Dateien ergeben ErrBundleFile.
func (b *BundleWriter) AddFile(r io.Reader, limit int64, head int) (size int64, prefix []byte, err error) {
	if b.closed {
		return 0, nil, errors.New("jobs: Bündel bereits abgeschlossen")
	}
	if err = b.start(); err != nil {
		return 0, nil, err
	}
	var frame [4]byte
	for {
		want := min(int64(len(b.buf)), limit-size+1) // eines mehr, um Überschreitung zu erkennen
		n, rerr := io.ReadFull(io.LimitReader(r, want), b.buf[:want])
		if n > 0 {
			size += int64(n)
			if size > limit {
				return size, prefix, fmt.Errorf("%w: zu groß", ErrBundleFile)
			}
			if len(prefix) < head {
				prefix = append(prefix, b.buf[:min(n, head-len(prefix))]...)
			}
			binary.BigEndian.PutUint32(frame[:], uint32(n))
			if err = b.write(frame[:]); err != nil {
				return size, prefix, err
			}
			if err = b.write(b.buf[:n]); err != nil {
				return size, prefix, err
			}
		}
		if rerr == io.EOF || rerr == io.ErrUnexpectedEOF {
			break
		}
		if rerr != nil {
			return size, prefix, rerr
		}
	}
	if size == 0 {
		return 0, prefix, fmt.Errorf("%w: leer", ErrBundleFile)
	}
	binary.BigEndian.PutUint32(frame[:], 0)
	return size, prefix, b.write(frame[:])
}

// Close schreibt das Ende. Ohne Dateien entsteht ein Bündel ohne Inhalt.
func (b *BundleWriter) Close() error {
	if b.closed {
		return nil
	}
	b.closed = true
	if err := b.start(); err != nil {
		return err
	}
	return b.write([]byte{0, 0, 0, 0})
}

// SplitBundle zerlegt ein vollständiges Bündel (Tests und Gegenprobe zum
// Python-Leser). Fehler bei Formverstößen oder Resten nach dem Ende.
func SplitBundle(data []byte) ([][]byte, error) {
	if !bytes.HasPrefix(data, []byte(BundleMagic)) {
		return nil, errors.New("jobs: Bündelkopf fehlt")
	}
	rest := data[len(BundleMagic):]
	var files [][]byte
	var current []byte
	chunks := 0
	for {
		if len(rest) < 4 {
			return nil, errors.New("jobs: Bündel abgeschnitten")
		}
		n := int(binary.BigEndian.Uint32(rest))
		rest = rest[4:]
		if n == 0 {
			if chunks == 0 {
				if len(rest) != 0 {
					return nil, errors.New("jobs: Daten nach Bündelende")
				}
				return files, nil
			}
			files = append(files, current)
			current, chunks = nil, 0
			continue
		}
		if n > len(rest) {
			return nil, errors.New("jobs: Bündel abgeschnitten")
		}
		current = append(current, rest[:n]...)
		rest = rest[n:]
		chunks++
	}
}
