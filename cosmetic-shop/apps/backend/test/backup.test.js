// Task 3: Working, tested backups via SQLite VACUUM INTO.
// Uses throwaway SQLite files under os.tmpdir() via test-support/tempDb.js.
// No production database is touched.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { execFileSync } from 'node:child_process';
import { createTempDb, assertTmpDbUrl } from '../test-support/tempDb.js';

const backendDir = path.resolve(import.meta.dirname, '..');
// Point backups at a throwaway dir BEFORE importing backup.service (it reads
// BACKUP_DIR at module load).
const backupRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'backups-'));
process.env.BACKUP_DIR = backupRoot;
process.env.BACKUP_KEEP = '2';

const ctx = await createTempDb({ prefix: 'backup-vac-', backendDir });
const { dbUrl, realTmp } = ctx;
process.env.JWT_SECRET = 'test-jwt-secret-that-is-long-enough-0123456789';
process.env.NODE_ENV = 'test';

let prisma;
let app;

before(async () => {
  assertTmpDbUrl(dbUrl, realTmp);
  assert.equal(process.env.DATABASE_URL, dbUrl);
  const db = await import('../src/db/prisma.js');
  prisma = db.prisma;
  const { createApp } = await import('../src/app.js');
  app = createApp();
  // Import backup service after BACKUP_DIR is set.
  await import('../src/services/backup.service.js');
});

beforeEach(async () => {
  // Each test gets a clean backups dir so files from earlier tests don't leak.
  try {
    fs.rmSync(backupRoot, { recursive: true, force: true });
  } catch {}
  fs.mkdirSync(backupRoot, { recursive: true });
});

after(async () => {
  if (prisma) { try { await prisma.$disconnect(); } catch {} }
  ctx.cleanup();
  try { fs.rmSync(backupRoot, { recursive: true, force: true }); } catch {}
});

function call(method, urlPath, { token, body } = {}) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      const payload = body === undefined ? null : JSON.stringify(body);
      const headers = { Accept: 'application/json' };
      if (payload !== null) {
        headers['Content-Type'] = 'application/json';
        headers['Content-Length'] = Buffer.byteLength(payload);
      }
      if (token) headers.Authorization = 'Bearer ' + token;
      const r = http.request({ host: '127.0.0.1', port, path: urlPath, method, headers }, (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => { server.close(); resolve({ status: res.statusCode, body: tryJson(data) }); });
      });
      r.on('error', (e) => { server.close(); reject(e); });
      if (payload !== null) r.write(payload);
      r.end();
    });
  });
}
function tryJson(data) { try { return data ? JSON.parse(data) : null; } catch { return { _raw: data }; } }

async function createUserAndToken() {
  const { hashPassword } = await import('../src/utils/password.js');
  const email = `bak-${Date.now()}-${Math.floor(Math.random() * 1e9)}@shop.local`;
  const hash = await hashPassword('BackupPass-12345-Long');
  const user = await prisma.user.create({ data: { name: 'B', email, password: hash, role: 'ADMIN', isActive: true } });
  const token = jwt.sign({ userId: user.id, role: user.role, tokenVersion: user.tokenVersion }, process.env.JWT_SECRET, { algorithm: 'HS256' });
  return { token, user };
}

function backupDirFiles() {
  return fs.readdirSync(backupRoot).filter((n) => /^shop-\d{8}-\d{6}\.db$/.test(n));
}

test('GET /api/backups without token is rejected with 401', async () => {
  const res = await call('GET', '/api/backups');
  assert.equal(res.status, 401);
});

test('GET /api/backups returns an empty list when no backups exist', async () => {
  const { token } = await createUserAndToken();
  const res = await call('GET', '/api/backups', { token });
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.backups.length, 0);
});

test('POST /api/backups creates a verified backup and GET lists it', async () => {
  const { token } = await createUserAndToken();
  const createRes = await call('POST', '/api/backups', { token });
  assert.equal(createRes.status, 201);
  assert.equal(createRes.body.ok, true);
  assert.ok(createRes.body.backup.filename.match(/^shop-\d{8}-\d{6}\.db$/));
  assert.ok(createRes.body.backup.size > 0);
  assert.ok(createRes.body.backup.createdAt);

  const file = path.join(backupRoot, createRes.body.backup.filename);
  assert.ok(fs.existsSync(file), 'backup file exists on disk');

  const listRes = await call('GET', '/api/backups', { token });
  assert.equal(listRes.status, 200);
  assert.equal(listRes.body.backups.length, 1);
  assert.equal(listRes.body.backups[0].filename, createRes.body.backup.filename);
});

test('POST /api/backups without token is rejected with 401', async () => {
  const res = await call('POST', '/api/backups');
  assert.equal(res.status, 401);
});

test('createBackup passes PRAGMA integrity_check', async () => {
  const { createBackup } = await import('../src/services/backup.service.js');
  const created = await createBackup();
  assert.ok(fs.existsSync(path.join(backupRoot, created.filename)));
  // verifyBackup is run inside createBackup; re-run directly to confirm.
  const { verifyBackup } = await import('../src/services/backup.service.js');
  assert.equal(await verifyBackup(path.join(backupRoot, created.filename)), true);
});

test('retention deletes oldest backups when count exceeds BACKUP_KEEP', async () => {
  const { enforceRetention } = await import('../src/services/backup.service.js');
  // Create 5 backup files with staggered mtimes (oldest first).
  for (let i = 1; i <= 5; i += 1) {
    const name = `shop-2024010${i}-000000.db`;
    fs.writeFileSync(path.join(backupRoot, name), Buffer.alloc(100));
    const mtime = Date.now() - (5 - i) * 1000; // 1..5 is oldest..newest
    fs.utimesSync(path.join(backupRoot, name), new Date(mtime), new Date(mtime));
  }
  assert.equal(backupDirFiles().length, 5);
  const deleted = enforceRetention(); // BACKUP_KEEP = 2
  assert.equal(deleted, 3);
  const remaining = backupDirFiles();
  assert.equal(remaining.length, 2);
  assert.ok(remaining.includes('shop-20240105-000000.db'));
  assert.ok(remaining.includes('shop-20240104-000000.db'));
  assert.ok(!remaining.includes('shop-20240101-000000.db'));
});

test('verifyBackup rejects a corrupted file and deletes it', async () => {
  const { verifyBackup } = await import('../src/services/backup.service.js');
  const corrupted = path.join(backupRoot, 'shop-20240109-000000.db');
  fs.writeFileSync(corrupted, crypto.randomBytes(4096));
  assert.ok(fs.existsSync(corrupted));
  await assert.rejects(verifyBackup(corrupted));
  assert.ok(!fs.existsSync(corrupted), 'corrupted backup file should be deleted');
});

test('restore round-trip via scripts/restore-backup.mjs', async () => {
  const { createBackup } = await import('../src/services/backup.service.js');
  const jwt = await import('jsonwebtoken');

  // Seed a known row in the temp DB.
  await prisma.user.create({
    data: { name: 'Restore Owner', email: `restore-${Date.now()}@shop.local`, password: 'x', role: 'ADMIN', isActive: true },
  });
  const beforeEmails = (await prisma.user.findMany({ select: { email: true } })).map((u) => u.email).sort();

  const created = await createBackup();
  const backupPath = path.join(backupRoot, created.filename);

  // Mutate the DB: add another user.
  await prisma.user.create({
    data: { name: 'Mutant', email: `mutant-${Date.now()}@shop.local`, password: 'x', role: 'ADMIN', isActive: true },
  });
  const afterEmails = (await prisma.user.findMany({ select: { email: true } })).map((u) => u.email).sort();
  assert.ok(afterEmails.length > beforeEmails.length, 'mutation should be present before restore');

  // Run the restore script as a subprocess against the temp DB.
  const scriptPath = path.join(backendDir, 'scripts', 'restore-backup.mjs');
  execFileSync(
    'node',
    [scriptPath, backupPath],
    {
      env: { ...process.env, DATABASE_URL: dbUrl, PORT: '65432' },
      stdio: 'pipe',
    },
  );

  // Re-open a fresh Prisma client against the restored DB.
  const { PrismaClient } = await import('@prisma/client');
  const { PrismaLibSql } = await import('@prisma/adapter-libsql');
  const adapter = new PrismaLibSql({ url: dbUrl });
  const restored = new PrismaClient({ adapter });
  try {
    const emails = (await restored.user.findMany({ select: { email: true } })).map((u) => u.email).sort();
    assert.deepEqual(emails, beforeEmails, 'restore should bring back the original rows');
    assert.ok(!emails.includes(afterEmails.find((e) => e.startsWith('mutant-'))), 'mutation should be gone after restore');
  } finally {
    await restored.$disconnect();
  }
});
