package endpoints

import (
	"context"
	"io"
)

// headerGuard bounds MIME header buffering before mime/multipart sees bytes.
// The standard parser remains responsible for all actual MIME interpretation.
type headerGuard struct {
	source                    io.Reader
	ctx                       context.Context
	first, marker             []byte
	prefix                    []int
	initial, matched, headers int
	mode                      byte // 0 initial delimiter, 1 headers, 2 payload
	tail                      uint32
}

func guardHeaders(ctx context.Context, source io.Reader, boundary string) io.Reader {
	marker := []byte("\r\n--" + boundary + "\r\n")
	prefix := make([]int, len(marker))
	for i, j := 1, 0; i < len(marker); i++ {
		for j > 0 && marker[i] != marker[j] {
			j = prefix[j-1]
		}
		if marker[i] == marker[j] {
			j++
		}
		prefix[i] = j
	}
	return &headerGuard{source: source, ctx: ctx, first: []byte("--" + boundary + "\r\n"), marker: marker, prefix: prefix}
}
func (g *headerGuard) Read(p []byte) (int, error) {
	if err := g.ctx.Err(); err != nil {
		return 0, err
	}
	n, err := g.source.Read(p)
	for i, c := range p[:n] {
		switch g.mode {
		case 0:
			if c != g.first[g.initial] {
				return i, errHeader
			}
			g.initial++
			if g.initial == len(g.first) {
				g.mode = 1
			}
		case 1:
			g.headers++
			if g.headers > 8192 {
				return i, errHeader
			}
			g.tail = g.tail<<8 | uint32(c)
			if g.tail == 0x0d0a0d0a {
				g.mode = 2
				g.matched = 0
			}
		case 2:
			for g.matched > 0 && c != g.marker[g.matched] {
				g.matched = g.prefix[g.matched-1]
			}
			if c == g.marker[g.matched] {
				g.matched++
			}
			if g.matched == len(g.marker) {
				g.mode = 1
				g.headers = 0
				g.tail = 0
				g.matched = 0
			}
		}
	}
	return n, err
}
