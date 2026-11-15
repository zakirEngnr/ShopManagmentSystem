// The migration chain and the Prisma client must agree.
//
// The backend applies schema changes with the migrations in
// prisma/migrations. Changing prisma/schema.prisma alone does NOT change an
// existing SQLite database: the column only exists in the database once a
// migration adds it. A client generated from a schema that is ahead of the
// migration chain therefore writes columns the database does not have, and
// every write fails with "no such column".
//
// This test replays the migration chain into a disposable database, exactly
// like the real deployment does, and checks that:
//   * the chain ends with the same columns as prisma/schema.prisma;
//   * a row that existed BEFORE the cashReceived migration stays valid and
//     readable with cashReceived = NULL;
//   * the Prisma client generated from prisma/schema.prisma can write a Sale
//     with a tender into the migrated database.
//
// Every database used here is a throw-away file inside the designated test
// database directory. The development database is never opened.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';

import { TEST_DB_ROOT, ensureTestDbRoot, assertIsolatedDatabaseUrl } from '../test-support/dbGuard.js';

const backendDir = path.resolve(import.meta.dirname, '..');
const backendUrl = pathToFileURL(backendDir + path.sep).href;
const migrationsDir = path.join(backendDir, 'prisma', 'migrations');

const migrationNames = fs
  .readdirSync(migrationsDir)
  .filter((name) => fs.existsSync(path.join(migrationsDir, name, 'migration.sql')))
  .sort();

let workDir;
let dbPath;
let prisma;

function applyMigration(db, name) {
  db.exec(fs.readFileSync(path.join(migrationsDir, name, 'migration.sql'), 'utf8'));
}

before(async () => {
  ensureTestDbRoot();
  workDir = fs.mkdtempSync(path.join(TEST_DB_ROOT, 'migchain-'));
  dbPath = path.join(workDir, 'migrated.db');

  // Apply the chain up to (but not including) the cashReceived migration and
  // insert a sale that existed before that migration.
  const cashReceivedMigration = migrationNames.find((name) => name.includes('cash_received'));
  assert.ok(cashReceivedMigration, 'a migration for the cash tender must exist');

  const db = new DatabaseSync(dbPath);
  for (const name of migrationNames) {
    if (name === cashReceivedMigration) break;
    applyMigration(db, name);
  }

  const now = new Date().toISOString();
  db.exec(
    `INSERT INTO "Sale" ("invoiceNo","subtotal","discount","total","recognizedAmount","paymentMethod","createdAt")
     VALUES ('INV-2020-0001', 10, 0, 10, 10, 'CASH', '${now}')`,
  );
  db.close();

  // Now apply the rest of the chain, including the cashReceived migration.
  const db2 = new DatabaseSync(dbPath);
  let applied = false;
  for (const name of migrationNames) {
    if (name === cashReceivedMigration) applied = true;
    if (applied) applyMigration(db2, name);
  }
  db2.close();

  // Point the Prisma client at the migrated database.
  const url = `file:${dbPath}`;
  assertIsolatedDatabaseUrl(url);
  process.env.DATABASE_URL = url;
  const module = await import(backendUrl + 'src/db/prisma.js');
  prisma = module.prisma;
  assert.equal(process.env.DATABASE_URL, url);
});

after(async () => {
  if (prisma) {
    try { await prisma.$disconnect(); } catch {}
  }
  if (workDir) fs.rmSync(workDir, { recursive: true, force: true });
});

test('the migration chain adds the cash tender as a nullable column', () => {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const columns = db.prepare('PRAGMA table_info("Sale")').all().map((c) => c.name);
  db.close();

  assert.ok(columns.includes('cashReceived'), `the Sale table must have a cashReceived column: ${columns.join(', ')}`);
  assert.ok(columns.includes('idempotencyKey'), 'the Sale table must have an idempotencyKey column');
});

test('the migration chain creates the counter and the idempotency columns', () => {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((t) => t.name);
  const khataColumns = db.prepare('PRAGMA table_info("KhataTransaction")').all().map((c) => c.name);
  const purchaseColumns = db.prepare('PRAGMA table_info("Purchase")').all().map((c) => c.name);
  const supplierPaymentColumns = db.prepare('PRAGMA table_info("SupplierPayment")').all().map((c) => c.name);
  db.close();

  assert.ok(tables.includes('Counter'), 'the Counter table must exist');
  assert.ok(khataColumns.includes('idempotencyKey'));
  assert.ok(purchaseColumns.includes('idempotencyKey'));
  assert.ok(supplierPaymentColumns.includes('idempotencyKey'));
});

test('a sale that existed before the cash tender migration stays valid with NULL', () => {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const row = db.prepare('SELECT "invoiceNo", "total", "recognizedAmount", "cashReceived" FROM "Sale" WHERE "invoiceNo" = ?').get('INV-2020-0001');
  db.close();

  assert.ok(row, 'the historical sale must still exist');
  assert.equal(row.cashReceived, null, 'the historical sale must have no tender');
  assert.equal(Number(row.total), 10, 'the historical total must not change');
  assert.equal(Number(row.recognizedAmount), 10, 'the historical recognized amount must not change');
});

test('the Prisma client and the migrated database agree on a Sale with a tender', async () => {
  const sale = await prisma.sale.create({
    data: {
      invoiceNo: 'INV-2020-0002',
      subtotal: 30,
      discount: 0,
      total: 30,
      recognizedAmount: 30,
      paymentMethod: 'CASH',
      cashReceived: 50,
      createdAt: new Date(),
    },
  });

  assert.ok(sale.id > 0);
  const row = await prisma.sale.findUnique({ where: { id: sale.id } });
  assert.equal(Number(row.cashReceived), 50, 'the tender must be stored in the migrated database');
  assert.equal(Number(row.total), 30);
});

test('the Prisma client and the migrated database agree on a Sale without a tender', async () => {
  const sale = await prisma.sale.create({
    data: {
      invoiceNo: 'INV-2020-0003',
      subtotal: 15,
      discount: 0,
      total: 15,
      recognizedAmount: 15,
      paymentMethod: 'CARD',
      createdAt: new Date(),
    },
  });

  const row = await prisma.sale.findUnique({ where: { id: sale.id } });
  assert.equal(row.cashReceived, null, 'a sale without a tender stores NULL');
});

test('the migrated database accepts the idempotency key of a sale', async () => {
  const key = crypto.randomUUID();
  const sale = await prisma.sale.create({
    data: {
      invoiceNo: 'INV-2020-0004',
      idempotencyKey: key,
      subtotal: 5,
      discount: 0,
      total: 5,
      recognizedAmount: 5,
      paymentMethod: 'CASH',
      cashReceived: 5,
      createdAt: new Date(),
    },
  });

  const found = await prisma.sale.findUnique({ where: { idempotencyKey: key } });
  assert.equal(found.id, sale.id, 'the idempotency key must be usable in the migrated database');
});
