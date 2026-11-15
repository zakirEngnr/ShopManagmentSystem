// SQLite table rebuild.
//
// A rebuild is the only way to change a column type, a default, a nullability
// or a foreign key action in SQLite. It is also the most dangerous operation
// in this tool, because DROP TABLE has side effects that are easy to miss:
//
//   * DROP TABLE removes every trigger attached to the table
//   * DROP TABLE removes the AUTOINCREMENT high-water mark (sqlite_sequence)
//   * DROP TABLE removes every index attached to the table
//   * ALTER TABLE ... RENAME re-parses the whole schema: with a dependent
//     VIEW the rename fails ("error in view V: no such table: main.X") and
//     leaves the database in a broken state. `PRAGMA legacy_alter_table=ON`
//     avoids the schema re-parse and keeps the view working.
//
// The rebuild therefore:
//   * runs outside a transaction (PRAGMA foreign_keys is a no-op inside one)
//   * turns foreign_keys OFF so that dropping a parent never cascades into
//     child rows
//   * uses legacy_alter_table so dependent views survive
//   * re-creates every index (expected + extra)
//   * restores the AUTOINCREMENT sequence afterwards
//   * re-creates every trigger afterwards (in a separate step, after all
//     rebuilds, so that triggers referencing another rebuilt table work)
import { columnDefinitions, parseCreateTable, quoteIdent, quoteLiteral, tableConstraints } from './ddl.mjs';

const TABLE_CONSTRAINT_RE = /^(CONSTRAINT|FOREIGN\s+KEY|PRIMARY\s+KEY|UNIQUE|CHECK)\b/i;

/**
 * Build the CREATE TABLE statement for the replacement table.
 * Extra columns and extra constraints of the live table are preserved.
 */
export function buildCreateTable(expectedSql, { extraColumns = [], extraConstraints = [], as = null } = {}) {
  const parsed = parseCreateTable(expectedSql);
  if (!parsed) throw new Error(`cannot parse expected CREATE TABLE:\n${expectedSql}`);
  const columnParts = [];
  const constraintParts = [];
  for (const part of parsed.parts) {
    if (TABLE_CONSTRAINT_RE.test(part)) constraintParts.push(part);
    else columnParts.push(part);
  }
  const body = [
    ...columnParts,
    ...extraColumns.map((c) => c.definition),
    ...constraintParts,
    ...extraConstraints,
  ]
    .map((p) => `    ${p}`)
    .join(',\n');
  return `CREATE TABLE ${quoteIdent(as ?? parsed.name)} (\n${body}\n);`;
}

/**
 * The full statement list of one table rebuild.
 * `copyColumns` are the columns that exist in the source table and are copied.
 */
export function buildRebuildSql({ table, createNewSql, copyColumns, expectedIndexes, extraIndexes }) {
  if (copyColumns.length === 0) {
    throw new Error(`refusing to rebuild "${table}": no columns can be copied`);
  }
  const cols = copyColumns.map(quoteIdent).join(', ');
  return [
    'PRAGMA defer_foreign_keys=ON;',
    'PRAGMA foreign_keys=OFF;',
    // Keeps dependent views intact during the rename (see file header).
    'PRAGMA legacy_alter_table=ON;',
    createNewSql,
    `INSERT INTO ${quoteIdent(`new_${table}`)} (${cols}) SELECT ${cols} FROM ${quoteIdent(table)};`,
    `DROP TABLE ${quoteIdent(table)};`,
    `ALTER TABLE ${quoteIdent(`new_${table}`)} RENAME TO ${quoteIdent(table)};`,
    ...expectedIndexes.map((i) => ensureSemicolon(i.sql)),
    ...extraIndexes.map((i) => ensureSemicolon(i.sql)),
    'PRAGMA legacy_alter_table=OFF;',
    'PRAGMA foreign_keys=ON;',
    'PRAGMA defer_foreign_keys=OFF;',
  ];
}

/** Restore the AUTOINCREMENT high-water mark captured before the rebuild. */
export function buildSequenceRestoreSql(table, seq) {
  if (seq === null || seq === undefined) return [];
  // sqlite_sequence.name is a COLUMN, so the table name must be a string
  // literal here - an identifier would be resolved as a column reference.
  return [
    `DELETE FROM sqlite_sequence WHERE name = ${quoteLiteral(table)};`,
    `INSERT INTO sqlite_sequence (name, seq) VALUES (${quoteLiteral(table)}, ${Number(seq)});`,
  ];
}

export function ensureSemicolon(sql) {
  const trimmed = String(sql).trim();
  return trimmed.endsWith(';') ? trimmed : `${trimmed};`;
}

/** Columns of the live table that the intent schema does not know about. */
export function extraColumnsOf(actualTable, expectedTable) {
  const defs = columnDefinitions(actualTable.sql);
  return actualTable.columns
    .filter((c) => !expectedTable.columns.some((e) => e.name === c.name))
    .map((c) => ({
      name: c.name,
      definition: defs.get(c.name)?.definition ?? quoteIdent(c.name),
    }));
}

/** Table constraints of the live table that the intent schema does not know about. */
export function extraConstraintsOf(actualTable, expectedTable) {
  const expectedKeys = new Set(expectedTable.fks.map((fk) => `${fk.from}->${fk.toTable}`));
  return tableConstraints(actualTable.sql).filter((constraint) => {
    const m = /FOREIGN\s+KEY\s*\(\s*"?([A-Za-z0-9_]+)"?\s*\)\s*REFERENCES\s+"?([A-Za-z0-9_]+)"?/i.exec(
      constraint,
    );
    if (!m) return false; // UNIQUE / CHECK constraints are not preserved silently
    return !expectedKeys.has(`${m[1]}->${m[2]}`);
  });
}
