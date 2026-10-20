// Login validation sanitization tests (HIGH-3).
// Safety: throwaway SQLite file under os.tmpdir() only via
// test-support/tempDb.js. Real server on 127.0.0.1:0. At most 8 HTTP logins
// per file (login limiter allows 10 per 15 min).
// Env is set BEFORE any src/ module is imported.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import http from 'node:http';
import { createTempDb, assertTmpDbUrl } from '../test-support/tempDb.js';

const backendDir = path.resolve(import.meta.dirname, '..');
const ctx = await createTempDb({ prefix: 'login-validation-', backendDir });
const { dbUrl, realTmp } = ctx;
process.env.JWT_SECRET = 'test-jwt-secret-that-is-long-enough-0123456789';
process.env.NODE_ENV = 'test';

const CORRECT = 'ValidPass-12345-Long';
const EMAIL = 'login-validation@shop.local';

let app;

function postLogin(body) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      const payload = JSON.stringify(body);
      const r = http.request(
        {
          host: '127.0.0.1',
          port,
          path: '/api/auth/login',
          method: 'POST',
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload),
          },
        },
        (res) => {
          let data = '';
          res.on('data', (c) => {
            data += c;
          });
          res.on('end', () => {
            server.close();
            let json = null;
            try {
              json = data ? JSON.parse(data) : null;
            } catch {
              json = { _raw: data };
            }
            resolve({ status: res.statusCode, body: json });
          });
        },
      );
      r.on('error', (e) => {
        server.close();
        reject(e);
      });
      r.write(payload);
      r.end();
    });
  });
}

function assertSanitized(res) {
  assert.equal(res.status, 400);
  const text = JSON.stringify(res.body);
  for (const banned of ['invalid_type', 'expected', 'received', '12345', 'Zod', '"code"']) {
    assert.ok(!text.includes(banned), `leaked ${JSON.stringify(banned)} in ${text.slice(0, 200)}`);
  }
  assert.ok(text.includes('Validation failed:'), `unexpected body ${text.slice(0, 200)}`);
}

before(async () => {
  assertTmpDbUrl(dbUrl, realTmp);
  assert.equal(process.env.DATABASE_URL, dbUrl);
  const { createApp } = await import('../src/app.js');
  app = createApp();
  const { hashPassword } = await import('../src/utils/password.js');
  const { prisma } = await import('../src/db/prisma.js');
  const hash = await hashPassword(CORRECT);
  await prisma.user.create({
    data: { name: 'Login Validation', email: EMAIL, password: hash, role: 'ADMIN', isActive: true },
  });
});

after(async () => {
  const { prisma } = await import('../src/db/prisma.js');
  try {
    await prisma.$disconnect();
  } catch {}
  ctx.cleanup();
});

test('non-string email is 400 and sanitized', async () => {
  const res = await postLogin({ email: 12345, password: 'x' });
  assertSanitized(res);
});

test('empty body is 400 and sanitized', async () => {
  const res = await postLogin({});
  assertSanitized(res);
});

test('valid credentials give 200', async () => {
  const res = await postLogin({ email: EMAIL, password: CORRECT });
  assert.equal(res.status, 200);
  assert.ok(res.body.token);
});

test('wrong password gives 401 Invalid credentials', async () => {
  const res = await postLogin({ email: EMAIL, password: 'WrongPass-00000' });
  assert.equal(res.status, 401);
  assert.equal(res.body.error.message, 'Invalid credentials');
});
