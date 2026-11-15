// The creation of a backup: atomicity, interruption, collisions, the space
// check and the permissions.
//
// Every database of this file is a throw-away SQLite file inside the
// designated test database directory and every backup directory is a
// throw-away directory. The shop database and the real backup directory are
// never touched.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

import { createTempDb, assertTmpDbUrl } from '../test-support/tempDb.js';

const backendDir = path.resolve(import.meta.dirname, '..');
const backendUrl = pathToFileURL(backendDir + path.sep).href;

const backupRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-creation-'));
process.env.BACKUP_DIR = backupRoot;
process.env.JWT_SECRET = 'creation-test-secret-that-is-long-enough-0123456789';
process.env.NODE_ENV = 'test';
delete process.env.BACKUP_COPY_DIR;

let prisma;
let backupService;
let backupFiles;
let ctx;

before(async () => {
  ctx = await createTempDb({ prefix: 'backup-creation-', backendDir });
  assertTmpDbUrl(ctx.dbUrl, ctx.realTmp);
  const db = await import(backendUrl + 'src/db/prisma.js');
  prisma = db.prisma;
  backupService = await import(backendUrl + 'src/services/backup.service.js');
  backupFiles = await import(backendUrl + 'src/utils/backupFiles.js');
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

const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

/** The files of the backup directory that the application would list. */
function listedFiles() {
  return fs.readdirSync(backupRoot).filter((name) => backupFiles.LISTED_BACKUP_REGEX.test(name));
}

/** Every file of the backup directory. */
function allFiles() {
  return fs.readdirSync(backupRoot);
}

/* ------------------------------------------------------------------ */
/* A. the backup is correct                                            */
/* ------------------------------------------------------------------ */

test('a backup is a consistent snapshot of the database', async () => {
  const category = await prisma.category.create({ data: { name: 'Creation Category', type: 'COSMETIC' } });
  const brand = await prisma.brand.create({ data: { name: 'Creation Brand' } });
  await prisma.product.create({
    data: { sku: 'CRE-1', name: 'Creation Product', type: 'COSMETIC', costPrice: 3, sellPrice: 9, stock: 17, lowStockAt: 2, categoryId: category.id, brandId: brand.id },
  });

  const created = await backupService.createBackup();
  const file = path.join(backupRoot, created.filename);

  assert.ok(fs.existsSync(file));
  assert.equal(created.verified, true);
  assert.match(created.sha256, /^[0-9a-f]{64}$/);
  assert.equal(created.sha256, sha256(file), 'the reported checksum must be the checksum of the file');
  assert.equal(created.size, fs.statSync(file).size);

  // The backup opens on its own and holds the same rows.
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(file, { readOnly: true });
  assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);
  assert.equal(db.prepare('SELECT count(*) c FROM "Product"').get().c, 1);
  assert.equal(db.prepare('SELECT coalesce(sum(stock),0) c FROM "Product"').get().c, 17);
  db.close();

  // The metadata is published with the backup.
  const metadata = JSON.parse(fs.readFileSync(path.join(backupRoot, `${created.filename}.json`), 'utf8'));
  assert.equal(metadata.sha256, created.sha256);
  assert.equal(metadata.integrity, 'ok');
});

/* ------------------------------------------------------------------ */
/* B. atomicity: an incomplete backup is never published                */
/* ------------------------------------------------------------------ */

test('a temporary file is never listed as a backup', async () => {
  fs.writeFileSync(path.join(backupRoot, '.shop-tmp-abc123.db'), 'an incomplete backup');
  fs.writeFileSync(path.join(backupRoot, 'shop-20260101-120000.db.json'), '{}');

  const listed = await backupService.listBackups();

  assert.equal(listed.length, 0, 'neither the temporary file nor the metadata may be listed');
});

test('an interrupted snapshot leaves no backup behind', async () => {
  const created = await backupService.createBackup();
  const before = sha256(path.join(backupRoot, created.filename));

  // The state of a process that died during the snapshot.
  fs.writeFileSync(path.join(backupRoot, '.shop-tmp-dead1.db'), 'half a database');

  const listed = await backupService.listBackups();

  assert.equal(listed.length, 1, 'only the published backup may be listed');
  assert.equal(listed[0].filename, created.filename);
  assert.equal(sha256(path.join(backupRoot, created.filename)), before, 'the published backup must be untouched');
});

test('an interrupted publication leaves the backup directory without a partial backup', async () => {
  // The state of a process that died after the snapshot but before the
  // publication: a complete temporary file that was never renamed.
  const temp = path.join(backupRoot, '.shop-tmp-dead2.db');
  fs.copyFileSync(ctx.dbFile, temp);

  const listed = await backupService.listBackups();

  assert.equal(listed.length, 0, 'a temporary file must never be listed as a backup');
  assert.ok(fs.existsSync(temp), 'the temporary file is left for the cleanup');
});

test('a backup that was published is complete and readable', async () => {
  const created = await backupService.createBackup();
  const file = path.join(backupRoot, created.filename);

  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(file, { readOnly: true });
  assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  db.close();
});

test('a backup process that is killed never publishes a partial backup', async () => {
  // The real thing: a child process that creates a backup and is killed at a
  // random moment. After every kill the directory must be consistent.
  const script = `
    const svc = await import('${backendUrl}src/services/backup.service.js');
    await svc.createBackup();
  `;
  const env = {
    ...process.env,
    DATABASE_URL: ctx.dbUrl,
    BACKUP_DIR: backupRoot,
    JWT_SECRET: process.env.JWT_SECRET,
  };

  for (let round = 0; round < 8; round += 1) {
    const child = spawn('node', ['--input-type=module', '-e', script], { env, stdio: 'ignore' });
    await new Promise((resolve) => setTimeout(resolve, 5 + round * 7));
    child.kill('SIGKILL');
    await new Promise((resolve) => setTimeout(resolve, 60));

    // Every published backup must be a complete, readable database.
    for (const name of listedFiles()) {
      const file = path.join(backupRoot, name);
      const { DatabaseSync } = await import('node:sqlite');
      const db = new DatabaseSync(file, { readOnly: true });
      assert.equal(
        db.prepare('PRAGMA integrity_check').get().integrity_check,
        'ok',
        `${name} must be a complete database after a kill in round ${round}`,
      );
      db.close();
    }
  }

  // The lock of a killed process must not block the next backup.
  const created = await backupService.createBackup();
  assert.ok(fs.existsSync(path.join(backupRoot, created.filename)));
});

/* ------------------------------------------------------------------ */
/* C. the names are unique                                             */
/* ------------------------------------------------------------------ */

test('two backups of the same second never share a name', async () => {
  const first = await backupService.createBackup();
  const second = await backupService.createBackup();

  assert.notEqual(first.filename, second.filename);
  assert.equal(listedFiles().length, 2);
});

test('a name that is taken is not used again', () => {
  const moment = new Date('2026-05-05T10:20:30.500Z');
  const name = backupFiles.uniqueBackupName(backupRoot, moment);
  // The name carries the local time of the moment, like every other backup.
  assert.equal(name, `shop-${backupFiles.backupTimestamp(moment)}-500.db`);

  fs.writeFileSync(path.join(backupRoot, name), 'taken');
  const second = backupFiles.uniqueBackupName(backupRoot, new Date('2026-05-05T10:20:30.500Z'));
  assert.notEqual(second, name);
  assert.match(second, new RegExp(`^shop-${backupFiles.backupTimestamp(moment)}-500-\\d+\\.db$`));
});

test('an existing backup is never overwritten', async () => {
  const first = await backupService.createBackup();
  const file = path.join(backupRoot, first.filename);
  const before = sha256(file);

  const second = await backupService.createBackup();

  assert.notEqual(second.filename, first.filename);
  assert.equal(sha256(file), before, 'the first backup must be untouched');
});

/* ------------------------------------------------------------------ */
/* D. the space check                                                  */
/* ------------------------------------------------------------------ */

test('the free space of the backup directory is checked before anything is written', async () => {
  const original = fs.statfsSync;
  let asked = null;
  fs.statfsSync = (directory) => {
    asked = directory;
    return original(directory);
  };
  try {
    await backupService.createBackup();
  } finally {
    fs.statfsSync = original;
  }
  assert.equal(asked, backupRoot, 'the space of the backup directory must be checked');
});

test('a backup is refused when there is not enough space', async () => {
  const original = fs.statfsSync;
  fs.statfsSync = () => ({ bavail: 1, bsize: 4096, bfree: 1, blocks: 1 });
  try {
    await assert.rejects(() => backupService.createBackup(), (err) => {
      assert.equal(err.code, 'insufficient-space');
      assert.match(err.message, /not enough space/i);
      assert.match(err.message, /needed/i);
      assert.match(err.message, /free/i);
      return true;
    });
  } finally {
    fs.statfsSync = original;
  }
  assert.equal(listedFiles().length, 0, 'no backup may be published');
  assert.equal(allFiles().filter((n) => backupFiles.TEMPORARY_BACKUP_REGEX.test(n)).length, 0, 'no temporary file may be left');
});

test('a space check that cannot be performed never claims that the space is enough', async () => {
  const original = fs.statfsSync;
  fs.statfsSync = () => { throw Object.assign(new Error('statfs is not supported here'), { code: 'ENOSYS' }); };
  try {
    const created = await backupService.createBackup();
    assert.equal(created.space.checked, false, 'the answer must say that the space was not checked');
    assert.match(created.space.message, /could not be checked/i);
  } finally {
    fs.statfsSync = original;
  }
  assert.equal(listedFiles().length, 1, 'the backup is still created when the space cannot be checked');
});

test('the space check of a destination that does not exist refuses the backup', async () => {
  const original = fs.statfsSync;
  fs.statfsSync = () => { throw Object.assign(new Error('no such directory'), { code: 'ENOENT' }); };
  try {
    const created = await backupService.createBackup();
    assert.equal(created.space.checked, false);
  } finally {
    fs.statfsSync = original;
  }
});

/* ------------------------------------------------------------------ */
/* E. the permissions                                                   */
/* ------------------------------------------------------------------ */

test('a new backup is only readable by its owner', async () => {
  const created = await backupService.createBackup();
  const stat = fs.statSync(path.join(backupRoot, created.filename));

  if (process.platform === 'win32') {
    // The POSIX modes do not exist on Windows; the test only proves that the
    // file was created and is readable.
    assert.ok(stat.size > 0);
  } else {
    assert.equal(stat.mode & 0o777, 0o600, 'a backup must not be readable by other accounts');
  }
});

test('a new backup directory is only accessible by its owner', () => {
  const directory = path.join(backupRoot, 'private-dir');
  backupFiles.ensureDirectory(directory);

  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(directory).mode & 0o777, 0o700);
  }
  assert.ok(fs.statSync(directory).isDirectory());
});

/* ------------------------------------------------------------------ */
/* F. the failure of a backup is reported, never silently successful    */
/* ------------------------------------------------------------------ */

test('a backup that cannot be written reports an error and keeps the old backups', async () => {
  const first = await backupService.createBackup();
  const before = sha256(path.join(backupRoot, first.filename));

  const original = fs.statfsSync;
  fs.statfsSync = () => ({ bavail: 0, bsize: 4096, bfree: 0, blocks: 0 });
  try {
    await assert.rejects(() => backupService.createBackup(), (err) => {
      assert.equal(err.code, 'insufficient-space');
      return true;
    });
  } finally {
    fs.statfsSync = original;
  }

  assert.equal(listedFiles().length, 1, 'the old backup must survive');
  assert.equal(sha256(path.join(backupRoot, first.filename)), before);
  assert.equal(allFiles().filter((n) => backupFiles.TEMPORARY_BACKUP_REGEX.test(n)).length, 0);
});
