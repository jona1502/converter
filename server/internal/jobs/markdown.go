package jobs

import (
	"bufio"
	"errors"
	"io"
	"unicode"
	"unicode/utf8"
)

// ErrInvalidMarkdown identifies invalid text rather than transport/storage failures.
var ErrInvalidMarkdown = errors.New("jobs: ungültiger Markdown-Text")

// ValidateMarkdown reads the complete bounded upload, including bytes beyond
// the sniff window. ReadRune carries UTF-8 sequences across reader boundaries.
// It consumes invalid sources too so byte limits take precedence consistently.
func ValidateMarkdown(source io.Reader) (int64, error) {
	reader := bufio.NewReader(source)
	var size int64
	valid, content := true, false
	for {
		r, n, err := reader.ReadRune()
		if err == io.EOF {
			break
		}
		if err != nil {
			return size, err
		}
		first := size == 0
		size += int64(n)
		if first && r == '\ufeff' {
			continue
		}
		if (r == utf8.RuneError && n == 1) || (r < 32 && r != '\t' && r != '\r' && r != '\n') || (r >= 127 && r <= 159) {
			valid = false
		}
		if !unicode.IsSpace(r) {
			content = true
		}
	}
	if !valid || !content {
		return size, ErrInvalidMarkdown
	}
	return size, nil
}
