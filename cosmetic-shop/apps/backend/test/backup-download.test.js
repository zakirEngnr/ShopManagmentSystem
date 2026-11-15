// The download endpoint of the backup files.
//
// The Settings page of the application has always offered to download the
// newest backup, but the backend had no such endpoint (D24 finding F07): the
// button could only ever answer 404.
//
// The backup directory of this suite is a throw-away directory; the real one
// is never written to or read from.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import jwt from 'jsonwebtoken';
import { pathToFileURL } from 'node:url';

const backendDir = path.resolve(import.meta.dirname, '..');
const backendUrl = pathToFileURL(backendDir + path.sep).href;

// The backup service reads BACKUP_DIR when the module is loaded, so it has to
// be set before anything is imported.
const backupRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-download-'));
process.env.BACKUP_DIR = backupRoot;
process.env.JWT_SECRET = 'download-test-secret-that-is-long-enough-0123456789';
process.env.NODE_ENV = 'test';

let app;
let token;
let backupFile;
let ctx;

before(async () => {
  // A throw-away database for the user of the test.
  const { createTempDb, assertTmpDbUrl } = await import(backendUrl + 'test-support/tempDb.js');
  ctx = await createTempDb({ prefix: 'backup-download-', backendDir });
  assertTmpDbUrl(ctx.dbUrl, ctx.realTmp);

  const { createApp } = await import(backendUrl + 'src/app.js');
  app = createApp();

  const { createUser, signToken } = await import(backendUrl + 'test-support/auth.js');
  const { prisma } = await import(backendUrl + 'src/db/prisma.js');
  const user = await createUser(prisma, { role: 'ADMIN', tag: 'download' });
  token = signToken(user);
});

after(async () => {
  if (ctx) ctx.cleanup();
  try { fs.rmSync(backupRoot, { recursive: true, force: true }); } catch {}
});

beforeEach(() => {
  for (const name of fs.readdirSync(backupRoot)) {
    try { fs.rmSync(path.join(backupRoot, name), { force: true }); } catch {}
  }
  backupFile = path.join(backupRoot, 'shop-20260101-120000.db');
  fs.writeFileSync(backupFile, 'the content of a backup');
});

function call(method, urlPath, { auth = true } = {}) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const headers = { Accept: '*/*' };
      if (auth) headers.Authorization = `Bearer ${token}`;
      const request = http.request({
        host: '127.0.0.1',
        port: server.address().port,
        path: urlPath,
        method,
        headers,
      }, (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          server.close();
          const buffer = Buffer.concat(chunks);
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: buffer,
            text: buffer.toString('utf8'),
          });
        });
      });
      request.on('error', (err) => {
        server.close();
        reject(err);
      });
      request.end();
    });
  });
}

test('an authenticated download of an existing backup works', async () => {
  const res = await call('GET', '/api/backups/shop-20260101-120000.db');

  assert.equal(res.status, 200);
  assert.equal(res.text, 'the content of a backup');
  assert.match(String(res.headers['content-disposition'] ?? ''), /attachment/);
  assert.match(String(res.headers['content-disposition'] ?? ''), /shop-20260101-120000\.db/);
  assert.equal(res.headers['content-type'], 'application/octet-stream');
  assert.equal(res.headers['cache-control'], 'no-store');
});

test('a download without a credential is rejected', async () => {
  const res = await call('GET', '/api/backups/shop-20260101-120000.db', { auth: false });

  assert.equal(res.status, 401);
  assert.equal(JSON.parse(res.text).ok, false);
});

test('a download of a missing backup answers 404', async () => {
  const res = await call('GET', '/api/backups/shop-20260102-120000.db');

  assert.equal(res.status, 404);
  const body = JSON.parse(res.text);
  assert.equal(body.ok, false);
  assert.match(body.error.message, /does not exist/i);
  assert.doesNotMatch(res.text, new RegExp(backupRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'the path of the backup directory must not be exposed');
});

test('a path traversal attempt is rejected', async () => {
  for (const attempt of [
    '..%2f..%2fetc%2fpasswd',
    '..%2fshop.db',
    '%2e%2e%2f%2e%2e%2fetc%2fpasswd',
    'shop-20260101-120000.db%00.txt',
  ]) {
    const res = await call('GET', `/api/backups/${attempt}`);
    assert.ok(res.status === 400 || res.status === 404, `the attempt "${attempt}" must be refused (${res.status})`);
    assert.doesNotMatch(res.text, /root:|passwd/i, 'no file content may be answered');
  }
});

test('a file name that is not a backup name is rejected', async () => {
  for (const attempt of ['shop.db', 'index.html', 'shop.db.backup', 'notabackup.db', 'shop-2026.db']) {
    const res = await call('GET', `/api/backups/${encodeURIComponent(attempt)}`);
    assert.equal(res.status, 400, `the name "${attempt}" must be refused`);
    const body = JSON.parse(res.text);
    assert.equal(body.ok, false);
    assert.match(body.error.message, /not a valid backup file name/i);
  }
});

test('a directory that is not a file is not downloaded', async () => {
  fs.mkdirSync(path.join(backupRoot, 'shop-20260103-120000.db'), { recursive: true });
  const res = await call('GET', '/api/backups/shop-20260103-120000.db');
  assert.equal(res.status, 404);
});

test('the answer of the download matches what the Settings page expects', async () => {
  // The Settings page reads the file name from the content-disposition header
  // and falls back to the name of the backup it asked for.
  const res = await call('GET', '/api/backups/shop-20260101-120000.db');
  const disposition = String(res.headers['content-disposition'] ?? '');
  const match = disposition.match(/filename\s*=\s*"?([^";]+)"?/i);

  assert.ok(match, 'the answer must carry a file name');
  assert.equal(decodeURIComponent(match[1]), 'shop-20260101-120000.db');
  assert.equal(res.headers['content-type'], 'application/octet-stream');
});
