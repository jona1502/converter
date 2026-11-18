package jobs

import "testing"

func TestPdfMergeResultRowIsOneFixedNamePDF(t *testing.T) {
	rows, err := Upload{Tool: "pdf-merge", OriginalName: "../geheim\x00.pdf"}.resultRows("../geheim\x00.pdf")
	if err != nil || len(rows) != 1 {
		t.Fatalf("%v %v", rows, err)
	}
	row := rows[0]
	if row.ordinal != 0 || row.level != nil || row.mime != PDFMIME || row.name != "zusammengefuehrt.pdf" {
		t.Fatalf("%+v", row)
	}
}
