package endpoints

import (
	"context"
	"encoding/binary"
	"errors"
	"image"
	_ "image/png"
	"io"
	"os"
	"time"

	_ "golang.org/x/image/webp"

	"miconverter/server/internal/apitypes"
	"miconverter/server/internal/config"
	"miconverter/server/internal/httpapi"
)

var errHeader = errors.New("ungÃ¼ltiger Bildkopf")

type fileHeader struct {
	file  *os.File
	size  int64
	ctx   context.Context
	cache []byte
	base  int64
	reads int
}

func (f *fileHeader) read(at int64, n int) ([]byte, error) {
	if err := f.ctx.Err(); err != nil {
		return nil, err
	}
	f.reads++
	if f.reads > 1_000_000 {
		return nil, errHeader
	}
	if at < 0 || n < 0 || at > f.size-int64(n) {
		return nil, errHeader
	}
	if at < f.base || at+int64(n) > f.base+int64(len(f.cache)) {
		f.base = at
		f.cache = make([]byte, min(int64(max(n, 65536)), f.size-at))
		got, err := f.file.ReadAt(f.cache, at)
		f.cache = f.cache[:got]
		if err != nil && !errors.Is(err, io.EOF) {
			return nil, err
		}
	}
	if at+int64(n) > f.base+int64(len(f.cache)) {
		return nil, errHeader
	}
	b := make([]byte, n)
	copy(b, f.cache[at-f.base:at-f.base+int64(n)])
	return b, nil
}
func le16(b []byte) int64 { return int64(binary.LittleEndian.Uint16(b)) }
func le32(b []byte) int64 { return int64(binary.LittleEndian.Uint32(b)) }
func be32(b []byte) int64 { return int64(binary.BigEndian.Uint32(b)) }
func dimensions(w, h int64, cfg *config.Config) error {
	if w <= 0 || h <= 0 {
		return httpapi.NewError(415, apitypes.CodeUnsupportedType, "Bildkopf ist beschÃ¤digt.")
	}
	if w > int64(cfg.ImageMaxEdge) || h > int64(cfg.ImageMaxEdge) || w > cfg.ImageMaxPixels/h {
		return httpapi.NewError(422, apitypes.CodeDimensionsTooLarge, "Bildabmessungen Ã¼berschreiten das Limit.")
	}
	return nil
}
func animated() error {
	return httpapi.NewError(422, apitypes.CodeAnimatedUnsupported, "Animierte Bilder werden nicht unterstÃ¼tzt.")
}

func probeImage(ctx context.Context, file *os.File, size int64, format string, cfg *config.Config) error {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	f := fileHeader{file: file, size: size, ctx: ctx}
	var w, h int64
	var err error
	switch format {
	case "jpeg":
		p := int64(2)
		for p < size {
			b, e := f.read(p, 1)
			if e != nil {
				return e
			}
			p++
			if b[0] != 255 {
				continue
			}
			for {
				b, e = f.read(p, 1)
				if e != nil {
					return e
				}
				p++
				if b[0] != 255 {
					break
				}
			}
			marker := b[0]
			if marker == 0xd9 || marker == 0xda {
				break
			}
			if marker == 0x01 || (marker >= 0xd0 && marker <= 0xd7) {
				continue
			}
			b, e = f.read(p, 2)
			if e != nil {
				return e
			}
			length := int64(binary.BigEndian.Uint16(b))
			if length < 2 || p > size-length {
				return errHeader
			}
			if marker >= 0xc0 && marker <= 0xcf && marker != 0xc4 && marker != 0xc8 && marker != 0xcc {
				b, e = f.read(p+2, 5)
				if e != nil {
					return e
				}
				h = int64(binary.BigEndian.Uint16(b[1:]))
				w = int64(binary.BigEndian.Uint16(b[3:]))
				break
			}
			p += length
		}
	case "png":
		b, e := f.read(16, 8)
		if e != nil {
			return e
		}
		w, h = be32(b), be32(b[4:])
		if e = dimensions(w, h, cfg); e != nil {
			return e
		}
		for p := int64(8); p < size; {
			b, e = f.read(p, 8)
			if e != nil {
				return e
			}
			n := be32(b)
			if n > size-p-12 {
				return errHeader
			}
			kind := string(b[4:])
			if kind == "acTL" {
				return animated()
			}
			p += n + 12
			if kind == "IEND" {
				break
			}
		}
	case "gif":
		b, e := f.read(6, 7)
		if e != nil {
			return e
		}
		w, h = le16(b), le16(b[2:])
		if e = dimensions(w, h, cfg); e != nil {
			return e
		}
		p := int64(13)
		if b[4]&0x80 != 0 {
			p += 3 * (1 << ((b[4] & 7) + 1))
		}
		frames := 0
		skip := func() error {
			for {
				b, e := f.read(p, 1)
				if e != nil {
					return e
				}
				p++
				n := int64(b[0])
				if n == 0 {
					return nil
				}
				if p > size-n {
					return errHeader
				}
				p += n
			}
		}
		for p < size {
			b, e = f.read(p, 1)
			if e != nil {
				return e
			}
			p++
			switch b[0] {
			case 0x3b:
				p = size
			case 0x21:
				p++
				if e = skip(); e != nil {
					return e
				}
			case 0x2c:
				frames++
				if frames > 1 {
					return animated()
				}
				b, e = f.read(p, 9)
				if e != nil {
					return e
				}
				p += 9
				if e = dimensions(max(w, le16(b[4:])), max(h, le16(b[6:])), cfg); e != nil {
					return e
				}
				if b[8]&0x80 != 0 {
					p += 3 * (1 << ((b[8] & 7) + 1))
				}
				p++
				if e = skip(); e != nil {
					return e
				}
			default:
				return errHeader
			}
		}
	case "webp":
		for p := int64(12); p+8 <= size; {
			b, e := f.read(p, 8)
			if e != nil {
				return e
			}
			n := le32(b[4:])
			if n > size-p-8 {
				return errHeader
			}
			if string(b[:4]) == "ANIM" {
				return animated()
			}
			if string(b[:4]) == "VP8X" {
				flags, e := f.read(p+8, 1)
				if e != nil {
					return e
				}
				if flags[0]&2 != 0 {
					return animated()
				}
			}
			p += 8 + n + (n & 1)
		}
		conf, _, e := image.DecodeConfig(io.NewSectionReader(file, 0, size))
		if e != nil {
			return e
		}
		w, h = int64(conf.Width), int64(conf.Height)
	case "bmp":
		b, e := f.read(14, 4)
		if e != nil {
			return e
		}
		dib := le32(b)
		if dib == 12 {
			b, e = f.read(18, 4)
			if e != nil {
				return e
			}
			w, h = le16(b), le16(b[2:])
		} else {
			b, e = f.read(18, 8)
			if e != nil {
				return e
			}
			w = int64(int32(binary.LittleEndian.Uint32(b)))
			h = int64(int32(binary.LittleEndian.Uint32(b[4:])))
			if h < 0 {
				h = -h
			}
		}
	case "ico":
		b, e := f.read(4, 2)
		if e != nil {
			return e
		}
		count := int(le16(b))
		if count == 0 || int64(6+16*count) > size {
			return errHeader
		}
		var selected []byte
		for i := 0; i < count; i++ {
			entry, e := f.read(int64(6+16*i), 16)
			if e != nil {
				return e
			}
			ew, eh := int64(entry[0]), int64(entry[1])
			if ew == 0 {
				ew = 256
			}
			if eh == 0 {
				eh = 256
			}
			if ew*eh > w*h {
				w, h = ew, eh
				selected = entry
			}
		}
		offset, length := le32(selected[12:]), le32(selected[8:])
		if offset < int64(6+16*count) || length <= 0 || offset > size-length {
			return errHeader
		}
		b, e = f.read(offset, 16)
		if e != nil {
			return e
		}
		if string(b[:8]) == "\x89PNG\r\n\x1a\n" {
			b, e = f.read(offset+16, 8)
			if e != nil {
				return e
			}
			w, h = be32(b), be32(b[4:])
		} else {
			dib := le32(b)
			if dib == 12 {
				w, h = le16(b[4:]), le16(b[6:])/2
			} else {
				w, h = le32(b[4:]), le32(b[8:])/2
			}
		}
	case "avif":
		w, h, err = probeAVIF(&f)
	default:
		return errHeader
	}
	if err != nil {
		return err
	}
	return dimensions(w, h, cfg)
}
