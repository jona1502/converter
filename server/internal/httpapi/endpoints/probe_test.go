package endpoints

import (
	"bytes"
	"context"
	"encoding/binary"
	"errors"
	"io"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"miconverter/server/internal/config"
	"miconverter/server/internal/httpapi"
)

func TestProbeRealCodecFixtures(t *testing.T) {
	cfg, err := config.Load(func(k string) (string, bool) {
		if k == "CONVERTER_ENVIRONMENT" {
			return "test", true
		}
		return "", false
	})
	if err != nil {
		t.Fatal(err)
	}
	root := "../../../../converter/testdata/headers"
	entries, err := os.ReadDir(root)
	if err != nil {
		t.Fatal(err)
	}
	checked := 0
	for _, entry := range entries {
		if entry.IsDir() || strings.HasSuffix(entry.Name(), "json") || strings.HasSuffix(entry.Name(), "md") {
			continue
		}
		ext := strings.TrimPrefix(filepath.Ext(entry.Name()), ".")
		if ext == "jpg" {
			ext = "jpeg"
		}
		file, err := os.Open(filepath.Join(root, entry.Name()))
		if err != nil {
			t.Fatal(err)
		}
		stat, _ := file.Stat()
		err = probeImage(t.Context(), file, stat.Size(), ext, cfg)
		file.Close()
		if strings.Contains(entry.Name(), "animated") {
			var api *httpapi.Error
			if !errors.As(err, &api) || api.Code != "animated-unsupported" {
				t.Errorf("%s: %v", entry.Name(), err)
			}
		} else if err != nil {
			t.Errorf("%s: %v", entry.Name(), err)
		}
		checked++
	}
	if checked < 11 {
		t.Fatal(checked)
	}
}
func box(kind string, data []byte) []byte {
	b := make([]byte, 8+len(data))
	binary.BigEndian.PutUint32(b, uint32(len(b)))
	copy(b[4:8], kind)
	copy(b[8:], data)
	return b
}
func TestAVIFPrimaryAssociationsIgnoreHugeThumbnail(t *testing.T) {
	ispe := func(w, h uint32) []byte {
		b := make([]byte, 12)
		binary.BigEndian.PutUint32(b[4:], w)
		binary.BigEndian.PutUint32(b[8:], h)
		return box("ispe", b)
	}
	properties := append(ispe(37, 23), ispe(90000, 90000)...)
	ipma := []byte{0, 0, 0, 0, 0, 0, 0, 2, 0, 1, 1, 1, 0, 2, 1, 2}
	iprp := box("iprp", append(box("ipco", properties), box("ipma", ipma)...))
	meta := box("meta", append(append([]byte{0, 0, 0, 0}, box("pitm", []byte{0, 0, 0, 0, 0, 1})...), iprp...))
	data := append(box("ftyp", []byte("avif\x00\x00\x00\x00avif")), meta...)
	path := filepath.Join(t.TempDir(), "primary.avif")
	os.WriteFile(path, data, 0600)
	file, _ := os.Open(path)
	defer file.Close()
	f := fileHeader{file: file, size: int64(len(data)), ctx: context.Background()}
	w, h, err := probeAVIF(&f)
	if err != nil || w != 37 || h != 23 {
		t.Fatalf("%d %d %v", w, h, err)
	}
}
func TestHeaderGuardRejectsOversizedPartBeforeMIMEAllocation(t *testing.T) {
	data := "--boundary\r\nX-Long: " + strings.Repeat("x", 20000) + "\r\n\r\nfile\r\n--boundary--\r\n"
	reader := guardHeaders(t.Context(), strings.NewReader(data), "boundary")
	read, err := io.ReadAll(reader)
	if err == nil || len(read) > 8300 {
		t.Fatalf("%d %v", len(read), err)
	}
}
func TestHeaderGuardPayloadAndSplitDelimiters(t *testing.T) {
	data := []byte("--boundary\r\nName: a\r\n\r\npayload\r\n--boundary\r\nName: b\r\n\r\nfile\r\n--boundary--\r\n")
	reader := guardHeaders(t.Context(), bytes.NewReader(data), "boundary")
	var got bytes.Buffer
	buf := make([]byte, 1)
	for {
		n, err := reader.Read(buf)
		got.Write(buf[:n])
		if err != nil {
			if err != io.EOF {
				t.Fatal(err)
			}
			break
		}
	}
	if !bytes.Equal(got.Bytes(), data) {
		t.Fatal("changed payload")
	}
}
func TestWriteRequiresCSRFAndOrigin(t *testing.T) {
	f := fixture(t)
	r := httptest.NewRequest("POST", "/api/v1/jobs", nil)
	r.Header.Set("Cookie", f.cookie)
	w := httptest.NewRecorder()
	f.router.ServeHTTP(w, r)
	if w.Code != 403 {
		t.Fatal(w.Code)
	}
	r = httptest.NewRequest("POST", "/api/v1/jobs", nil)
	r.Header.Set("Cookie", f.cookie)
	r.Header.Set("X-CSRF-Token", f.csrf)
	r.Header.Set("Origin", "http://foreign")
	w = httptest.NewRecorder()
	f.router.ServeHTTP(w, r)
	if w.Code != 403 {
		t.Fatal(w.Code)
	}
}
