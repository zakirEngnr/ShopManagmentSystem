import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import http from 'node:http';
import { createTempDb, assertTmpDbUrl } from '../test-support/tempDb.js';
import { createUser, signToken } from '../test-support/auth.js';

// Brand FK integrity (HIGH-1): Product.brandId is ON DELETE RESTRICT.
// Safety: throwaway SQLite file under os.tmpdir() only. Real server on
// 127.0.0.1:0. Env is set BEFORE any src/ module is imported.
const backendDir = path.resolve(import.meta.dirname, '..');
const ctx = await createTempDb({ prefix: 'brand-integrity-', backendDir });
const { dbUrl, realTmp } = ctx;
process.env.JWT_SECRET = 'test-jwt-secret-that-is-long-enough-0123456789';
process.env.NODE_ENV = 'test';

let prisma;
let app;
let token;
let seq = 0;
function uniq(p) {
  seq += 1;
  return `${p}-${Date.now()}-${seq}-${Math.floor(Math.random() * 1e9)}`;
}

function call(method, urlPath, { token: tok, body } = {}) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      const payload = body === undefined ? null : JSON.stringify(body);
      const headers = { Accept: 'application/json' };
      if (payload !== null) {
        headers['Content-Type'] = 'application/json';
        headers['Content-Length'] = Buffer.byteLength(payload);
      }
      if (tok) headers.Authorization = 'Bearer ' + tok;
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

before(async () => {
  assertTmpDbUrl(dbUrl, realTmp);
  assert.equal(process.env.DATABASE_URL, dbUrl);
  const db = await import('../src/db/prisma.js');
  prisma = db.prisma;
  const { createApp } = await import('../src/app.js');
  app = createApp();
  const admin = await createUser(prisma, { tag: 'brand-int' });
  token = signToken(admin);
});

after(async () => {
  if (prisma) {
    try {
      await prisma.$disconnect();
    } catch {}
  }
  ctx.cleanup();
});

async function makeCategory() {
  return prisma.category.create({ data: { name: uniq('BICat'), type: 'COSMETIC' } });
}

test('referenced brand -> 409, brand and product.brandId unchanged', async () => {
  const cat = await makeCategory();
  const b = await call('POST', '/api/brands', { token, body: { name: uniq('BIRef') } });
  assert.equal(b.status, 201);
  const brandId = b.body.brand.id;
  const p = await call('POST', '/api/products', {
    token,
    body: { sku: uniq('BISKU'), name: 'BI Prod', type: 'COSMETIC', costPrice: 5, sellPrice: 9, categoryId: cat.id, brandId },
  });
  assert.equal(p.status, 201);
  const del = await call('DELETE', '/api/brands/' + brandId, { token });
  assert.equal(del.status, 409);
  assert.equal(del.body.error.message, 'Brand is referenced by other records');
  const still = await call('GET', '/api/brands/' + brandId, { token });
  assert.equal(still.status, 200);
  const prod = await prisma.product.findUnique({ where: { id: p.body.product.id } });
  assert.equal(prod.brandId, brandId);
  const fk = await prisma.$queryRawUnsafe('PRAGMA foreign_key_check;');
  assert.equal(fk.length, 0);
});

test('unreferenced brand -> 200 and gone', async () => {
  const b = await call('POST', '/api/brands', { token, body: { name: uniq('BIGone') } });
  assert.equal(b.status, 201);
  const del = await call('DELETE', '/api/brands/' + b.body.brand.id, { token });
  assert.equal(del.status, 200);
  const gone = await call('GET', '/api/brands/' + b.body.brand.id, { token });
  assert.equal(gone.status, 404);
});

test('deterministic ordering: delete-first vs create-first', async () => {
  const cat = await makeCategory();
  // delete first -> product create 404 or 409.
  const b1 = await call('POST', '/api/brands', { token, body: { name: uniq('BIOrd') } });
  const goneId = b1.body.brand.id;
  assert.equal((await call('DELETE', '/api/brands/' + goneId, { token })).status, 200);
  const createAfter = await call('POST', '/api/products', {
    token,
    body: { sku: uniq('BISKU'), name: 'BI Ord', type: 'COSMETIC', costPrice: 5, sellPrice: 9, categoryId: cat.id, brandId: goneId },
  });
  assert.ok(createAfter.status === 404 || createAfter.status === 409, 'got ' + createAfter.status);
  // create first -> delete 409.
  const b2 = await call('POST', '/api/brands', { token, body: { name: uniq('BIOrd') } });
  const keepId = b2.body.brand.id;
  const made = await call('POST', '/api/products', {
    token,
    body: { sku: uniq('BISKU'), name: 'BI Ord', type: 'COSMETIC', costPrice: 5, sellPrice: 9, categoryId: cat.id, brandId: keepId },
  });
  assert.equal(made.status, 201);
  const delAfter = await call('DELETE', '/api/brands/' + keepId, { token });
  assert.equal(delAfter.status, 409);
});
test('20-iteration race: delete-brand vs create-product-with-brand', async () => {
  // Limits of HTTP-level race tests: Node/Express serializes requests on one
  // event loop, so this cannot prove true DB-level serialization. It proves
  // the API never returns 500, never leaves a dangling/NULLed brandId, and
  // the (brand gone) <=> (delete 200) invariant holds on every iteration.
  for (let i = 0; i < 20; i++) {
    const cat = await makeCategory();
    const b = await call('POST', '/api/brands', { token, body: { name: uniq('BIRace') } });
    assert.equal(b.status, 201);
    const brandId = b.body.brand.id;
    const sku = uniq('BIRSKU');
    const prodBody = { sku, name: 'BI Race', type: 'COSMETIC', costPrice: 5, sellPrice: 9, categoryId: cat.id, brandId };
    const [delRes, createRes] = await Promise.all([
      call('DELETE', '/api/brands/' + brandId, { token }),
      call('POST', '/api/products', { token, body: prodBody }),
    ]);
    assert.ok([200, 404, 409].includes(delRes.status), 'delete got ' + delRes.status);
    assert.ok([201, 404, 409].includes(createRes.status), 'create got ' + createRes.status);
    assert.notEqual(delRes.status, 500);
    assert.notEqual(createRes.status, 500);
    const brandRow = await prisma.brand.findUnique({ where: { id: brandId } });
    const prodRow = await prisma.product.findUnique({ where: { sku } });
    assert.equal(brandRow === null, delRes.status === 200, `iter ${i}: brand gone vs delete status mismatch`);
    if (prodRow !== null) {
      assert.equal(prodRow.brandId, brandId, `iter ${i}: brandId changed`);
    }
    if (brandRow !== null && prodRow === null) {
      assert.ok(delRes.status === 409 || createRes.status !== 201, `iter ${i}: inconsistent`);
    }
    const fk = await prisma.$queryRawUnsafe('PRAGMA foreign_key_check;');
    assert.equal(fk.length, 0, `iter ${i}: fkcheck not empty`);
    if (prodRow) await prisma.product.deleteMany({ where: { sku } });
    await prisma.brand.deleteMany({ where: { id: brandId } });
    await prisma.category.deleteMany({ where: { id: cat.id } });
  }
});

test('same race for category (regression: RESTRICT + mapPrismaError)', async () => {
  for (let i = 0; i < 20; i++) {
    const c = await call('POST', '/api/categories', { token, body: { name: uniq('BIRCat'), type: 'COSMETIC' } });
    assert.equal(c.status, 201);
    const catId = c.body.category.id;
    const sku = uniq('BIRCSKU');
    const prodBody = { sku, name: 'BI Race C', type: 'COSMETIC', costPrice: 5, sellPrice: 9, categoryId: catId };
    const [delRes, createRes] = await Promise.all([
      call('DELETE', '/api/categories/' + catId, { token }),
      call('POST', '/api/products', { token, body: prodBody }),
    ]);
    assert.ok([200, 404, 409].includes(delRes.status), 'delete got ' + delRes.status);
    assert.ok([201, 404, 409].includes(createRes.status), 'create got ' + createRes.status);
    assert.notEqual(delRes.status, 500);
    const catRow = await prisma.category.findUnique({ where: { id: catId } });
    const prodRow = await prisma.product.findUnique({ where: { sku } });
    assert.equal(catRow === null, delRes.status === 200, `iter ${i}: category gone vs delete status mismatch`);
    const fk = await prisma.$queryRawUnsafe('PRAGMA foreign_key_check;');
    assert.equal(fk.length, 0, `iter ${i}: fkcheck not empty`);
    if (prodRow) await prisma.product.deleteMany({ where: { sku } });
    await prisma.category.deleteMany({ where: { id: catId } });
  }
});
