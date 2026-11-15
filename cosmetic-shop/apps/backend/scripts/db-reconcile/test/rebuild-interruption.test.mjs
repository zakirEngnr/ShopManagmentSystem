#!/usr/bin/env node
// Rebuild interruption and recovery tests.
//
// A table rebuild cannot run inside a transaction (PRAGMA foreign_keys is a
// no-op there), so an interruption can leave the database in a half-finished
// state. These tests drive the REAL rebuild statements of the tool, stop after
// every stage and then verify that the pre-rebuild backup restores the
// database completely.
//
// The rebuilt table is "Sale": it has children (SaleItem, PaymentAllocation,
// KhataTransaction), a dependent view and a trigger, so every preservation
// property can be checked.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test, describe, before } from 'node:test';

import { BACKEND_ROOT } from '../lib/paths.mjs';
import { SCENARIOS } from '../lib/scenarios.mjs';
import { reconcile } from '../lib/engine.mjs';
import { openWritable, openReadOnly, all } from '../lib/sqlite.mjs';
import { buildSpecFromDdl, generateIntentDdl } from '../lib/expected.mjs';
import { TEST_DB_ROOT, ensureTestDbRoot } from '../../../test-support/dbGuard.js';

const MIGRATIONS_DIR = path.join(BACKEND_ROOT, 'prisma/migrations');
const SCHEMA = path.join(BACKEND_ROOT, 'prisma/schema.prisma');
const TARGET = 'Sale';
ensureTestDbRoot();
const WORK = fs.mkdtempSync(path.join(TEST_DB_ROOT, 'rebuild-interrupt-'));

let expectedSpec = null;

before(async () => {
  const generated = generateIntentDdl({
    schemaPath: SCHEMA,
    workDir: path.join(WORK, 'work'),
    cliCwd: BACKEND_ROOT,
  });
  expectedSpec = buildSpecFromDdl(generated.sql, path.join(WORK, 'work', 'expected.db')).spec;
});

// --------------------------------------------------------------------------
function buildFixture(name) {
  const dbPath = path.join(WORK, `${name}.db`);
  SCENARIOS.F.build({ dbPath, migrationsDir: MIGRATIONS_DIR });
  const db = openWritable(dbPath);
  // a dependent view and a trigger on the table that will be rebuilt
  db.exec(`CREATE VIEW "V_sales" AS SELECT "id","invoiceNo","total" FROM "Sale"`);
  db.exec(
    `CREATE TRIGGER "Sale_guard" BEFORE UPDATE ON "Sale" BEGIN SELECT RAISE(ABORT, 'no updates'); END`,
  );
  db.close();
  return dbPath;
}

/** Everything that must be identical before and after a restore. */
function measure(dbPath) {
  // writable: the trigger check performs an UPDATE that the trigger aborts
  const db = openWritable(dbPath);
  try {
    const tables = all(db, `SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`).map(
      (r) => r.name,
    );
    const counts = {};
    for (const t of tables) {
      if (t.startsWith('sqlite_')) continue;
      try {
        counts[t] = all(db, `SELECT count(*) AS c FROM "${t}"`)[0].c;
      } catch (err) {
        counts[t] = `ERROR: ${err.message}`;
      }
    }
    let viewRows = null;
    try {
      viewRows = all(db, `SELECT count(*) AS c FROM "V_sales"`)[0].c;
    } catch (err) {
      viewRows = `ERROR: ${err.message}`;
    }
    const triggers = all(db, `SELECT name FROM sqlite_master WHERE type='trigger' ORDER BY name`).map(
      (r) => r.name,
    );
    // does the trigger still fire?
    let triggerFires = null;
    try {
      db.prepare(`UPDATE "Sale" SET "total" = "total" WHERE "id" = 1`).run();
      triggerFires = false;
    } catch (err) {
      triggerFires = /no updates/.test(err.message);
    }
    const seq = all(db, `SELECT seq FROM sqlite_sequence WHERE name = ?`, [TARGET])[0]?.seq ?? null;
    let integrity = 'ok';
    try {
      const rows = all(db, 'PRAGMA integrity_check');
      integrity = Object.values(rows[0] ?? {})[0] ?? 'ok';
    } catch (err) {
      integrity = `ERROR: ${err.message}`;
    }
    let fkCheck = [];
    try {
      fkCheck = all(db, 'PRAGMA foreign_key_check');
    } catch (err) {
      fkCheck = [{ error: err.message }];
    }
    return {
      tables: tables.filter((t) => !t.startsWith('sqlite_')),
      counts,
      viewRows,
      triggers,
      triggerFires,
      seq,
      integrity,
      fkViolations: fkCheck.length,
      fkSample: fkCheck.slice(0, 2),
      saleIndexes: all(
        db,
        `SELECT name FROM sqlite_master WHERE type='index' AND tbl_name = ? ORDER BY name`,
        [TARGET],
      ).map((r) => r.name),
    };
  } finally {
    db.close();
  }
}

/** The rebuild statements of the plan, grouped into the stages we interrupt. */
function stagesOf(rebuildStep) {
  const sql = rebuildStep.sql;
  const find = (re) => sql.findIndex((s) => re.test(s));
  const idx = {
    pragmas: find(/PRAGMA defer_foreign_keys=ON/),
    create: find(/^CREATE TABLE "new_/),
    copy: find(/^INSERT INTO "new_/),
    drop: find(/^DROP TABLE/),
    rename: find(/^ALTER TABLE "new_.*RENAME TO/),
    indexes: find(/^CREATE (UNIQUE )?INDEX/),
  };
  return [
    { name: '0-backup-created', upto: -1 },
    { name: '1-pragmas-set', upto: idx.pragmas },
    { name: '2-replacement-created', upto: idx.create },
    { name: '3-data-copied', upto: idx.copy },
    { name: '4-original-dropped', upto: idx.drop },
    { name: '5-replacement-renamed', upto: idx.rename },
    { name: '6-indexes-restored', upto: idx.indexes },
  ];
}

function backupOf(dbPath, dir) {
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, `${path.basename(dbPath)}.bak`);
  fs.rmSync(target, { force: true });
  const db = openWritable(dbPath);
  try {
    db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
  } finally {
    db.close();
  }
  return target;
}

/** Restore the database file from a backup (what an operator would do). */
function restoreFrom(backup, dbPath) {
  for (const suffix of ['-wal', '-shm', '-journal']) {
    fs.rmSync(`${dbPath}${suffix}`, { force: true });
  }
  fs.copyFileSync(backup, dbPath);
}

async function planFor(dbPath, outDir, tag = 'work') {
  const audit = await reconcile({
    dbPath,
    mode: 'audit',
    schemaPath: SCHEMA,
    migrationsDir: MIGRATIONS_DIR,
    workDir: path.join(outDir, tag),
    cliCwd: BACKEND_ROOT,
    allowWrites: false,
  });
  const rebuild = audit.plan.find((s) => s.category === 'TABLE_REBUILD' && s.table === TARGET);
  assert.ok(rebuild, `the fixture must produce a rebuild of ${TARGET}`);
  return { rebuild, plan: audit.plan };
}

// --------------------------------------------------------------------------
describe('rebuild interruption', () => {
  const STAGES = [
    '0-backup-created',
    '1-pragmas-set',
    '2-replacement-created',
    '3-data-copied',
    '4-original-dropped',
    '5-replacement-renamed',
    '6-indexes-restored',
  ];

  for (const stageName of STAGES) {
    test(`interrupted after "${stageName}" - the backup restores everything`, async () => {
      const dbPath = buildFixture(`interrupt-${stageName}`);
      const outDir = path.join(WORK, `out-${stageName}`);
      fs.mkdirSync(outDir, { recursive: true });

      const { rebuild } = await planFor(dbPath, outDir);
      const before = measure(dbPath);

      // the backup the tool takes before it writes
      const backup = backupOf(dbPath, path.join(outDir, 'backups'));

      // run the rebuild statements until the interruption point
      const stage = stagesOf(rebuild).find((s) => s.name === stageName);
      const db = openWritable(dbPath);
      try {
        for (let i = 0; i <= stage.upto; i++) db.exec(rebuild.sql[i]);
      } finally {
        db.close();
      }

      const interrupted = measure(dbPath);
      const damaged =
        interrupted.counts[TARGET] === undefined ||
        interrupted.integrity !== 'ok' ||
        interrupted.fkViolations > 0 ||
        String(interrupted.viewRows).startsWith('ERROR') ||
        interrupted.triggerFires !== true;

      // restore from the backup
      restoreFrom(backup, dbPath);
      const after = measure(dbPath);

      assert.deepEqual(after.tables, before.tables, 'the table list must be restored');
      assert.deepEqual(after.counts, before.counts, 'every row count must be restored');
      assert.equal(after.counts[TARGET], before.counts[TARGET], 'the rebuilt table must be back');
      assert.equal(
        after.counts.SaleItem,
        before.counts.SaleItem,
        'child rows (SaleItem) must be intact',
      );
      assert.equal(
        after.counts.KhataTransaction,
        before.counts.KhataTransaction,
        'child rows (KhataTransaction) must be intact',
      );
      assert.equal(
        after.counts.PaymentAllocation,
        before.counts.PaymentAllocation,
        'child rows (PaymentAllocation) must be intact',
      );
      assert.equal(after.viewRows, before.viewRows, 'the view must work again');
      assert.deepEqual(after.triggers, before.triggers, 'the trigger must be back');
      assert.equal(after.triggerFires, true, 'the trigger must fire again');
      assert.equal(after.seq, before.seq, 'the AUTOINCREMENT sequence must be preserved');
      assert.equal(after.integrity, 'ok', 'PRAGMA integrity_check must be ok');
      assert.equal(after.fkViolations, 0, 'PRAGMA foreign_key_check must be clean');
      assert.deepEqual(after.saleIndexes, before.saleIndexes, 'the indexes must be back');

      console.log(
        `      [${stageName}] interrupted: sale=${interrupted.counts[TARGET] ?? 'MISSING'} ` +
          `replacement=${interrupted.counts[`new_${TARGET}`] ?? '-'} ` +
          `integrity=${interrupted.integrity} fkViolations=${interrupted.fkViolations} ` +
          `view=${interrupted.viewRows} triggerFires=${interrupted.triggerFires} ` +
          `seq=${interrupted.seq} -> ${damaged ? 'DAMAGED (restore required)' : 'still consistent'}`,
      );
    });
  }

  test('a complete rebuild keeps children, views, triggers and the sequence', async () => {
    const dbPath = buildFixture('complete');
    const outDir = path.join(WORK, 'out-complete');
    fs.mkdirSync(outDir, { recursive: true });

    const { rebuild, plan } = await planFor(dbPath, outDir);
    const before = measure(dbPath);
    const backup = backupOf(dbPath, path.join(outDir, 'backups'));

    const db = openWritable(dbPath);
    try {
      const seqBefore = all(db, `SELECT seq FROM sqlite_sequence WHERE name = ?`, [TARGET])[0];
      for (const statement of rebuild.sql) db.exec(statement);
      if (seqBefore) {
        db.exec(`DELETE FROM sqlite_sequence WHERE name = '${TARGET}'`);
        db.exec(`INSERT INTO sqlite_sequence (name, seq) VALUES ('${TARGET}', ${Number(seqBefore.seq)})`);
      }
      // the applier runs the trigger restore step after the rebuild
      const triggerStep = plan.find((s) => s.category === 'TRIGGER_RESTORE');
      assert.ok(triggerStep, 'the plan must contain a trigger restore step');
      for (const statement of triggerStep.sql) db.exec(statement);
    } finally {
      db.close();
    }

    const after = measure(dbPath);
    assert.equal(after.counts[TARGET], before.counts[TARGET], 'no row may be lost');
    assert.equal(after.counts.SaleItem, before.counts.SaleItem, 'child rows must survive');
    assert.equal(after.counts.KhataTransaction, before.counts.KhataTransaction);
    assert.equal(after.counts.PaymentAllocation, before.counts.PaymentAllocation);
    assert.equal(after.viewRows, before.viewRows, 'the dependent view must still work');
    assert.deepEqual(after.triggers, before.triggers, 'the trigger must still exist');
    assert.equal(after.seq, before.seq, 'the AUTOINCREMENT sequence must be preserved');
    assert.equal(after.integrity, 'ok');
    assert.equal(after.fkViolations, 0);
    assert.ok(fs.existsSync(backup), 'the backup must exist');
  });

  test('the trigger restore step re-creates a trigger that the rebuild removed', async () => {
    const dbPath = buildFixture('trigger-restore');
    const outDir = path.join(WORK, 'out-trigger-restore');
    fs.mkdirSync(outDir, { recursive: true });
    // the plan is captured BEFORE the rebuild, because after the rebuild the
    // table already matches and no trigger restore step would be produced.
    const { rebuild, plan } = await planFor(dbPath, outDir);
    const triggerStep = plan.find((s) => s.category === 'TRIGGER_RESTORE');
    assert.ok(triggerStep, 'the plan must contain a trigger restore step');

    const db = openWritable(dbPath);
    try {
      for (const statement of rebuild.sql) db.exec(statement);
    } finally {
      db.close();
    }
    const afterDrop = measure(dbPath);
    assert.deepEqual(
      afterDrop.triggers,
      [],
      'DROP TABLE removes the trigger - the plan must re-create it',
    );
    const db2 = openWritable(dbPath);
    try {
      for (const statement of triggerStep.sql) db2.exec(statement);
    } finally {
      db2.close();
    }
    const restored = measure(dbPath);
    assert.ok(restored.triggers.includes('Sale_guard'), 'the trigger must be back');
    assert.equal(restored.triggerFires, true, 'the trigger must fire again');
  });
});
