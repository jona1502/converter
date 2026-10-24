package jobs_test

import (
	"bytes"
	"io"
	"math"
	"strings"
)

func bytesReader(b []byte) io.Reader { return bytes.NewReader(b) }

func containsAny(s, chars string) bool { return strings.ContainsAny(s, chars) }

func nanValue() float64 { return math.NaN() }
