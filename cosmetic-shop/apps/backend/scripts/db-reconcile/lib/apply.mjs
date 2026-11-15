// Plan applier.
//
// Rules:
//   * every pre-check runs before the step; a failing pre-check BLOCKS the
//     step and stops the whole run (orphan foreign keys, duplicate unique
//     values and unexpected NULLs are never "fixed" automatically)
//   * a backup of the whole database is taken before the first write and again
//     before every table rebuild
//   * a rebuild restores the AUTOINCREMENT sequence and re-creates the triggers
//     that DROP TABLE removed
//   * the data fingerprint is compared before and after; any real data loss
//     aborts the run and reports the backup that can restore the file
import fs from 'node:fs';
import path from 'node:path';
import { all, get, openWritable } from './sqlite.mjs';
import { diffFingerprints, dataLossDeltas, fingerprint } from './fingerprint.mjs';
import { buildSequenceRestoreSql } from './rebuild.mjs';
import { CATEGORY } from './plan.mjs';

function evaluateCheck(db, check) {
  if (/^\s*PRAGMA/i.test(check.sql)) {
    const rows = all(db, check.sql);
    if (check.expect === 'empty result set') return { ok: rows.length === 0, actual: rows };
    if (check.expect === 'ok') {
      const value = rows[0] ? Object.values(rows[0])[0] : undefined;
      return { ok: value === 'ok', actual: value };
    }
    return { ok: true, actual: rows };
  }
  const rows = all(db, check.sql);
  const row = rows[0] ?? {};
  if (check.expect && typeof check.expect === 'object') {
    for (const [key, value] of Object.entries(check.expect)) {
      if (row[key] !== value) return { ok: false, actual: row };
    }
  }
  return { ok: true, actual: row };
}

function backupPath(dir, dbPath, label) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const target = path.join(dir, `${path.basename(dbPath)}.${label}.${stamp}.bak`);
  fs.rmSync(target, { force: true });
  return target;
}

/**
 * Apply a plan to a disposable database.
 * Returns a detailed log; the caller decides what to do with a failure.
 */
export function applyPlan(dbPath, plan, { backupDir, allowWrites }) {
  const log = [];
  const state = { aborted: false, abortReason: null, backups: [] };
  let triggersBefore = new Set();

  if (!allowWrites) {
    return { log: [{ status: 'skipped', detail: 'writes are not allowed in this mode' }], state, before: null, after: null, deltas: [] };
  }

  fs.mkdirSync(backupDir, { recursive: true });
  const db = openWritable(dbPath);
  let before;
  try {
    before = fingerprint(db);
    triggersBefore = new Set(
      all(db, `SELECT name FROM sqlite_master WHERE type='trigger'`).map((r) => r.name),
    );

    // pre-flight: refuse to work on a database that already violates its own
    // foreign keys or fails the integrity check.
    const fkViolations = all(db, 'PRAGMA foreign_key_check');
    if (fkViolations.length > 0) {
      state.aborted = true;
      state.abortReason = `the database already contains ${fkViolations.length} foreign key violation(s)`;
      log.push({
        status: 'blocked',
        detail: `PRAGMA foreign_key_check reports ${fkViolations.length} violation(s): ${fkViolations
          .slice(0, 5)
          .map((v) => `${v.table}.rowid=${v.rowid}`)
          .join(', ')}`,
      });
    }
    const integrity = all(db, 'PRAGMA integrity_check');
    if (integrity.length > 0 && Object.values(integrity[0])[0] !== 'ok') {
      state.aborted = true;
      state.abortReason = `PRAGMA integrity_check reports: ${Object.values(integrity[0])[0]}`;
      log.push({ status: 'blocked', detail: state.abortReason });
    }

    // backup before the first write
    const initial = backupPath(backupDir, dbPath, 'pre-reconcile');
    db.exec(`VACUUM INTO '${initial.replace(/'/g, "''")}'`);
    state.backups.push(initial);
    log.push({ status: 'backup', detail: `pre-reconcile backup: ${initial}` });

    for (const step of plan) {
      if (state.aborted) {
        log.push({ step: step.id, status: 'skipped', detail: 'run aborted by an earlier failure' });
        continue;
      }
      if (step.category === CATEGORY.REPORT) {
        log.push({ step: step.id, status: 'reported', detail: step.rationale });
        continue;
      }
      if (step.category === CATEGORY.REPAIR) {
        log.push({ step: step.id, status: 'blocked', detail: step.rationale });
        state.aborted = true;
        state.abortReason = `manual data repair required: ${step.rationale}`;
        continue;
      }
      if (!step.auto) {
        log.push({ step: step.id, status: 'skipped-manual', detail: step.rationale });
        continue;
      }

      // ---- pre-checks -----------------------------------------------------
      let blocked = null;
      for (const check of step.prechecks ?? []) {
        const res = evaluateCheck(db, check);
        if (!res.ok) {
          blocked = { description: check.description, actual: res.actual };
          break;
        }
      }
      if (blocked) {
        log.push({
          step: step.id,
          status: 'blocked',
          detail: `${blocked.description} -> ${JSON.stringify(blocked.actual)}`,
        });
        step.status = 'blocked';
        step.blockedBy = blocked.description;
        state.aborted = true;
        state.abortReason = `pre-check failed for ${step.id}: ${blocked.description}`;
        continue;
      }

      // ---- backup before a rebuild ----------------------------------------
      if (step.category === CATEGORY.REBUILD) {
        const backup = backupPath(backupDir, dbPath, `pre-${step.id}`);
        db.exec(`VACUUM INTO '${backup.replace(/'/g, "''")}'`);
        state.backups.push(backup);
        step.backup = backup;
        log.push({ step: step.id, status: 'backup', detail: `pre-rebuild backup: ${backup}` });
      }

      // ---- execute --------------------------------------------------------
      try {
        const runStatement = (statement) => {
          try {
            db.exec(statement);
          } catch (err) {
            throw new Error(`${err.message} [statement: ${String(statement).slice(0, 160)}]`);
          }
        };
        if (step.category === CATEGORY.REBUILD) {
          const rowsBefore = get(db, `SELECT COUNT(*) AS c FROM "${step.table.replace(/"/g, '""')}"`);
          const seqBefore = get(db, `SELECT seq FROM sqlite_sequence WHERE name = ?`, [step.table]);
          for (const statement of step.sql) runStatement(statement);
          // restore the AUTOINCREMENT high-water mark (DROP TABLE removes it)
          for (const statement of buildSequenceRestoreSql(
            step.table,
            seqBefore ? Number(seqBefore.seq) : null,
          )) {
            db.exec(statement);
          }
          const rowsAfter = get(db, `SELECT COUNT(*) AS c FROM "${step.table.replace(/"/g, '""')}"`);
          if (rowsBefore && rowsAfter && Number(rowsBefore.c) !== Number(rowsAfter.c)) {
            throw new Error(
              `row count changed during rebuild of "${step.table}": ${rowsBefore.c} -> ${rowsAfter.c}`,
            );
          }
        } else {
          for (const statement of step.sql) runStatement(statement);
        }
        step.status = 'applied';
        log.push({ step: step.id, status: 'applied', detail: step.action });
      } catch (err) {
        step.status = 'failed';
        step.error = err.message;
        log.push({ step: step.id, status: 'failed', detail: `${step.action}: ${err.message}` });
        state.aborted = true;
        state.abortReason = `step ${step.id} failed: ${err.message}`;
        continue;
      }

      // ---- post-checks ----------------------------------------------------
      for (const check of step.postchecks ?? []) {
        const res = evaluateCheck(db, check);
        if (!res.ok) {
          log.push({
            step: step.id,
            status: 'postcheck-failed',
            detail: `${check.description} -> ${JSON.stringify(res.actual)}`,
          });
          state.aborted = true;
          state.abortReason = `post-check failed for ${step.id}: ${check.description}`;
        }
      }
    }
  } finally {
    db.close();
  }

  const afterDb = openWritable(dbPath);
  let after;
  try {
    after = fingerprint(afterDb);
  } finally {
    afterDb.close();
  }
  const deltas = diffFingerprints(before, after);
  const loss = dataLossDeltas(deltas);
  if (loss.length > 0) {
    state.aborted = true;
    state.abortReason = `unexpected data loss detected: ${loss.map((l) => l.table).join(', ')}`;
  }

  // Final gate: a rebuild must not lose a trigger or break a view.
  const gateDb = openWritable(dbPath);
  try {
    const afterTriggers = new Set(
      all(gateDb, `SELECT name FROM sqlite_master WHERE type='trigger'`).map((r) => r.name),
    );
    // triggersBefore was captured before the first write
    const lostTriggers = [...triggersBefore].filter((t) => !afterTriggers.has(t));
    if (lostTriggers.length > 0) {
      state.aborted = true;
      state.abortReason = `trigger(s) lost during the reconciliation: ${lostTriggers.join(', ')}`;
      log.push({ status: 'postcheck-failed', detail: state.abortReason });
    }
    const views = all(gateDb, `SELECT name FROM sqlite_master WHERE type='view'`).map((r) => r.name);
    for (const view of views) {
      try {
        all(gateDb, `SELECT * FROM "${view.replace(/"/g, '""')}" LIMIT 1`);
      } catch (err) {
        state.aborted = true;
        state.abortReason = `view "${view}" is broken after the reconciliation: ${err.message}`;
        log.push({ status: 'postcheck-failed', detail: state.abortReason });
      }
    }
  } finally {
    gateDb.close();
  }

  return { log, state, before, after, deltas, dataLoss: loss };
}
