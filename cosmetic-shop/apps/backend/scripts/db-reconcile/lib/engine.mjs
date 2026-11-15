// Reconciliation engine.
//
// The engine is the single implementation used by the CLI and by the test
// suite, so the behaviour that is tested is exactly the behaviour that runs.
//
// It NEVER writes to the target unless `allowWrites` is true, and it never
// writes to the migration history.
import fs from 'node:fs';
import path from 'node:path';
import {
  buildCumulativeSpecs,
  buildSpecFromDdl,
  buildSpecFromMigrations,
  generateIntentDdl,
  listMigrations,
} from './expected.mjs';
import { compare, summarise } from './compare.mjs';
import { buildPlan } from './plan.mjs';
import { applyPlan } from './apply.mjs';
import {
  classifyHistory,
  migrationOwnObjects,
  planHistory,
  readHistory,
  verifyObjects,
} from './history.mjs';
import { introspect } from './introspect.mjs';
import { foreignKeyCheck, integrityCheck, journalMode, openReadOnly, openWritable, sqliteVersion } from './sqlite.mjs';

export async function reconcile({
  dbPath,
  mode = 'audit',
  schemaPath,
  migrationsDir,
  expectedDdlFile = null,
  workDir,
  cliCwd,
  backupDir = null,
  allowWrites = false,
}) {
  fs.mkdirSync(workDir, { recursive: true });

  // ---- expected schema ----------------------------------------------------
  let intentDdl;
  let intentSource;
  if (expectedDdlFile) {
    intentDdl = fs.readFileSync(path.resolve(expectedDdlFile), 'utf8');
    intentSource = `supplied file ${path.resolve(expectedDdlFile)}`;
  } else {
    const generated = generateIntentDdl({ schemaPath, workDir, cliCwd });
    intentDdl = generated.sql;
    intentSource = `prisma migrate diff --from-empty --to-schema ${path.resolve(schemaPath)}`;
  }
  const intent = buildSpecFromDdl(intentDdl, path.join(workDir, 'expected-intent.db'));
  const chain = buildSpecFromMigrations(migrationsDir, path.join(workDir, 'expected-chain.db'));
  const cumulative = buildCumulativeSpecs(migrationsDir, path.join(workDir, 'cumulative'));

  const expectedSpec = intent.spec;
  const chainSpec = chain.spec;
  const chainDelta = compare(expectedSpec, chainSpec).filter((r) => r.status !== 'CORRECT');

  // ---- actual database ----------------------------------------------------
  const readDb = openReadOnly(dbPath);
  let actualSpec;
  let dbMeta;
  let history;
  let classified;
  const effectsMissingByMigration = new Map();
  try {
    actualSpec = introspect(readDb);
    dbMeta = {
      sqliteVersion: sqliteVersion(readDb),
      journalMode: journalMode(readDb),
      integrityCheck: integrityCheck(readDb),
      foreignKeyCheck: foreignKeyCheck(readDb),
    };
    history = readHistory(readDb);
    classified = classifyHistory(history, listMigrations(migrationsDir), migrationsDir);
  } finally {
    readDb.close();
  }

  const migrationNames = listMigrations(migrationsDir);
  migrationNames.forEach((name, index) => {
    const previous = index === 0 ? null : cumulative.get(migrationNames[index - 1]);
    const own = migrationOwnObjects(previous, cumulative.get(name));
    effectsMissingByMigration.set(name, verifyObjects(actualSpec, own));
  });
  const historyItems = planHistory({
    classified,
    effectsMissingByMigration,
    historyPresent: history.present,
    historyError: history.error,
  });

  // ---- classification + plan ----------------------------------------------
  const comparison = compare(expectedSpec, actualSpec);
  const before = summarise(comparison);
  const plan = buildPlan({
    expected: expectedSpec,
    expectedDdl: intent.ddl,
    actual: actualSpec,
    comparison,
    chainSpec,
  });

  // ---- pre-flight: a database that already violates its own constraints -----
  // is not repaired automatically: the orphans are reported and the run stops.
  const preflight = [];
  if (dbMeta.foreignKeyCheck.length > 0) {
    preflight.push({
      category: 'MANUAL_DATA_REPAIR',
      action: 'resolve the existing foreign key violations before reconciling',
      table: null,
      object: null,
      sql: [],
      auto: false,
      blocking: true,
      rationale: `PRAGMA foreign_key_check reports ${dbMeta.foreignKeyCheck.length} violation(s): ${dbMeta.foreignKeyCheck
        .slice(0, 5)
        .map((v) => `${v.table}.rowid=${v.rowid} -> ${v.parent}.${v.fkid}`)
        .join(', ')}${dbMeta.foreignKeyCheck.length > 5 ? ', ...' : ''}`,
    });
  }
  const integrityProblem = dbMeta.integrityCheck.filter((v) => v !== 'ok');
  if (integrityProblem.length > 0) {
    preflight.push({
      category: 'MANUAL_DATA_REPAIR',
      action: 'repair the SQLite integrity problems before reconciling',
      table: null,
      object: null,
      sql: [],
      auto: false,
      blocking: true,
      rationale: `PRAGMA integrity_check reports: ${integrityProblem.join(' | ')}`,
    });
  }
  if (preflight.length > 0) {
    plan.unshift(...preflight.map((p, i) => ({ ...p, id: `P${String(i + 1).padStart(2, '0')}` })));
  }

  // ---- apply (optional) ---------------------------------------------------
  let applyResult = null;
  let afterSummary = null;
  if (allowWrites) {
    applyResult = applyPlan(dbPath, plan, { backupDir, allowWrites: true });
    const afterDb = openWritable(dbPath);
    try {
      afterSummary = summarise(compare(expectedSpec, introspect(afterDb)));
    } finally {
      afterDb.close();
    }
  }

  return {
    expectedSource: intentSource,
    expectedSpec,
    chainSpec,
    chainDelta,
    actualSpec,
    comparison,
    before,
    after: afterSummary,
    plan,
    history: historyItems,
    historyState: classified,
    dbMeta,
    applyResult,
  };
}
