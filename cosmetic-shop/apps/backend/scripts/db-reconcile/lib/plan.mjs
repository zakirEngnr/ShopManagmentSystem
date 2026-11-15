// Deterministic reconciliation plan builder.
//
// Step categories (never mixed, always emitted in this order):
//   REPORT_ONLY        - extra objects: reported, never dropped
//   MANUAL_DATA_REPAIR - blocking conditions, a human must decide
//   SAFE_ADDITIVE_DDL  - CREATE TABLE / ALTER TABLE ADD COLUMN (no data loss)
//   TABLE_REBUILD      - SQLite table rebuild
//   INDEX_CREATION     - CREATE [UNIQUE] INDEX
//   TRIGGER_RESTORE    - re-create triggers that a rebuild dropped
//
// The plan is a pure function of (expected spec, actual spec, comparison), so
// the same database always produces the same plan.
import { STATUS } from './compare.mjs';
import { columnDefinitions, duplicateCheckSql, orphanCheckSql, quoteIdent } from './ddl.mjs';
import {
  buildCreateTable,
  buildRebuildSql,
  buildSequenceRestoreSql,
  ensureSemicolon,
  extraColumnsOf,
  extraConstraintsOf,
} from './rebuild.mjs';

export const CATEGORY = {
  REPORT: 'REPORT_ONLY',
  REPAIR: 'MANUAL_DATA_REPAIR',
  ADDITIVE: 'SAFE_ADDITIVE_DDL',
  REBUILD: 'TABLE_REBUILD',
  INDEX: 'INDEX_CREATION',
  TRIGGERS: 'TRIGGER_RESTORE',
};

/** SQLite (ALTER TABLE ADD COLUMN) restrictions. */
export function canAddColumn(expTable, expCol) {
  const reasons = [];
  if (expTable.pk.includes(expCol.name)) reasons.push('column is part of the primary key');
  if (expCol.notnull && expCol.dflt === null) {
    reasons.push('NOT NULL without a default cannot be added to a table that holds rows');
  }
  if (expCol.dflt && expCol.dflt.kind === 'now') {
    reasons.push('SQLite forbids ALTER TABLE ADD COLUMN with a non-constant default (CURRENT_TIMESTAMP)');
  }
  if (expCol.dflt && expCol.dflt.kind === 'null' && expCol.notnull) {
    reasons.push('NOT NULL with default NULL cannot be added');
  }
  return { ok: reasons.length === 0, reasons };
}

/** Deterministic topological order: referenced (parent) tables first. */
export function sortByDependency(tables) {
  const names = new Set(tables.map((t) => t.name));
  const deps = new Map(
    tables.map((t) => [
      t.name,
      new Set(t.fks.map((fk) => fk.toTable).filter((p) => names.has(p) && p !== t.name)),
    ]),
  );
  const out = [];
  const done = new Set();
  const remaining = [...tables];
  while (remaining.length) {
    const pick = remaining.find((t) => [...deps.get(t.name)].every((d) => done.has(d))) ?? remaining[0];
    out.push(pick);
    done.add(pick.name);
    remaining.splice(remaining.indexOf(pick), 1);
  }
  return out;
}

export function buildPlan({ expected, expectedDdl, actual, comparison, chainSpec = null }) {
  const steps = [];
  let seq = 0;
  const push = (step) => {
    step.id = `S${String(++seq).padStart(2, '0')}`;
    steps.push(step);
    return step;
  };

  const actualTables = new Map(actual.tables.map((t) => [t.name, t]));
  const byTable = new Map();
  for (const r of comparison) {
    if (!byTable.has(r.table)) byTable.set(r.table, []);
    byTable.get(r.table).push(r);
  }
  const expectedTables = expected.tables;

  // ---- (1) REPORT_ONLY: extra objects are never dropped -------------------
  for (const r of comparison) {
    if (r.status !== STATUS.EXTRA) continue;
    push({
      category: CATEGORY.REPORT,
      action: `report extra ${r.kind} "${r.name}"`,
      table: r.table,
      object: r.name,
      sql: [],
      auto: false,
      rationale: r.details.join('; '),
    });
  }

  // ---- (2) MANUAL_DATA_REPAIR: unsupported structures ---------------------
  for (const r of comparison) {
    if (r.status !== STATUS.UNSUPPORTED) continue;
    push({
      category: CATEGORY.REPAIR,
      action: `manual review required for table "${r.table}"`,
      table: r.table,
      object: r.name,
      sql: [],
      auto: false,
      blocking: true,
      rationale: r.details.join('; '),
    });
  }

  // ---- (3) CREATE TABLE for tables that do not exist ------------------------
  for (const expTable of sortByDependency(expectedTables).filter((t) => !actualTables.has(t.name))) {
    const chainExtras = chainExtraColumns(chainSpec, expected, expTable.name);
    const createSql = buildCreateTable(expectedDdl.tables.get(expTable.name), {
      extraColumns: chainExtras,
      as: expTable.name,
    });
    const indexes = (expectedDdl.indexes.get(expTable.name) ?? []).map((i) => ensureSemicolon(i.sql));
    push({
      category: CATEGORY.ADDITIVE,
      action: `create missing table "${expTable.name}"`,
      table: expTable.name,
      object: expTable.name,
      sql: [ensureSemicolon(createSql), ...indexes],
      auto: true,
      rationale: `table "${expTable.name}" does not exist in the database`,
      prechecks: [],
      postchecks: [],
      preservedExtraColumns: chainExtras.map((c) => c.name),
    });
  }

  // ---- (4) per table decision ----------------------------------------------
  const decisions = new Map();
  for (const expTable of expectedTables) {
    const actTable = actualTables.get(expTable.name);
    if (!actTable) continue;
    if (actTable.unsupported?.length) continue; // already reported as blocking

    const rows = byTable.get(expTable.name) ?? [];
    const cols = rows.filter((r) => r.kind === 'column');
    const pkRow = rows.find((r) => r.kind === 'primaryKey');
    const fkRows = rows.filter((r) => r.kind === 'foreignKey');
    const idxRows = rows.filter((r) => r.kind === 'index');

    const missingCols = cols.filter((r) => r.status === STATUS.MISSING);
    const mismatchedCols = cols.filter((r) => r.status === STATUS.MISMATCH);
    const fkProblems = fkRows.filter((r) => r.status !== STATUS.CORRECT);
    const pkProblem = pkRow && pkRow.status !== STATUS.CORRECT;

    const reasons = [];
    for (const m of mismatchedCols) reasons.push(`${expTable.name}.${m.name}: ${m.details.join('; ')}`);
    if (pkProblem) reasons.push(`${expTable.name}: ${pkRow.details.join('; ')}`);
    for (const f of fkProblems) reasons.push(`${expTable.name}: ${f.details.join('; ')}`);

    const addable = [];
    for (const m of missingCols) {
      const check = canAddColumn(expTable, m.expected);
      if (check.ok) addable.push(m);
      else {
        reasons.push(
          `${expTable.name}.${m.name}: missing and cannot be added in place (${check.reasons.join('; ')})`,
        );
      }
    }
    for (const idx of idxRows) {
      if (idx.status !== STATUS.MISMATCH) continue;
      if (idx.actual?.implicit) {
        reasons.push(
          `${expTable.name}.${idx.name}: index is an inline UNIQUE/PK index and cannot be dropped (rebuild required)`,
        );
      }
    }

    decisions.set(expTable.name, {
      expTable,
      actTable,
      idxRows,
      addable,
      rebuild: reasons.length > 0,
      reasons,
    });
  }

  // ---- (5) SAFE ADDITIVE DDL: missing columns ---------------------------
  for (const [name, d] of decisions) {
    for (const m of d.addable) {
      const def = columnDefinition(d.expTable, m.expected);
      push({
        category: CATEGORY.ADDITIVE,
        action: `add column "${name}"."${m.name}"`,
        table: name,
        object: m.name,
        sql: [`ALTER TABLE ${quoteIdent(name)} ADD COLUMN ${def};`],
        auto: true,
        rationale: 'column is missing and can be added without rewriting the table',
        prechecks: [],
        postchecks: [],
      });
    }
  }

  // ---- (6) TABLE REBUILD ---------------------------------------------------
  const rebuilt = new Set();
  const rebuildInfo = [];
  for (const [name, d] of decisions) {
    if (!d.rebuild) continue;
    rebuilt.add(name);
    const expTable = d.expTable;
    const actTable = d.actTable;

    const extraColumns = extraColumnsOf(actTable, expTable);
    const extraConstraints = extraConstraintsOf(actTable, expTable);
    const actColNames = new Set(actTable.columns.map((c) => c.name));
    const copyColumns = [
      ...expTable.columns.filter((c) => actColNames.has(c.name)).map((c) => c.name),
      ...extraColumns.filter((c) => actColNames.has(c.name)).map((c) => c.name),
    ];
    const requiredColumns = expTable.columns.map((c) => c.name);

    const expectedIndexes = expectedDdl.indexes.get(name) ?? [];
    const extraIndexes = actTable.indexes.filter(
      (i) => !i.implicit && i.sql && !expectedIndexes.some((e) => e.name === i.name),
    );

    const createNewSql = buildCreateTable(expectedDdl.tables.get(name), {
      extraColumns,
      extraConstraints,
      as: `new_${name}`,
    });
    const sql = buildRebuildSql({
      table: name,
      createNewSql,
      copyColumns,
      expectedIndexes,
      extraIndexes,
    });

    const prechecks = [
      {
        description: `every expected column of "${name}" exists before the rebuild`,
        sql: `SELECT COUNT(*) AS violations FROM pragma_table_xinfo('${name.replace(/'/g, "''")}') WHERE name IN (${requiredColumns
          .map((c) => `'${c.replace(/'/g, "''")}'`)
          .join(', ')}) AND name NOT IN (${copyColumns
          .map((c) => `'${c.replace(/'/g, "''")}'`)
          .join(', ')});`,
        expect: { violations: 0 },
      },
    ];
    for (const c of expTable.columns) {
      if (c.notnull) {
        prechecks.push({
          description: `no NULL values in NOT NULL column ${name}.${c.name}`,
          sql: `SELECT COUNT(*) AS violations FROM ${quoteIdent(name)} WHERE ${quoteIdent(c.name)} IS NULL;`,
          expect: { violations: 0 },
        });
      }
    }
    for (const f of expTable.fks) {
      prechecks.push({
        description: `no orphan ${f.from} values in ${name} (FK -> ${f.toTable}.${f.to})`,
        sql: orphanCheckSql(name, f.from, f.toTable, f.to),
        expect: { violations: 0 },
      });
    }
    for (const idx of expectedIndexes.filter((i) => i.unique)) {
      prechecks.push({
        description: `no duplicates for unique index ${idx.name}`,
        sql: duplicateCheckSql(name, idx.columns),
        expect: { violations: 0 },
      });
    }

    const dependentViews = (actual.views ?? [])
      .filter((v) => v.references.includes(name))
      .map((v) => v.name);

    push({
      category: CATEGORY.REBUILD,
      action: `rebuild table "${name}"`,
      table: name,
      object: name,
      sql,
      auto: true,
      rationale: d.reasons.join(' | '),
      prechecks,
      postchecks: [
        {
          description: 'row count preserved',
          sql: `SELECT COUNT(*) AS rows FROM ${quoteIdent(name)};`,
          compareTo: 'rowCountBefore',
        },
        { description: 'no foreign key violations', sql: 'PRAGMA foreign_key_check;', expect: 'empty result set' },
        { description: 'sqlite integrity', sql: 'PRAGMA integrity_check;', expect: 'ok' },
      ],
      preservedExtraColumns: extraColumns.map((c) => c.name),
      preservedExtraConstraints: extraConstraints,
      preservedExtraIndexes: extraIndexes.map((i) => i.name),
      dependentViews,
      sequenceRestore: buildSequenceRestoreSql(name, null), // filled in by the applier
      triggers: actTable.triggers ?? [],
    });
    rebuildInfo.push({ table: name, triggers: actTable.triggers ?? [] });
  }

  // ---- (7) INDEX CREATION --------------------------------------------------
  for (const [name, d] of decisions) {
    if (rebuilt.has(name)) continue; // the rebuild already recreates the indexes
    for (const idx of d.idxRows) {
      if (idx.status === STATUS.CORRECT) continue;
      const expIdx = expectedDdl.indexes.get(name)?.find((i) => i.name === idx.name);
      if (!expIdx) continue;
      const prechecks =
        idx.status === STATUS.MISMATCH
          ? []
          : expIdx.unique
            ? [
                {
                  description: `no duplicates for unique index ${expIdx.name}`,
                  sql: duplicateCheckSql(name, expIdx.columns),
                  expect: { violations: 0 },
                },
              ]
            : [];
      push({
        category: CATEGORY.INDEX,
        action:
          idx.status === STATUS.MISMATCH
            ? `recreate index "${idx.name}" on "${name}"`
            : `create index "${idx.name}" on "${name}"`,
        table: name,
        object: idx.name,
        sql:
          idx.status === STATUS.MISMATCH
            ? [`DROP INDEX ${quoteIdent(idx.name)};`, ensureSemicolon(expIdx.sql)]
            : [ensureSemicolon(expIdx.sql)],
        auto: true,
        rationale: idx.details.join('; '),
        prechecks,
        postchecks: [],
      });
    }
  }

  // ---- (8) TRIGGER_RESTORE -------------------------------------------------
  const droppedTriggers = new Map();
  for (const info of rebuildInfo) {
    for (const trg of info.triggers) {
      if (!droppedTriggers.has(trg.name)) droppedTriggers.set(trg.name, trg);
    }
  }
  if (droppedTriggers.size > 0) {
    push({
      category: CATEGORY.TRIGGERS,
      action: `re-create ${droppedTriggers.size} trigger(s) removed by the rebuild`,
      table: null,
      object: [...droppedTriggers.keys()].join(', '),
      sql: [...droppedTriggers.values()]
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((t) => ensureSemicolon(t.sql)),
      auto: true,
      rationale:
        'DROP TABLE removes the triggers attached to the table. They are re-created verbatim after every rebuild has finished.',
      prechecks: [],
      postchecks: [],
    });
  }

  return steps;
}

/** Columns the migration chain creates but schema.prisma does not model. */
export function chainExtraColumns(chainSpec, expectedSpec, tableName) {
  const chainTable = chainSpec?.tables.find((t) => t.name === tableName);
  const expectedTable = expectedSpec.tables.find((t) => t.name === tableName);
  if (!chainTable || !expectedTable) return [];
  const defs = columnDefinitions(chainTable.sql);
  return chainTable.columns
    .filter((c) => !expectedTable.columns.some((e) => e.name === c.name))
    .map((c) => ({ name: c.name, definition: defs.get(c.name)?.definition ?? quoteIdent(c.name) }));
}

function columnDefinition(expTable, expCol) {
  const defs = columnDefinitions(createTableSqlFromSpec(expTable));
  const def = defs.get(expCol.name);
  if (!def) throw new Error(`no column definition for ${expCol.name}`);
  return def.definition;
}

function createTableSqlFromSpec(expTable) {
  const cols = expTable.columns.map((c) => {
    let s = `    ${quoteIdent(c.name)} ${c.type}`;
    if (c.notnull) s += ' NOT NULL';
    if (c.dflt) {
      if (c.dflt.kind === 'string') s += ` DEFAULT '${c.dflt.value}'`;
      else if (c.dflt.kind === 'bool') s += ` DEFAULT ${c.dflt.value}`;
      else if (c.dflt.kind === 'number') s += ` DEFAULT ${c.dflt.value}`;
      else if (c.dflt.kind === 'now') s += ' DEFAULT CURRENT_TIMESTAMP';
    }
    if (expTable.pk.includes(c.name)) s += ' PRIMARY KEY';
    return s;
  });
  return `CREATE TABLE ${quoteIdent(expTable.name)} (\n${cols.join(',\n')}\n);`;
}
