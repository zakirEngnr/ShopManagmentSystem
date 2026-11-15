// Schema introspection.
//
// The same code path produces the *expected* spec and the *actual* spec, so
// the comparison semantics can never drift between the two sides.
//
// Beyond tables/columns/indexes/foreign keys the introspection also collects
// the objects that a naive table rebuild destroys or breaks:
//   * triggers  (DROP TABLE removes them)
//   * views     (a dependent view makes ALTER TABLE ... RENAME fail)
//   * sqlite_sequence (AUTOINCREMENT high-water mark)
//   * unsupported structures (generated columns, WITHOUT ROWID, STRICT tables,
//     virtual tables) that the tool refuses to rebuild
import { all } from './sqlite.mjs';
import { columnDefinitions, normaliseDefault, parseCreateTable, unquoteIdent } from './ddl.mjs';

const GENERATED_RE = /\bGENERATED\s+ALWAYS\s+AS\b|\bAS\s*\(/i;
const WITHOUT_ROWID_RE = /\bWITHOUT\s+ROWID\b/i;
const STRICT_RE = /\)\s*,?\s*STRICT\b/i;

/**
 * Map "from -> toTable.to" to the declared CONSTRAINT name.
 * PRAGMA foreign_key_list does not expose constraint names.
 */
export function constraintNames(sql) {
  const map = new Map();
  if (!sql) return map;
  const re =
    /CONSTRAINT\s+("(?:[^"]|"")+"|`[^`]+`)\s+FOREIGN\s+KEY\s*\(\s*("(?:[^"]|"")+"|`[^`]+`)\s*\)\s*REFERENCES\s+("(?:[^"]|"")+"|`[^`]+`)\s*\(\s*("(?:[^"]|"")+"|`[^`]+`)\s*\)/gi;
  let m;
  while ((m = re.exec(sql)) !== null) {
    map.set(`${unquoteIdent(m[2])}->${unquoteIdent(m[3])}.${unquoteIdent(m[4])}`, unquoteIdent(m[1]));
  }
  return map;
}

/** Structures this tool will not rewrite. */
export function detectUnsupported(table) {
  const reasons = [];
  const parsed = parseCreateTable(table.sql);
  const trailing = parsed?.trailing ?? '';
  if (WITHOUT_ROWID_RE.test(table.sql)) reasons.push('WITHOUT ROWID table');
  if (STRICT_RE.test(table.sql) || /\bSTRICT\b/i.test(trailing)) reasons.push('STRICT table');
  for (const col of table.columns) {
    if (col.hidden === 2 || col.hidden === 3) {
      reasons.push(`generated column "${col.name}"`);
    }
  }
  if (parsed) {
    for (const part of parsed.parts) {
      if (/^CHECK\b/i.test(part)) reasons.push('CHECK constraint (cannot be reproduced safely)');
    }
  }
  return [...new Set(reasons)];
}

export function introspect(db) {
  const tableRows = all(
    db,
    `SELECT name, sql FROM sqlite_master
      WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
      ORDER BY name`,
  );
  const indexRows = all(
    db,
    `SELECT name, tbl_name, sql FROM sqlite_master
      WHERE type = 'index' AND name NOT LIKE 'sqlite_%'
      ORDER BY name`,
  );
  const triggerRows = all(
    db,
    `SELECT name, tbl_name, sql FROM sqlite_master
      WHERE type = 'trigger' AND sql IS NOT NULL
      ORDER BY name`,
  );
  const viewRows = all(
    db,
    `SELECT name, sql FROM sqlite_master
      WHERE type = 'view'
      ORDER BY name`,
  );
  const indexSqlByName = new Map(indexRows.map((r) => [r.name, r.sql]));

  const tables = [];
  for (const row of tableRows) {
    const cols = all(db, `SELECT * FROM pragma_table_xinfo(?)`, [row.name]);
    const visibleCols = cols.filter((c) => c.hidden === 0 || c.hidden === 2 || c.hidden === 3);
    const defs = columnDefinitions(row.sql);

    const idxs = all(db, `SELECT * FROM pragma_index_list(?)`, [row.name]);
    const indexes = idxs.map((idx) => {
      const info = all(db, `SELECT * FROM pragma_index_info(?)`, [idx.name]);
      return {
        name: idx.name,
        unique: idx.unique === 1,
        origin: idx.origin,
        // 'c' = CREATE INDEX (what Prisma emits), 'u' = inline UNIQUE, 'pk' = primary key
        implicit: idx.origin !== 'c',
        partial: idx.partial === 1,
        columns: info.map((i) => i.name),
        sql: indexSqlByName.get(idx.name) ?? null,
      };
    });

    const fkNames = constraintNames(row.sql);
    const fks = all(db, `SELECT * FROM pragma_foreign_key_list(?)`, [row.name]).map((f) => {
      const key = `${f.from}->${f.table}.${f.to}`;
      return {
        id: f.id,
        seq: f.seq,
        name: f.from,
        from: f.from,
        toTable: f.table,
        to: f.to,
        onUpdate: (f.on_update || 'NO ACTION').toUpperCase(),
        onDelete: (f.on_delete || 'NO ACTION').toUpperCase(),
        match: f.match,
        constraint: fkNames.get(key) ?? null,
      };
    });

    const table = {
      name: row.name,
      sql: row.sql || '',
      autoincrement: /AUTOINCREMENT/i.test(row.sql),
      pk: visibleCols
        .filter((c) => c.pk > 0)
        .sort((a, b) => a.pk - b.pk)
        .map((c) => c.name),
      columns: visibleCols.map((c) => ({
        name: c.name,
        type: (c.type || '').toUpperCase(),
        notnull: c.notnull === 1,
        // NOT NULL as written in the DDL: PRAGMA reports 0 for an
        // INTEGER PRIMARY KEY rowid alias even when NOT NULL was declared.
        declaredNotNull: /\bNOT\s+NULL\b/i.test(defs.get(c.name)?.definition ?? ''),
        dflt: normaliseDefault(c.dflt_value),
        dfltRaw: c.dflt_value === null ? null : String(c.dflt_value),
        pk: c.pk,
        hidden: c.hidden,
      })),
      indexes,
      fks,
      triggers: triggerRows
        .filter((t) => t.tbl_name === row.name)
        .map((t) => ({ name: t.name, table: t.tbl_name, sql: t.sql })),
    };
    table.unsupported = detectUnsupported(table);
    tables.push(table);
  }

  const views = viewRows.map((v) => ({
    name: v.name,
    sql: v.sql,
    references: referencedTables(v.sql),
  }));

  const sequences = all(
    db,
    `SELECT name, seq FROM sqlite_sequence ORDER BY name`,
  ).map((r) => ({ name: r.name, seq: r.seq }));

  return {
    tables,
    views,
    triggers: triggerRows.map((t) => ({ name: t.name, table: t.tbl_name, sql: t.sql })),
    sequences,
    internalTables: all(
      db,
      `SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'sqlite_%' ORDER BY name`,
    ).map((r) => r.name),
  };
}

/** Table names referenced by a view body (best effort, identifier scan). */
export function referencedTables(sql) {
  if (!sql) return [];
  const names = new Set();
  const re = /\b(?:FROM|JOIN|INTO|UPDATE)\s+("?(?:[A-Za-z_][A-Za-z0-9_]*)"?)/gi;
  let m;
  while ((m = re.exec(sql)) !== null) names.add(unquoteIdent(m[1]));
  return [...names].sort();
}

/** Tables that reference `table` through a foreign key (direct children). */
export function childTables(spec, table) {
  return spec.tables
    .filter((t) => t.name !== table && t.fks.some((fk) => fk.toTable === table))
    .map((t) => t.name)
    .sort();
}
