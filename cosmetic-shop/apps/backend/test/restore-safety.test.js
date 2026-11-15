// The safety of the restore workflow.
//
// EVERY database of this file is a throw-away SQLite file inside the
// designated test database directory. The development database (shop.db), its
// backups and its sidecar files are never opened, written or replaced.
//
// The scenarios are the ones the D24 audit found broken:
//   * a corrupted backup replaced the live database before it was checked;
//   * the replacement was not atomic - a crash left a malformed database;
//   * a stale -wal / -journal was applied to the restored file;
//   * the recovery copy was written to the wrong directory and never rotated.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';

import { createTempDb, assertTmpDbUrl } from '../test-support/tempDb.js';

const backendDir = path.resolve(import.meta.dirname, '..');
const backendUrl = pathToFileURL(backendDir + path.sep).href;

let prisma;
let restoreService;
let ctx;
let workDir;

/** The facts of a database file that a shop cares about. */
function snapshot(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  const one = (sql) => {
    try { return db.prepare(sql).get(); } catch { return { c: 'n/a' }; }
  };
  const all = (sql) => {
    try { return db.prepare(sql).all(); } catch { return []; }
  };
  const out = {
    integrity: one('PRAGMA integrity_check').integrity_check,
    foreignKeys: all('PRAGMA foreign_key_check').length,
    tables: one("SELECT count(*) c FROM sqlite_master WHERE type='table'").c,
    indexes: one("SELECT count(*) c FROM sqlite_master WHERE type='index'").c,
    migrations: all('SELECT migration_name FROM _prisma_migrations ORDER BY migration_name').map((r) => r.migration_name),
    users: one('SELECT count(*) c FROM User').c,
    products: one('SELECT count(*) c FROM Product').c,
    stock: one('SELECT coalesce(sum(stock),0) s FROM Product').s,
    sales: one('SELECT count(*) c FROM Sale').c,
    saleTotal: one('SELECT coalesce(sum(total),0) s FROM Sale').s,
    purchases: one('SELECT count(*) c FROM "Purchase"').c,
    expensesActive: one('SELECT count(*) c FROM Expense WHERE deletedAt IS NULL').c,
    expensesArchived: one('SELECT count(*) c FROM Expense WHERE deletedAt IS NOT NULL').c,
    expenseTotal: one('SELECT coalesce(sum(amount),0) s FROM Expense WHERE deletedAt IS NULL').s,
    expenseHistory: one('SELECT count(*) c FROM ExpenseHistory').c,
    customers: one('SELECT count(*) c FROM Customer').c,
    customerBalance: one('SELECT coalesce(sum(balance),0) s FROM Customer').s,
    suppliers: one('SELECT count(*) c FROM Supplier').c,
    supplierBalance: one('SELECT coalesce(sum(balance),0) s FROM Supplier').s,
    ledger: one('SELECT count(*) c FROM KhataTransaction').c,
  };
  db.close();
  return out;
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/** Fill the database with rows that a shop would recognise. */
async function seedBusinessData() {
  const now = new Date('2026-03-01T10:00:00.000Z');
  const user = await prisma.user.create({
    data: { name: 'Owner', email: `owner-${Date.now()}@shop.local`, password: 'x', role: 'ADMIN', isActive: true },
  });
  const category = await prisma.category.create({ data: { name: 'Cosmetics', type: 'COSMETIC' } });
  const brand = await prisma.brand.create({ data: { name: 'Generic' } });
  const product = await prisma.product.create({
    data: { sku: 'AUD-1', name: 'Audit Product', type: 'COSMETIC', costPrice: 5, sellPrice: 10, stock: 42, lowStockAt: 5, categoryId: category.id, brandId: brand.id },
  });
  const customer = await prisma.customer.create({ data: { name: 'Audit Customer', phone: '03000000001', balance: 250, type: 'RETAIL' } });
  const supplier = await prisma.supplier.create({ data: { name: 'Audit Supplier', phone: '03000000002', balance: 75 } });
  const expense = await prisma.expense.create({
    data: { date: now, category: 'RENT', expenseName: 'Audit Head', description: 'Audit rent', amount: 300 },
  });
  await prisma.expense.update({ where: { id: expense.id }, data: { deletedAt: new Date('2026-03-02T10:00:00.000Z') } });
  await prisma.expenseHistory.create({
    data: { expenseId: expense.id, action: 'DELETE', snapshot: JSON.stringify({ id: expense.id }) },
  });
  return { user, product, customer, supplier, expense };
}

before(async () => {
  ctx = await createTempDb({ prefix: 'restore-safety-', backendDir });
  assertTmpDbUrl(ctx.dbUrl, ctx.realTmp);
  workDir = ctx.tmpDir;
  const db = await import(backendUrl + 'src/db/prisma.js');
  prisma = db.prisma;
  restoreService = await import(backendUrl + 'src/services/restore.service.js');
});

after(async () => {
  if (prisma) await prisma.$disconnect();
  if (ctx) ctx.cleanup();
});

beforeEach(() => {
  // Every test works on its own file inside the throw-away directory. The
  // database of the suite itself is never touched.
  for (const name of fs.readdirSync(workDir)) {
    if (name === path.basename(ctx.dbFile)) continue;
    if (name.startsWith('live-') || name.startsWith('shop-') || name.includes('restore-tmp') || name.includes('pre-restore') || name === 'big.db' || name === 'wal.db' || name === 'journal.db') {
      try { fs.rmSync(path.join(workDir, name), { force: true, recursive: true }); } catch {}
    }
  }
});

/** A disposable database file with a copy of the schema and some rows. */
async function makeLiveDatabase(name) {
  const file = path.join(workDir, name);
  fs.copyFileSync(ctx.dbFile, file);
  return file;
}

/* ------------------------------------------------------------------ */
/* 1. a valid backup restores successfully                              */
/* ------------------------------------------------------------------ */

test('a valid backup restores the database and every aggregate', async () => {
  await seedBusinessData();
  const backupDir = path.join(workDir, 'backups');
  fs.mkdirSync(backupDir, { recursive: true });

  // The backup is created in a child process: the backup service reads
  // BACKUP_DIR when the module is loaded, so it must be set before the import.
  const realBackupDir = path.join(backendDir, 'backups');
  const realBefore = fs.readdirSync(realBackupDir).length;
  const child = spawnSync('node', ['-e', `
    process.env.DATABASE_URL = 'file:${ctx.dbFile}';
    process.env.BACKUP_DIR = '${backupDir}';
    const svc = await import('${backendUrl}src/services/backup.service.js');
    const created = await svc.createBackup();
    console.log('CREATED ' + created.filename);
  `], { env: { ...process.env }, encoding: 'utf8' });
  const created = /CREATED (\S+)/.exec(child.stdout || '');
  assert.ok(created, `the backup could not be created: ${child.stderr}`);
  assert.equal(
    fs.readdirSync(realBackupDir).length,
    realBefore,
    'the real backup directory must not be written to by a test',
  );

  const backupPath = path.join(backupDir, created[1]);
  const expected = snapshot(ctx.dbFile);

  // The live database of this test is a copy with an extra row.
  const live = await makeLiveDatabase('live-valid.db');
  await prisma.customer.create({ data: { name: 'Extra', phone: '03000000009', balance: 0, type: 'RETAIL' } });

  const result = await restoreService.performRestore({
    backupPath,
    databasePath: live,
    keep: 5,
  });

  assert.equal(result.outcome, restoreService.RESTORE_OUTCOME.RESTORED, result.message);
  const restored = snapshot(live);
  for (const key of Object.keys(expected)) {
    assert.deepEqual(restored[key], expected[key], `the restored database differs in ${key}`);
  }
  assert.ok(result.recoveryCopy, 'a recovery copy must be reported');
  assert.ok(fs.existsSync(result.recoveryCopy), 'the recovery copy must exist');
  assert.notEqual(sha256(result.recoveryCopy), sha256(live), 'the recovery copy must hold the previous database');
});

/* ------------------------------------------------------------------ */
/* 2-4. an invalid backup never replaces the live database             */
/* ------------------------------------------------------------------ */

test('a corrupted backup is refused and the live database stays byte identical', async () => {
  const live = await makeLiveDatabase('live-corrupt.db');
  const before = sha256(live);
  const corrupt = path.join(workDir, 'shop-20260102-000000.db');
  fs.writeFileSync(corrupt, crypto.randomBytes(64 * 1024));

  const result = await restoreService.performRestore({ backupPath: corrupt, databasePath: live });

  assert.equal(result.outcome, restoreService.RESTORE_OUTCOME.REJECTED);
  assert.equal(result.code, restoreService.REJECT_CODE.BACKUP_NOT_A_DATABASE);
  assert.equal(sha256(live), before, 'the live database must be byte identical');
  assert.doesNotMatch(result.message, /at .*\.js:\d+/, 'the message must not contain a stack trace');
});

test('a missing backup leaves the live database byte identical', async () => {
  const live = await makeLiveDatabase('live-missing.db');
  const before = sha256(live);

  const result = await restoreService.performRestore({
    backupPath: path.join(workDir, 'does-not-exist.db'),
    databasePath: live,
  });

  assert.equal(result.outcome, restoreService.RESTORE_OUTCOME.REJECTED);
  assert.equal(result.code, restoreService.REJECT_CODE.BACKUP_MISSING);
  assert.equal(sha256(live), before, 'the live database must be byte identical');
  assert.equal(fs.readdirSync(workDir).filter((n) => n.includes('pre-restore')).length, 0, 'no recovery copy may be created');
});

test('an invalid SQLite file leaves the live database byte identical', async () => {
  const live = await makeLiveDatabase('live-invalid.db');
  const before = sha256(live);
  const invalid = path.join(workDir, 'shop-20260103-000000.db');
  fs.writeFileSync(invalid, 'this is definitely not a database, not even a little bit');

  const result = await restoreService.performRestore({ backupPath: invalid, databasePath: live });

  assert.equal(result.outcome, restoreService.RESTORE_OUTCOME.REJECTED);
  assert.equal(result.code, restoreService.REJECT_CODE.BACKUP_NOT_A_DATABASE);
  assert.equal(sha256(live), before, 'the live database must be byte identical');
});

test('an empty backup file leaves the live database byte identical', async () => {
  const live = await makeLiveDatabase('live-empty.db');
  const before = sha256(live);
  const empty = path.join(workDir, 'shop-20260104-000000.db');
  fs.writeFileSync(empty, '');

  const result = await restoreService.performRestore({ backupPath: empty, databasePath: live });

  assert.equal(result.outcome, restoreService.RESTORE_OUTCOME.REJECTED);
  assert.equal(result.code, restoreService.REJECT_CODE.BACKUP_EMPTY);
  assert.equal(sha256(live), before, 'the live database must be byte identical');
});

/* ------------------------------------------------------------------ */
/* 5. a failed recovery copy prevents the replacement                  */
/* ------------------------------------------------------------------ */

test('a recovery copy that cannot be written prevents the replacement', async () => {
  const live = await makeLiveDatabase('live-recovery-fail.db');
  const before = sha256(live);
  const backup = path.join(workDir, 'shop-20260105-000000.db');
  fs.copyFileSync(ctx.dbFile, backup);

  // A directory that cannot be written to: the recovery copy fails.
  const lockedDir = path.join(workDir, 'locked');
  fs.mkdirSync(lockedDir, { recursive: true });
  const lockedDb = path.join(lockedDir, 'shop.db');
  fs.copyFileSync(ctx.dbFile, lockedDb);
  const lockedBefore = sha256(lockedDb);
  fs.chmodSync(lockedDir, 0o555);
  try {
    const result = await restoreService.performRestore({ backupPath: backup, databasePath: lockedDb });
    assert.equal(result.outcome, restoreService.RESTORE_OUTCOME.REJECTED);
    assert.equal(result.code, restoreService.REJECT_CODE.RECOVERY_COPY_FAILED);
    assert.equal(sha256(lockedDb), lockedBefore, 'the live database must be byte identical');
  } finally {
    fs.chmodSync(lockedDir, 0o755);
  }
  assert.equal(sha256(live), before);
});

/* ------------------------------------------------------------------ */
/* 6. an interrupted restore leaves a usable database                  */
/* ------------------------------------------------------------------ */

test('a restore that is killed leaves the live database usable', async () => {
  const script = path.join(backendDir, 'scripts', 'restore-backup.mjs');

  // A database big enough that the replacement takes a moment.
  const big = path.join(workDir, 'big.db');
  {
    const db = new DatabaseSync(big);
    db.exec('CREATE TABLE big (id INTEGER PRIMARY KEY, payload TEXT)');
    db.exec('BEGIN');
    for (let i = 0; i < 25000; i += 1) {
      db.prepare('INSERT INTO big (payload) VALUES (?)').run('x'.repeat(4000));
      if (i % 2500 === 0) db.exec('COMMIT; BEGIN;');
    }
    db.exec('COMMIT');
    db.close();
  }
  const backup = path.join(workDir, 'shop-20260106-000000.db');
  fs.copyFileSync(big, backup);

  for (const delay of [40, 90, 160, 260]) {
    const live = path.join(workDir, 'live-interrupted.db');
    fs.copyFileSync(big, live);
    const before = sha256(live);

    const child = spawn('node', [script, backup], {
      env: { ...process.env, DATABASE_URL: `file:${live}`, PORT: '45961' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.resume();
    child.stderr.resume();
    await new Promise((resolve) => setTimeout(resolve, delay));
    child.kill('SIGKILL');
    await new Promise((resolve) => setTimeout(resolve, 250));

    const after = sha256(live);
    const usable = (() => {
      try {
        const db = new DatabaseSync(live, { readOnly: true });
        const integrity = db.prepare('PRAGMA integrity_check').get().integrity_check;
        db.close();
        return integrity === 'ok';
      } catch {
        return false;
      }
    })();

    assert.ok(usable, `the live database must stay usable after a kill at ${delay}ms`);
    assert.ok(
      after === before || after === sha256(backup),
      `the live database must be the old or the new database after a kill at ${delay}ms`,
    );
  }
});

/* ------------------------------------------------------------------ */
/* 7-8. a stale sidecar may not be applied to the restored database     */
/* ------------------------------------------------------------------ */

test('a stale write-ahead log is not applied to the restored database', async () => {
  const walDb = path.join(workDir, 'wal.db');
  const backup = path.join(workDir, 'shop-20260107-000000.db');
  {
    const writer = new DatabaseSync(walDb);
    writer.exec('PRAGMA journal_mode=WAL');
    writer.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
    writer.close();
  }

  // A writer that dies without closing leaves a write-ahead log with a
  // committed row that was never checkpointed into the database file.
  const child = spawn('node', ['-e', `
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync('${walDb}');
    db.exec('PRAGMA journal_mode=WAL');
    db.prepare('INSERT INTO t (v) VALUES (?)').run('committed-in-the-wal');
    setTimeout(() => {}, 10000);
  `], { stdio: 'ignore' });
  await new Promise((resolve) => setTimeout(resolve, 700));
  child.kill('SIGKILL');
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.ok(fs.existsSync(`${walDb}-wal`), 'the write-ahead log must exist for this scenario');

  // The backup is the database file without the write-ahead log.
  fs.copyFileSync(walDb, backup);

  const result = await restoreService.performRestore({
    backupPath: backup,
    databasePath: walDb,
    allowOlderSchema: true,
  });

  assert.equal(result.outcome, restoreService.RESTORE_OUTCOME.RESTORED, result.message);

  // The restored database must be EXACTLY the backup: the rows of the stale
  // write-ahead log must not have been applied to it.
  assert.equal(sha256(walDb), sha256(backup), 'the restored database must be the backup, byte for byte');

  const db = new DatabaseSync(walDb, { readOnly: true });
  const rows = db.prepare('SELECT * FROM t').all();
  const integrity = db.prepare('PRAGMA integrity_check').get().integrity_check;
  db.close();
  assert.equal(integrity, 'ok');
  assert.equal(rows.length, 0, 'the rows of the stale write-ahead log must not be in the restored database');

  const sidecarStep = result.steps.find((step) => step.step === 'sidecars');
  assert.match(sidecarStep.message, /wal/, 'the stale write-ahead log must be reported as removed');
});

test('a stale hot journal does not corrupt the restored database', async () => {
  const journalDb = path.join(workDir, 'journal.db');
  const backup = path.join(workDir, 'shop-20260108-000000.db');

  // The live database holds one row.
  {
    const db = new DatabaseSync(journalDb);
    db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
    db.prepare('INSERT INTO t (v) VALUES (?)').run('row-of-the-live-database');
    db.close();
  }
  // The backup holds a DIFFERENT row: if the hot journal of the live database
  // were applied to the restored file, the live row would come back.
  {
    const db = new DatabaseSync(backup);
    db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
    db.prepare('INSERT INTO t (v) VALUES (?)').run('row-of-the-backup');
    db.close();
  }

  // A writer that dies with an open transaction leaves a hot journal.
  const writer = spawn('node', ['-e', `
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync('${journalDb}');
    db.exec('BEGIN IMMEDIATE');
    db.prepare('INSERT INTO t (v) VALUES (?)').run('uncommitted-row');
    setTimeout(() => {}, 10000);
  `], { stdio: 'ignore' });
  await new Promise((resolve) => setTimeout(resolve, 700));
  writer.kill('SIGKILL');
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.ok(fs.existsSync(`${journalDb}-journal`), 'the hot journal must exist for this scenario');

  const result = await restoreService.performRestore({
    backupPath: backup,
    databasePath: journalDb,
    allowOlderSchema: true,
  });

  assert.equal(result.outcome, restoreService.RESTORE_OUTCOME.RESTORED, result.message);

  // The restored database must be EXACTLY the backup: the hot journal of the
  // old database must not have been rolled back onto it.
  assert.equal(sha256(journalDb), sha256(backup), 'the restored database must be the backup, byte for byte');

  const db = new DatabaseSync(journalDb, { readOnly: true });
  const integrity = db.prepare('PRAGMA integrity_check').get().integrity_check;
  const rows = db.prepare('SELECT * FROM t').all();
  db.close();
  assert.equal(integrity, 'ok', 'the restored database must be intact');
  assert.deepEqual(
    rows.map((row) => row.v),
    ['row-of-the-backup'],
    'the row of the live database must not have been rolled back into the restored database',
  );
});

/* ------------------------------------------------------------------ */
/* 9-11. the recovery copies                                           */
/* ------------------------------------------------------------------ */

test('an existing recovery copy is never overwritten', async () => {
  const live = await makeLiveDatabase('live-recovery-copies.db');
  const first = restoreService.uniqueRecoveryCopyPath(live);
  fs.writeFileSync(first, 'an earlier recovery copy');

  const second = restoreService.uniqueRecoveryCopyPath(live);
  assert.notEqual(first, second, 'a second recovery copy must get its own name');
  assert.equal(fs.readFileSync(first, 'utf8'), 'an earlier recovery copy', 'the earlier copy must not be touched');
});

test('repeated restores keep every recovery copy', async () => {
  const live = await makeLiveDatabase('live-repeated.db');
  const backup = path.join(workDir, 'shop-20260109-000000.db');
  fs.copyFileSync(ctx.dbFile, backup);

  const copies = [];
  for (let index = 0; index < 3; index += 1) {
    const result = await restoreService.performRestore({ backupPath: backup, databasePath: live, keep: 10 });
    assert.equal(result.outcome, restoreService.RESTORE_OUTCOME.RESTORED, result.message);
    copies.push(result.recoveryCopy);
  }

  assert.equal(new Set(copies).size, 3, 'every restore must create its own recovery copy');
  for (const copy of copies) {
    assert.ok(fs.existsSync(copy), 'every recovery copy must still exist');
    const db = new DatabaseSync(copy, { readOnly: true });
    assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok', 'every recovery copy must be valid');
    db.close();
  }
});

test('the recovery copy retention keeps the newest copies and never the last one', async () => {
  const live = await makeLiveDatabase('live-retention.db');
  const backup = path.join(workDir, 'shop-20260110-000000.db');
  fs.copyFileSync(ctx.dbFile, backup);

  for (let index = 0; index < 4; index += 1) {
    await restoreService.performRestore({ backupPath: backup, databasePath: live, keep: 2 });
  }

  const remaining = restoreService.listRecoveryCopies(live);
  assert.equal(remaining.length, 2, 'the retention must keep exactly the number of copies that was asked for');
  for (const copy of remaining) {
    assert.ok(fs.existsSync(copy.path));
  }

  // A retention of 1 must still keep one copy.
  await restoreService.performRestore({ backupPath: backup, databasePath: live, keep: 1 });
  const afterOne = restoreService.listRecoveryCopies(live);
  assert.equal(afterOne.length, 1, 'the last known good recovery copy must never be deleted');
});

test('the recovery copies of the old naming are never touched', async () => {
  const live = await makeLiveDatabase('live-old-copies.db');
  const oldCopy = path.join(workDir, 'shop.db.pre-restore-20260101-000000');
  fs.writeFileSync(oldCopy, 'an old recovery copy');
  const backup = path.join(workDir, 'shop-20260111-000000.db');
  fs.copyFileSync(ctx.dbFile, backup);

  await restoreService.performRestore({ backupPath: backup, databasePath: live, keep: 1 });

  assert.ok(fs.existsSync(oldCopy), 'a recovery copy of an older version must not be deleted');
});
