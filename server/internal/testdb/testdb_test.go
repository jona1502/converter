package testdb_test

import (
	"testing"

	"miconverter/server/internal/testdb"
)

func TestValidateName(t *testing.T) {
	for _, ok := range []string{"converter_go_test", "converter_go_test_ab12"} {
		if err := testdb.ValidateName(ok); err != nil {
			t.Errorf("%q abgelehnt: %v", ok, err)
		}
	}
	for _, bad := range []string{"", "converter", "postgres", "converter_go_TEST", "x_test; DROP", "te-st"} {
		if err := testdb.ValidateName(bad); err == nil {
			t.Errorf("%q akzeptiert", bad)
		}
	}
}
