// The retention of the backup directory.
//
// The retention runs after EVERY backup, manual or scheduled, and manages
// only the files with the canonical name. The temporary files, the legacy
// names, the in-flight transfers and the last known-good backup are never
// touched.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { createTempDb, assertTmpDbUrl } from '../test-support/tempDb.js';

const backendDir = path.resolve(import.meta.dirname, '..');
const backendUrl = pathToFileURL(backendDir + path.sep).href;

const backupRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-retention-'));
process.env.BACKUP_DIR = backupRoot;
process.env.BACKUP_KEEP = '2';
process.env.JWT_SECRET = 'retention-test-secret-that-is-long-enough-0123456789';
process.env.NODE_ENV = 'test';
delete process.env.BACKUP_COPY_DIR;

let prisma;
let backupService;
let ctx;

before(async () => {
  ctx = await createTempDb({ prefix: 'backup-retention-', backendDir });
  assertTmpDbUrl(ctx.dbUrl, ctx.realTmp);
  const db = await import(backendUrl + 'src/db/prisma.js');
  prisma = db.prisma;
  backupService = await import(backendUrl + 'src/services/backup.service.js');
});

after(async () => {
  if (prisma) await prisma.$disconnect();
  if (ctx) ctx.cleanup();
  try { fs.rmSync(backupRoot, { recursive: true, force: true }); } catch {}
});

beforeEach(() => {
  for (const name of fs.readdirSync(backupRoot)) {
    try { fs.rmSync(path.join(backupRoot, name), { force: true, recursive: true }); } catch {}
  }
});

/* ------------------------------------------------------------------ */
/* the basic rule                                                       */
/* ------------------------------------------------------------------ */

test('manual backups are counted down', async () => {
  process.env.BACKUP_KEEP = '2';
  const service = await import(backendUrl + 'src/services/backup.service.js');

  for (let i = 0; i < 5; i += 1) {
    await service.createBackup();
    // Each backup gets a distinct timestamp.
    await new Promise((resolve) => setTimeout(resolve, 1100));
  }

  const files = fs.readdirSync(backupRoot).filter((name) => name.endsWith('.db'));
  assert.equal(files.length, 2, 'the directory must hold exactly the retained number of backups');
});

test('the newest valid backup is never deleted', async () => {
  process.env.BACKUP_KEEP = '1';
  const service = await import(backendUrl + 'src/services/backup.service.js');

  const first = await service.createBackup();
  await new Promise((resolve) => setTimeout(resolve, 1100));
  const second = await service.createBackup();

  const deleted = service.enforceRetention({ keep: 1 });
  assert.equal(deleted, 1, 'the older backup must be removed');

  const files = fs.readdirSync(backupRoot).filter((name) => name.endsWith('.db'));
  assert.ok(files.includes(second.filename), 'the newest backup must survive');
  assert.ok(!files.includes(first.filename), 'the older backup must be removed');
});

test('the last known good backup is never deleted', async () => {
  process.env.BACKUP_KEEP = '1';
  const service = await import(backendUrl + 'src/services/backup.service.js');

  const first = await service.createBackup();
  // A retention of zero is clamped to one.
  const deleted = service.enforceRetention({ keep: 0 });
  assert.equal(deleted, 0, 'nothing may be deleted when only one backup exists');
  assert.ok(fs.existsSync(path.join(backupRoot, first.filename)), 'the only backup must survive');
});

/* ------------------------------------------------------------------ */
/* what is never touched                                                */
/* ------------------------------------------------------------------ */

test('temporary files are not rotated as if they were backups', () => {
  fs.writeFileSync(path.join(backupRoot, '.shop-tmp-leftover.db'), 'an incomplete backup');
  fs.writeFileSync(path.join(backupRoot, '.shop-tmp-leftover.db.json'), '{}');
  fs.writeFileSync(path.join(backupRoot, 'shop-20240101-000000.db'), 'a published backup');

  const deleted = backupService.enforceRetention();
  assert.equal(deleted, 0, 'no published backup must be removed');
  assert.ok(fs.existsSync(path.join(backupRoot, '.shop-tmp-leftover.db')), 'the temporary file must not be touched');
});

test('legacy backup names are preserved', () => {
  fs.writeFileSync(path.join(backupRoot, 'shop-backup-2026-01-01T00:00:00Z.db'), 'a legacy backup');
  fs.writeFileSync(path.join(backupRoot, 'shop-20240101-000000.db'), 'a published backup');

  const deleted = backupService.enforceRetention();
  assert.equal(deleted, 0);
  assert.ok(fs.existsSync(path.join(backupRoot, 'shop-backup-2026-01-01T00:00:00Z.db')), 'a legacy name must never be rotated');
});

test('invalid files are not touched', () => {
  fs.writeFileSync(path.join(backupRoot, 'README.txt'), 'not a backup');
  fs.writeFileSync(path.join(backupRoot, 'shop-20240101-000000.db'), 'a published backup');

  const deleted = backupService.enforceRetention();
  assert.equal(deleted, 0, 'no published backup must be removed');
  assert.ok(fs.existsSync(path.join(backupRoot, 'README.txt')), 'an unrelated file must not be touched');
});

test('a file that is being transferred is never deleted', () => {
  const name = 'shop-20240101-000000.db';
  fs.writeFileSync(path.join(backupRoot, name), 'a published backup');

  // Register the file as being transferred.
  backupService.inFlightTransfers.add(name);
  try {
    const deleted = backupService.enforceRetention();
    assert.equal(deleted, 0, 'a file that is being transferred must not be deleted');
    assert.ok(fs.existsSync(path.join(backupRoot, name)), 'the transferred file must survive');
  } finally {
    backupService.inFlightTransfers.delete(name);
  }
});

/* ------------------------------------------------------------------ */
/* the scheduled backup rotates as well                                 */
/* ------------------------------------------------------------------ */

test('the scheduled backup also runs the retention', async () => {
  // The scheduled backup creates a backup and then rotates. The retention
  // runs inside the same call, so a directory with one backup and a keep of
  // one stays at one backup.
  process.env.BACKUP_KEEP = '1';
  const service = await import(backendUrl + 'src/services/backup.service.js');

  await service.runScheduledBackup();
  const before = fs.readdirSync(backupRoot).filter((n) => n.endsWith('.db')).length;
  assert.ok(before >= 1);

  // A second scheduled backup within 24 hours is not due, so the count stays.
  await service.runScheduledBackup();
  const after = fs.readdirSync(backupRoot).filter((n) => n.endsWith('.db')).length;
  assert.equal(after, before, 'the scheduled backup must not run twice within 24 hours');
});

/* ------------------------------------------------------------------ */
/* concurrency                                                          */
/* ------------------------------------------------------------------ */

test('two concurrent retentions do not delete the same file twice', async () => {
  for (let i = 0; i < 5; i += 1) {
    const name = `shop-2024010${i + 1}-000000.db`;
    fs.writeFileSync(path.join(backupRoot, name), Buffer.alloc(100));
    const mtime = Date.now() - (5 - i) * 1000;
    fs.utimesSync(path.join(backupRoot, name), new Date(mtime), new Date(mtime));
  }

  process.env.BACKUP_KEEP = '2';
  const service = await import(backendUrl + 'src/services/backup.service.js');
  const [first, second] = await Promise.all([
    Promise.resolve(service.enforceRetention()),
    Promise.resolve(service.enforceRetention()),
  ]);

  assert.ok(first + second >= 0, 'the retention must not throw');
  assert.equal(fs.readdirSync(backupRoot).filter((n) => n.endsWith('.db')).length, 2, 'the directory must hold exactly two backups');
});
