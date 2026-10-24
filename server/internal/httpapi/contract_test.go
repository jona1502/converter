package httpapi

import (
	"context"
	"errors"
	"net/http"
	"testing"

	"miconverter/server/internal/contracttest"
)

// Echte Antworten der Go-Handler gegen das Schema der jeweiligen Operation
// und des jeweiligen Statuscodes in api/openapi.json.
func TestResponsesMatchContract(t *testing.T) {
	spec := contracttest.MustLoad(t)
	a := newTestAPI(t)
	broken := newTestAPI(t)
	_ = broken.readiness.Register(CheckDatabase, func(context.Context) error { return errors.New("x") })

	cases := []struct {
		name       string
		api        *testAPI
		method     string
		path       string
		status     int
		opPath     string // Operation im Vertrag; leer = Komponente ErrorResponse
		opMethod   string
		retryAfter bool
	}{
		{"live", a, "GET", "/api/v1/health/live", 200, "/api/v1/health/live", "GET", false},
		{"ready ok", a, "GET", "/api/v1/health/ready", 200, "/api/v1/health/ready", "GET", false},
		{"ready fail", broken, "GET", "/api/v1/health/ready", 503, "/api/v1/health/ready", "GET", false},
		// Interner Fehler: jede Operation dokumentiert 500 ErrorResponse.
		{"500", a, "GET", "/api/v1/_test/crash", 500, "/api/v1/health/live", "GET", false},
		// Fehler mit Retry-After wie bei POST /jobs (429/503 ErrorResponse).
		{"503 retry", a, "GET", "/api/v1/_test/busy", 503, "/api/v1/jobs", "POST", true},
		{"429 retry", a, "GET", "/api/v1/_test/limited", 429, "", "", true},
		{"422 fields", a, "GET", "/api/v1/_test/invalid-options", 422, "/api/v1/jobs", "POST", false},
		{"422 strict json", a, "POST", "/api/v1/_test/options", 422, "/api/v1/jobs", "POST", false},
		// 404/405 haben keine Operation; Format = ErrorResponse.
		{"404", a, "GET", "/api/v1/does-not-exist", 404, "", "", false},
		{"405", a, "DELETE", "/api/v1/health/ready", 405, "", "", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			body := ""
			if tc.method == "POST" {
				body = `{"tool":"pdf-compress","levels":null,"x":1}`
			}
			rec := tc.api.do(tc.method, tc.path, nil, body)
			if rec.Code != tc.status {
				t.Fatalf("Status %d, erwartet %d", rec.Code, tc.status)
			}
			var err error
			if tc.opPath == "" {
				err = spec.ValidateComponent("ErrorResponse", rec.Body.Bytes())
			} else {
				schema, serr := spec.ResponseSchema(tc.opPath, tc.opMethod, tc.status)
				if serr != nil {
					t.Fatal(serr)
				}
				err = spec.Validate(schema, rec.Body.Bytes())
			}
			if err != nil {
				t.Fatalf("Antwort verletzt den Vertrag: %v\n%s", err, rec.Body.String())
			}
			if got := rec.Header().Get("Retry-After") != ""; got != tc.retryAfter {
				t.Fatalf("Retry-After vorhanden=%v, erwartet %v", got, tc.retryAfter)
			}
			if rec.Header().Get("Content-Type") != "application/json" {
				t.Fatalf("Content-Type %q", rec.Header().Get("Content-Type"))
			}
		})
	}
}

// Die Health-Routen des Vertrags sind in Go registriert.
func TestHealthRoutesExistInContract(t *testing.T) {
	spec := contracttest.MustLoad(t)
	for _, p := range []string{Prefix + "/health/live", Prefix + "/health/ready"} {
		if _, err := spec.ResponseSchema(p, http.MethodGet, 200); err != nil {
			t.Error(err)
		}
	}
}
