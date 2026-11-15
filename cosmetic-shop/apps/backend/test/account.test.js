// Account & security integration tests.
// Safety: throwaway SQLite file under os.tmpdir() only via test-support/tempDb.js.
// Real server on 127.0.0.1:0 with real HS256 JWTs (one server per request).
// Env is set BEFORE any src/ module is imported.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import http from 'node:http';
import jwt from 'jsonwebtoken';
import { createTempDb, assertTmpDbUrl } from '../test-support/tempDb.js';
import { createUser, signToken } from '../test-support/auth.js';

const backendDir = path.resolve(import.meta.dirname, '..');
const ctx = await createTempDb({ prefix: 'account-', backendDir });
const { dbUrl, realTmp } = ctx;
process.env.JWT_SECRET = 'test-jwt-secret-that-is-long-enough-0123456789';
process.env.NODE_ENV = 'test';

const SECRET = process.env.JWT_SECRET;

let prisma;
let app;

before(async () => {
  assertTmpDbUrl(dbUrl, realTmp);
  assert.equal(process.env.DATABASE_URL, dbUrl);
  const db = await import('../src/db/prisma.js');
  prisma = db.prisma;
  const { createApp } = await import('../src/app.js');
  app = createApp();
});

after(async () => {
  if (prisma) {
    try { await prisma.$disconnect(); } catch {}
  }
  ctx.cleanup();
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
        res.on('end', () => {
          server.close();
          let json = null;
          try { json = data ? JSON.parse(data) : null; } catch { json = { _raw: data }; }
          resolve({ status: res.statusCode, body: json });
        });
      });
      r.on('error', (e) => { server.close(); reject(e); });
      if (payload !== null) r.write(payload);
      r.end();
    });
  });
}

async function hashAndCreate(overrides = {}) {
  const { hashPassword } = await import('../src/utils/password.js');
  const email = `acc-${Date.now()}-${Math.floor(Math.random() * 1e9)}@shop.local`;
  const hash = await hashPassword('CurrentPass-12345-Long');
  return prisma.user.create({
    data: { name: 'Acc Owner', email, password: hash, role: 'ADMIN', isActive: true, ...overrides },
  });
}

test('GET /api/auth/me without token is rejected with 401', async () => {
  const res = await call('GET', '/api/auth/me');
  assert.equal(res.status, 401);
  assert.equal(res.body.ok, false);
});

test('GET /api/auth/me returns safe account details without password hash', async () => {
  const user = await hashAndCreate();
  const token = signToken(user);
  const res = await call('GET', '/api/auth/me', { token });
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.user.id, user.id);
  assert.equal(res.body.user.email, user.email);
  assert.equal(res.body.user.role, user.role);
  assert.ok(!('password' in res.body.user), 'password hash must not be returned');
});

test('POST /api/auth/password with wrong current password is rejected', async () => {
  const user = await hashAndCreate();
  const token = signToken(user);
  const res = await call('POST', '/api/auth/password', {
    token,
    body: { currentPassword: 'WrongPass-12345-Long', newPassword: 'NewChangedPass-12345-Long' },
  });
  assert.equal(res.status, 401);
  assert.equal(res.body.ok, false);
});

test('POST /api/auth/password successfully changes the password', async () => {
  const user = await hashAndCreate();
  const token = signToken(user);
  const res = await call('POST', '/api/auth/password', {
    token,
    body: { currentPassword: 'CurrentPass-12345-Long', newPassword: 'NewChangedPass-12345-Long' },
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.user.email, user.email);
  assert.ok(!('password' in res.body.user));
});

test('old password no longer authenticates after a password change', async () => {
  const { login } = await import('../src/services/auth.service.js');
  const user = await hashAndCreate();
  const token = signToken(user);
  await call('POST', '/api/auth/password', {
    token,
    body: { currentPassword: 'CurrentPass-12345-Long', newPassword: 'NewChangedPass-12345-Long' },
  });

  await assert.rejects(
    login(user.email, 'CurrentPass-12345-Long'),
    /Invalid credentials/,
  );
});

test('new password authenticates after a password change', async () => {
  const { login } = await import('../src/services/auth.service.js');
  const user = await hashAndCreate();
  const token = signToken(user);
  await call('POST', '/api/auth/password', {
    token,
    body: { currentPassword: 'CurrentPass-12345-Long', newPassword: 'NewChangedPass-12345-Long' },
  });

  const result = await login(user.email, 'NewChangedPass-12345-Long');
  assert.ok(result.token);
  assert.equal(result.user.email, user.email);
});

test('POST /api/auth/password rejects a new password shorter than 12 characters', async () => {
  const user = await hashAndCreate();
  const token = signToken(user);
  const res = await call('POST', '/api/auth/password', {
    token,
    body: { currentPassword: 'CurrentPass-12345-Long', newPassword: 'short' },
  });
  assert.equal(res.status, 400);
  assert.equal(res.body.ok, false);
});

test('POST /api/auth/email successfully changes the email', async () => {
  const user = await hashAndCreate();
  const token = signToken(user);
  const res = await call('POST', '/api/auth/email', {
    token,
    body: { currentPassword: 'CurrentPass-12345-Long', newEmail: 'changed-owner@shop.local' },
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.user.email, 'changed-owner@shop.local');
  assert.ok(!('password' in res.body.user));
});

test('POST /api/auth/email with wrong current password is rejected', async () => {
  const user = await hashAndCreate();
  const token = signToken(user);
  const res = await call('POST', '/api/auth/email', {
    token,
    body: { currentPassword: 'WrongPass-12345-Long', newEmail: 'changed-owner@shop.local' },
  });
  assert.equal(res.status, 401);
});

test('POST /api/auth/email rejects an invalid email', async () => {
  const user = await hashAndCreate();
  const token = signToken(user);
  const res = await call('POST', '/api/auth/email', {
    token,
    body: { currentPassword: 'CurrentPass-12345-Long', newEmail: 'not-an-email' },
  });
  assert.equal(res.status, 400);
});

test('POST /api/auth/email rejects a duplicate email', async () => {
  const user = await hashAndCreate();
  await hashAndCreate({ email: 'taken-owner@shop.local' });
  const token = signToken(user);
  const res = await call('POST', '/api/auth/email', {
    token,
    body: { currentPassword: 'CurrentPass-12345-Long', newEmail: 'taken-owner@shop.local' },
  });
  assert.equal(res.status, 409);
});

test('POST /api/auth/email rejects an unchanged email', async () => {
  const user = await hashAndCreate();
  const token = signToken(user);
  const res = await call('POST', '/api/auth/email', {
    token,
    body: { currentPassword: 'CurrentPass-12345-Long', newEmail: user.email },
  });
  assert.equal(res.status, 400);
});

test('updated email works with the existing login flow', async () => {
  const { login } = await import('../src/services/auth.service.js');
  const user = await hashAndCreate();
  const token = signToken(user);
  await call('POST', '/api/auth/email', {
    token,
    body: { currentPassword: 'CurrentPass-12345-Long', newEmail: 'rotated-owner@shop.local' },
  });

  const result = await login('rotated-owner@shop.local', 'CurrentPass-12345-Long');
  assert.ok(result.token);
  assert.equal(result.user.email, 'rotated-owner@shop.local');
});

test('POST /api/auth/password invalidates the old session via tokenVersion', async () => {
  const user = await hashAndCreate();
  const oldToken = signToken(user);

  await call('POST', '/api/auth/password', {
    token: oldToken,
    body: { currentPassword: 'CurrentPass-12345-Long', newPassword: 'NewChangedPass-12345-Long' },
  });

  // The old token should no longer be accepted.
  const res = await call('GET', '/api/auth/me', { token: oldToken });
  assert.equal(res.status, 401);

  // A newly issued token works.
  const { login } = await import('../src/services/auth.service.js');
  const result = await login(user.email, 'NewChangedPass-12345-Long');
  const freshRes = await call('GET', '/api/auth/me', { token: result.token });
  assert.equal(freshRes.status, 200);
});
