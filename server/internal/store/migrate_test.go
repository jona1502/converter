package store_test

import (
	"context"
	"errors"
	"fmt"
	"os"
	"regexp"
	"slices"
	"strings"
	"sync"
	"testing"
	"testing/fstest"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"miconverter/server/internal/store"
	"miconverter/server/internal/testdb"
	"miconverter/server/migrations"
)

const (
	snapshotQueryFile = "../../migrations/testdata/schema_snapshot.sql"
	referenceFile     = "../../migrations/testdata/alembic_0003_schema.txt"
	alembicHeadFile   = "../../../backend/migrations/versions/0003_stale_attempts.py"
)

func testContext(t *testing.T) context.Context {
	t.Helper()
	ctx, cancel := context.WithTimeout(t.Context(), 60*time.Second)
	t.Cleanup(cancel)
	return ctx
}

func snapshot(t *testing.T, ctx context.Context, pool *pgxpool.Pool) string {
	t.Helper()
	query, err := os.ReadFile(snapshotQueryFile)
	if err != nil {
		t.Fatal(err)
	}
	rows, err := pool.Query(ctx, string(query))
	if err != nil {
		t.Fatalf("Schnappschuss: %v", err)
	}
	lines, err := pgx.CollectRows(rows, pgx.RowTo[string])
	if err != nil {
		t.Fatalf("Schnappschuss: %v", err)
	}
	return strings.Join(lines, "\n") + "\n"
}

func reference(t *testing.T) string {
	t.Helper()
	data, err := os.ReadFile(referenceFile)
	if err != nil {
		t.Fatal(err)
	}
	return strings.ReplaceAll(string(data), "\r\n", "\n")
}

// Constraint-Zeilen, die 0004_audio gegenüber Alembic 0003 ersetzt.
// 0005_markdown erweitert diese Listen im aktuellen Schnappschuss weiter.
const (
	alembicToolCheck   = `constraint jobs.ck_jobs_tool c CHECK (tool = ANY (ARRAY['image-convert'::text, 'image-compress'::text, 'image-resize'::text, 'pdf-compress'::text]))`
	alembicFormatCheck = `constraint jobs.ck_jobs_input_format c CHECK (input_format = ANY (ARRAY['jpeg'::text, 'png'::text, 'webp'::text, 'gif'::text, 'bmp'::text, 'ico'::text, 'avif'::text, 'pdf'::text]))`
	audioToolCheck     = `constraint jobs.ck_jobs_tool c CHECK (tool = ANY (ARRAY['image-convert'::text, 'image-compress'::text, 'image-resize'::text, 'pdf-compress'::text, 'audio-convert'::text]))`
	audioFormatCheck   = `constraint jobs.ck_jobs_input_format c CHECK (input_format = ANY (ARRAY['jpeg'::text, 'png'::text, 'webp'::text, 'gif'::text, 'bmp'::text, 'ico'::text, 'avif'::text, 'pdf'::text, 'mp3'::text, 'wav'::text, 'flac'::text, 'ogg'::text]))`
)

// currentSchema ist der Alembic-0003-Schnappschuss plus 0004_audio/0005_markdown: nur die
// beiden CHECK-Constraints für Werkzeug und Eingabeformat sind erweitert.
func currentSchema(t *testing.T) string {
	t.Helper()
	ref := reference(t)
	for _, line := range []string{alembicToolCheck, alembicFormatCheck} {
		if strings.Count(ref, line+"\n") != 1 {
			t.Fatalf("Referenzzeile fehlt: %s", line)
		}
	}
	ref = strings.Replace(ref, alembicToolCheck+"\n", strings.Replace(audioToolCheck, "'audio-convert'::text", "'audio-convert'::text, 'markdown-pdf'::text, 'pdf-rotate'::text", 1)+"\n", 1)
	return strings.Replace(ref, alembicFormatCheck+"\n", strings.Replace(audioFormatCheck, "'ogg'::text", "'ogg'::text, 'markdown'::text", 1)+"\n", 1)
}

// alembicOnly enthält nur die Portierungen 0001–0003.
func alembicOnly(t *testing.T) fstest.MapFS {
	t.Helper()
	all, err := store.LoadMigrations(migrations.FS)
	if err != nil {
		t.Fatal(err)
	}
	fsys := fstest.MapFS{}
	for _, m := range all[:store.AlembicBaselineVersion] {
		name := fmt.Sprintf("%04d_%s.sql", m.Version, m.Name)
		fsys[name] = &fstest.MapFile{Data: []byte(m.SQL)}
	}
	return fsys
}

func assertSchemaEqualsAlembic(t *testing.T, ctx context.Context, pool *pgxpool.Pool) {
	t.Helper()
	assertSchema(t, ctx, pool, reference(t))
}

func assertSchema(t *testing.T, ctx context.Context, pool *pgxpool.Pool, want string) {
	t.Helper()
	got := snapshot(t, ctx, pool)
	if got == want {
		return
	}
	gotLines, wantLines := strings.Split(got, "\n"), strings.Split(want, "\n")
	for _, l := range wantLines {
		if !slices.Contains(gotLines, l) {
			t.Errorf("fehlt: %s", l)
		}
	}
	for _, l := range gotLines {
		if !slices.Contains(wantLines, l) {
			t.Errorf("zusätzlich: %s", l)
		}
	}
	t.Fatal("Schema weicht vom erwarteten Schnappschuss ab")
}

func versions(t *testing.T, ctx context.Context, pool *pgxpool.Pool) []int {
	t.Helper()
	rows, err := pool.Query(ctx, "SELECT version FROM schema_migrations ORDER BY version")
	if err != nil {
		t.Fatal(err)
	}
	v, err := pgx.CollectRows(rows, pgx.RowTo[int])
	if err != nil {
		t.Fatal(err)
	}
	return v
}

// applyRawSQL baut einen Alembic-artigen Stand ohne den Runner auf.
func applyRawSQL(t *testing.T, ctx context.Context, pool *pgxpool.Pool, upTo int) {
	t.Helper()
	all, err := store.LoadMigrations(migrations.FS)
	if err != nil {
		t.Fatal(err)
	}
	for _, m := range all[:upTo] {
		if _, err := pool.Exec(ctx, m.SQL, pgx.QueryExecModeSimpleProtocol); err != nil {
			t.Fatalf("%04d: %v", m.Version, err)
		}
	}
}

func createAlembicVersion(t *testing.T, ctx context.Context, pool *pgxpool.Pool, revision string) {
	t.Helper()
	// So legt Alembic die Tabelle an.
	if _, err := pool.Exec(ctx, `CREATE TABLE alembic_version (
		version_num VARCHAR(32) NOT NULL,
		CONSTRAINT alembic_version_pkc PRIMARY KEY (version_num))`); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, "INSERT INTO alembic_version (version_num) VALUES ($1)", revision); err != nil {
		t.Fatal(err)
	}
}

func tableExists(t *testing.T, ctx context.Context, pool *pgxpool.Pool, name string) bool {
	t.Helper()
	var ok bool
	if err := pool.QueryRow(ctx, "SELECT to_regclass($1) IS NOT NULL", "public."+name).Scan(&ok); err != nil {
		t.Fatal(err)
	}
	return ok
}

func TestAlembicHeadRevisionMatchesPythonMigration(t *testing.T) {
	data, err := os.ReadFile(alembicHeadFile)
	if errors.Is(err, os.ErrNotExist) {
		t.Skip("Python-Backend nicht mehr vorhanden")
	}
	if err != nil {
		t.Fatal(err)
	}
	m := regexp.MustCompile(`(?m)^revision\s*(?::\s*str\s*)?=\s*"([^"]+)"`).FindSubmatch(data)
	if m == nil || string(m[1]) != store.AlembicHeadRevision {
		t.Fatalf("Revision in %s ist nicht %q", alembicHeadFile, store.AlembicHeadRevision)
	}
}

func TestLoadMigrations(t *testing.T) {
	all, err := store.LoadMigrations(migrations.FS)
	if err != nil {
		t.Fatal(err)
	}
	var got []string
	for _, m := range all {
		got = append(got, m.Name)
	}
	want := []string{"initial_schema", "download_lease", "stale_attempts", "audio", "markdown", "pdf_rotate"}
	if !slices.Equal(got[:6], want) {
		t.Fatalf("Migrationen = %v", got)
	}
}

func TestMigrationsUpTo0003MatchAlembicSchema(t *testing.T) {
	ctx := testContext(t)
	pool, _ := testdb.NewPool(t)
	res, err := store.Migrate(ctx, pool, alembicOnly(t))
	if err != nil {
		t.Fatal(err)
	}
	if res.Baselined || !slices.Equal(res.Applied, []int{1, 2, 3}) {
		t.Fatalf("Ergebnis = %+v", res)
	}
	assertSchemaEqualsAlembic(t, ctx, pool)
}

func TestMigrateEmptyDatabaseMatchesCurrentSchema(t *testing.T) {
	ctx := testContext(t)
	pool, _ := testdb.NewPool(t)

	res, err := store.Migrate(ctx, pool, migrations.FS)
	if err != nil {
		t.Fatal(err)
	}
	if res.Baselined || !slices.Equal(res.Applied, []int{1, 2, 3, 4, 5, 6}) {
		t.Fatalf("Ergebnis = %+v", res)
	}
	assertSchema(t, ctx, pool, currentSchema(t))
	if tableExists(t, ctx, pool, "alembic_version") {
		t.Fatal("Go-Runner darf alembic_version nicht anlegen")
	}

	// Zweiter Lauf ist ein No-op.
	res, err = store.Migrate(ctx, pool, migrations.FS)
	if err != nil {
		t.Fatal(err)
	}
	if res.Baselined || len(res.Applied) != 0 {
		t.Fatalf("zweiter Lauf = %+v", res)
	}
	if v := versions(t, ctx, pool); !slices.Equal(v, []int{1, 2, 3, 4, 5, 6}) {
		t.Fatalf("Versionen = %v", v)
	}
}

func TestMigration0004AllowsAudioJobs(t *testing.T) {
	ctx := testContext(t)
	pool, _ := testdb.NewPool(t)
	if _, err := store.Migrate(ctx, pool, alembicOnly(t)); err != nil {
		t.Fatal(err)
	}
	seedJobs(t, ctx, pool)
	insert := func(tool, format string) error {
		_, err := pool.Exec(ctx, `INSERT INTO jobs (id, session_id, tool, state, options, input_name,
		        input_size, input_format, input_sha256, input_storage_key, max_attempts, expires_at)
		      VALUES (gen_random_uuid(), $1, $2, 'queued', '{}', 'a', 1, $3,
		        decode(repeat('cd', 32), 'hex'), 'jobs/x/input', 3, now() + interval '1 hour')`,
			sessionID, tool, format)
		return err
	}
	if err := insert("audio-convert", "mp3"); err == nil {
		t.Fatal("0003 darf audio-convert noch nicht zulassen")
	}
	before := dataDump(t, ctx, pool)
	res, err := store.Migrate(ctx, pool, migrations.FS)
	if err != nil || !slices.Equal(res.Applied, []int{4, 5, 6}) {
		t.Fatalf("Ergebnis = %+v, %v", res, err)
	}
	if after := dataDump(t, ctx, pool); after != before {
		t.Fatalf("Migration hat Daten verändert")
	}
	for _, format := range []string{"mp3", "wav", "flac", "ogg"} {
		if err := insert("audio-convert", format); err != nil {
			t.Fatalf("%s: %v", format, err)
		}
	}
	for _, bad := range [][2]string{{"audio-convert", "m4a"}, {"video-convert", "mp3"}} {
		if err := insert(bad[0], bad[1]); err == nil {
			t.Fatalf("%v zugelassen", bad)
		}
	}
	if err := insert("image-convert", "png"); err != nil {
		t.Fatalf("Bildauftrag abgelehnt: %v", err)
	}
}

func TestMigrateBaselinesAlembicHeadWithoutTouchingData(t *testing.T) {
	ctx := testContext(t)
	pool, _ := testdb.NewPool(t)
	applyRawSQL(t, ctx, pool, 3)
	createAlembicVersion(t, ctx, pool, store.AlembicHeadRevision)
	if tableExists(t, ctx, pool, "schema_migrations") {
		t.Fatal("Ausgangszustand enthält schema_migrations")
	}
	seedJobs(t, ctx, pool)
	if _, err := pool.Exec(ctx, "UPDATE storage_usage SET reserved_bytes = 4242"); err != nil {
		t.Fatal(err)
	}
	before := dataDump(t, ctx, pool)

	res, err := store.Migrate(ctx, pool, migrations.FS)
	if err != nil {
		t.Fatal(err)
	}
	// Baseline übernimmt 1–3 ohne SQL, danach laufen 0004_audio bis 0006_pdf_rotate.
	if !res.Baselined || !slices.Equal(res.Applied, []int{4, 5, 6}) {
		t.Fatalf("Ergebnis = %+v", res)
	}
	if v := versions(t, ctx, pool); !slices.Equal(v, []int{1, 2, 3, 4, 5, 6}) {
		t.Fatalf("Versionen = %v", v)
	}
	if after := dataDump(t, ctx, pool); after != before {
		t.Fatalf("Daten verändert:\nvorher %s\nnachher %s", before, after)
	}
	var rev string
	if err := pool.QueryRow(ctx, "SELECT version_num FROM alembic_version").Scan(&rev); err != nil || rev != store.AlembicHeadRevision {
		t.Fatalf("alembic_version = %q, %v", rev, err)
	}

	res, err = store.Migrate(ctx, pool, migrations.FS)
	if err != nil || res.Baselined || len(res.Applied) != 0 {
		t.Fatalf("zweiter Lauf = %+v, %v", res, err)
	}
}

func TestMigrateRejectsOutdatedAlembicRevision(t *testing.T) {
	ctx := testContext(t)
	pool, _ := testdb.NewPool(t)
	applyRawSQL(t, ctx, pool, 2)
	createAlembicVersion(t, ctx, pool, "0002")

	_, err := store.Migrate(ctx, pool, migrations.FS)
	if !errors.Is(err, store.ErrAlembicRevision) {
		t.Fatalf("Fehler = %v", err)
	}
	if tableExists(t, ctx, pool, "schema_migrations") || tableExists(t, ctx, pool, "stale_attempts") {
		t.Fatal("Runner hat trotz Fehler etwas verändert")
	}
	var rev string
	if err := pool.QueryRow(ctx, "SELECT version_num FROM alembic_version").Scan(&rev); err != nil || rev != "0002" {
		t.Fatalf("alembic_version = %q, %v", rev, err)
	}
}

func TestMigrateRejectsUnknownSchema(t *testing.T) {
	ctx := testContext(t)
	pool, _ := testdb.NewPool(t)
	if _, err := pool.Exec(ctx, "CREATE TABLE fremd (id int)"); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Migrate(ctx, pool, migrations.FS); !errors.Is(err, store.ErrUnknownSchema) {
		t.Fatalf("Fehler = %v", err)
	}
	if tableExists(t, ctx, pool, "schema_migrations") || tableExists(t, ctx, pool, "jobs") {
		t.Fatal("Runner hat trotz Fehler etwas verändert")
	}
}

func TestMigrateRejectsNewerSchema(t *testing.T) {
	ctx := testContext(t)
	pool, _ := testdb.NewPool(t)
	if _, err := store.Migrate(ctx, pool, migrations.FS); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, "INSERT INTO schema_migrations (version) VALUES (999)"); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Migrate(ctx, pool, migrations.FS); !errors.Is(err, store.ErrSchemaTooNew) {
		t.Fatalf("Fehler = %v", err)
	}
}

func TestMigrateConcurrentRunnersApplyOnce(t *testing.T) {
	ctx := testContext(t)
	_, dsn := testdb.NewPool(t)

	const runners = 4
	results := make([]store.MigrateResult, runners)
	errs := make([]error, runners)
	pools := make([]*pgxpool.Pool, runners)
	for i := range runners {
		pools[i] = testdb.Connect(t, dsn)
	}
	var start, wg sync.WaitGroup
	start.Add(1)
	for i := range runners {
		wg.Go(func() {
			start.Wait()
			results[i], errs[i] = store.Migrate(ctx, pools[i], migrations.FS)
		})
	}
	start.Done()
	wg.Wait()

	applied := 0
	for i := range runners {
		if errs[i] != nil {
			t.Fatalf("Runner %d: %v", i, errs[i])
		}
		switch len(results[i].Applied) {
		case 6:
			applied++
		case 0:
		default:
			t.Fatalf("Runner %d hat teilweise migriert: %+v", i, results[i])
		}
	}
	if applied != 1 {
		t.Fatalf("%d Runner haben migriert, erwartet genau 1", applied)
	}
	if v := versions(t, ctx, pools[0]); !slices.Equal(v, []int{1, 2, 3, 4, 5, 6}) {
		t.Fatalf("Versionen = %v", v)
	}
	assertSchema(t, ctx, pools[0], currentSchema(t))
}

func TestMigrateConcurrentBaselineOnce(t *testing.T) {
	ctx := testContext(t)
	pool, dsn := testdb.NewPool(t)
	applyRawSQL(t, ctx, pool, 3)
	createAlembicVersion(t, ctx, pool, store.AlembicHeadRevision)

	const runners = 4
	results := make([]store.MigrateResult, runners)
	errs := make([]error, runners)
	pools := make([]*pgxpool.Pool, runners)
	for i := range runners {
		pools[i] = testdb.Connect(t, dsn)
	}
	var wg sync.WaitGroup
	for i := range runners {
		wg.Go(func() { results[i], errs[i] = store.Migrate(ctx, pools[i], migrations.FS) })
	}
	wg.Wait()
	baselined := 0
	for i := range runners {
		if errs[i] != nil {
			t.Fatalf("Runner %d: %v", i, errs[i])
		}
		// Nur der baselinende Runner führt danach 0004 bis 0006 aus.
		if results[i].Baselined != slices.Equal(results[i].Applied, []int{4, 5, 6}) ||
			(!results[i].Baselined && len(results[i].Applied) != 0) {
			t.Fatalf("Runner %d: %+v", i, results[i])
		}
		if results[i].Baselined {
			baselined++
		}
	}
	if baselined != 1 {
		t.Fatalf("%d Baselines, erwartet 1", baselined)
	}
}

func TestMigrateHonoursCancelledContext(t *testing.T) {
	pool, _ := testdb.NewPool(t)
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	if _, err := store.Migrate(ctx, pool, migrations.FS); err == nil {
		t.Fatal("abgebrochener Context muss scheitern")
	}
	ctx = testContext(t)
	if tableExists(t, ctx, pool, "schema_migrations") {
		t.Fatal("abgebrochener Lauf hat etwas angelegt")
	}
}

func TestMigration0005PreservesJobsAndAddsMarkdown(t *testing.T) {
	ctx := testContext(t)
	pool, _ := testdb.NewPool(t)
	all, err := store.LoadMigrations(migrations.FS)
	if err != nil {
		t.Fatal(err)
	}
	beforeFS := fstest.MapFS{}
	for _, m := range all[:4] {
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
	if err := insert("audio-convert", "mp3"); err != nil {
		t.Fatal(err)
	}
	if err := insert("markdown-pdf", "markdown"); err == nil {
		t.Fatal("0004 accepted Markdown")
	}
	before := dataDump(t, ctx, pool)
	result, err := store.Migrate(ctx, pool, migrations.FS)
	if err != nil || !slices.Equal(result.Applied, []int{5, 6}) {
		t.Fatalf("%+v %v", result, err)
	}
	if after := dataDump(t, ctx, pool); after != before {
		t.Fatal("0005 changed existing data")
	}
	if err := insert("markdown-pdf", "markdown"); err != nil {
		t.Fatal(err)
	}
	if err := insert("pdf-compress", "pdf"); err != nil {
		t.Fatal(err)
	}
	if err := insert("video-convert", "markdown"); err == nil {
		t.Fatal("unknown tool accepted")
	}
	if err := insert("markdown-pdf", "html"); err == nil {
		t.Fatal("unknown format accepted")
	}
}

func TestMigration0006PreservesJobsAndAddsPdfRotate(t *testing.T) {
	ctx := testContext(t)
	pool, _ := testdb.NewPool(t)
	all, err := store.LoadMigrations(migrations.FS)
	if err != nil {
		t.Fatal(err)
	}
	beforeFS := fstest.MapFS{}
	for _, m := range all[:5] {
		beforeFS[fmt.Sprintf("%04d_%s.sql", m.Version, m.Name)] = &fstest.MapFile{Data: []byte(m.SQL)}
	}
	if _, err := store.Migrate(ctx, pool, beforeFS); err != nil {
		t.Fatal(err)
	}
	seedJobs(t, ctx, pool)
	insert := func(tool, format string) error {
		_, err := pool.Exec(ctx, `INSERT INTO jobs (id,session_id,tool,state,options,input_name,input_size,input_format,input_sha256,input_storage_key,max_attempts,expires_at) VALUES (gen_random_uuid(),$1,$2,'queued','{}','test',1,$3,decode(repeat('ef',32),'hex'),'jobs/x/input',3,now()+interval '1 hour')`, sessionID, tool, format)
		return err
	}
	if err := insert("pdf-rotate", "pdf"); err == nil {
		t.Fatal("0005 accepted pdf-rotate")
	}
	before := dataDump(t, ctx, pool)
	result, err := store.Migrate(ctx, pool, migrations.FS)
	if err != nil || !slices.Equal(result.Applied, []int{6}) {
		t.Fatalf("%+v %v", result, err)
	}
	if after := dataDump(t, ctx, pool); after != before {
		t.Fatal("0006 changed existing data")
	}
	for _, tc := range [][2]string{{"pdf-rotate", "pdf"}, {"markdown-pdf", "markdown"}, {"pdf-compress", "pdf"}} {
		if err := insert(tc[0], tc[1]); err != nil {
			t.Fatalf("%v: %v", tc, err)
		}
	}
	if err := insert("pdf-flip", "pdf"); err == nil {
		t.Fatal("unknown tool accepted")
	}
}
