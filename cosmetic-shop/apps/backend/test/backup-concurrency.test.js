// The lock of the backup directory.
//
// The backup service runs in the backend process, but a backup can also be
// created by a second backend, by a script or by the scheduler of another
// instance. An in-memory flag cannot protect against that, so the lock is a
// file that is created exclusively.
//
// These are REAL multi-process tests: the children are separate processes.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

import { createTempDb, assertTmpDbUrl } from '../test-support/tempDb.js';

const backendDir = path.resolve(import.meta.dirname, '..');
const backendUrl = pathToFileURL(backendDir + path.sep).href;

const backupRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-lock-'));
process.env.BACKUP_DIR = backupRoot;
process.env.JWT_SECRET = 'lock-test-secret-that-is-long-enough-0123456789';
process.env.NODE_ENV = 'test';

let prisma;
let backupService;
let lockService;
let ctx;

before(async () => {
  ctx = await createTempDb({ prefix: 'backup-lock-', backendDir });
  assertTmpDbUrl(ctx.dbUrl, ctx.realTmp);
  const db = await import(backendUrl + 'src/db/prisma.js');
  prisma = db.prisma;
  backupService = await import(backendUrl + 'src/services/backup.service.js');
  lockService = await import(backendUrl + 'src/services/backupLock.service.js');
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

const lockPath = () => path.join(backupRoot, lockService.BACKUP_LOCK_FILENAME);

/* ------------------------------------------------------------------ */
/* the lock itself                                                      */
/* ------------------------------------------------------------------ */

test('the lock is taken exclusively', () => {
  const first = lockService.acquireBackupLock({ directory: backupRoot });
  try {
    assert.ok(fs.existsSync(lockPath()), 'the lock file must exist');
    assert.throws(
      () => lockService.acquireBackupLock({ directory: backupRoot }),
      (err) => {
        assert.equal(err.code, 'backup-in-progress');
        assert.equal(err.status, 409);
        assert.match(err.message, /already running/i);
        return true;
      },
    );
  } finally {
    first.release();
  }
  assert.equal(fs.existsSync(lockPath()), false, 'the lock must be released');
});

test('a lock of a live process is never broken', () => {
  // The current process is alive: its lock must not be broken.
  fs.writeFileSync(lockPath(), JSON.stringify({ pid: process.pid, hostname: 'test', startedAt: new Date().toISOString() }));

  assert.throws(
    () => lockService.acquireBackupLock({ directory: backupRoot }),
    (err) => {
      assert.equal(err.code, 'backup-in-progress');
      assert.equal(err.holderPid, process.pid);
      return true;
    },
  );
  assert.ok(fs.existsSync(lockPath()), 'the lock of a live process must stay');
});

test('a lock of a process that is gone is broken', () => {
  fs.writeFileSync(lockPath(), JSON.stringify({ pid: 999999, hostname: 'test', startedAt: new Date().toISOString() }));

  const lock = lockService.acquireBackupLock({ directory: backupRoot });
  try {
    assert.equal(fs.existsSync(lockPath()), true);
    assert.equal(lockService.readLock(lockPath()).pid, process.pid);
  } finally {
    lock.release();
  }
});

test('a lock that cannot be read is treated as held', () => {
  fs.writeFileSync(lockPath(), 'not json');

  assert.throws(
    () => lockService.acquireBackupLock({ directory: backupRoot }),
    (err) => {
      assert.equal(err.code, 'backup-lock-unreadable');
      assert.match(err.message, /cannot be read/i);
      return true;
    },
  );
  assert.ok(fs.existsSync(lockPath()), 'a lock that cannot be read must not be broken');
});

test('the lock is released when the backup fails', async () => {
  const original = fs.statfsSync;
  fs.statfsSync = () => ({ bavail: 0, bsize: 4096, bfree: 0, blocks: 0 });
  try {
    await assert.rejects(() => backupService.createBackup());
  } finally {
    fs.statfsSync = original;
  }
  assert.equal(fs.existsSync(lockPath()), false, 'a failed backup must not leave a lock behind');
});

test('the lock is released when the backup succeeds', async () => {
  await backupService.createBackup();
  assert.equal(fs.existsSync(lockPath()), false, 'a finished backup must not leave a lock behind');
});

/* ------------------------------------------------------------------ */
/* real processes                                                       */
/* ------------------------------------------------------------------ */

test('two processes that back up at the same time do not write at the same time', async () => {
  const script = `
    const svc = await import('${backendUrl}src/services/backup.service.js');
    try {
      const created = await svc.createBackup();
      console.log('OK ' + created.filename);
    } catch (err) {
      console.log('REFUSED ' + (err.code || err.message));
    }
  `;
  const env = {
    ...process.env,
    DATABASE_URL: ctx.dbUrl,
    BACKUP_DIR: backupRoot,
    JWT_SECRET: process.env.JWT_SECRET,
  };

  const run = () => new Promise((resolve) => {
    const child = spawn('node', ['--input-type=module', '-e', script], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => { out += d.toString(); });
    child.on('exit', () => resolve(out.trim()));
  });

  const results = await Promise.all([run(), run(), run()]);

  const created = results.filter((line) => line.startsWith('OK'));
  const refused = results.filter((line) => line.startsWith('REFUSED'));

  assert.equal(created.length + refused.length, 3, 'every process must answer');
  assert.equal(created.length, 1, `exactly one process may create the backup: ${JSON.stringify(results)}`);
  for (const line of refused) {
    assert.match(line, /backup-in-progress|already running/, 'the other processes must be refused with a clear reason');
  }

  // The directory holds exactly one backup and no lock.
  const files = fs.readdirSync(backupRoot).filter((name) => name.endsWith('.db'));
  assert.equal(files.length, 1);
  assert.equal(fs.existsSync(lockPath()), false);
});

test('a process that dies while it holds the lock does not block the next backup', async () => {
  const script = `
    const svc = await import('${backendUrl}src/services/backup.service.js');
    await svc.createBackup();
    // Hold the lock forever so that the process has to be killed.
    const lock = await import('${backendUrl}src/services/backupLock.service.js');
    lock.acquireBackupLock({ directory: process.env.BACKUP_DIR });
    setTimeout(() => {}, 60000);
  `;
  const env = {
    ...process.env,
    DATABASE_URL: ctx.dbUrl,
    BACKUP_DIR: backupRoot,
    JWT_SECRET: process.env.JWT_SECRET,
  };

  const child = spawn('node', ['--input-type=module', '-e', script], { env, stdio: 'ignore' });
  await new Promise((resolve) => setTimeout(resolve, 2500));

  // The lock is held by the living child.
  assert.ok(fs.existsSync(lockPath()), 'the child must hold the lock');
  await assert.rejects(() => backupService.createBackup(), (err) => {
    assert.equal(err.code, 'backup-in-progress');
    return true;
  });

  child.kill('SIGKILL');
  await new Promise((resolve) => setTimeout(resolve, 500));

  // The lock of the dead process is broken and the backup works again.
  const created = await backupService.createBackup();
  assert.ok(fs.existsSync(path.join(backupRoot, created.filename)));
  assert.equal(fs.existsSync(lockPath()), false);
});
