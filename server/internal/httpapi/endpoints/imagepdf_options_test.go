package endpoints

import "testing"

func TestImagePdfOptionsCanonicalDefaults(t *testing.T) {
	o, err := parseOptions([]byte(`{"tool":"image-pdf"}`))
	const defaults = `{"margin":"small","orientation":"auto","pageSize":"a4","tool":"image-pdf"}`
	if err != nil || o.tool != "image-pdf" || o.format != "pdf" || string(o.canonical) != defaults {
		t.Fatalf("%+v %v", o, err)
	}
}

func TestImagePdfOptionsCanonicalExplicit(t *testing.T) {
	o, err := parseOptions([]byte(`{"tool":"image-pdf","pageSize":"letter","orientation":"landscape","margin":"none"}`))
	const want = `{"margin":"none","orientation":"landscape","pageSize":"letter","tool":"image-pdf"}`
	if err != nil || string(o.canonical) != want {
		t.Fatalf("%+v %v", o, err)
	}
	o, err = parseOptions([]byte(`{"tool":"image-pdf","pageSize":"fit","margin":"medium"}`))
	const fit = `{"margin":"medium","orientation":"auto","pageSize":"fit","tool":"image-pdf"}`
	if err != nil || string(o.canonical) != fit {
		t.Fatalf("%+v %v", o, err)
	}
}

func TestImagePdfOptionsRejectInvalid(t *testing.T) {
	for _, raw := range []string{
		`{"tool":"image-pdf","pageSize":"a3"}`,
		`{"tool":"image-pdf","pageSize":null}`,
		`{"tool":"image-pdf","pageSize":4}`,
		`{"tool":"image-pdf","orientation":"diagonal"}`,
		`{"tool":"image-pdf","orientation":null}`,
		`{"tool":"image-pdf","margin":"huge"}`,
		`{"tool":"image-pdf","margin":12}`,
		`{"tool":"image-pdf","format":"pdf"}`,
		`{"tool":"image-pdf","quality":0.5}`,
		// Bei fit bestimmt das Bild die Ausrichtung.
		`{"tool":"image-pdf","pageSize":"fit","orientation":"portrait"}`,
		`{"tool":"image-pdf","pageSize":"fit","orientation":"landscape"}`,
	} {
		if _, err := parseOptions([]byte(raw)); err == nil {
			t.Errorf("%s wurde akzeptiert", raw)
		}
	}
}
