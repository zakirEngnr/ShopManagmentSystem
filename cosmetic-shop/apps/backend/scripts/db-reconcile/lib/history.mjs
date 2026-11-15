// Migration history planner - REPORT ONLY.
//
// This module never writes to _prisma_migrations:
//   * it never DELETEs a record
//   * it never marks a migration as applied
//   * it never resolves a failed migration
//
// It detects the state of every migration, verifies the checksums, detects
// partial execution and prints the manual actions a human should run.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { all } from './sqlite.mjs';

export const STATE = {
  APPLIED: 'APPLIED',
  FAILED: 'FAILED',
  ROLLED_BACK: 'ROLLED_BACK',
  MISSING: 'MISSING',
  NOT_A_MIGRATION: 'NOT_A_MIGRATION',
};

export function listMigrationNames(migrationsDir) {
  const dir = path.resolve(migrationsDir);
  if (!fs.existsSync(dir)) throw new Error(`migrations directory not found: ${dir}`);
  return fs
    .readdirSync(dir)
    .filter((n) => fs.existsSync(path.join(dir, n, 'migration.sql')))
    .sort();
}

export function migrationChecksum(migrationsDir, name) {
  const file = path.join(path.resolve(migrationsDir), name, 'migration.sql');
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

export function readHistory(db) {
  const present =
    all(
      db,
      `SELECT name FROM sqlite_master WHERE type='table' AND name='_prisma_migrations'`,
    ).length > 0;
  if (!present) return { present: false, rows: [], error: null };

  try {
    const rows = all(
      db,
      `SELECT id, checksum, finished_at, migration_name, logs, rolled_back_at, started_at, applied_steps_count
         FROM _prisma_migrations ORDER BY started_at, migration_name`,
    );
    return { present: true, rows, error: null };
  } catch (err) {
    return { present: true, rows: [], error: err.message };
  }
}

export function classifyHistory(history, names, migrationsDir) {
  const byName = new Map();
  for (const row of history.rows) {
    if (!byName.has(row.migration_name)) byName.set(row.migration_name, []);
    byName.get(row.migration_name).push(row);
  }

  const entries = [];
  for (const name of names) {
    const rows = byName.get(name) ?? [];
    const applied = rows.filter((r) => r.finished_at !== null && r.rolled_back_at === null);
    const failed = rows.filter((r) => r.finished_at === null && r.rolled_back_at === null);
    const rolledBack = rows.filter((r) => r.rolled_back_at !== null);

    let state = STATE.MISSING;
    if (applied.length > 0) state = STATE.APPLIED;
    else if (failed.length > 0) state = STATE.FAILED;
    else if (rolledBack.length > 0) state = STATE.ROLLED_BACK;

    const expectedChecksum = migrationChecksum(migrationsDir, name);
    entries.push({
      name,
      state,
      recordCount: rows.length,
      appliedCount: applied.length,
      failedCount: failed.length,
      rolledBackCount: rolledBack.length,
      duplicateApplied: applied.length > 1,
      checksumOk: rows.length === 0 ? null : rows.every((r) => r.checksum === expectedChecksum),
      expectedChecksum,
      recordedChecksums: [...new Set(rows.map((r) => r.checksum))],
      rows: rows.map((r) => ({
        id: r.id,
        started_at: r.started_at,
        finished_at: r.finished_at,
        rolled_back_at: r.rolled_back_at,
        checksum: r.checksum,
        logs: r.logs,
      })),
    });
  }

  const orphans = history.rows
    .filter((r) => !names.includes(r.migration_name))
    .map((r) => ({ id: r.id, migration_name: r.migration_name, state: STATE.NOT_A_MIGRATION }));

  return { entries, orphans };
}

/**
 * Flatten a schema spec into a map of object descriptors.
 * Descriptor format:
 *   table <name> | column <table>.<name> | index <name> | fk <table>.<from>-><to>.<to>
 */
export function specObjects(spec) {
  const objects = new Map();
  for (const table of spec.tables) {
    objects.set(`table ${table.name}`, { kind: 'table', table: table.name, name: table.name });
    for (const col of table.columns) {
      objects.set(`column ${table.name}.${col.name}`, {
        kind: 'column',
        table: table.name,
        name: col.name,
        type: col.type,
        notnull: col.declaredNotNull,
        dflt: col.dflt,
      });
    }
    for (const idx of table.indexes) {
      objects.set(`index ${idx.name}`, {
        kind: 'index',
        table: table.name,
        name: idx.name,
        unique: idx.unique,
        columns: idx.columns,
      });
    }
    for (const fk of table.fks) {
      const key = `${fk.from}->${fk.toTable}.${fk.to}`;
      objects.set(`fk ${table.name}.${key}`, {
        kind: 'foreignKey',
        table: table.name,
        name: fk.constraint ?? key,
        from: fk.from,
        toTable: fk.toTable,
        to: fk.to,
      });
    }
  }
  return objects;
}

/**
 * The objects a single migration introduces: everything that is in the spec
 * after the migration and not in the spec before it.
 */
export function migrationOwnObjects(previousSpec, nextSpec) {
  const before = previousSpec ? specObjects(previousSpec) : new Map();
  const after = specObjects(nextSpec);
  const own = new Map();
  for (const [descriptor, meta] of after) {
    if (!before.has(descriptor)) own.set(descriptor, meta);
  }
  return own;
}

/**
 * Does the live database contain the given schema objects?
 *
 * The check is evolution aware: a later migration may have tightened a
 * constraint or added a column, so the database only has to be at least as
 * strict as the migration requires.
 */
export function verifyObjects(actualSpec, objects) {
  const missing = [];
  const differing = [];
  const present = [];
  const actualTables = new Map(actualSpec.tables.map((t) => [t.name, t]));

  for (const [descriptor, meta] of objects) {
    const actTable = actualTables.get(meta.table);
    if (meta.kind === 'table') {
      if (!actTable) missing.push({ object: descriptor, kind: 'table' });
      else present.push(descriptor);
      continue;
    }
    if (!actTable) {
      missing.push({ object: descriptor, kind: meta.kind });
      continue;
    }
    if (meta.kind === 'column') {
      const actCol = actTable.columns.find((c) => c.name === meta.name);
      if (!actCol) {
        missing.push({ object: descriptor, kind: 'column' });
        continue;
      }
      present.push(descriptor);
      if (actCol.type !== meta.type) {
        differing.push({ object: descriptor, kind: 'column', detail: `type ${actCol.type} != ${meta.type}` });
      }
      if (meta.notnull && !actCol.declaredNotNull) {
        differing.push({ object: descriptor, kind: 'column', detail: 'expected NOT NULL but the column is nullable' });
      }
      if (meta.dflt && !actCol.dflt) {
        differing.push({ object: descriptor, kind: 'column', detail: 'expected a default value' });
      }
      continue;
    }
    if (meta.kind === 'index') {
      const actIdx = actTable.indexes.find((i) => i.name === meta.name);
      if (!actIdx) {
        missing.push({ object: descriptor, kind: 'index' });
        continue;
      }
      present.push(descriptor);
      if (actIdx.columns.join(',') !== meta.columns.join(',') || actIdx.unique !== meta.unique) {
        differing.push({ object: descriptor, kind: 'index', detail: 'shape differs' });
      }
      continue;
    }
    if (meta.kind === 'foreignKey') {
      const actFk = actTable.fks.find((f) => f.from === meta.from && f.toTable === meta.toTable && f.to === meta.to);
      if (!actFk) {
        missing.push({ object: descriptor, kind: 'foreignKey' });
        continue;
      }
      present.push(descriptor);
    }
  }
  return { missing, differing, present };
}

/**
 * Build the migration history report.
 * Everything in `recommendedActions` is a MANUAL step: the tool prints them,
 * it never runs them.
 */
function summariseObjects(missing, limit = 8) {
  const names = missing.map((m) => m.object);
  if (names.length <= limit) return names.join(', ');
  return `${names.slice(0, limit).join(', ')} (+${names.length - limit} more)`;
}

export function planHistory({ classified, effectsMissingByMigration, historyPresent, historyError }) {
  const items = [];
  let seq = 0;
  const push = (item) => {
    item.id = `H${String(++seq).padStart(2, '0')}`;
    items.push(item);
  };

  if (!historyPresent) {
    push({
      migration: null,
      state: STATE.MISSING,
      finding: 'the database has no _prisma_migrations table',
      recommendedActions: [
        'Do NOT run `prisma migrate deploy` against a database whose schema is already present: Prisma refuses with P3005 and, for a schema that is ahead of the history, it fails with P3018 and leaves a failed record.',
        'After the schema has been reconciled and verified, baseline every migration whose effects are present with `prisma migrate resolve --applied <migration_name>`.',
      ],
      severity: 'warning',
    });
  } else if (historyError) {
    push({
      migration: null,
      state: STATE.NOT_A_MIGRATION,
      finding: `the _prisma_migrations table could not be read: ${historyError}`,
      recommendedActions: ['Inspect the table manually; the tool refuses to touch it.'],
      severity: 'error',
    });
  }

  for (const entry of classified.entries) {
    const effects = effectsMissingByMigration.get(entry.name) ?? {
      missing: [],
      differing: [],
      present: [],
    };
    // "partially applied" means: some objects of this migration are there and
    // some are really absent (a different column type is a drift, not a
    // half finished migration).
    const partiallyApplied = effects.missing.length > 0 && effects.present.length > 0;

    const findings = [];
    const actions = [];
    let severity = 'info';

    if (entry.state === STATE.APPLIED && entry.duplicateApplied) {
      findings.push(
        `${entry.appliedCount} records mark this migration as applied - a duplicate applied record makes "applied exactly once" unprovable`,
      );
      actions.push(
        'MANUAL: keep exactly one record with finished_at NOT NULL and rolled_back_at IS NULL, and delete the surplus one, e.g.',
        `MANUAL: DELETE FROM "_prisma_migrations" WHERE id = '<surplus-row-id>';   -- surplus rows: ${entry.rows
          .filter((r) => r.finished_at !== null && r.rolled_back_at === null)
          .map((r) => r.id)
          .join(', ')}`,
      );
      severity = 'warning';
    }

    if (entry.state === STATE.APPLIED && effects.missing.length > 0) {
      findings.push(
        `recorded as applied, but the database does not contain: ${summariseObjects(effects.missing)}` +
          (effects.differing.length
            ? ` (and ${effects.differing.length} object(s) differ: ${summariseObjects(effects.differing)})`
            : ''),
      );
      actions.push(
        'MANUAL: reconcile the schema first (the plan in this report), then re-baseline with `prisma migrate resolve --applied ' +
          `${entry.name}` + '`.',
      );
      severity = 'error';
    }

    if (entry.state === STATE.FAILED) {
      findings.push(
        `a failed migration record exists (finished_at IS NULL) - ${
          effects.missing.length === 0
            ? 'all of its schema objects are present and match'
            : `missing: ${summariseObjects(effects.missing)}`
        }`,
      );
      if (effects.missing.length === 0) {
        actions.push(
          `MANUAL: prisma migrate resolve --applied ${entry.name}   # re-baseline; the migration's objects are already present`,
        );
      } else {
        actions.push(
          `MANUAL: prisma migrate resolve --rolled-back ${entry.name}   # mark the failed attempt, then`,
          'MANUAL: prisma migrate deploy   # re-apply it once the schema no longer collides with its DDL',
        );
      }
      severity = 'error';
    }

    if (entry.state === STATE.ROLLED_BACK) {
      findings.push('the migration was rolled back and has to be re-applied');
      actions.push(
        'MANUAL: prisma migrate deploy   # re-applies the rolled-back migration',
      );
      severity = 'warning';
    }

    if (entry.state === STATE.MISSING) {
      if (effects.missing.length === 0) {
        findings.push('no history record, but every schema object of this migration is present');
        actions.push(
          `MANUAL: prisma migrate resolve --applied ${entry.name}   # baseline without re-running the DDL`,
        );
        severity = 'warning';
      } else {
        findings.push(
          `no history record and the schema is missing: ${summariseObjects(effects.missing)}` +
            (effects.differing.length
              ? ` (and ${effects.differing.length} object(s) differ: ${summariseObjects(effects.differing)})`
              : ''),
        );
        actions.push(
          'MANUAL: prisma migrate deploy   # apply the migration for real (after the schema has been reconciled so its DDL succeeds)',
        );
        severity = 'warning';
      }
    }

    if (partiallyApplied && entry.state !== STATE.FAILED) {
      findings.push(
        'the migration looks partially applied: some of its objects exist and some do not',
      );
      severity = 'error';
    }

    if (entry.checksumOk === false) {
      findings.push(
        `checksum mismatch: the database records ${entry.recordedChecksums.join(', ')} but sha256(migration.sql) is ${entry.expectedChecksum} - the migration file was edited after it was applied`,
      );
      actions.push(
        'MANUAL: restore the original migration file, or accept the change and re-baseline deliberately. Do not edit the migration file in place.',
      );
      severity = 'error';
    }

    if (findings.length > 0) {
      push({
        migration: entry.name,
        state: entry.state,
        finding: findings.join(' | '),
      missingObjects: effects.missing.map((m) => m.object),
      differingObjects: effects.differing.map((m) => m.object),
        recommendedActions: actions,
        severity,
        recordCount: entry.recordCount,
        appliedCount: entry.appliedCount,
        failedCount: entry.failedCount,
        rolledBackCount: entry.rolledBackCount,
      });
    }
  }

  for (const orphan of classified.orphans) {
    push({
      migration: orphan.migration_name,
      state: orphan.state,
      finding: 'a history record exists for a migration that is not present in prisma/migrations',
      recommendedActions: [
        `MANUAL: decide whether to keep or delete the orphan record (id ${orphan.id}). The tool never deletes history records.`,
      ],
      severity: 'warning',
    });
  }

  return items;
}
