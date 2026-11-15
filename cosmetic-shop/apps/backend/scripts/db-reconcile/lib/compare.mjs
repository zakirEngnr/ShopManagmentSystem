// Comparison engine: expected spec vs actual spec.
//
// Every database object receives exactly one classification:
//   CORRECT     - exists and matches exactly
//   MISSING     - expected but not present
//   MISMATCH    - present but differs
//   EXTRA       - present but not expected (never dropped, only reported)
//   UNSUPPORTED - present, but built with a structure this tool refuses to
//                  rewrite (generated columns, WITHOUT ROWID, STRICT, CHECK)
//                  -> the table is excluded from automatic reconciliation
import { defaultEquals } from './ddl.mjs';

export const STATUS = {
  CORRECT: 'CORRECT',
  MISSING: 'MISSING',
  MISMATCH: 'MISMATCH',
  EXTRA: 'EXTRA',
  UNSUPPORTED: 'UNSUPPORTED',
};

function sameType(a, b) {
  const norm = (t) =>
    String(t || '')
      .toUpperCase()
      .replace(/\s+/g, ' ')
      .trim();
  return norm(a) === norm(b);
}

function effectiveNotNull(col) {
  if (col.declaredNotNull !== undefined) return col.declaredNotNull;
  if (col.notnull) return true;
  return false;
}

export function compare(expected, actual) {
  const results = [];
  const actualTables = new Map(actual.tables.map((t) => [t.name, t]));

  for (const expTable of expected.tables) {
    const actTable = actualTables.get(expTable.name);

    if (!actTable) {
      results.push({
        kind: 'table',
        table: expTable.name,
        name: expTable.name,
        status: STATUS.MISSING,
        details: ['table does not exist'],
      });
      continue;
    }

    if (actTable.unsupported?.length) {
      results.push({
        kind: 'table',
        table: expTable.name,
        name: expTable.name,
        status: STATUS.UNSUPPORTED,
        details: [
          `table uses a structure this tool will not rewrite: ${actTable.unsupported.join(', ')}`,
        ],
      });
      continue;
    }

    results.push({
      kind: 'table',
      table: expTable.name,
      name: expTable.name,
      status: STATUS.CORRECT,
      details: [],
    });

    // --- columns ------------------------------------------------------------
    const actCols = new Map(actTable.columns.map((c) => [c.name, c]));
    for (const expCol of expTable.columns) {
      const actCol = actCols.get(expCol.name);
      if (!actCol) {
        results.push({
          kind: 'column',
          table: expTable.name,
          name: expCol.name,
          status: STATUS.MISSING,
          details: [`column "${expCol.name}" is missing`],
          expected: expCol,
        });
        continue;
      }
      const diffs = [];
      if (!sameType(expCol.type, actCol.type)) {
        diffs.push(`type: expected ${expCol.type}, found ${actCol.type}`);
      }
      if (effectiveNotNull(expCol) !== effectiveNotNull(actCol)) {
        diffs.push(
          `nullability: expected ${effectiveNotNull(expCol) ? 'NOT NULL' : 'NULLABLE'}, found ${
            effectiveNotNull(actCol) ? 'NOT NULL' : 'NULLABLE'
          }`,
        );
      }
      if (!defaultEquals(expCol.dflt, actCol.dflt)) {
        diffs.push(
          `default: expected ${describeDefaultValue(expCol.dflt)}, found ${describeDefaultValue(actCol.dflt)}`,
        );
      }
      results.push({
        kind: 'column',
        table: expTable.name,
        name: expCol.name,
        status: diffs.length ? STATUS.MISMATCH : STATUS.CORRECT,
        details: diffs,
        expected: expCol,
        actual: actCol,
      });
    }
    for (const actCol of actTable.columns) {
      if (!expTable.columns.some((c) => c.name === actCol.name)) {
        results.push({
          kind: 'column',
          table: expTable.name,
          name: actCol.name,
          status: STATUS.EXTRA,
          details: [
            `column "${actCol.name}" is not part of schema.prisma - preserved, never dropped`,
          ],
          actual: actCol,
        });
      }
    }

    // --- primary key --------------------------------------------------------
    const pkDiffs = [];
    if (expTable.pk.join(',') !== actTable.pk.join(',')) {
      pkDiffs.push(`pk columns: expected [${expTable.pk.join(', ')}], found [${actTable.pk.join(', ')}]`);
    }
    if (expTable.autoincrement !== actTable.autoincrement) {
      pkDiffs.push(
        `autoincrement: expected ${expTable.autoincrement}, found ${actTable.autoincrement}`,
      );
    }
    results.push({
      kind: 'primaryKey',
      table: expTable.name,
      name: expTable.name,
      status: pkDiffs.length ? STATUS.MISMATCH : STATUS.CORRECT,
      details: pkDiffs,
    });

    // --- indexes ------------------------------------------------------------
    const actIdxByName = new Map(actTable.indexes.map((i) => [i.name, i]));
    for (const expIdx of expTable.indexes) {
      const actIdx = actIdxByName.get(expIdx.name);
      if (!actIdx) {
        const sameShape = actTable.indexes.find(
          (i) =>
            i.unique === expIdx.unique &&
            i.columns.length === expIdx.columns.length &&
            i.columns.every((c, n) => c === expIdx.columns[n]),
        );
        results.push({
          kind: 'index',
          table: expTable.name,
          name: expIdx.name,
          status: STATUS.MISSING,
          details: [
            sameShape
              ? `index "${expIdx.name}" is missing (an equivalent index "${sameShape.name}" exists under a different name)`
              : `index "${expIdx.name}" is missing`,
          ],
          expected: expIdx,
        });
        continue;
      }
      const diffs = [];
      if (actIdx.unique !== expIdx.unique) {
        diffs.push(
          `uniqueness: expected ${expIdx.unique ? 'UNIQUE' : 'NON-UNIQUE'}, found ${actIdx.unique ? 'UNIQUE' : 'NON-UNIQUE'}`,
        );
      }
      if (actIdx.columns.join(',') !== expIdx.columns.join(',')) {
        diffs.push(
          `columns: expected [${expIdx.columns.join(', ')}], found [${actIdx.columns.join(', ')}]`,
        );
      }
      results.push({
        kind: 'index',
        table: expTable.name,
        name: expIdx.name,
        status: diffs.length ? STATUS.MISMATCH : STATUS.CORRECT,
        details: diffs,
        expected: expIdx,
        actual: actIdx,
      });
    }
    for (const actIdx of actTable.indexes) {
      if (actIdx.implicit) continue; // inline UNIQUE / PK index - covered by the PK check
      if (!expTable.indexes.some((i) => i.name === actIdx.name)) {
        results.push({
          kind: 'index',
          table: expTable.name,
          name: actIdx.name,
          status: STATUS.EXTRA,
          details: [`index "${actIdx.name}" is not part of schema.prisma - preserved, never dropped`],
          actual: actIdx,
        });
      }
    }

    // --- foreign keys -------------------------------------------------------
    const fkKey = (fk) => `${fk.from}->${fk.toTable}.${fk.to}`;
    const actByKey = new Map();
    for (const fk of actTable.fks) {
      if (!actByKey.has(fkKey(fk))) actByKey.set(fkKey(fk), fk);
    }
    for (const expFk of expTable.fks) {
      const actFk = actByKey.get(fkKey(expFk));
      if (!actFk) {
        results.push({
          kind: 'foreignKey',
          table: expTable.name,
          name: expFk.constraint ?? fkKey(expFk),
          status: STATUS.MISSING,
          details: [
            `foreign key ${fkKey(expFk)} (${expFk.onDelete} ON DELETE / ${expFk.onUpdate} ON UPDATE) is missing`,
          ],
          expected: expFk,
        });
        continue;
      }
      const diffs = [];
      if (actFk.onDelete !== expFk.onDelete) {
        diffs.push(`ON DELETE: expected ${expFk.onDelete}, found ${actFk.onDelete}`);
      }
      if (actFk.onUpdate !== expFk.onUpdate) {
        diffs.push(`ON UPDATE: expected ${expFk.onUpdate}, found ${actFk.onUpdate}`);
      }
      results.push({
        kind: 'foreignKey',
        table: expTable.name,
        name: actFk.constraint ?? expFk.constraint ?? fkKey(expFk),
        status: diffs.length ? STATUS.MISMATCH : STATUS.CORRECT,
        details: diffs,
        expected: expFk,
        actual: actFk,
      });
    }
    for (const actFk of actTable.fks) {
      if (!expTable.fks.some((fk) => fkKey(fk) === fkKey(actFk))) {
        results.push({
          kind: 'foreignKey',
          table: expTable.name,
          name: actFk.constraint ?? fkKey(actFk),
          status: STATUS.EXTRA,
          details: [
            `foreign key ${fkKey(actFk)} is not part of schema.prisma - preserved, never dropped`,
          ],
          actual: actFk,
        });
      }
    }

    // --- triggers of this table --------------------------------------------
    for (const trg of actTable.triggers ?? []) {
      results.push({
        kind: 'trigger',
        table: expTable.name,
        name: trg.name,
        status: STATUS.EXTRA,
        details: [
          `trigger "${trg.name}" is not part of schema.prisma - preserved, and re-created after any rebuild of "${expTable.name}"`,
        ],
        actual: trg,
      });
    }
  }

  // --- extra tables --------------------------------------------------------
  for (const actTable of actual.tables) {
    if (!expected.tables.some((t) => t.name === actTable.name)) {
      results.push({
        kind: 'table',
        table: actTable.name,
        name: actTable.name,
        status: STATUS.EXTRA,
        details: [`table "${actTable.name}" is not part of schema.prisma - preserved, never dropped`],
      });
    }
  }

  // --- views ---------------------------------------------------------------
  for (const view of actual.views ?? []) {
    results.push({
      kind: 'view',
      table: view.name,
      name: view.name,
      status: STATUS.EXTRA,
      details: [
        `view "${view.name}" is not part of schema.prisma - preserved. A rebuild of any table it references uses legacy_alter_table so the view keeps working.`,
      ],
      actual: view,
    });
  }

  return results;
}

function describeDefaultValue(d) {
  if (!d) return 'no default';
  if (d.kind === 'string') return `'${d.value}'`;
  if (d.kind === 'bool') return String(d.value);
  if (d.kind === 'number') return String(d.value);
  if (d.kind === 'now') return 'CURRENT_TIMESTAMP';
  if (d.kind === 'null') return 'NULL';
  return d.value;
}

export function summarise(results) {
  const counts = { CORRECT: 0, MISSING: 0, MISMATCH: 0, EXTRA: 0, UNSUPPORTED: 0 };
  const byKind = {};
  for (const r of results) {
    counts[r.status] = (counts[r.status] ?? 0) + 1;
    byKind[r.kind] ??= { CORRECT: 0, MISSING: 0, MISMATCH: 0, EXTRA: 0, UNSUPPORTED: 0 };
    byKind[r.kind][r.status] = (byKind[r.kind][r.status] ?? 0) + 1;
  }
  return { counts, byKind };
}
