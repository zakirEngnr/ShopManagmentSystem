#!/usr/bin/env node
// Test suite for the db-reconcile tool.
//
//   node --test scripts/db-reconcile/test/reconcile.test.mjs
//
// Every test runs against a disposable database under the OS temp directory.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, before, after, describe } from 'node:test';
import { execFileSync } from 'node:child_process';

import { BACKEND_ROOT, resolveTargetPath } from '../lib/paths.mjs';
import { TEST_DB_ROOT, ensureTestDbRoot } from '../../../test-support/dbGuard.js';
import { SCENARIOS } from '../lib/scenarios.mjs';
import { reconcile } from '../lib/engine.mjs';
import { openReadOnly, openWritable, all } from '../lib/sqlite.mjs';
import { compare, summarise } from '../lib/compare.mjs';
import { fingerprint, diffFingerprints, dataLossDeltas } from '../lib/fingerprint.mjs';
import { buildSpecFromDdl, generateIntentDdl } from '../lib/expected.mjs';
import { classifyHistory, listMigrationNames, readHistory } from '../lib/history.mjs';
import { runAppChecks } from '../app-check.mjs';

const MIGRATIONS_DIR = path.join(BACKEND_ROOT, 'prisma/migrations');
const SCHEMA = path.join(BACKEND_ROOT, 'prisma/schema.prisma');
// Every disposable database of this suite lives inside the designated test
// database directory (shared with the rest of the backend test suite).
ensureTestDbRoot();
const TMP = fs.mkdtempSync(path.join(TEST_DB_ROOT, 'db-reconcile-test-'));

let expectedSpec = null;
let intentDdl = null;

before(async () => {
  const generated = generateIntentDdl({
    schemaPath: SCHEMA,
    workDir: path.join(TMP, 'work'),
    cliCwd: BACKEND_ROOT,
  });
  intentDdl = generated.sql;
  expectedSpec = buildSpecFromDdl(intentDdl, path.join(TMP, 'work', 'expected.db')).spec;
});

after(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

function buildScenario(key) {
  const dir = path.join(TMP, 'scenarios', key);
  fs.mkdirSync(dir, { recursive: true });
  const dbPath = path.join(dir, 'scenario.db');
  SCENARIOS[key].build({ dbPath, migrationsDir: MIGRATIONS_DIR });
  return { dbPath, dir };
}

async function runReconcile(dbPath, { allowWrites = false, dir = null } = {}) {
  const outDir = dir ?? path.join(TMP, 'runs', path.basename(path.dirname(dbPath)));
  fs.mkdirSync(outDir, { recursive: true });
  return reconcile({
    dbPath,
    mode: allowWrites ? 'apply' : 'audit',
    schemaPath: SCHEMA,
    migrationsDir: MIGRATIONS_DIR,
    workDir: path.join(outDir, 'work'),
    cliCwd: BACKEND_ROOT,
    backupDir: path.join(outDir, 'backups'),
    allowWrites,
  });
}

// ---------------------------------------------------------------------------
describe('safety guards', () => {
  test('refuses the live shop.db and its backups', () => {
    const protectedPaths = [
      path.join(BACKEND_ROOT, 'shop.db'),
      path.join(BACKEND_ROOT, 'shop.db.BACKUP-20261109-123638'),
      path.join(BACKEND_ROOT, 'shop.db.pre-restore-20261111-152801'),
      path.join(BACKEND_ROOT, 'shop.db.bak.1792328119'),
      path.join(BACKEND_ROOT, 'backups', 'anything.db'),
    ];
    for (const p of protectedPaths) {
      assert.throws(
        () => resolveTargetPath(p),
        /protected/i,
        `expected ${p} to be refused`,
      );
    }
  });

  test('the CLI refuses --db without a value and never falls back to DATABASE_URL', () => {
    const result = (() => {
      try {
        execFileSync(
          'node',
          [path.join(BACKEND_ROOT, 'scripts/db-reconcile/reconcile.mjs')],
          { cwd: BACKEND_ROOT, encoding: 'utf8', env: { ...process.env, DATABASE_URL: 'file:./shop.db' } },
        );
        return { code: 0, out: '' };
      } catch (err) {
        return { code: err.status, out: `${err.stdout ?? ''}${err.stderr ?? ''}` };
      }
    })();
    assert.notEqual(result.code, 0);
    assert.match(result.out, /missing required argument --db/i);
    assert.doesNotMatch(result.out, /shop\.db/);
  });

  test('the CLI refuses --apply without --yes-disposable', () => {
    const dbPath = path.join(TMP, 'guard.db');
    fs.rmSync(dbPath, { force: true });
    fs.writeFileSync(dbPath, '');
    const result = (() => {
      try {
        execFileSync(
          'node',
          [path.join(BACKEND_ROOT, 'scripts/db-reconcile/reconcile.mjs'), '--db', dbPath, '--apply'],
          { cwd: BACKEND_ROOT, encoding: 'utf8' },
        );
        return { code: 0, out: '' };
      } catch (err) {
        return { code: err.status, out: `${err.stdout ?? ''}${err.stderr ?? ''}` };
      }
    })();
    assert.notEqual(result.code, 0);
    assert.match(result.out, /--yes-disposable/i);
  });

  test('the CLI refuses --apply on a path outside the disposable roots', () => {
    const dbPath = path.join(BACKEND_ROOT, 'scripts/db-reconcile/test', 'not-disposable.db');
    fs.rmSync(dbPath, { force: true });
    fs.writeFileSync(dbPath, '');
    const result = (() => {
      try {
        execFileSync(
          'node',
          [
            path.join(BACKEND_ROOT, 'scripts/db-reconcile/reconcile.mjs'),
            '--db', dbPath,
            '--apply',
            '--yes-disposable',
          ],
          { cwd: BACKEND_ROOT, encoding: 'utf8' },
        );
        return { code: 0, out: '' };
      } catch (err) {
        return { code: err.status, out: `${err.stdout ?? ''}${err.stderr ?? ''}` };
      }
    })();
    fs.rmSync(dbPath, { force: true });
    assert.notEqual(result.code, 0);
    assert.match(result.out, /disposable root/i);
  });
});

// ---------------------------------------------------------------------------
describe('scenarios A-G', () => {
  for (const key of Object.keys(SCENARIOS)) {
    test(`scenario ${key} (${SCENARIOS[key].title})`, async () => {
      const { dbPath, dir } = buildScenario(key);

      // ---- audit ----------------------------------------------------------
      const audit = await runReconcile(dbPath, { dir });
      assert.ok(audit.before.counts.MISSING + audit.before.counts.MISMATCH > 0, 'scenario must need work');
      assert.ok(audit.plan.length > 0, 'a plan must be produced');
      // A DROP TABLE is only allowed inside a rebuild that copies every row
      // into the replacement table first.
      for (const step of audit.plan) {
        const drops = step.sql.filter((q) => /DROP\s+TABLE/i.test(q));
        if (drops.length === 0) continue;
        assert.equal(step.category, 'TABLE_REBUILD', 'only a rebuild may drop a table');
        const joined = step.sql.join('\n');
        assert.match(joined, /INSERT INTO "new_/, 'the rows must be copied before the old table is dropped');
        assert.match(joined, /ALTER TABLE "new_[^"]+" RENAME TO/, 'the copy must be renamed back');
      }

      // ---- history is report only ------------------------------------------
      const historyBefore = readHistory(openReadOnly(dbPath));
      const historyAfter = readHistory(openReadOnly(dbPath));
      assert.deepEqual(
        historyBefore.rows.map((r) => r.id),
        historyAfter.rows.map((r) => r.id),
        'the history planner must not touch the migration history',
      );

      // ---- apply -----------------------------------------------------------
      const before = fingerprint(openWritable(dbPath));
      const applied = await runReconcile(dbPath, { allowWrites: true, dir: path.join(dir, 'apply') });
      assert.equal(applied.applyResult.state.aborted, false, `run aborted: ${applied.applyResult.state.abortReason}`);
      assert.equal(applied.applyResult.dataLoss.length, 0, 'no data loss is allowed');
      assert.equal(applied.after.counts.MISSING, 0, 'no expected object may stay missing');
      assert.equal(applied.after.counts.MISMATCH, 0, 'no expected object may stay mismatched');
      assert.equal(applied.after.counts.UNSUPPORTED, 0, 'no unsupported structure may remain');

      // ---- data preservation ------------------------------------------------
      const after = fingerprint(openWritable(dbPath));
      const deltas = diffFingerprints(before, after);
      const loss = dataLossDeltas(deltas);
      assert.equal(loss.length, 0, `data loss detected: ${JSON.stringify(loss)}`);
      for (const table of Object.keys(before)) {
        assert.equal(before[table].count, after[table].count, `row count changed in ${table}`);
      }
      // created tables are allowed, dropped tables are not
      for (const delta of deltas) {
        assert.notEqual(delta.kind, 'dropped', 'no table may be dropped');
        assert.notEqual(delta.kind, 'row-count-changed', 'no row count may change');
      }

      // ---- indexes and foreign keys ------------------------------------------
      const db = openReadOnly(dbPath);
      try {
        for (const table of expectedSpec.tables) {
          const indexes = all(db, `SELECT * FROM pragma_index_list(?)`, [table.name]);
          for (const expectedIndex of table.indexes) {
            const found = indexes.find((i) => i.name === expectedIndex.name);
            assert.ok(found, `index ${expectedIndex.name} missing on ${table.name}`);
            assert.equal(Boolean(found.unique), Boolean(expectedIndex.unique));
          }
          const fks = all(db, `SELECT * FROM pragma_foreign_key_list(?)`, [table.name]);
          for (const expectedFk of table.fks) {
            const found = fks.find(
              (f) =>
                f.from === expectedFk.from &&
                f.table === expectedFk.toTable &&
                f.to === expectedFk.to,
            );
            assert.ok(found, `foreign key ${expectedFk.from}->${expectedFk.toTable} missing on ${table.name}`);
            assert.equal(found.on_delete, expectedFk.onDelete, `ON DELETE of ${table.name}.${expectedFk.from}`);
            assert.equal(found.on_update, expectedFk.onUpdate, `ON UPDATE of ${table.name}.${expectedFk.from}`);
          }
        }
        // integrity + foreign key checks must be clean
        const integrity = all(db, 'PRAGMA integrity_check');
        assert.equal(Object.values(integrity[0])[0], 'ok');
        const fkCheck = all(db, 'PRAGMA foreign_key_check');
        assert.equal(fkCheck.length, 0, `foreign key violations: ${JSON.stringify(fkCheck)}`);
      } finally {
        db.close();
      }

      // ---- application level checks -------------------------------------------
      process.env.DATABASE_URL = `file:${dbPath}`;
      process.env.UPLOAD_DIR = path.join(dir, 'uploads');
      fs.mkdirSync(process.env.UPLOAD_DIR, { recursive: true });
      process.env.JWT_SECRET = 'db-reconcile-test-secret-0123456789abcdef';
      process.env.NODE_ENV = 'test';
      const appResults = await runAppChecks({ uploadDir: process.env.UPLOAD_DIR });
      const failed = appResults.filter((r) => !r.ok);
      assert.equal(
        failed.length,
        0,
        `application checks failed: ${JSON.stringify(failed)}`,
      );
      assert.equal(appResults.length, 42, 'the application check set must stay complete');
    });
  }
});

// ---------------------------------------------------------------------------
describe('determinism', () => {
  test('the same database always produces the same plan', async () => {
    const { dbPath } = buildScenario('F');
    const first = await runReconcile(dbPath, { dir: path.join(TMP, 'determinism-1') });
    const second = await runReconcile(dbPath, { dir: path.join(TMP, 'determinism-2') });
    assert.deepEqual(
      first.plan.map((s) => [s.id, s.category, s.action, s.sql]),
      second.plan.map((s) => [s.id, s.category, s.action, s.sql]),
    );
  });
});

describe('migration history planner', () => {
  test('detects missing, applied, failed and duplicate records', async () => {
    const { dbPath } = buildScenario('G');
    const result = await runReconcile(dbPath, { dir: path.join(TMP, 'history') });
    const byMigration = new Map(result.history.map((h) => [h.migration, h]));

    const failed = byMigration.get('20261111120000_add_idempotency_and_counter');
    assert.ok(failed, 'the failed migration must be reported');
    assert.equal(failed.state, 'FAILED');
    assert.equal(failed.severity, 'error');
    assert.match(failed.recommendedActions.join(' '), /resolve --applied|resolve --rolled-back/);

    const duplicate = byMigration.get('20261020124202_brand_fk_restrict');
    assert.ok(duplicate, 'the duplicated migration must be reported');
    assert.match(duplicate.recommendedActions.join(' '), /DELETE FROM "_prisma_migrations"/);

    // every action is manual
    for (const item of result.history) {
      for (const action of item.recommendedActions) {
        assert.match(action, /^MANUAL:/, 'history actions must be marked as manual');
      }
    }
  });

  test('never modifies the history table', async () => {
    const { dbPath } = buildScenario('G');
    const db = openReadOnly(dbPath);
    const before = all(db, 'SELECT * FROM "_prisma_migrations" ORDER BY id');
    db.close();
    await runReconcile(dbPath, { allowWrites: true, dir: path.join(TMP, 'history-write') });
    const db2 = openReadOnly(dbPath);
    const after = all(db2, 'SELECT * FROM "_prisma_migrations" ORDER BY id');
    db2.close();
    assert.deepEqual(before, after, 'applying a plan must not change the migration history');
  });

  test('detects a checksum mismatch', async () => {
    const { dbPath } = buildScenario('G');
    const db = openWritable(dbPath);
    db.exec(`UPDATE "_prisma_migrations" SET checksum = 'deadbeef' WHERE migration_name = '20261018125524_init'`);
    db.close();
    const result = await runReconcile(dbPath, { dir: path.join(TMP, 'history-checksum') });
    const entry = result.history.find((h) => h.migration === '20261018125524_init');
    assert.ok(entry, 'the migration must be reported');
    assert.match(entry.finding, /checksum mismatch/i);
  });
});

// ---------------------------------------------------------------------------
describe('rebuild safety', () => {
  test('a rebuild keeps the AUTOINCREMENT sequence', async () => {
    const { dbPath } = buildScenario('F');
    const db = openWritable(dbPath);
    db.exec(`INSERT INTO "Purchase" ("id","supplierId","totalAmount","paidAmount","status","createdAt")
             VALUES (900,1,10,0,'UNPAID','2026-01-15 09:00:00')`);
    db.close();
    await runReconcile(dbPath, { allowWrites: true, dir: path.join(TMP, 'seq') });
    const db2 = openWritable(dbPath);
    const seq = all(db2, `SELECT seq FROM sqlite_sequence WHERE name='Purchase'`)[0];
    db2.close();
    assert.ok(Number(seq?.seq) >= 900, `the AUTOINCREMENT sequence must not go backwards: ${JSON.stringify(seq)}`);
  });

  test('a rebuild keeps a dependent view working', async () => {
    const { dbPath } = buildScenario('F');
    const db = openWritable(dbPath);
    db.exec(`CREATE VIEW "V_sales" AS SELECT "id","invoiceNo","total" FROM "Sale"`);
    db.close();
    await runReconcile(dbPath, { allowWrites: true, dir: path.join(TMP, 'view') });
    const db2 = openWritable(dbPath);
    const rows = all(db2, 'SELECT * FROM "V_sales"');
    db2.close();
    assert.equal(rows.length, 2, 'the view must still return the sale rows');
  });

  test('a rebuild re-creates the triggers it removed', async () => {
    const { dbPath } = buildScenario('F');
    const db = openWritable(dbPath);
    db.exec(`CREATE TRIGGER "Sale_guard_total" BEFORE UPDATE ON "Sale" BEGIN SELECT RAISE(ABORT, 'no updates'); END`);
    db.close();
    await runReconcile(dbPath, { allowWrites: true, dir: path.join(TMP, 'trigger') });
    const db2 = openWritable(dbPath);
    const triggers = all(db2, `SELECT name FROM sqlite_master WHERE type='trigger'`);
    db2.close();
    assert.ok(
      triggers.some((t) => t.name === 'Sale_guard_total'),
      'the trigger must survive the rebuild',
    );
  });

  test('the plan stops on orphan foreign keys', async () => {
    const { dbPath } = buildScenario('A');
    const db = openWritable(dbPath);
    db.exec('PRAGMA foreign_keys=OFF;');
    db.exec(`INSERT INTO "KhataTransaction" ("id","customerId","type","amount","createdAt")
             VALUES (99, 424242, 'SALE', 10, '2026-01-15 09:00:00')`);
    db.exec('PRAGMA foreign_keys=ON;');
    db.close();
    const result = await runReconcile(dbPath, { allowWrites: true, dir: path.join(TMP, 'orphan') });
    assert.equal(result.applyResult.state.aborted, true, 'the run must abort on an orphan row');
    assert.match(result.applyResult.state.abortReason, /orphan|pre-check|foreign key violation/i);
  });

  test('the plan stops on duplicate values of a unique index', async () => {
    const { dbPath } = buildScenario('A');
    const db = openWritable(dbPath);
    // remove the unique index first so that the duplicate row can be stored
    db.exec(`DROP INDEX "Sale_invoiceNo_key";`);
    db.exec(`INSERT INTO "Sale" ("id","invoiceNo","subtotal","discount","total","recognizedAmount","paymentMethod","createdAt")
             VALUES (77, 'INV-0001', 1, 0, 1, 0, 'CASH', '2026-01-15 09:00:00')`);
    db.close();
    const result = await runReconcile(dbPath, { allowWrites: true, dir: path.join(TMP, 'dupe') });
    assert.equal(result.applyResult.state.aborted, true, 'the run must abort on a duplicate value');
    assert.match(result.applyResult.state.abortReason, /pre-check|duplicate/i);
  });

  test('a backup exists before every rebuild', async () => {
    const { dbPath, dir } = buildScenario('F');
    const result = await runReconcile(dbPath, { allowWrites: true, dir: path.join(dir, 'apply') });
    const rebuilds = result.plan.filter((s) => s.category === 'TABLE_REBUILD');
    assert.ok(rebuilds.length > 0);
    const backups = result.applyResult.state.backups;
    assert.ok(backups.length >= rebuilds.length, 'one backup per rebuild plus the initial one');
    for (const backup of backups) {
      assert.ok(fs.existsSync(backup), `backup ${backup} must exist`);
      assert.ok(fs.statSync(backup).size > 0, 'the backup must not be empty');
    }
  });
});

// ---------------------------------------------------------------------------
describe('final safety gate', () => {
  test('a rebuild that loses a trigger aborts the run', async () => {
    const { dbPath } = buildScenario('F');
    const db = openWritable(dbPath);
    db.exec(`CREATE TRIGGER "Sale_guard" BEFORE UPDATE ON "Sale" BEGIN SELECT RAISE(ABORT, 'no'); END`);
    db.close();

    const result = await runReconcile(dbPath, { dir: path.join(TMP, 'gate') });
    const triggerStep = result.plan.find((s) => s.category === 'TRIGGER_RESTORE');
    assert.ok(triggerStep, 'the plan must restore the trigger');

    // simulate an interruption before the trigger restore step
    const { applyPlan } = await import('../lib/apply.mjs');
    const truncated = result.plan.filter((s) => s.category !== 'TRIGGER_RESTORE');
    const applied = applyPlan(dbPath, truncated, {
      backupDir: path.join(TMP, 'gate', 'backups'),
      allowWrites: true,
    });
    assert.equal(applied.state.aborted, true, 'the run must abort');
    assert.match(applied.state.abortReason, /trigger/i);
  });
});

// ---------------------------------------------------------------------------
describe('reports', () => {
  test('the JSON report and the SQL plan are written', async () => {
    const { dbPath } = buildScenario('D');
    const outDir = path.join(TMP, 'report');
    await runReconcile(dbPath, { dir: outDir });
    const { writeJsonReport, writeSqlPlan } = await import('../lib/report.mjs');
    const result = await runReconcile(dbPath, { dir: outDir });
    const jsonFile = writeJsonReport(outDir, {
      target: { path: dbPath },
      mode: 'audit',
      generatedAt: new Date().toISOString(),
      expected: { source: 'test', tables: 18, columns: 124, uniqueIndexes: 14, regularIndexes: 25, foreignKeys: 16 },
      classification: { before: result.before, after: null },
      plan: result.plan,
      history: result.history,
      data: null,
      output: { json: '', sql: '' },
    });
    const sqlFile = writeSqlPlan(outDir, result.plan, { target: dbPath, history: result.history });
    assert.ok(fs.existsSync(jsonFile));
    assert.ok(fs.existsSync(sqlFile));
    const sql = fs.readFileSync(sqlFile, 'utf8');
    assert.match(sql, /REVIEW THIS FILE BEFORE RUNNING ANY OF IT/);
    assert.match(sql, /ALTER TABLE "KhataTransaction" ADD COLUMN "idempotencyKey" TEXT;/);
    // every DROP TABLE in the plan belongs to a rebuild that copies first
    for (const block of sql.split('-- ---------------------------------------------------------------------------')) {
      if (!/DROP TABLE/i.test(block)) continue;
      assert.match(block, /INSERT INTO "new_/);
      assert.match(block, /ALTER TABLE "new_[^"]+" RENAME TO/);
    }
    const report = JSON.parse(fs.readFileSync(jsonFile, 'utf8'));
    assert.equal(report.classification.before.counts.MISSING > 0, true);
    assert.ok(Array.isArray(report.history));
  });
});
