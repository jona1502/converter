package main

import (
	"bytes"
	"strings"
	"testing"

	"miconverter/server/internal/testdb"
)

func env(values map[string]string) func(string) string {
	return func(k string) string { return values[k] }
}

func TestUsageErrors(t *testing.T) {
	for _, args := range [][]string{nil, {"down"}, {"up", "extra"}, {"-timeout", "0s", "up"}, {"-unknown"}} {
		var out bytes.Buffer
		if code := run(t.Context(), args, env(nil), &out); code != 2 {
			t.Errorf("%v: Exitcode %d", args, code)
		}
	}
}

func TestMissingOrInvalidURLFailsWithoutLeakingSecret(t *testing.T) {
	var out bytes.Buffer
	if code := run(t.Context(), []string{"up"}, env(nil), &out); code != 1 {
		t.Fatalf("Exitcode %d", code)
	}
	out.Reset()
	bad := map[string]string{envDatabaseURL: "mysql://u:geheim@db/x"}
	if code := run(t.Context(), []string{"up"}, env(bad), &out); code != 1 {
		t.Fatalf("Exitcode %d", code)
	}
	unreachable := map[string]string{envDatabaseURL: "postgresql+psycopg://u:geheim@127.0.0.1:1/x_test"}
	if code := run(t.Context(), []string{"-timeout", "5s", "requeue"}, env(unreachable), &out); code != 1 {
		t.Fatalf("Exitcode %d", code)
	}
	if strings.Contains(out.String(), "geheim") {
		t.Fatalf("Ausgabe enthält Passwort: %s", out.String())
	}
}

func TestUpAndRequeue(t *testing.T) {
	dsn := testdb.NewDatabase(t)
	vars := map[string]string{envDatabaseURL: strings.Replace(dsn, "postgres://", "postgresql+psycopg://", 1)}
	for _, cmd := range []string{"up", "up", "requeue", "requeue"} {
		var out bytes.Buffer
		if code := run(t.Context(), []string{cmd}, env(vars), &out); code != 0 {
			t.Fatalf("%s: Exitcode %d: %s", cmd, code, out.String())
		}
		if strings.Contains(out.String(), "converter:converter") {
			t.Fatalf("Ausgabe enthält Zugangsdaten: %s", out.String())
		}
	}
}
