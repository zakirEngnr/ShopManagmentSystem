// The transfer of a backup to an external destination (a USB drive).
//
// The destination of this file is a THROW-AWAY DIRECTORY. No real USB drive
// and no removable device is used: the "removal" of the destination is
// simulated by removing the directory while a transfer is running.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

import { createTempDb, assertTmpDbUrl } from '../test-support/tempDb.js';

const backendDir = path.resolve(import.meta.dirname, '..');
const backendUrl = pathToFileURL(backendDir + path.sep).href;

const backupRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-external-src-'));
const autoCopyRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-external-auto-'));
const manualDest = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-external-manual-'));
process.env.BACKUP_DIR = backupRoot;
process.env.BACKUP_COPY_DIR = autoCopyRoot;
process.env.JWT_SECRET = 'external-test-secret-that-is-long-enough-0123456789';
process.env.NODE_ENV = 'test';

let prisma;
let backupService;
let ctx;

before(async () => {
  ctx = await createTempDb({ prefix: 'backup-external-', backendDir });
  assertTmpDbUrl(ctx.dbUrl, ctx.realTmp);
  const db = await import(backendUrl + 'src/db/prisma.js');
  prisma = db.prisma;
  backupService = await import(backendUrl + 'src/services/backup.service.js');
});

after(async () => {
  if (prisma) await prisma.$disconnect();
  if (ctx) ctx.cleanup();
  for (const dir of [backupRoot, autoCopyRoot, manualDest]) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

beforeEach(() => {
  for (const dir of [autoCopyRoot, manualDest]) {
    for (const name of fs.readdirSync(dir)) {
      try { fs.rmSync(path.join(dir, name), { force: true, recursive: true }); } catch {}
    }
  }
});

const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

/* ------------------------------------------------------------------ */
/* the successful transfer                                              */
/* ------------------------------------------------------------------ */

test('a backup is copied to the destination and published there only after it was verified', async () => {
  const created = await backupService.createBackup();
  const source = path.join(backupRoot, created.filename);
  const destination = path.join(autoCopyRoot, created.filename);

  assert.ok(fs.existsSync(destination), 'the backup must be on the destination');
  assert.equal(sha256(destination), sha256(source), 'the checksums must match');
  assert.equal(created.external.copied, true);
  assert.match(created.external.sha256, /^[0-9a-f]{64}$/);

  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(destination, { readOnly: true });
  assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);
  db.close();

  assert.equal(
    fs.readdirSync(autoCopyRoot).filter((name) => name.startsWith('.shop-tmp-')).length,
    0,
    'the temporary file of the destination must be gone',
  );

  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(destination).mode & 0o777, 0o600, 'the copy must only be readable by its owner');
  }
});

test('a backup that is already on the destination is not copied again', async () => {
  const created = await backupService.createBackup();
  const source = path.join(backupRoot, created.filename);

  const again = await backupService.copyBackupToExternalDestination(source, created.filename, { destination: autoCopyRoot });

  assert.equal(again.copied, false);
  assert.match(again.reason, /already on the destination/i);
  assert.equal(sha256(path.join(autoCopyRoot, created.filename)), sha256(source));
});

/* ------------------------------------------------------------------ */
/* the failing transfers                                                */
/* ------------------------------------------------------------------ */

test('a destination that does not exist is reported', async () => {
  const created = await backupService.createBackup();
  const source = path.join(backupRoot, created.filename);

  await assert.rejects(
    () => backupService.copyBackupToExternalDestination(source, created.filename, { destination: path.join(manualDest, 'not-there') }),
    (err) => {
      assert.equal(err.code, 'external-destination-unavailable');
      assert.match(err.message, /not available/i);
      return true;
    },
  );
});

test('a destination that cannot be written to is reported', async () => {
  if (process.platform === 'win32') return;
  const created = await backupService.createBackup();
  const source = path.join(backupRoot, created.filename);
  const readOnly = path.join(manualDest, 'read-only');
  fs.mkdirSync(readOnly, { recursive: true });
  fs.chmodSync(readOnly, 0o555);
  try {
    await assert.rejects(
      () => backupService.copyBackupToExternalDestination(source, created.filename, { destination: readOnly }),
      (err) => {
        assert.equal(err.code, 'external-destination-read-only');
        assert.match(err.message, /not writable/i);
        return true;
      },
    );
    assert.equal(fs.readdirSync(readOnly).filter((name) => name.startsWith('.shop-tmp-')).length, 0);
  } finally {
    fs.chmodSync(readOnly, 0o755);
  }
});

test('a destination without enough space is reported before the copy', async () => {
  const created = await backupService.createBackup();
  const source = path.join(backupRoot, created.filename);

  const original = fs.statfsSync;
  fs.statfsSync = () => ({ bavail: 0, bsize: 4096, bfree: 0, blocks: 0 });
  try {
    await assert.rejects(
      () => backupService.copyBackupToExternalDestination(source, created.filename, { destination: manualDest }),
      (err) => {
        assert.equal(err.code, 'external-destination-full');
        assert.match(err.message, /not enough space/i);
        return true;
      },
    );
  } finally {
    fs.statfsSync = original;
  }
  assert.equal(fs.readdirSync(manualDest).length, 0, 'nothing may be written to the destination');
});

test('a copy whose checksum does not match is rejected and the old backup survives', async () => {
  const created = await backupService.createBackup();
  const source = path.join(backupRoot, created.filename);
  const destination = path.join(manualDest, created.filename);

  const previous = path.join(manualDest, 'shop-20250101-000000.db');
  fs.writeFileSync(previous, 'the previous backup');
  const previousHash = sha256(previous);

  const original = fs.copyFileSync;
  fs.copyFileSync = (from, to) => {
    original(from, to);
    fs.writeFileSync(to, Buffer.alloc(fs.statSync(to).size, 0x41));
  };
  try {
    await assert.rejects(
      () => backupService.copyBackupToExternalDestination(source, created.filename, { destination: manualDest }),
      (err) => {
        assert.match(err.message, /checksum/i);
        return true;
      },
    );
  } finally {
    fs.copyFileSync = original;
  }

  assert.equal(sha256(previous), previousHash, 'the previous backup must survive');
  assert.equal(fs.readdirSync(manualDest).filter((name) => name.startsWith('.shop-tmp-')).length, 0, 'the incomplete copy must be removed');
  assert.equal(fs.existsSync(destination), false, 'the copy must not be published');
});

test('a backup that changes during the transfer is rejected', async () => {
  const created = await backupService.createBackup();
  const source = path.join(backupRoot, created.filename);

  const original = fs.copyFileSync;
  fs.copyFileSync = (from, to) => {
    original(from, to);
    fs.appendFileSync(from, 'a change');
  };
  try {
    await assert.rejects(
      () => backupService.copyBackupToExternalDestination(source, created.filename, { destination: manualDest }),
      (err) => {
        // The change of the source during the transfer is detected either by
        // the hash of the copy or by the second hash of the source.
        assert.match(err.message, /checksum|changed while/i);
        return true;
      },
    );
  } finally {
    fs.copyFileSync = original;
  }
  assert.equal(fs.existsSync(path.join(manualDest, created.filename)), false);
});

test('a different backup with the same name is never overwritten on the destination', async () => {
  const created = await backupService.createBackup();
  const source = path.join(backupRoot, created.filename);
  const destination = path.join(manualDest, created.filename);
  fs.writeFileSync(destination, 'a different backup');
  const before = sha256(destination);

  await assert.rejects(
    () => backupService.copyBackupToExternalDestination(source, created.filename, { destination: manualDest }),
    (err) => {
      assert.equal(err.code, 'external-destination-conflict');
      return true;
    },
  );
  assert.equal(sha256(destination), before, 'the backup on the destination must not be overwritten');
});

test('an interrupted transfer leaves the previous backup intact and publishes nothing', async () => {
  const created = await backupService.createBackup();
  const source = path.join(backupRoot, created.filename);
  const previous = path.join(manualDest, 'shop-20250101-000000.db');
  fs.writeFileSync(previous, 'the previous backup');
  const previousHash = sha256(previous);

  const original = fs.copyFileSync;
  fs.copyFileSync = (from, to) => {
    fs.writeFileSync(to, Buffer.alloc(1, 0x41));
    throw new Error('the destination vanished');
  };
  try {
    await assert.rejects(
      () => backupService.copyBackupToExternalDestination(source, created.filename, { destination: manualDest }),
      () => true,
    );
  } finally {
    fs.copyFileSync = original;
  }

  assert.equal(sha256(previous), previousHash, 'the previous backup must survive');
  assert.equal(
    fs.readdirSync(manualDest).filter((name) => name.startsWith('.shop-tmp-')).length,
    0,
    'no incomplete file may be left on the destination',
  );
  assert.equal(fs.existsSync(path.join(manualDest, created.filename)), false, 'nothing may be published');
});

test('a transfer that is killed in a child process publishes nothing', async () => {
  const created = await backupService.createBackup();
  const source = path.join(backupRoot, created.filename);
  const script = `
    const svc = await import('${backendUrl}src/services/backup.service.js');
    await svc.copyBackupToExternalDestination('${source}', '${created.filename}', { destination: '${manualDest}' });
  `;
  const env = { ...process.env, BACKUP_DIR: backupRoot, DATABASE_URL: ctx.dbUrl, JWT_SECRET: process.env.JWT_SECRET };

  const child = spawn('node', ['--input-type=module', '-e', script], { env, stdio: 'ignore' });
  await new Promise((resolve) => setTimeout(resolve, 15));
  child.kill('SIGKILL');
  await new Promise((resolve) => setTimeout(resolve, 300));

  for (const name of fs.readdirSync(manualDest)) {
    if (name.startsWith('.shop-tmp-')) continue;
    const db = new (require('node:sqlite').DatabaseSync)(path.join(manualDest, name), { readOnly: true });
    assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok', `${name} must be a complete database`);
    db.close();
  }
});

test('a retry after a failed transfer succeeds', async () => {
  const created = await backupService.createBackup();
  const source = path.join(backupRoot, created.filename);

  const original = fs.copyFileSync;
  fs.copyFileSync = (from, to) => {
    original(from, to);
    fs.writeFileSync(to, Buffer.alloc(fs.statSync(to).size, 0x41));
  };
  try {
    await assert.rejects(() => backupService.copyBackupToExternalDestination(source, created.filename, { destination: manualDest }));
  } finally {
    fs.copyFileSync = original;
  }
  assert.equal(fs.existsSync(path.join(manualDest, created.filename)), false);

  const retry = await backupService.copyBackupToExternalDestination(source, created.filename, { destination: manualDest });
  assert.equal(retry.copied, true);
  assert.equal(sha256(path.join(manualDest, created.filename)), sha256(source));
});
