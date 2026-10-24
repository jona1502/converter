package main

import (
	"strings"
	"testing"
	"time"

	"miconverter/server/internal/config"
	"miconverter/server/internal/httpapi"
)

// Registrierung wie backend/app/factory.py build_readiness.
func TestRegisterChecksLikePython(t *testing.T) {
	cases := []struct {
		env  map[string]string
		want string
	}{
		{map[string]string{"CONVERTER_ENVIRONMENT": "test"}, "capabilities,storage"},
		{map[string]string{"CONVERTER_ENVIRONMENT": "development"}, "capabilities,redis,storage"},
		{map[string]string{"CONVERTER_ENVIRONMENT": "test", "CONVERTER_DATABASE_URL": "postgresql://x", "CONVERTER_REDIS_URL": "redis://y"}, "capabilities,database,redis,storage"},
	}
	for _, tc := range cases {
		cfg, err := config.Load(func(k string) (string, bool) { v, ok := tc.env[k]; return v, ok })
		if err != nil {
			t.Fatal(err)
		}
		r := httpapi.NewReadiness(time.Second, nil)
		registerChecks(cfg, r)
		if got := strings.Join(r.Names(), ","); got != tc.want {
			t.Errorf("%v: %s, erwartet %s", tc.env, got, tc.want)
		}
	}
}
