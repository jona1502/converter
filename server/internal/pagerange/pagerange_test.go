package pagerange

import (
	"encoding/json"
	"os"
	"strings"
	"testing"
)

type vectors struct {
	MaxPageNumber int `json:"maxPageNumber"`
	MaxRanges     int `json:"maxRanges"`
	MaxLength     int `json:"maxLength"`
	Valid         []struct {
		Input  string    `json:"input"`
		Ranges [][2]*int `json:"ranges"`
	} `json:"valid"`
	Invalid []string `json:"invalid"`
}

func load(t *testing.T) vectors {
	t.Helper()
	raw, err := os.ReadFile("../../../api/page-range-vectors.json")
	if err != nil {
		t.Fatal(err)
	}
	var v vectors
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatal(err)
	}
	return v
}

func TestConstantsMatchSharedVectors(t *testing.T) {
	v := load(t)
	if v.MaxPageNumber != MaxPageNumber || v.MaxRanges != MaxRanges || v.MaxLength != MaxLength {
		t.Fatalf("Grenzen weichen von api/page-range-vectors.json ab: %+v", v)
	}
}

func TestParseValidVectors(t *testing.T) {
	for _, c := range load(t).Valid {
		got, err := Parse(c.Input)
		if err != nil {
			t.Fatalf("%q: %v", c.Input, err)
		}
		if len(got) != len(c.Ranges) {
			t.Fatalf("%q: %v", c.Input, got)
		}
		for i, want := range c.Ranges {
			end := 0
			if want[1] != nil {
				end = *want[1]
			}
			if got[i].Start != *want[0] || got[i].End != end || got[i].Open() != (want[1] == nil) {
				t.Fatalf("%q[%d]: %+v", c.Input, i, got[i])
			}
		}
	}
}

func TestParseInvalidVectors(t *testing.T) {
	for _, in := range load(t).Invalid {
		if got, err := Parse(in); err == nil {
			t.Fatalf("%q akzeptiert: %v", in, got)
		}
	}
}

func TestParseLimits(t *testing.T) {
	if _, err := Parse(strings.Repeat("1,", MaxRanges-1) + "1"); err != nil {
		t.Fatalf("genau MaxRanges: %v", err)
	}
	if _, err := Parse(strings.Repeat("1,", MaxRanges) + "1"); err == nil {
		t.Fatal("MaxRanges+1 akzeptiert")
	}
	if _, err := Parse("1-" + strings.Repeat("0", MaxLength)); err == nil {
		t.Fatal("zu lange Angabe akzeptiert")
	}
}
