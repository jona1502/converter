// Package migrations bettet die SQL-Migrationen des Go-Backends ein.
//
// Dateinamen folgen dem Muster NNNN_name.sql; die Nummer ist die Version in
// schema_migrations. 0001–0003 sind Portierungen der Alembic-Revisionen
// 0001–0003 und erzeugen exakt dasselbe Schema (testdata/alembic_0003_schema.txt).
package migrations

import "embed"

// FS enthält alle Migrationsdateien.
//
//go:embed *.sql
var FS embed.FS
