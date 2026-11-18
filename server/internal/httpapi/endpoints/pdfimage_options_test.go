package endpoints

import (
	"errors"
	"testing"

	"miconverter/server/internal/apitypes"
	"miconverter/server/internal/httpapi"
)

func TestPdfImageOptionsAreCanonicalWithDefaults(t *testing.T) {
	cases := map[string]string{
		`{"tool":"pdf-to-image","format":"png"}`:                                         `{"dpi":150,"format":"png","pages":"all","quality":0.85,"tool":"pdf-to-image"}`,
		`{"tool":"pdf-to-image","format":"jpeg","dpi":72,"pages":"3,1,2","quality":0.5}`: `{"dpi":72,"format":"jpeg","pages":"1-3","quality":0.5,"tool":"pdf-to-image"}`,
		`{"format":"webp","tool":"pdf-to-image","dpi":300,"pages":"all","quality":1}`:    `{"dpi":300,"format":"webp","pages":"all","quality":1.0,"tool":"pdf-to-image"}`,
		`{"tool":"pdf-to-image","format":"png","pages":"7"}`:                             `{"dpi":150,"format":"png","pages":"7","quality":0.85,"tool":"pdf-to-image"}`,
		`{"tool":"pdf-to-image","format":"png","pages":"1-2,2-4,9"}`:                     `{"dpi":150,"format":"png","pages":"1-4,9","quality":0.85,"tool":"pdf-to-image"}`,
	}
	for input, want := range cases {
		got, err := parseOptions([]byte(input))
		if err != nil {
			t.Fatalf("%s: %v", input, err)
		}
		if string(got.canonical) != want || got.tool != "pdf-to-image" {
			t.Errorf("%s:\n%s\n%s", input, got.canonical, want)
		}
	}
}

func TestPdfImageOptionsDecideContainerAndCountPages(t *testing.T) {
	type want struct {
		archive bool
		page    int
		count   int
	}
	cases := map[string]want{
		`{"tool":"pdf-to-image","format":"png"}`:                {archive: true},
		`{"tool":"pdf-to-image","format":"png","pages":"all"}`:  {archive: true},
		`{"tool":"pdf-to-image","format":"png","pages":"4"}`:    {page: 4, count: 1},
		`{"tool":"pdf-to-image","format":"png","pages":"4-4"}`:  {page: 4, count: 1},
		`{"tool":"pdf-to-image","format":"png","pages":"1,2"}`:  {archive: true, count: 2},
		`{"tool":"pdf-to-image","format":"png","pages":"2-12"}`: {archive: true, count: 11},
	}
	for input, w := range cases {
		got, err := parseOptions([]byte(input))
		if err != nil {
			t.Fatalf("%s: %v", input, err)
		}
		if got.pdfArchive != w.archive || got.pdfPage != w.page || got.pageCount != w.count || got.format != "png" {
			t.Errorf("%s: archive=%v page=%d count=%d format=%q", input, got.pdfArchive, got.pdfPage, got.pageCount, got.format)
		}
	}
}

func TestPdfImageOptionsRejectInvalidValues(t *testing.T) {
	cases := map[string]apitypes.ApiErrorCode{
		`{"tool":"pdf-to-image"}`:                                       apitypes.CodeInvalidRequest,
		`{"tool":"pdf-to-image","format":"gif"}`:                        apitypes.CodeInvalidOptions,
		`{"tool":"pdf-to-image","format":"original"}`:                   apitypes.CodeInvalidOptions,
		`{"tool":"pdf-to-image","format":"png","dpi":71}`:               apitypes.CodeInvalidOptions,
		`{"tool":"pdf-to-image","format":"png","dpi":301}`:              apitypes.CodeInvalidOptions,
		`{"tool":"pdf-to-image","format":"png","dpi":150.5}`:            apitypes.CodeInvalidRequest,
		`{"tool":"pdf-to-image","format":"png","dpi":null}`:             apitypes.CodeInvalidRequest,
		`{"tool":"pdf-to-image","format":"png","pages":""}`:             apitypes.CodeInvalidOptions,
		`{"tool":"pdf-to-image","format":"png","pages":"0"}`:            apitypes.CodeInvalidOptions,
		`{"tool":"pdf-to-image","format":"png","pages":"3-1"}`:          apitypes.CodeInvalidOptions,
		`{"tool":"pdf-to-image","format":"png","pages":"1, 2"}`:         apitypes.CodeInvalidOptions,
		`{"tool":"pdf-to-image","format":"png","pages":5}`:              apitypes.CodeInvalidRequest,
		`{"tool":"pdf-to-image","format":"png","quality":1.5}`:          apitypes.CodeInvalidOptions,
		`{"tool":"pdf-to-image","format":"png","quality":-0.1}`:         apitypes.CodeInvalidOptions,
		`{"tool":"pdf-to-image","format":"png","quality":null}`:         apitypes.CodeInvalidRequest,
		`{"tool":"pdf-to-image","format":"png","background":"#ffffff"}`: apitypes.CodeInvalidRequest,
		`{"tool":"pdf-to-image","format":"png","levels":["high"]}`:      apitypes.CodeInvalidRequest,
	}
	for input, code := range cases {
		_, err := parseOptions([]byte(input))
		var api *httpapi.Error
		if !errors.As(err, &api) || api.Code != code {
			t.Errorf("%s: erwartet %s, erhalten %v", input, code, err)
		}
	}
}
