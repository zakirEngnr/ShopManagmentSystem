// Regression tests for the purchase detail lookup.
//
// Defect: GET /api/purchases/:id filtered the query with `supplierId: id`, so
// the route returned the newest purchase of the supplier whose id happened to
// equal the requested id — not the purchase with that primary key. A
// nonexistent purchase id also produced a 500 instead of a 404.
//
// Every test below runs against an isolated temporary database.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { createTempDb, assertTmpDbUrl } from '../test-support/tempDb.js';
import { createUser, signToken } from '../test-support/auth.js';

const backendDir = path.resolve(import.meta.dirname, '..');
const backendUrl = pathToFileURL(backendDir + path.sep).href;

let prisma;
let app;
let adminToken;
let ctx;
let categoryId;
let brandId;
let seq = 0;

before(async () => {
  ctx = await createTempDb({ prefix: 'purchase-detail-', backendDir });
  const { dbUrl, realTmp } = ctx;
  assertTmpDbUrl(dbUrl, realTmp);
  const db = await import(backendUrl + 'src/db/prisma.js');
  prisma = db.prisma;
  assert.equal(process.env.DATABASE_URL, dbUrl);
  app = (await import(backendUrl + 'src/app.js')).createApp();
  const admin = await createUser(prisma, { role: 'ADMIN', tag: 'purchase-detail-admin' });
  adminToken = signToken(admin);
  const category = await prisma.category.create({ data: { name: 'Detail Category', type: 'COSMETIC' } });
  categoryId = category.id;
  const brand = await prisma.brand.create({ data: { name: 'Detail Brand' } });
  brandId = brand.id;
});

after(async () => {
  if (prisma) {
    try { await prisma.$disconnect(); } catch {}
  }
  if (ctx) ctx.cleanup();
});

function doReq(method, full, tok, payload) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      const headers = { Accept: 'application/json' };
      if (payload !== null) {
        headers['Content-Type'] = 'application/json';
        headers['Content-Length'] = Buffer.byteLength(payload);
      }
      if (tok) headers.Authorization = 'Bearer ' + tok;
      const r = http.request({ host: '127.0.0.1', port, path: full, method, headers }, (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
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

function req(method, urlPath, opts = {}) {
  const payload = opts.body === undefined ? null : JSON.stringify(opts.body);
  return doReq(method, urlPath, opts.token, payload);
}

async function createProduct(overrides = {}) {
  const n = ++seq;
  return prisma.product.create({
    data: {
      sku: `DET-${Date.now()}-${n}`,
      name: `Detail Product ${n}`,
      type: 'COSMETIC',
      costPrice: 10,
      sellPrice: 25,
      stock: 10,
      categoryId,
      brandId,
      ...overrides,
    },
  });
}

async function createSupplier(overrides = {}) {
  const n = ++seq;
  return prisma.supplier.create({
    data: { name: `Detail Supplier ${n}`, phone: `+20000${String(n).padStart(4, '0')}`, balance: 0, ...overrides },
  });
}

/** Create a purchase through the API so the fixture is realistic. */
async function createPurchase(supplierId, overrides = {}) {
  const product = overrides.product ?? (await createProduct({ stock: 20 }));
  const res = await req('POST', '/api/purchases', {
    token: adminToken,
    body: { supplierId, items: [{ productId: product.id, quantity: 2, unitCost: 10 }] },
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return { purchase: res.body.purchase, product };
}

test('purchase detail: returns the exact purchase for the requested id', async () => {
  const supplier = await createSupplier();
  const { purchase, product } = await createPurchase(supplier.id);

  const res = await req('GET', `/api/purchases/${purchase.id}`, { token: adminToken });

  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.ok, true);
  assert.equal(res.body.purchase.id, purchase.id, 'the purchase with that id must be returned');
  assert.equal(res.body.purchase.supplierId, supplier.id);
  assert.equal(res.body.purchase.totalAmount, 20);
  assert.equal(res.body.purchase.items.length, 1);
  assert.equal(res.body.purchase.items[0].productId, product.id);
  // The detail response carries the same relations as a list entry.
  assert.ok(res.body.purchase.supplier, 'the supplier relation must be included');
  assert.ok(res.body.purchase.items[0].product, 'the product relation must be included');
});

test('purchase detail: two purchases of the same supplier are returned individually', async () => {
  const supplier = await createSupplier();
  const first = await createPurchase(supplier.id);
  const second = await createPurchase(supplier.id);

  assert.notEqual(first.purchase.id, second.purchase.id, 'the two purchases must differ');
  assert.equal(first.purchase.supplierId, second.purchase.supplierId, 'both belong to one supplier');

  const resFirst = await req('GET', `/api/purchases/${first.purchase.id}`, { token: adminToken });
  const resSecond = await req('GET', `/api/purchases/${second.purchase.id}`, { token: adminToken });

  assert.equal(resFirst.status, 200, JSON.stringify(resFirst.body));
  assert.equal(resSecond.status, 200, JSON.stringify(resSecond.body));
  assert.equal(resFirst.body.purchase.id, first.purchase.id, 'the first purchase must be returned for its own id');
  assert.equal(resSecond.body.purchase.id, second.purchase.id, 'the second purchase must be returned for its own id');
  assert.notEqual(resFirst.body.purchase.id, resSecond.body.purchase.id);
});

test('purchase detail: a purchase is never returned for another supplier\'s purchase id', async () => {
  const supplierA = await createSupplier();
  const supplierB = await createSupplier();
  const a = await createPurchase(supplierA.id);
  const b = await createPurchase(supplierB.id);

  const resA = await req('GET', `/api/purchases/${a.purchase.id}`, { token: adminToken });
  const resB = await req('GET', `/api/purchases/${b.purchase.id}`, { token: adminToken });

  assert.equal(resA.status, 200, JSON.stringify(resA.body));
  assert.equal(resB.status, 200, JSON.stringify(resB.body));
  assert.equal(resA.body.purchase.id, a.purchase.id);
  assert.equal(resA.body.purchase.supplierId, supplierA.id);
  assert.equal(resB.body.purchase.id, b.purchase.id);
  assert.equal(resB.body.purchase.supplierId, supplierB.id);
  assert.notEqual(resA.body.purchase.id, resB.body.purchase.id);
});

test('purchase detail: the supplier id is not used as the purchase lookup key', async () => {
  // The defect filtered by supplierId, so requesting /api/purchases/<supplierId>
  // returned that supplier's newest purchase. A purchase id must never resolve
  // to a purchase of a different supplier.
  const supplier = await createSupplier();
  const other = await createPurchase(supplier.id);

  // A purchase whose id equals the supplier id would be the exact collision
  // the old supplierId filter got wrong.
  const res = await req('GET', `/api/purchases/${other.purchase.id}`, { token: adminToken });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.purchase.id, other.purchase.id);
  assert.equal(res.body.purchase.supplierId, supplier.id);

  const all = await prisma.purchase.findMany({ where: { supplierId: supplier.id } });
  assert.equal(all.length, 1);
  assert.equal(all[0].id, other.purchase.id);
});

test('purchase detail: a nonexistent purchase id returns 404', async () => {
  const supplier = await createSupplier();
  await createPurchase(supplier.id);

  const missingId = 987654321;
  const res = await req('GET', `/api/purchases/${missingId}`, { token: adminToken });

  assert.equal(res.status, 404, JSON.stringify(res.body));
  assert.equal(res.body.ok, false);
  assert.equal(res.body.error.message, 'Purchase not found');
});

test('purchase detail: an invalid purchase id returns 400 and no purchase is leaked', async () => {
  const supplier = await createSupplier();
  const { purchase } = await createPurchase(supplier.id);

  const res = await req('GET', '/api/purchases/abc', { token: adminToken });
  assert.equal(res.status, 400, JSON.stringify(res.body));

  const resZero = await req('GET', '/api/purchases/0', { token: adminToken });
  assert.equal(resZero.status, 400, JSON.stringify(resZero.body));

  const resNegative = await req('GET', '/api/purchases/-1', { token: adminToken });
  assert.equal(resNegative.status, 400, JSON.stringify(resNegative.body));

  // The valid purchase is still reachable.
  const ok = await req('GET', `/api/purchases/${purchase.id}`, { token: adminToken });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.purchase.id, purchase.id);
});

test('purchase detail: requires authentication', async () => {
  const supplier = await createSupplier();
  const { purchase } = await createPurchase(supplier.id);

  const res = await req('GET', `/api/purchases/${purchase.id}`);
  assert.equal(res.status, 401);
});
