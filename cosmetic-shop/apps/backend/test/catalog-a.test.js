// Phase A: category + brand CRUD integration tests.
// Safety: throwaway SQLite file under os.tmpdir() only. Schema is created
// from prisma/migrations/.../migration.sql via Prisma $executeRawUnsafe —
// no Prisma CLI, no --accept-data-loss, no writes to the real shop.db.
// Env is set BEFORE any src/ module is imported.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import http from 'node:http';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'catalog-a-'));
const dbFile = path.join(tmpDir, 'test.db');

function abortIfNotTmpDb(url) {
  const resolved = path.resolve(url.replace(/^file:/, ''));
  const tmp = path.resolve(os.tmpdir());
  if (!resolved.startsWith(tmp + path.sep)) {
    throw new Error('refusing to run: DATABASE_URL is not inside os.tmpdir()');
  }
}

const dbUrl = `file:${dbFile}`;
abortIfNotTmpDb(dbUrl);
process.env.DATABASE_URL = dbUrl;
process.env.JWT_SECRET = 'test-jwt-secret-that-is-long-enough-0123456789';
process.env.NODE_ENV = 'test';

let prisma;
let app;
let adminToken;
const SECRET = 'SECRET-VALUE-7c1d9a';

function req(method, urlPath, opts = {}) {
  const { token, body } = opts;
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

async function initTmpDb() {
  abortIfNotTmpDb(dbUrl);
  const backendDir = path.resolve(import.meta.dirname, '..');
  const sqlPath = path.join(backendDir, 'prisma', 'migrations', '20261018125524_init', 'migration.sql');
  const sql = fs.readFileSync(sqlPath, 'utf8');
  const stmts = sql
    .split(/;\s*(?:\n|$)/)
    .map((s) => s
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith('--'))
      .join('\n')
      .trim())
    .filter(Boolean);
  assert.ok(stmts.length > 0, 'migration.sql must not be empty');
  for (const s of stmts) {
    assert.match(s, /^CREATE\s+(TABLE|INDEX|UNIQUE\s+INDEX)/i, 'unexpected statement: ' + s.slice(0, 60));
  }
  for (const s of stmts) {
    await prisma.$executeRawUnsafe(s + ';');
  }
}

let tagSeq = 0;
function tag(prefix) {
  tagSeq += 1;
  return prefix + '-' + Date.now() + '-' + tagSeq + '-' + Math.floor(Math.random() * 1e9);
}

before(async () => {
  abortIfNotTmpDb(dbUrl);
  process.env.DATABASE_URL = dbUrl;
  const db = await import('../src/db/prisma.js');
  prisma = db.prisma;
  try {
    await initTmpDb();
  } catch (err) {
    try { await prisma.$disconnect(); } catch {}
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    throw err;
  }
  const { createApp } = await import('../src/app.js');
  app = createApp();
  const { hashPassword } = await import('../src/utils/password.js');
  const hash = await hashPassword('AdminPass-12345-Long');
  await prisma.user.create({
    data: { name: 'Admin', email: 'admin-a@shop.local', password: hash, role: 'ADMIN', isActive: true },
  });
  const { login } = await import('../src/services/auth.service.js');
  const out = await login('admin-a@shop.local', 'AdminPass-12345-Long');
  adminToken = out.token;
  assert.ok(adminToken);
});

after(async () => {
  if (prisma) {
    try {
      const url = process.env.DATABASE_URL;
      if (url) abortIfNotTmpDb(url);
      await prisma.$disconnect();
    } catch {}
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function assertSafeBody(res) {
  const text = JSON.stringify(res.body);
  assert.ok(!text.includes(SECRET), 'leaked attacker value');
  assert.ok(!text.includes('SECRET-VALUE'), 'leaked attacker value');
}

test('health still ok', async () => {
  const r = await req('GET', '/api/health');
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
});
test('category CRUD success', async () => {
  const name = tag('Cat');
  const created = await req('POST', '/api/categories', { token: adminToken, body: { name, type: 'COSMETIC' } });
  assert.equal(created.status, 201);
  assert.equal(created.body.category.name, name);
  const id = created.body.category.id;
  const list = await req('GET', '/api/categories');
  assert.equal(list.status, 200);
  assert.ok(list.body.categories.some((c) => c.id === id));
  const detail = await req('GET', '/api/categories/' + id);
  assert.equal(detail.status, 200);
  const updated = await req('PATCH', '/api/categories/' + id, { token: adminToken, body: { name: name + '-New' } });
  assert.equal(updated.status, 200);
  const spaced = await req('POST', '/api/categories', { token: adminToken, body: { name: '  ' + tag('Spaced') + '  ', type: 'JEWELRY' } });
  assert.equal(spaced.status, 201);
  assert.equal(spaced.body.category.name, spaced.body.category.name.trim());
  const del = await req('DELETE', '/api/categories/' + id, { token: adminToken });
  assert.equal(del.status, 200);
  const gone = await req('GET', '/api/categories/' + id);
  assert.equal(gone.status, 404);
});

test('category duplicate names give 409', async () => {
  const name = tag('Dup');
  const first = await req('POST', '/api/categories', { token: adminToken, body: { name, type: 'COSMETIC' } });
  assert.equal(first.status, 201);
  const second = await req('POST', '/api/categories', { token: adminToken, body: { name, type: 'COSMETIC' } });
  assert.equal(second.status, 409);
  assertSafeBody(second);
  const other = await req('POST', '/api/categories', { token: adminToken, body: { name: tag('Other'), type: 'COSMETIC' } });
  assert.equal(other.status, 201);
  const clash = await req('PATCH', '/api/categories/' + other.body.category.id, { token: adminToken, body: { name } });
  assert.equal(clash.status, 409);
});

test('category invalid inputs give 400 without leakage', async () => {
  const bad = await req('POST', '/api/categories', { token: adminToken, body: { name: 'X', type: SECRET } });
  assert.equal(bad.status, 400);
  assertSafeBody(bad);
  const unknown = await req('POST', '/api/categories', { token: adminToken, body: { name: tag('U'), type: 'COSMETIC', password: SECRET } });
  assert.equal(unknown.status, 400);
  assertSafeBody(unknown);
  const empty = await req('POST', '/api/categories', { token: adminToken, body: { name: '   ', type: 'COSMETIC' } });
  assert.equal(empty.status, 400);
  const badType = await req('POST', '/api/categories', { token: adminToken, body: { name: tag('T'), type: 'FOOD' } });
  assert.equal(badType.status, 400);
  assertSafeBody(badType);
  const created = await req('POST', '/api/categories', { token: adminToken, body: { name: tag('EU'), type: 'COSMETIC' } });
  assert.equal(created.status, 201);
  const emptyUpdate = await req('PATCH', '/api/categories/' + created.body.category.id, { token: adminToken, body: {} });
  assert.equal(emptyUpdate.status, 400);
});

test('category malformed ids give 400; missing gives 404', async () => {
  for (const badId of ['0', '-1', 'abc']) {
    const r = await req('GET', '/api/categories/' + badId);
    assert.equal(r.status, 400);
    assertSafeBody(r);
  }
  const sec = await req('GET', '/api/categories/' + encodeURIComponent(SECRET));
  assert.equal(sec.status, 400);
  assertSafeBody(sec);
  const missing = await req('GET', '/api/categories/999999');
  assert.equal(missing.status, 404);
});

test('category auth required for mutations; reads public', async () => {
  const anon = await req('POST', '/api/categories', { body: { name: tag('Anon'), type: 'COSMETIC' } });
  assert.equal(anon.status, 401);
  const list = await req('GET', '/api/categories');
  assert.equal(list.status, 200);
  const created = await req('POST', '/api/categories', { token: adminToken, body: { name: tag('Auth'), type: 'COSMETIC' } });
  assert.equal(created.status, 201);
  const anonDel = await req('DELETE', '/api/categories/' + created.body.category.id);
  assert.equal(anonDel.status, 401);
});

test('category guarded deletion while referenced gives 409', async () => {
  const cat = await req('POST', '/api/categories', { token: adminToken, body: { name: tag('Ref'), type: 'COSMETIC' } });
  assert.equal(cat.status, 201);
  const catId = cat.body.category.id;
  await prisma.product.create({
    data: { sku: tag('SKU'), name: 'Ref Product', type: 'COSMETIC', costPrice: 10, sellPrice: 20, stock: 1, categoryId: catId },
  });
  const del = await req('DELETE', '/api/categories/' + catId, { token: adminToken });
  assert.equal(del.status, 409);
  const still = await req('GET', '/api/categories/' + catId);
  assert.equal(still.status, 200);
  const missing = await req('DELETE', '/api/categories/999999', { token: adminToken });
  assert.equal(missing.status, 404);
});

test('category race stays consistent', async () => {
  const cat = await req('POST', '/api/categories', { token: adminToken, body: { name: tag('Race'), type: 'COSMETIC' } });
  assert.equal(cat.status, 201);
  const catId = cat.body.category.id;
  const sku = tag('RACESKU');
  const delP = req('DELETE', '/api/categories/' + catId, { token: adminToken });
  const prodP = (async () => {
    try {
      const p = await prisma.product.create({
        data: { sku, name: 'Race Product', type: 'COSMETIC', costPrice: 5, sellPrice: 9, stock: 1, categoryId: catId },
      });
      return { status: 'created', id: p.id };
    } catch (err) {
      return { status: 'failed', code: err && err.code };
    }
  })();
  const results = await Promise.all([delP, prodP]);
  const delRes = results[0];
  assert.ok(delRes.status === 200 || delRes.status === 409);
  const catRow = await prisma.category.findUnique({ where: { id: catId } });
  const prodRow = await prisma.product.findUnique({ where: { sku } });
  if (catRow === null) {
    assert.equal(prodRow, null);
    assert.equal(delRes.status, 200);
  } else {
    assert.equal(delRes.status, 409);
    if (prodRow !== null) assert.equal(prodRow.categoryId, catId);
  }
  if (prodRow !== null) await prisma.product.deleteMany({ where: { sku } });
  await prisma.category.deleteMany({ where: { id: catId } });
});

test('brand CRUD success', async () => {
  const name = tag('Brand');
  const created = await req('POST', '/api/brands', { token: adminToken, body: { name } });
  assert.equal(created.status, 201);
  const id = created.body.brand.id;
  const list = await req('GET', '/api/brands');
  assert.equal(list.status, 200);
  assert.ok(list.body.brands.some((b) => b.id === id));
  const detail = await req('GET', '/api/brands/' + id);
  assert.equal(detail.status, 200);
  const updated = await req('PATCH', '/api/brands/' + id, { token: adminToken, body: { name: name + '-New' } });
  assert.equal(updated.status, 200);
  const del = await req('DELETE', '/api/brands/' + id, { token: adminToken });
  assert.equal(del.status, 200);
  const gone = await req('GET', '/api/brands/' + id);
  assert.equal(gone.status, 404);
});

test('brand edges give right codes', async () => {
  const name = tag('BDup');
  const first = await req('POST', '/api/brands', { token: adminToken, body: { name } });
  assert.equal(first.status, 201);
  const dup = await req('POST', '/api/brands', { token: adminToken, body: { name } });
  assert.equal(dup.status, 409);
  const unknown = await req('POST', '/api/brands', { token: adminToken, body: { name: tag('BU'), password: SECRET } });
  assert.equal(unknown.status, 400);
  assertSafeBody(unknown);
  const emptyUpdate = await req('PATCH', '/api/brands/' + first.body.brand.id, { token: adminToken, body: {} });
  assert.equal(emptyUpdate.status, 400);
  const anon = await req('POST', '/api/brands', { body: { name: tag('BAnon') } });
  assert.equal(anon.status, 401);
  const malformed = await req('GET', '/api/brands/abc');
  assert.equal(malformed.status, 400);
  const missing = await req('GET', '/api/brands/999999');
  assert.equal(missing.status, 404);
  const brandId = first.body.brand.id;
  const cat = await prisma.category.create({ data: { name: tag('BCat'), type: 'COSMETIC' } });
  const sku = tag('BSKU');
  await prisma.product.create({
    data: { sku, name: 'Brand Ref', type: 'COSMETIC', costPrice: 10, sellPrice: 20, stock: 1, categoryId: cat.id, brandId },
  });
  const del = await req('DELETE', '/api/brands/' + brandId, { token: adminToken });
  assert.equal(del.status, 409);
  const still = await req('GET', '/api/brands/' + brandId);
  assert.equal(still.status, 200);
  const missingDel = await req('DELETE', '/api/brands/999999', { token: adminToken });
  assert.equal(missingDel.status, 404);
  await prisma.product.deleteMany({ where: { sku } });
  await prisma.category.deleteMany({ where: { id: cat.id } });
  await prisma.brand.deleteMany({ where: { id: brandId } });
});

test('brand race stays consistent', async () => {
  const created = await req('POST', '/api/brands', { token: adminToken, body: { name: tag('BRace') } });
  assert.equal(created.status, 201);
  const brandId = created.body.brand.id;
  const cat = await prisma.category.create({ data: { name: tag('BRaceCat'), type: 'COSMETIC' } });
  const sku = tag('BRACESKU');
  const delP = req('DELETE', '/api/brands/' + brandId, { token: adminToken });
  const prodP = (async () => {
    try {
      const p = await prisma.product.create({
        data: { sku, name: 'Brand Race', type: 'COSMETIC', costPrice: 5, sellPrice: 9, stock: 1, categoryId: cat.id, brandId },
      });
      return { status: 'created', id: p.id };
    } catch (err) {
      return { status: 'failed', code: err && err.code };
    }
  })();
  const both = await Promise.all([delP, prodP]);
  const delRes = both[0];
  assert.ok(delRes.status === 200 || delRes.status === 409);
  const brandRow = await prisma.brand.findUnique({ where: { id: brandId } });
  const prodRow = await prisma.product.findUnique({ where: { sku } });
  if (brandRow === null) {
    assert.equal(prodRow, null);
    assert.equal(delRes.status, 200);
  } else {
    assert.equal(delRes.status, 409);
  }
  if (prodRow !== null) await prisma.product.deleteMany({ where: { sku } });
  await prisma.brand.deleteMany({ where: { id: brandId } });
  await prisma.category.deleteMany({ where: { id: cat.id } });
});

test('database is isolated temp file', async () => {
  abortIfNotTmpDb(process.env.DATABASE_URL);
  assert.ok(!path.resolve(dbFile).includes('shop.db'));
  const realDb = path.resolve(import.meta.dirname, '..', 'shop.db');
  assert.notEqual(path.resolve(dbFile), realDb);
});
