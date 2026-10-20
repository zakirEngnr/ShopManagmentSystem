// Auth security tests: tokenVersion revocation + disabled accounts (CRITICAL-1).
// Safety: throwaway SQLite file under os.tmpdir() only via
// test-support/tempDb.js. All tokens are real (login service or HS256
// signToken). Real server on 127.0.0.1:0.
// Env is set BEFORE any src/ module is imported.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import http from 'node:http';
import jwt from 'jsonwebtoken';
import { createTempDb, assertTmpDbUrl } from '../test-support/tempDb.js';
import { createUser, signToken } from '../test-support/auth.js';

const backendDir = path.resolve(import.meta.dirname, '..');
const ctx = await createTempDb({ prefix: 'auth-security-', backendDir });
const { dbUrl, realTmp } = ctx;
process.env.JWT_SECRET = 'test-jwt-secret-that-is-long-enough-0123456789';
process.env.NODE_ENV = 'test';

const SECRET = process.env.JWT_SECRET;

let prisma;
let app;
let login;

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
      });
      r.on('error', (e) => {
        server.close();
        reject(e);
      });
      if (payload !== null) r.write(payload);
      r.end();
    });
  });
}

async function makeLoginUser(tag, password = 'SecPass-12345-Long') {
  const { hashPassword } = await import('../src/utils/password.js');
  const email = `sec-${tag}-${Date.now()}-${Math.floor(Math.random() * 1e9)}@shop.local`;
  const hash = await hashPassword(password);
  const user = await prisma.user.create({
    data: { name: `Sec ${tag}`, email, password: hash, role: 'ADMIN', isActive: true },
  });
  return { user, email, password };
}

let seq = 0;
function uniq(p) {
  seq += 1;
  return `${p}-${Date.now()}-${seq}-${Math.floor(Math.random() * 1e9)}`;
}

before(async () => {
  assertTmpDbUrl(dbUrl, realTmp);
  assert.equal(process.env.DATABASE_URL, dbUrl);
  const db = await import('../src/db/prisma.js');
  prisma = db.prisma;
  const { createApp } = await import('../src/app.js');
  app = createApp();
  ({ login } = await import('../src/services/auth.service.js'));
});

after(async () => {
  if (prisma) {
    try {
      await prisma.$disconnect();
    } catch {}
  }
  ctx.cleanup();
});
test('login -> revokeUserTokens -> old token 401 on POST /api/categories', async () => {
  const { revokeUserTokens } = await import('../src/services/auth.service.js');
  const { email, password } = await makeLoginUser('revoke');
  const out = await login(email, password);
  const oldToken = out.token;
  const okBefore = await call('POST', '/api/categories', {
    token: oldToken,
    body: { name: uniq('SecCat'), type: 'COSMETIC' },
  });
  assert.equal(okBefore.status, 201);
  await revokeUserTokens(out.user.id);
  const denied = await call('POST', '/api/categories', {
    token: oldToken,
    body: { name: uniq('SecCat'), type: 'COSMETIC' },
  });
  assert.equal(denied.status, 401);
  assert.equal(denied.body.error.message, 'Invalid or expired token');
});

test('disabled account: 403 on POST /api/brands and /api/auth/me, GET /api/categories stays 200', async () => {
  const user = await createUser(prisma, { tag: 'disabled' });
  const token = signToken(user);
  const before = await call('POST', '/api/brands', { token, body: { name: uniq('SecBrand') } });
  assert.equal(before.status, 201);
  await prisma.user.update({ where: { id: user.id }, data: { isActive: false } });
  const deniedBrand = await call('POST', '/api/brands', { token, body: { name: uniq('SecBrand') } });
  assert.equal(deniedBrand.status, 403);
  assert.equal(deniedBrand.body.error.message, 'Account is disabled');
  const deniedMe = await call('GET', '/api/auth/me', { token });
  assert.equal(deniedMe.status, 403);
  assert.equal(deniedMe.body.error.message, 'Account is disabled');
  const pub = await call('GET', '/api/categories');
  assert.equal(pub.status, 200);
});

test('fresh login after revocation works (201 on POST /api/categories)', async () => {
  const { revokeUserTokens } = await import('../src/services/auth.service.js');
  const { email, password } = await makeLoginUser('fresh');
  const first = await login(email, password);
  await revokeUserTokens(first.user.id);
  const second = await login(email, password);
  const res = await call('POST', '/api/categories', {
    token: second.token,
    body: { name: uniq('SecCat'), type: 'COSMETIC' },
  });
  assert.equal(res.status, 201);
});

test('legacy token without tokenVersion -> 401', async () => {
  const user = await createUser(prisma, { tag: 'legacy' });
  const legacy = jwt.sign({ userId: user.id, role: user.role }, SECRET, { algorithm: 'HS256' });
  const res = await call('POST', '/api/categories', {
    token: legacy,
    body: { name: uniq('SecCat'), type: 'COSMETIC' },
  });
  assert.equal(res.status, 401);
  assert.equal(res.body.error.message, 'Invalid or expired token');
});

test('token for a deleted user -> 401', async () => {
  const user = await createUser(prisma, { tag: 'deleted' });
  const token = signToken(user);
  await prisma.user.delete({ where: { id: user.id } });
  const res = await call('POST', '/api/categories', {
    token,
    body: { name: uniq('SecCat'), type: 'COSMETIC' },
  });
  assert.equal(res.status, 401);
  assert.equal(res.body.error.message, 'Invalid or expired token');
});
test('role changed in the DB applies on the next request', async () => {
  const user = await createUser(prisma, { role: 'ADMIN', tag: 'role' });
  const token = signToken(user);
  const before = await call('GET', '/api/auth/me', { token });
  assert.equal(before.status, 200);
  assert.equal(before.body.user.role, 'ADMIN');
  await prisma.user.update({ where: { id: user.id }, data: { role: 'OWNER' } });
  const after = await call('GET', '/api/auth/me', { token });
  assert.equal(after.status, 200);
  assert.equal(after.body.user.role, 'OWNER');
});

test('tampered, expired and alg=none tokens -> 401', async () => {
  const user = await createUser(prisma, { tag: 'bad' });
  const good = signToken(user);
  const tampered = good.slice(0, -2) + (good.endsWith('aa') ? 'bb' : 'aa');
  const wrongSecret = jwt.sign(
    { userId: user.id, role: user.role, tokenVersion: 0 },
    'wrong-secret-that-is-long-enough-0123456789',
    { algorithm: 'HS256' },
  );
  const expired = jwt.sign({ userId: user.id, role: user.role, tokenVersion: 0 }, SECRET, {
    algorithm: 'HS256',
    expiresIn: '-10s',
  });
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const noneTok = `${b64({ alg: 'none', typ: 'JWT' })}.${b64({ userId: user.id, role: user.role, tokenVersion: 0 })}.`;
  for (const bad of [tampered, wrongSecret, expired, noneTok]) {
    const res = await call('POST', '/api/categories', {
      token: bad,
      body: { name: uniq('SecCat'), type: 'COSMETIC' },
    });
    assert.equal(res.status, 401);
  }
});

test('DB failure inside requireAuth returns 500 and does not hang', async () => {
  const user = await createUser(prisma, { tag: 'dbfail' });
  const token = signToken(user);
  const orig = prisma.user.findUnique;
  prisma.user.findUnique = async () => {
    throw new Error('simulated db failure');
  };
  try {
    const res = await call('POST', '/api/categories', {
      token,
      body: { name: uniq('SecCat'), type: 'COSMETIC' },
    });
    assert.equal(res.status, 500);
    assert.equal(res.body.error.message, 'Internal server error');
  } finally {
    prisma.user.findUnique = orig;
  }
  const ok = await call('POST', '/api/categories', {
    token,
    body: { name: uniq('SecCat'), type: 'COSMETIC' },
  });
  assert.equal(ok.status, 201);
});

test('upgrade: init-only user gets tokenVersion 0 after new migration', async () => {
  const migrationsDir = path.join(backendDir, 'prisma', 'migrations');
  const folders = fs
    .readdirSync(migrationsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
  assert.ok(folders.length >= 2, 'expected init + tokenVersion migrations');
  const split = (sql) =>
    sql
      .split(/;\s*(?:\n|$)/)
      .map((s) =>
        s
          .split('\n')
          .map((l) => l.trim())
          .filter((l) => l && !l.startsWith('--'))
          .join('\n')
          .trim(),
      )
      .filter(Boolean);
  const initSql = fs.readFileSync(path.join(migrationsDir, folders[0], 'migration.sql'), 'utf8');
  // Recreate the User table exactly as init defines it, including its email
  // indexes — otherwise a later test in this file would silently lose the
  // unique-email constraint in the shared temp DB.
  const recreateUserTable = async () => {
    await prisma.$executeRawUnsafe('DROP TABLE IF EXISTS "User";');
    for (const s of split(initSql)) {
      if (
        s.startsWith('CREATE TABLE "User"') ||
        s.startsWith('CREATE UNIQUE INDEX "User_email_key"') ||
        s.startsWith('CREATE INDEX "User_email_idx"')
      ) {
        await prisma.$executeRawUnsafe(s + ';');
      }
    }
  };
  await recreateUserTable();
  await prisma.$executeRawUnsafe(
    `INSERT INTO "User" (name, email, password, role, isActive, failedAttempts, updatedAt) VALUES ('Up','upgrade-tok@shop.local','h','ADMIN',1,0,CURRENT_TIMESTAMP);`,
  );
  // Select the tokenVersion migration by name (not "last folder"): later
  // migrations (e.g. brand_fk_restrict) may exist after it.
  const tvFolder = folders.find((f) => f.endsWith('_add_user_token_version'));
  assert.ok(tvFolder, 'tokenVersion migration folder not found');
  const migSql = fs.readFileSync(path.join(migrationsDir, tvFolder, 'migration.sql'), 'utf8');
  for (const s of split(migSql)) {
    await prisma.$executeRawUnsafe(s + ';');
  }
  const rows = await prisma.$queryRawUnsafe(
    `SELECT email, "tokenVersion" FROM "User" WHERE email='upgrade-tok@shop.local';`,
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].tokenVersion, 0);
  await recreateUserTable();
  for (const s of split(migSql)) {
    await prisma.$executeRawUnsafe(s + ';');
  }
});
