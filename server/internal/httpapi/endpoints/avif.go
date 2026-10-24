package endpoints

import "encoding/binary"

type avifBox struct {
	kind       string
	start, end int64
}

func boxes(f *fileHeader, start, end int64) ([]avifBox, error) {
	var result []avifBox
	for p := start; p < end; {
		b, err := f.read(p, 8)
		if err != nil {
			return nil, err
		}
		size, header := be32(b), int64(8)
		kind := string(b[4:])
		if size == 1 {
			b, err = f.read(p+8, 8)
			if err != nil {
				return nil, err
			}
			value := binary.BigEndian.Uint64(b)
			if value > uint64(f.size) {
				return nil, errHeader
			}
			size, header = int64(value), 16
		}
		if size == 0 {
			size = end - p
		}
		if size < header || size > end-p {
			return nil, errHeader
		}
		result = append(result, avifBox{kind: kind, start: p + header, end: p + size})
		if len(result) > 65536 {
			return nil, errHeader
		}
		p += size
	}
	return result, nil
}
func probeAVIF(f *fileHeader) (int64, int64, error) {
	root, err := boxes(f, 0, f.size)
	if err != nil {
		return 0, 0, err
	}
	var meta *avifBox
	for i, box := range root {
		switch box.kind {
		case "moov":
			return 0, 0, animated()
		case "ftyp":
			if box.end-box.start < 8 || box.end-box.start > 4096 {
				return 0, 0, errHeader
			}
			brands, e := f.read(box.start, int(box.end-box.start))
			if e != nil {
				return 0, 0, e
			}
			if string(brands[:4]) == "avis" {
				return 0, 0, animated()
			}
			for p := 8; p+4 <= len(brands); p += 4 {
				if string(brands[p:p+4]) == "avis" {
					return 0, 0, animated()
				}
			}
		case "meta":
			if meta != nil {
				return 0, 0, errHeader
			}
			copy := root[i]
			meta = &copy
		}
	}
	if meta == nil {
		return 0, 0, errHeader
	}
	children, err := boxes(f, meta.start+4, meta.end)
	if err != nil {
		return 0, 0, err
	}
	var primary uint32
	var properties []avifBox
	associations := map[uint32][]uint16{}
	for _, box := range children {
		switch box.kind {
		case "pitm":
			b, e := f.read(box.start, 4)
			if e != nil {
				return 0, 0, e
			}
			if b[0] == 0 {
				b, e = f.read(box.start+4, 2)
				if e != nil {
					return 0, 0, e
				}
				primary = uint32(binary.BigEndian.Uint16(b))
			} else {
				b, e = f.read(box.start+4, 4)
				if e != nil {
					return 0, 0, e
				}
				primary = binary.BigEndian.Uint32(b)
			}
		case "iprp":
			items, e := boxes(f, box.start, box.end)
			if e != nil {
				return 0, 0, e
			}
			for _, item := range items {
				switch item.kind {
				case "ipco":
					if properties != nil {
						return 0, 0, errHeader
					}
					properties, e = boxes(f, item.start, item.end)
					if e != nil {
						return 0, 0, e
					}
				case "ipma":
					if item.end-item.start > 1<<20 {
						return 0, 0, errHeader
					}
					b, e := f.read(item.start, int(item.end-item.start))
					if e != nil || len(b) < 8 {
						return 0, 0, errHeader
					}
					version, large := b[0], b[3]&1 != 0
					entries := binary.BigEndian.Uint32(b[4:])
					if entries > 65536 {
						return 0, 0, errHeader
					}
					p := 8
					for n := uint32(0); n < entries; n++ {
						var id uint32
						if version == 0 {
							if p+2 > len(b) {
								return 0, 0, errHeader
							}
							id = uint32(binary.BigEndian.Uint16(b[p:]))
							p += 2
						} else {
							if p+4 > len(b) {
								return 0, 0, errHeader
							}
							id = binary.BigEndian.Uint32(b[p:])
							p += 4
						}
						if p >= len(b) {
							return 0, 0, errHeader
						}
						count := int(b[p])
						p++
						for j := 0; j < count; j++ {
							var index uint16
							if large {
								if p+2 > len(b) {
									return 0, 0, errHeader
								}
								index = binary.BigEndian.Uint16(b[p:]) & 0x7fff
								p += 2
							} else {
								if p >= len(b) {
									return 0, 0, errHeader
								}
								index = uint16(b[p] & 0x7f)
								p++
							}
							associations[id] = append(associations[id], index)
						}
					}
				}
			}
		}
	}
	var width, height int64
	rotate := false
	for _, index := range associations[primary] {
		if index == 0 {
			continue
		}
		if int(index) > len(properties) {
			return 0, 0, errHeader
		}
		prop := properties[index-1]
		switch prop.kind {
		case "ispe":
			if width != 0 {
				return 0, 0, errHeader
			}
			if prop.end-prop.start != 12 {
				return 0, 0, errHeader
			}
			b, e := f.read(prop.start, 12)
			if e != nil {
				return 0, 0, e
			}
			width, height = be32(b[4:]), be32(b[8:])
		case "irot":
			b, e := f.read(prop.start, 1)
			if e != nil {
				return 0, 0, e
			}
			rotate = b[0]&1 != 0
		}
	}
	if primary == 0 || width == 0 || height == 0 {
		return 0, 0, errHeader
	}
	if rotate {
		width, height = height, width
	}
	return width, height, nil
}
