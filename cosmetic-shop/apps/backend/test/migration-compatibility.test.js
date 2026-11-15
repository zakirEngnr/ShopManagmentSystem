// The migration compatibility of a backup and of the running database.
//
// The D24 audit found that the shop database carries the schema of two
// migrations that its _prisma_migrations table does not record, and that a
// "prisma migrate deploy" on such a database fails with P3018.
//
// EVERY database of this file is a throw-away file inside the designated test
// database directory. The reconciliation is only ever proved on a COPY; the
// development database is never touched.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';

import { createMigratedTempDb } from '../test-support/migratedDb.js';

const backendDir = path.resolve(import.meta.dirname, '..');
const backendUrl = pathToFileURL(backendDir + path.sep).href;
const prismaBin = path.join(backendDir, 'node_modules', '.bin', 'prisma');

const MIGRATION_CASH = '20261114090000_add_cash_received_to_sale';
const MIGRATION_AUDIT = '20261115100000_add_expense_auditability';

let restoreService;
let compatibility;
let ctx;
let workDir;

/** Run the Prisma CLI against a throw-away database. */
function prisma(args, dbFile) {
  try {
    const out = execFileSync(prismaBin, args, {
      cwd: backendDir,
      encoding: 'utf8',
      env: { ...process.env, DATABASE_URL: `file:${dbFile}` },
      stdio: 'pipe',
    });
    return { code: 0, out };
  } catch (err) {
    return { code: err.status, out: `${err.stdout || ''}${err.stderr || ''}` };
  }
}

/** The columns of a table. */
function columnsOf(file, table) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return db.prepare(`PRAGMA table_info("${table}")`).all().map((column) => ({
      name: column.name,
      type: column.type,
      notNull: Number(column.notnull) === 1,
      default: column.dflt_value ?? null,
      primaryKey: Number(column.pk) === 1,
    }));
  } finally {
    db.close();
  }
}

function indexesOf(file, table) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name=? ORDER BY name").all(table)
      .map((row) => row.name);
  } finally {
    db.close();
  }
}

function foreignKeysOf(file, table) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return db.prepare(`PRAGMA foreign_key_list("${table}")`).all().map((row) => ({
      table: row.table,
      from: row.from,
      to: row.to,
      onDelete: row.on_delete,
      onUpdate: row.on_update,
    }));
  } finally {
    db.close();
  }
}

function recordedMigrations(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return db.prepare('SELECT migration_name FROM _prisma_migrations ORDER BY started_at').all()
      .map((row) => row.migration_name);
  } finally {
    db.close();
  }
}

/** Remove the record of a migration without touching the schema. */
function unrecordMigration(file, migrationName) {
  const db = new DatabaseSync(file);
  try {
    db.prepare('DELETE FROM _prisma_migrations WHERE migration_name = ?').run(migrationName);
  } finally {
    db.close();
  }
}

before(async () => {
  process.env.JWT_SECRET = 'migration-test-secret-that-is-long-enough-0123456789';
  ctx = await createMigratedTempDb({ prefix: 'migration-compat-', backendDir });
  workDir = ctx.tmpDir;
  restoreService = await import(backendUrl + 'src/services/restore.service.js');
  compatibility = await import(backendUrl + 'src/utils/databaseCompatibility.js');
});

after(async () => {
  if (ctx) ctx.cleanup();
});

/* ------------------------------------------------------------------ */
/* 12. a backup with the current migration history is accepted          */
/* ------------------------------------------------------------------ */

test('a backup with the current migration history is accepted', async () => {
  const backup = path.join(workDir, 'shop-20260101-000000.db');
  fs.copyFileSync(ctx.dbFile, backup);

  const validation = await restoreService.validateBackupFile(backup);

  assert.equal(validation.ok, true, validation.message);
  assert.equal(validation.details.unrecordedMigrations.length, 0, 'no migration may be missing');
  assert.equal(validation.details.structure.compatible, true);
});

/* ------------------------------------------------------------------ */
/* 13. a backup that misses migrations is detected                     */
/* ------------------------------------------------------------------ */

test('a backup that misses migrations of the application is detected', async () => {
  // A database of an older version of the shop: it has neither the expense
  // history nor the cash tender of the sale.
  const old = path.join(workDir, 'old.db');
  {
    const db = new DatabaseSync(old);
    db.exec('CREATE TABLE "User" ("id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT, "name" TEXT NOT NULL, "email" TEXT NOT NULL, "password" TEXT NOT NULL, "role" TEXT NOT NULL DEFAULT \'ADMIN\', "isActive" BOOLEAN NOT NULL DEFAULT true, "failedAttempts" INTEGER NOT NULL DEFAULT 0, "tokenVersion" INTEGER NOT NULL DEFAULT 0, "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" DATETIME)');
    db.exec('CREATE TABLE "Setting" ("id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT, "key" TEXT NOT NULL, "value" TEXT NOT NULL)');
    db.close();
  }
  const backup = path.join(workDir, 'shop-20250101-000000.db');
  fs.copyFileSync(old, backup);

  const validation = await restoreService.validateBackupFile(backup);

  assert.equal(validation.ok, false);
  assert.equal(validation.code, restoreService.REJECT_CODE.BACKUP_INCOMPATIBLE);
  assert.match(validation.message, /not compatible with this version/);
  assert.match(validation.message, /allow-older-schema/, 'the message must name the way out');

  // The restore refuses it as well and does not touch the live database.
  const live = path.join(workDir, 'live-old.db');
  fs.copyFileSync(ctx.dbFile, live);
  const before = fs.readFileSync(live);
  const result = await restoreService.performRestore({ backupPath: backup, databasePath: live });

  assert.equal(result.outcome, restoreService.RESTORE_OUTCOME.REJECTED);
  assert.equal(result.code, restoreService.REJECT_CODE.BACKUP_INCOMPATIBLE);
  assert.deepEqual(fs.readFileSync(live), before, 'the live database must be byte identical');

  // An explicit decision restores it anyway.
  const allowed = await restoreService.performRestore({
    backupPath: backup,
    databasePath: live,
    allowOlderSchema: true,
  });
  assert.equal(allowed.outcome, restoreService.RESTORE_OUTCOME.RESTORED, allowed.message);
});

/* ------------------------------------------------------------------ */
/* 14-15. the reconciliation, proved on a disposable copy               */
/* ------------------------------------------------------------------ */

test('the effects of the two unrecorded migrations are completely present', async () => {
  // The state of the shop database: the schema has the changes, the history
  // does not record them.
  const copy = path.join(workDir, 'shop-copy.db');
  fs.copyFileSync(ctx.dbFile, copy);
  unrecordMigration(copy, MIGRATION_CASH);
  unrecordMigration(copy, MIGRATION_AUDIT);

  assert.deepEqual(
    recordedMigrations(copy).filter((name) => name === MIGRATION_CASH || name === MIGRATION_AUDIT),
    [],
    'the two migrations must not be recorded',
  );

  // 20261114090000_add_cash_received_to_sale:
  //   ALTER TABLE "Sale" ADD COLUMN "cashReceived" REAL;
  const sale = columnsOf(copy, 'Sale').find((column) => column.name === 'cashReceived');
  assert.ok(sale, 'the column cashReceived must exist');
  assert.equal(sale.type, 'REAL');
  assert.equal(sale.notNull, false, 'the column must be nullable');
  assert.equal(sale.default, null, 'the column must not have a default');

  // 20261115100000_add_expense_auditability:
  //   ALTER TABLE "Expense" ADD COLUMN "updatedAt" DATETIME;
  //   ALTER TABLE "Expense" ADD COLUMN "deletedAt" DATETIME;
  for (const name of ['updatedAt', 'deletedAt']) {
    const column = columnsOf(copy, 'Expense').find((candidate) => candidate.name === name);
    assert.ok(column, `the column ${name} must exist`);
    assert.equal(column.type, 'DATETIME');
    assert.equal(column.notNull, false, `the column ${name} must be nullable`);
    assert.equal(column.default, null, `the column ${name} must not have a default`);
  }

  //   CREATE TABLE "ExpenseHistory" (...)
  const history = columnsOf(copy, 'ExpenseHistory');
  assert.deepEqual(
    history.map((column) => `${column.name}:${column.type}:${column.notNull ? 'NOT NULL' : 'NULL'}`),
    [
      'id:INTEGER:NOT NULL',
      'expenseId:INTEGER:NOT NULL',
      'action:TEXT:NOT NULL',
      'snapshot:TEXT:NOT NULL',
      'createdAt:DATETIME:NOT NULL',
    ],
    'the table ExpenseHistory must exist with exactly the columns of the migration',
  );
  const id = history.find((column) => column.name === 'id');
  assert.equal(id.primaryKey, true, 'id must be the primary key');
  const createdAt = history.find((column) => column.name === 'createdAt');
  assert.match(String(createdAt.default), /CURRENT_TIMESTAMP/i, 'createdAt must keep its default');

  //   CONSTRAINT "ExpenseHistory_expenseId_fkey" FOREIGN KEY ("expenseId")
  //     REFERENCES "Expense" ("id") ON DELETE CASCADE ON UPDATE CASCADE
  assert.deepEqual(foreignKeysOf(copy, 'ExpenseHistory'), [
    { table: 'Expense', from: 'expenseId', to: 'id', onDelete: 'CASCADE', onUpdate: 'CASCADE' },
  ]);

  //   the three indexes of the migration
  const expenseIndexes = indexesOf(copy, 'Expense');
  assert.ok(expenseIndexes.includes('Expense_deletedAt_idx'), 'the index on Expense.deletedAt must exist');
  const historyIndexes = indexesOf(copy, 'ExpenseHistory');
  assert.ok(historyIndexes.includes('ExpenseHistory_expenseId_idx'));
  assert.ok(historyIndexes.includes('ExpenseHistory_createdAt_idx'));

  // The migration has no data transformation, so the data cannot be missing
  // anything: the rows of the history table are read back.
  const db = new DatabaseSync(copy, { readOnly: true });
  const historyRows = db.prepare('SELECT count(*) c FROM ExpenseHistory').get().c;
  db.close();
  assert.equal(typeof historyRows, 'number');
});

test('the reconciliation of the migration history succeeds on the disposable copy', async () => {
  const copy = path.join(workDir, 'shop-reconciled.db');
  fs.copyFileSync(ctx.dbFile, copy);
  unrecordMigration(copy, MIGRATION_CASH);
  unrecordMigration(copy, MIGRATION_AUDIT);

  // Before the reconciliation the status shows the two migrations as pending.
  let status = prisma(['migrate', 'status'], copy);
  assert.equal(status.code, 1, 'the status must show pending migrations');
  assert.match(status.out, new RegExp(MIGRATION_CASH));
  assert.match(status.out, new RegExp(MIGRATION_AUDIT));

  // The reconciliation marks them as applied. This is only ever done on a
  // copy: the development database is never touched.
  for (const migration of [MIGRATION_CASH, MIGRATION_AUDIT]) {
    const resolved = prisma(['migrate', 'resolve', '--applied', migration], copy);
    assert.equal(resolved.code, 0, `the reconciliation of ${migration} failed: ${resolved.out}`);
  }

  // After the reconciliation there is nothing left to apply.
  status = prisma(['migrate', 'status'], copy);
  assert.equal(status.code, 0, `the status must be clean: ${status.out}`);

  const deploy = prisma(['migrate', 'deploy'], copy);
  assert.equal(deploy.code, 0, `the deploy must succeed: ${deploy.out}`);

  // The schema and the data are unchanged.
  const db = new DatabaseSync(copy, { readOnly: true });
  assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);
  db.close();
  assert.ok(columnsOf(copy, 'Sale').some((column) => column.name === 'cashReceived'));
  assert.ok(columnsOf(copy, 'ExpenseHistory').length > 0);
  assert.deepEqual(
    recordedMigrations(copy).filter((name) => name === MIGRATION_CASH || name === MIGRATION_AUDIT).sort(),
    [MIGRATION_CASH, MIGRATION_AUDIT].sort(),
    'both migrations must be recorded again',
  );
});

/* ------------------------------------------------------------------ */
/* 16. a failing migration does not destroy the database               */
/* ------------------------------------------------------------------ */

test('a failing migration leaves the database readable and recoverable', async () => {
  const copy = path.join(workDir, 'shop-failing-migration.db');
  fs.copyFileSync(ctx.dbFile, copy);
  unrecordMigration(copy, MIGRATION_CASH);

  const deploy = prisma(['migrate', 'deploy'], copy);

  assert.notEqual(deploy.code, 0, 'the deploy must fail');
  assert.match(deploy.out, /P3018|duplicate column name/, 'the failure must be reported');

  // The data is untouched and the database is still usable.
  const db = new DatabaseSync(copy, { readOnly: true });
  assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);
  const tables = db.prepare("SELECT count(*) c FROM sqlite_master WHERE type='table'").get().c;
  db.close();
  assert.ok(tables > 0, 'the tables must still be there');

  // The failed migration is recorded as failed, so no other migration can be
  // applied until it is resolved - the state the operator has to repair.
  const history = compatibility.compareMigrationHistory(
    { migrations: (() => {
      const d = new DatabaseSync(copy, { readOnly: true });
      const rows = d.prepare('SELECT migration_name, finished_at, rolled_back_at FROM _prisma_migrations').all();
      d.close();
      return rows.map((row) => ({
        name: row.migration_name,
        finished: row.finished_at !== null,
        rolledBack: row.rolled_back_at !== null,
      }));
    })() },
  );
  assert.ok(history.failed.length >= 1, 'the failed migration must be visible');
});

/* ------------------------------------------------------------------ */
/* 17. the application still starts with a correct database            */
/* ------------------------------------------------------------------ */

test('the application accepts a correctly migrated database', async () => {
  const health = await import(backendUrl + 'src/services/databaseHealth.service.js');
  const check = await health.checkDatabaseHealth({ databasePath: ctx.dbFile });

  assert.equal(check.ok, true, `the database must be accepted: ${check.errors.join(' ')}`);
  assert.deepEqual(check.errors, []);
  assert.deepEqual(check.history.unrecorded, [], 'no migration may be missing');
  assert.deepEqual(check.warnings, []);
  assert.equal(health.getDatabaseHealthSummary().compatible, true);
});

test('the application reports a migration history that is out of sync', async () => {
  const health = await import(backendUrl + 'src/services/databaseHealth.service.js');
  const copy = path.join(workDir, 'shop-out-of-sync.db');
  fs.copyFileSync(ctx.dbFile, copy);
  unrecordMigration(copy, MIGRATION_CASH);
  unrecordMigration(copy, MIGRATION_AUDIT);

  const check = await health.checkDatabaseHealth({ databasePath: copy });

  // The schema is complete, so the application can work - but the history is
  // wrong and has to be reported.
  assert.equal(check.ok, true, 'a database with a complete schema must still start');
  assert.equal(check.structure.compatible, true);
  assert.deepEqual(check.history.unrecorded.sort(), [MIGRATION_CASH, MIGRATION_AUDIT].sort());
  assert.ok(check.warnings.length >= 1, 'the out of sync history must be reported');
  assert.match(check.warnings.join(' '), /migrate resolve --applied/);
});

test('the application refuses to start on a database it cannot work with', async () => {
  const health = await import(backendUrl + 'src/services/databaseHealth.service.js');

  // A database that misses a table of the application.
  const broken = path.join(workDir, 'shop-broken.db');
  {
    const db = new DatabaseSync(broken);
    db.exec('CREATE TABLE "User" ("id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT, "name" TEXT NOT NULL)');
    db.close();
  }

  const check = await health.checkDatabaseHealth({ databasePath: broken });

  assert.equal(check.ok, false, 'an incompatible database must not be accepted');
  assert.ok(check.errors.length > 0, 'the missing objects must be named');
  assert.match(check.errors.join(' '), /table "Setting" is missing/);
  assert.equal(health.getDatabaseHealthSummary().compatible, false);
});

test('the server does not start on a database it cannot work with', async () => {
  // The entry point of the backend refuses to serve an incompatible database.
  const broken = path.join(workDir, 'shop-broken-entry.db');
  {
    const db = new DatabaseSync(broken);
    db.exec('CREATE TABLE "User" ("id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT, "name" TEXT NOT NULL)');
    db.close();
  }

  const result = spawnSync('node', [path.join(backendDir, 'src', 'index.js')], {
    cwd: backendDir,
    encoding: 'utf8',
    env: {
      ...process.env,
      DATABASE_URL: `file:${broken}`,
      PORT: '45972',
      JWT_SECRET: 'startup-test-secret-that-is-long-enough-0123456789',
    },
    timeout: 60000,
    stdio: 'pipe',
  });

  assert.notEqual(result.status, 0, 'the server must not start');
  const output = `${result.stdout || ''}${result.stderr || ''}`;
  assert.match(output, /not compatible with this version of the application/i);
  assert.match(output, /table "Setting" is missing/);
});
