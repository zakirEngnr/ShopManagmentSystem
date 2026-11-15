// One resolution of the DATABASE_URL for the backup service and for the
// restore script.
//
// Before D24.1 the backup service resolved a relative URL against the
// working directory and the restore script against apps/backend, so a backup
// could be taken from one file and restored over another.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const backendDir = path.resolve(import.meta.dirname, '..');
const backendUrl = pathToFileURL(backendDir + path.sep).href;

const { resolveDatabaseFilePath, BACKEND_ROOT, describeDatabaseUrl } = await import(
  backendUrl + 'src/utils/databasePath.js'
);

test('a relative DATABASE_URL always resolves against the backend root', () => {
  const resolved = resolveDatabaseFilePath('file:./shop.db');

  assert.equal(resolved, path.join(BACKEND_ROOT, 'shop.db'));
  assert.equal(
    resolveDatabaseFilePath('file:shop.db'),
    path.join(BACKEND_ROOT, 'shop.db'),
    'a relative URL without a directory must resolve the same way',
  );
  assert.ok(
    !resolved.startsWith(`${os.tmpdir()}${path.sep}`) || resolved === path.join(os.tmpdir(), 'shop.db'),
    'the resolved path may not depend on the working directory',
  );

  // An explicit base directory is honoured - that is the parameter the tests
  // use; the default never depends on the working directory.
  assert.equal(
    resolveDatabaseFilePath('file:./shop.db', { baseDir: '/tmp' }),
    path.join('/tmp', 'shop.db'),
    'an explicit base directory must be honoured',
  );
});

test('an absolute DATABASE_URL is used as it is', () => {
  const absolute = path.join(os.tmpdir(), 'some-shop.db');
  assert.equal(resolveDatabaseFilePath(`file:${absolute}`), absolute, 'file:/absolute');
  assert.equal(resolveDatabaseFilePath(`file://${absolute}`), absolute, 'file:///absolute');
});

test('the file prefix and the URL encoding are handled', () => {
  assert.equal(
    resolveDatabaseFilePath('file:./a%20shop.db'),
    path.join(BACKEND_ROOT, 'a shop.db'),
    'a percent encoded path must be decoded',
  );
  assert.equal(
    resolveDatabaseFilePath('file:///tmp/absolute%20name.db'),
    '/tmp/absolute name.db',
    'three slashes are an absolute path',
  );
});

test('a URL that is not a local file is refused without leaking anything', () => {
  assert.throws(
    () => resolveDatabaseFilePath('libsql://remote.example.com/db'),
    (err) => {
      assert.match(err.message, /Only a local "file:" DATABASE_URL/);
      assert.doesNotMatch(err.message, /remote\.example\.com/, 'the URL must not be echoed');
      assert.doesNotMatch(err.message, /password|secret|token/i);
      return true;
    },
  );
  assert.throws(() => resolveDatabaseFilePath(''), /DATABASE_URL is not set/);
  assert.equal(describeDatabaseUrl('libsql://user:secret@host/db'), 'libsql:...');
});

test('the backup service and the restore script resolve the same file', async () => {
  // The service resolves the URL through the shared helper.
  const { default: backupService } = await import(backendUrl + 'src/services/backup.service.js');
  assert.equal(typeof backupService, 'object');

  const source = fs.readFileSync(path.join(backendDir, 'src/services/backup.service.js'), 'utf8');
  assert.match(source, /resolveDatabaseFilePath\(env\.DATABASE_URL\)/, 'the backup service must use the shared resolver');

  const script = fs.readFileSync(path.join(backendDir, 'scripts/restore-backup.mjs'), 'utf8');
  assert.match(
    script,
    /databasePath\.js/,
    'the restore script must use the shared resolver',
  );
  assert.doesNotMatch(
    script,
    /path\.resolve\(BACKEND_ROOT,\s*databaseUrl/,
    'the restore script must not resolve the URL on its own any more',
  );
});

test('the restore script reports the same database from every working directory', () => {
  const script = path.join(backendDir, 'scripts/restore-backup.mjs');
  const report = (cwd) => {
    let output = '';
    try {
      output = execFileSync('node', [script, 'missing.db', '--dry-run'], {
        cwd,
        encoding: 'utf8',
        env: { ...process.env, DATABASE_URL: 'file:./shop.db', PORT: '45971' },
        stdio: 'pipe',
      });
    } catch (err) {
      // The dry run of a missing backup ends with a non-zero status; the
      // report of the database is printed before that.
      output = `${err.stdout || ''}${err.stderr || ''}`;
    }
    const match = /^Database:\s*(.+)$/m.exec(output);
    return match ? match[1].trim() : null;
  };

  const fromBackend = report(backendDir);
  const fromTmp = report(os.tmpdir());

  assert.equal(fromBackend, path.join(BACKEND_ROOT, 'shop.db'));
  assert.equal(fromTmp, fromBackend, 'the working directory must not change the database of the restore');
});
