#!/usr/bin/env node
// Regression tests for the test database isolation guard.
//
// They prove that the guard rejects:
//   * a missing DATABASE_URL
//   * a relative path that resolves outside the designated test directory
//   * apps/backend/shop.db (the development database)
//   * backups of shop.db and WAL / SHM side files
//   * a symlink inside the designated directory that points at shop.db
// and that the bootstrap aborts a process that inherits an unsafe URL.
//
// The guard never opens the file it rejects.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

import {
  BACKEND_ROOT,
  TEST_DB_ROOT,
  assertIsolatedDatabaseUrl,
  ensureTestDbRoot,
  protectedReason,
  resolveDatabaseUrl,
} from '../test-support/dbGuard.js';

ensureTestDbRoot();

const SHOP_DB = path.join(BACKEND_ROOT, 'shop.db');

describe('guard: missing DATABASE_URL', () => {
  test('rejects an undefined URL', () => {
    assert.throws(() => assertIsolatedDatabaseUrl(undefined), /DATABASE_URL is not set/);
  });

  test('rejects an empty URL', () => {
    assert.throws(() => assertIsolatedDatabaseUrl(''), /DATABASE_URL is not set/);
  });

  test('rejects a whitespace-only URL', () => {
    assert.throws(() => assertIsolatedDatabaseUrl('   '), /DATABASE_URL is not set/);
  });
});

describe('guard: paths outside the designated directory', () => {
  test('rejects a relative path that resolves outside the test directory', () => {
    // ./shop.db from the backend directory is refused twice over: it is the
    // development database AND it is outside the designated test directory.
    assert.throws(
      () => assertIsolatedDatabaseUrl('file:./shop.db', { cwd: BACKEND_ROOT }),
      /protected file|not inside the designated test database directory/,
    );
    assert.throws(
      () => assertIsolatedDatabaseUrl('file:./dev.db', { cwd: BACKEND_ROOT }),
      /not inside the designated test database directory/,
    );
  });

  test('rejects a relative path that escapes with ..', () => {
    assert.throws(
      () => assertIsolatedDatabaseUrl('file:../../../../etc/passwd', { cwd: TEST_DB_ROOT }),
      /not inside the designated test database directory/,
    );
  });

  test('rejects an absolute path in the system temp directory', () => {
    assert.throws(
      () => assertIsolatedDatabaseUrl(`file:${path.join(fs.realpathSync(os.tmpdir()), 'elsewhere.db')}`),
      /not inside the designated test database directory/,
    );
  });

  test('rejects a non-file URL', () => {
    assert.throws(
      () => assertIsolatedDatabaseUrl('libsql://remote.example.com'),
      /must be a local "file:" URL/,
    );
  });

  test('accepts a file inside the designated directory', () => {
    const url = `file:${path.join(TEST_DB_ROOT, 'accepted.db')}`;
    assert.equal(assertIsolatedDatabaseUrl(url), path.join(TEST_DB_ROOT, 'accepted.db'));
  });
});

describe('guard: the development database and its neighbours', () => {
  test('rejects apps/backend/shop.db', () => {
    assert.throws(() => assertIsolatedDatabaseUrl(`file:${SHOP_DB}`), /protected file/);
  });

  test('rejects a relative ./shop.db from the backend directory', () => {
    assert.throws(
      () => assertIsolatedDatabaseUrl('file:./shop.db', { cwd: BACKEND_ROOT }),
      /protected file/,
    );
  });

  test('rejects every shop.db backup name', () => {
    const backups = [
      'shop.db.BACKUP-20261109-123638',
      'shop.db.BACKUP-BEFORE-ACCOUNTING-RECOGNITION',
      'shop.db.pre-restore-20261111-152801',
      'shop.db.pre-tokenversion-backup',
      'shop.db.bak.1792328119',
    ];
    for (const name of backups) {
      assert.throws(
        () => assertIsolatedDatabaseUrl(`file:${path.join(BACKEND_ROOT, name)}`),
        /protected file/,
        `${name} must be refused`,
      );
    }
  });

  test('rejects WAL and SHM side files', () => {
    for (const name of ['shop.db-wal', 'shop.db-shm', 'shop.db-journal']) {
      assert.throws(
        () => assertIsolatedDatabaseUrl(`file:${path.join(BACKEND_ROOT, name)}`),
        /protected file/,
        `${name} must be refused`,
      );
    }
  });

  test('rejects a shop.db file that was copied into the test directory', () => {
    // The name pattern is what protects it, wherever the file lives.
    const copy = path.join(TEST_DB_ROOT, 'shop.db');
    assert.throws(() => assertIsolatedDatabaseUrl(`file:${copy}`), /protected file/);
  });

  test('rejects a symlink inside the test directory that points at shop.db', () => {
    const link = path.join(TEST_DB_ROOT, 'link-to-shop.db');
    try {
      fs.symlinkSync(SHOP_DB, link);
    } catch {
      return; // symlinks are not available on this platform
    }
    try {
      assert.throws(() => assertIsolatedDatabaseUrl(`file:${link}`), /protected file/);
    } finally {
      fs.rmSync(link, { force: true });
    }
  });

  test('rejects anything inside the backups directory', () => {
    assert.throws(
      () => assertIsolatedDatabaseUrl(`file:${path.join(BACKEND_ROOT, 'backups', 'shop-20260101-000000.db')}`),
      /protected file/,
    );
  });

  test('protectedReason explains every refusal', () => {
    assert.match(protectedReason(SHOP_DB), /development database/);
    assert.match(protectedReason(path.join(BACKEND_ROOT, 'shop.db-wal')), /development database/);
    assert.match(protectedReason(path.join(BACKEND_ROOT, 'backups', 'x.db')), /backup directory/);
    assert.equal(protectedReason(path.join(BACKEND_ROOT, 'dev.db')), null);
    assert.equal(protectedReason(path.join(TEST_DB_ROOT, 'fine.db')), null);
  });

  test('the guard never opens the file it rejects', () => {
    // resolveDatabaseUrl must not touch the file system of the target beyond a
    // path lookup - proven by the fact that a non-existent path is fine.
    assert.equal(resolveDatabaseUrl(`file:${path.join(TEST_DB_ROOT, 'missing.db')}`), path.join(TEST_DB_ROOT, 'missing.db'));
  });
});

describe('bootstrap', () => {
  const bootstrap = path.join(BACKEND_ROOT, 'test-support', 'guard-bootstrap.mjs');
  const bootstrapUrl = pathToFileURL(bootstrap).href;

  function runBootstrap(env) {
    return spawnSync(
      process.execPath,
      ['--import', bootstrapUrl, '-e', 'console.log("BOOTSTRAP_OK")'],
      {
        cwd: BACKEND_ROOT,
        encoding: 'utf8',
        timeout: 20000,
        env: { ...process.env, ...env },
      },
    );
  }

  test('aborts when DATABASE_URL points at the development database', () => {
    const r = runBootstrap({ DATABASE_URL: `file:${SHOP_DB}` });
    assert.notEqual(r.status, 0, 'the bootstrap must abort');
    assert.match(r.stderr, /db-guard/);
    assert.match(r.stderr, /development database/);
    assert.doesNotMatch(r.stdout, /BOOTSTRAP_OK/);
  });

  test('aborts when DATABASE_URL points at a backup', () => {
    const r = runBootstrap({ DATABASE_URL: `file:${path.join(BACKEND_ROOT, 'shop.db.BACKUP-BEFORE-EXPENSE-NAME')}` });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /db-guard/);
  });

  test('aborts when DATABASE_URL points outside the designated directory', () => {
    const r = runBootstrap({ DATABASE_URL: 'file:./shop.db' });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /db-guard/);
  });

  test('installs an isolated database when DATABASE_URL is missing', () => {
    const env = { ...process.env };
    delete env.DATABASE_URL;
    const r = spawnSync(
      process.execPath,
      ['--import', bootstrapUrl, '-e', 'console.log(process.env.DATABASE_URL)'],
      {
        cwd: BACKEND_ROOT,
        encoding: 'utf8',
        timeout: 20000,
        env,
      },
    );
    assert.equal(r.status, 0, r.stderr);
    const url = r.stdout.trim();
    assert.match(url, /^file:/);
    assert.ok(
      resolveDatabaseUrl(url).startsWith(TEST_DB_ROOT),
      `the fallback must live inside ${TEST_DB_ROOT}, got ${url}`,
    );
  });
});

describe('the test suite itself', () => {
  test('every test file either selects an isolated database or is declared database-free', () => {
    // Test files that provably never open a database. Each entry must stay
    // justified: a new database-free test has to be listed here.
    const DATABASE_FREE = {
      'env-validation.test.js':
        'spawns a child process with an isolated DATABASE_URL; it only checks that env.js rejects a placeholder secret',
      'gitignore.test.js': 'runs `git check-ignore`; it never opens a database',
      'validate.regression.test.js':
        'imports validation schemas only; no Prisma client is created',
      'product-type-validation.test.js':
        'imports product validation schemas only; no Prisma client is created',
    };
    const testDir = path.join(BACKEND_ROOT, 'test');
    const files = fs.readdirSync(testDir).filter((f) => f.endsWith('.test.js'));
    assert.ok(files.length > 10, 'the audit must see the real test suite');
    const offenders = [];
    for (const file of files) {
      if (file in DATABASE_FREE) continue;
      const source = fs.readFileSync(path.join(testDir, file), 'utf8');
      const selectsDb =
        /process\.env\.DATABASE_URL\s*=/.test(source) ||
        /DATABASE_URL\s*:/.test(source) ||
        /createTempDb|makeIsolatedDb|assertIsolatedDatabaseUrl/.test(source);
      if (!selectsDb) offenders.push(file);
    }
    assert.deepEqual(
      offenders,
      [],
      `these test files never select a database - they would inherit DATABASE_URL: ${offenders.join(', ')}`,
    );
  });

  test('the audit log shows no accepted development database', () => {
    const logFile = path.join(TEST_DB_ROOT, 'db-url-audit.log');
    if (!fs.existsSync(logFile)) return; // nothing audited yet
    const lines = fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean);
    // REJECTED lines are the guard doing its job; only ACCEPTED / FALLBACK
    // lines describe a database a test process actually used.
    const used = lines.filter((line) => /^(ACCEPTED|FALLBACK)\b/.test(line));
    const bad = used.filter((line) => /shop\.db([.-].*)?$/i.test(line.split(' ').pop() ?? ''));
    assert.deepEqual(bad, [], 'no test process may point at the development database');
  });
});
