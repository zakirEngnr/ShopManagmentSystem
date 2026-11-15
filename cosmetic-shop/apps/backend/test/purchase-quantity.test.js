// Regression tests for F-01: a purchase must be accepted for any valid
// quantity, regardless of the current stock of the product.
//
// The throw-away database is created by createTempDb (schema + seed rows).
import { test, before, after, beforeEach } from 'node:test';
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

before(async () => {
  ctx = await createTempDb({ prefix: 'purchase-quantity-', backendDir });
  const { dbUrl, realTmp } = ctx;
  assertTmpDbUrl(dbUrl, realTmp);
  const db = await import(backendUrl + 'src/db/prisma.js');
  prisma = db.prisma;
  assert.equal(process.env.DATABASE_URL, dbUrl);
  app = (await import(backendUrl + 'src/app.js')).createApp();
  const admin = await createUser(prisma, { role: 'ADMIN', tag: 'purchase-quantity-admin' });
  adminToken = signToken(admin);
  const category = await prisma.category.create({ data: { name: 'Purchase Quantity Category', type: 'COSMETIC' } });
  categoryId = category.id;
  const brand = await prisma.brand.create({ data: { name: 'Purchase Quantity Brand' } });
  brandId = brand.id;
});

after(async () => {
  if (prisma) { try { await prisma.$disconnect(); } catch {} }
  if (ctx) ctx.cleanup();
});

beforeEach(async () => {
  await prisma.purchaseItem.deleteMany();
  await prisma.purchase.deleteMany();
  await prisma.supplierPayment.deleteMany();
  await prisma.supplierPaymentAllocation.deleteMany();
  await prisma.product.deleteMany();
  await prisma.supplier.deleteMany();
});

function request(method, full, token, payload) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      const headers = { Accept: 'application/json' };
      const body = payload === undefined ? null : JSON.stringify(payload);
      if (body !== null) {
        headers['Content-Type'] = 'application/json';
        headers['Content-Length'] = Buffer.byteLength(body);
      }
      if (token) headers.Authorization = `Bearer ${token}`;
      const r = http.request({ host: '127.0.0.1', port, path: full, method, headers }, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          server.close();
          let json = null;
          try { json = data ? JSON.parse(data) : null; } catch { json = { _raw: data }; }
          resolve({ status: res.statusCode, body: json });
        });
      });
      r.on('error', (err) => { server.close(); reject(err); });
      if (body !== null) r.write(body);
      r.end();
    });
  });
}

/** Create a product with the given stock and a supplier. */
async function seed(stock) {
  const product = await prisma.product.create({
    data: { sku: `PQ-${stock}-${Date.now()}`, name: `PQ Product ${stock}`, type: 'COSMETIC', costPrice: 5, sellPrice: 10, stock, lowStockAt: 1, categoryId, brandId },
  });
  const supplier = await prisma.supplier.create({
    data: { name: `PQ Supplier ${stock}`, phone: `0300${Math.floor(Math.random() * 1e9)}`, balance: 0 },
  });
  return { product, supplier };
}

/** One purchase of the product through the API. */
async function buy(product, supplier, quantity, unitCost = 5) {
  return request('POST', '/api/purchases', adminToken, {
    supplierId: supplier.id,
    items: [{ productId: product.id, quantity, unitCost }],
  });
}

/* ------------------------------------------------------------------ */
/* A. normal restocking                                                */
/* ------------------------------------------------------------------ */

test('A. a purchase of 24 with a stock of 3 is accepted and the stock becomes 27', async () => {
  const { product, supplier } = await seed(3);

  const res = await buy(product, supplier, 24);

  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.ok(res.body.purchase, 'the purchase must be created');

  const after = await prisma.product.findUnique({ where: { id: product.id } });
  assert.equal(after.stock, 27, 'the stock must be 3 + 24');
});

/* ------------------------------------------------------------------ */
/* B. other quantities                                                 */
/* ------------------------------------------------------------------ */

test('B. a purchase of 24 with a stock of 0 is accepted', async () => {
  const { product, supplier } = await seed(0);
  const res = await buy(product, supplier, 24);
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal((await prisma.product.findUnique({ where: { id: product.id } })).stock, 24);
});

test('B. a purchase of 4 with a stock of 3 is accepted', async () => {
  const { product, supplier } = await seed(3);
  const res = await buy(product, supplier, 4);
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal((await prisma.product.findUnique({ where: { id: product.id } })).stock, 7);
});

test('B. a purchase of 5 with a stock of 3 is accepted', async () => {
  const { product, supplier } = await seed(3);
  const res = await buy(product, supplier, 5);
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal((await prisma.product.findUnique({ where: { id: product.id } })).stock, 8);
});

test('B. a purchase of 100 with a stock of 3 is accepted', async () => {
  const { product, supplier } = await seed(3);
  const res = await buy(product, supplier, 100);
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal((await prisma.product.findUnique({ where: { id: product.id } })).stock, 103);
});

/* ------------------------------------------------------------------ */
/* C. invalid quantities                                               */
/* ------------------------------------------------------------------ */

test('C. a quantity of zero is rejected', async () => {
  const { product, supplier } = await seed(3);
  const res = await buy(product, supplier, 0);
  assert.equal(res.status, 400);
  assert.equal((await prisma.product.findUnique({ where: { id: product.id } })).stock, 3);
  assert.equal(await prisma.purchase.count(), 0);
});

test('C. a negative quantity is rejected', async () => {
  const { product, supplier } = await seed(3);
  const res = await buy(product, supplier, -1);
  assert.equal(res.status, 400);
  assert.equal((await prisma.product.findUnique({ where: { id: product.id } })).stock, 3);
  assert.equal(await prisma.purchase.count(), 0);
});

test('C. a non-integer quantity is rejected', async () => {
  const { product, supplier } = await seed(3);
  const res = await buy(product, supplier, 2.5);
  assert.equal(res.status, 400);
  assert.equal((await prisma.product.findUnique({ where: { id: product.id } })).stock, 3);
  assert.equal(await prisma.purchase.count(), 0);
});

test('C. a missing product is rejected', async () => {
  const supplier = await prisma.supplier.create({
    data: { name: 'Missing Product Supplier', phone: '03009999999', balance: 0 },
  });
  const res = await request('POST', '/api/purchases', adminToken, {
    supplierId: supplier.id,
    items: [{ productId: 999999, quantity: 24, unitCost: 5 }],
  });
  assert.equal(res.status, 404);
  assert.equal(await prisma.purchase.count(), 0);
});

test('C. a missing supplier is rejected', async () => {
  const { product } = await seed(3);
  const res = await request('POST', '/api/purchases', adminToken, {
    supplierId: 999999,
    items: [{ productId: product.id, quantity: 24, unitCost: 5 }],
  });
  assert.equal(res.status, 404);
  assert.equal(await prisma.purchase.count(), 0);
  assert.equal((await prisma.product.findUnique({ where: { id: product.id } })).stock, 3);
});

/* ------------------------------------------------------------------ */
/* D. financial integrity                                              */
/* ------------------------------------------------------------------ */

test('D. the purchase total, the supplier balance and the items are correct', async () => {
  const { product, supplier } = await seed(3);

  const res = await buy(product, supplier, 24, 5);

  assert.equal(res.status, 201);
  const purchase = res.body.purchase;
  assert.equal(Number(purchase.totalAmount), 120, 'the total must be 24 * 5');
  assert.equal(Number(purchase.paidAmount), 0);
  assert.equal(purchase.status, 'UNPAID');
  assert.equal(purchase.items.length, 1);
  assert.equal(purchase.items[0].quantity, 24);
  assert.equal(Number(purchase.items[0].unitCost), 5);
  assert.equal(Number(purchase.items[0].total), 120);

  const supplierAfter = await prisma.supplier.findUnique({ where: { id: supplier.id } });
  assert.equal(Number(supplierAfter.balance), 120, 'the supplier balance must be incremented by the total');

  const productAfter = await prisma.product.findUnique({ where: { id: product.id } });
  assert.equal(productAfter.stock, 27, 'the stock must be incremented exactly once');
  assert.equal(Number(productAfter.costPrice), 5, 'the cost price must be updated');
});

test('D. a failed purchase does not leave a partial purchase or stock change', async () => {
  const { product, supplier } = await seed(3);

  // A purchase with a zero quantity must be rejected without changing anything.
  const beforeStock = (await prisma.product.findUnique({ where: { id: product.id } })).stock;
  const beforeBalance = (await prisma.supplier.findUnique({ where: { id: supplier.id } })).balance;
  const beforePurchases = await prisma.purchase.count();
  const beforeItems = await prisma.purchaseItem.count();

  const res = await request('POST', '/api/purchases', adminToken, {
    supplierId: supplier.id,
    items: [{ productId: product.id, quantity: 24, unitCost: 5 }, { productId: product.id, quantity: 0, unitCost: 5 }],
  });

  assert.ok(res.status >= 400, 'a purchase with a zero quantity must be rejected');
  assert.equal((await prisma.product.findUnique({ where: { id: product.id } })).stock, beforeStock, 'the stock must not change');
  assert.equal((await prisma.supplier.findUnique({ where: { id: supplier.id } })).balance, beforeBalance, 'the supplier balance must not change');
  assert.equal(await prisma.purchase.count(), beforePurchases, 'no purchase must be created');
  assert.equal(await prisma.purchaseItem.count(), beforeItems, 'no purchase item must be created');
});

test('D. the stock is incremented exactly once even when the quantity is large', async () => {
  const { product, supplier } = await seed(3);

  await buy(product, supplier, 1000);
  await buy(product, supplier, 5);

  const after = await prisma.product.findUnique({ where: { id: product.id } });
  assert.equal(after.stock, 3 + 1000 + 5, 'two valid purchases must add up');

  const purchases = await prisma.purchase.findMany();
  assert.equal(purchases.length, 2, 'two purchases must exist');
});
