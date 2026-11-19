package store_test

import (
	"fmt"
	"slices"
	"testing"
	"testing/fstest"

	"miconverter/server/internal/store"
	"miconverter/server/internal/testdb"
	"miconverter/server/migrations"
)

func TestMigration0010AddsPdfToImageOnly(t *testing.T) {
	ctx := testContext(t)
	pool, _ := testdb.NewPool(t)
	all, err := store.LoadMigrations(migrations.FS)
	if err != nil {
		t.Fatal(err)
	}
	if len(all) < 10 || all[9].Name != "pdf_to_image" {
		t.Fatalf("0010 fehlt: %+v", all)
	}
	beforeFS := fstest.MapFS{}
	for _, m := range all[:9] {
		beforeFS[fmt.Sprintf("%04d_%s.sql", m.Version, m.Name)] = &fstest.MapFile{Data: []byte(m.SQL)}
	}
	if _, err := store.Migrate(ctx, pool, beforeFS); err != nil {
		t.Fatal(err)
	}
	seedJobs(t, ctx, pool)
	insert := func(tool, format string) error {
		_, err := pool.Exec(ctx, `INSERT INTO jobs (id,session_id,tool,state,options,input_name,input_size,input_format,input_sha256,input_storage_key,max_attempts,expires_at) VALUES (gen_random_uuid(),$1,$2,'queued','{}','test',1,$3,decode(repeat('cd',32),'hex'),'jobs/x/input',3,now()+interval '1 hour')`, sessionID, tool, format)
		return err
	}
	if err := insert("pdf-to-image", "pdf"); err == nil {
		t.Fatal("0009 akzeptiert pdf-to-image")
	}
	before := dataDump(t, ctx, pool)
	result, err := store.Migrate(ctx, pool, migrations.FS)
	if err != nil || !slices.Equal(result.Applied, []int{10}) {
		t.Fatalf("%+v %v", result, err)
	}
	if after := dataDump(t, ctx, pool); after != before {
		t.Fatal("0010 hat vorhandene Daten verändert")
	}
	for _, ok := range [][2]string{{"pdf-to-image", "pdf"}, {"markdown-pdf", "markdown"}, {"pdf-compress", "pdf"}, {"audio-convert", "mp3"}, {"pdf-rotate", "pdf"}, {"pdf-split", "pdf"}, {"pdf-merge", "pdf"}, {"image-pdf", "zip"}} {
		if err := insert(ok[0], ok[1]); err != nil {
			t.Fatalf("%v: %v", ok, err)
		}
	}
	if err := insert("pdf-to-video", "pdf"); err == nil {
		t.Fatal("unbekanntes Werkzeug akzeptiert")
	}
}
