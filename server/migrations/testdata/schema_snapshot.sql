-- Deterministischer Schema-Schnappschuss des Schemas public für den Vergleich
-- Alembic-0003 ↔ Go-Migrationen. Versionstabellen (alembic_version,
-- schema_migrations) sind bewusst ausgenommen. Eine Zeile je Objekt,
-- sortiert mit Kollation "C".
WITH rels AS (
    SELECT c.oid, c.relname::text AS relname
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relkind IN ('r', 'p')
       AND c.relname NOT IN ('alembic_version', 'schema_migrations')
), lines AS (
    SELECT 1 AS sec, r.relname AS k1, '' AS k2, 'table ' || r.relname AS line
      FROM rels r
    UNION ALL
    SELECT 2, r.relname, lpad(a.attnum::text, 4, '0'),
           format('column %s.%s %s %s%s%s%s',
                  r.relname, a.attname, format_type(a.atttypid, a.atttypmod),
                  CASE WHEN a.attnotnull THEN 'not null' ELSE 'null' END,
                  coalesce(' default ' || pg_get_expr(d.adbin, d.adrelid), ''),
                  CASE a.attidentity WHEN 'a' THEN ' identity always'
                                     WHEN 'd' THEN ' identity by default' ELSE '' END,
                  CASE WHEN a.attgenerated <> '' THEN ' generated' ELSE '' END)
      FROM rels r
      JOIN pg_attribute a ON a.attrelid = r.oid AND a.attnum > 0 AND NOT a.attisdropped
      LEFT JOIN pg_attrdef d ON d.adrelid = r.oid AND d.adnum = a.attnum
    UNION ALL
    SELECT 3, r.relname, con.conname::text,
           format('constraint %s.%s %s %s', r.relname, con.conname, con.contype,
                  pg_get_constraintdef(con.oid, true))
      FROM rels r
      JOIN pg_constraint con ON con.conrelid = r.oid
    UNION ALL
    SELECT 4, r.relname, i.relname::text,
           format('index %s.%s %s', r.relname, i.relname, pg_get_indexdef(i.oid))
      FROM rels r
      JOIN pg_index x ON x.indrelid = r.oid
      JOIN pg_class i ON i.oid = x.indexrelid
    UNION ALL
    SELECT 5, s.sequencename::text, '',
           format('sequence %s %s start %s increment %s min %s max %s cache %s cycle %s owned_by %s',
                  s.sequencename, s.data_type, s.start_value, s.increment_by, s.min_value,
                  s.max_value, s.cache_size, s.cycle,
                  coalesce((SELECT t.relname || '.' || a.attname
                              FROM pg_depend dep
                              JOIN pg_class t ON t.oid = dep.refobjid
                              JOIN pg_attribute a ON a.attrelid = dep.refobjid AND a.attnum = dep.refobjsubid
                             WHERE dep.classid = 'pg_class'::regclass
                               AND dep.objid = (quote_ident(s.schemaname) || '.' || quote_ident(s.sequencename))::regclass
                               AND dep.deptype IN ('a', 'i')
                             LIMIT 1), '-'))
      FROM pg_sequences s
     WHERE s.schemaname = 'public'
    UNION ALL
    SELECT 6, 'storage_usage', lpad(u.id::text, 6, '0'),
           format('row storage_usage id=%s reserved_bytes=%s', u.id, u.reserved_bytes)
      FROM storage_usage u
)
SELECT line FROM lines ORDER BY sec, k1 COLLATE "C", k2 COLLATE "C", line COLLATE "C";
