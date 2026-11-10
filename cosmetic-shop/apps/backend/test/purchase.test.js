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

before(async () => {
  ctx = await createTempDb({ prefix: 'purchases-', backendDir });
  const { dbUrl, realTmp } = ctx;
  assertTmpDbUrl(dbUrl, realTmp);
  const db = await import(backendUrl + 'src/db/prisma.js');
  prisma = db.prisma;
  assert.equal(process.env.DATABASE_URL, dbUrl);
  app = (await import(backendUrl + 'src/app.js')).createApp();
  const admin = await createUser(prisma, { role: 'ADMIN', tag: 'purchase-admin' });
  adminToken = signToken(admin);
  const category = await prisma.category.create({ data: { name: 'Purchase Category', type: 'COSMETIC' } });
  categoryId = category.id;
  const brand = await prisma.brand.create({ data: { name: 'Purchase Brand' } });
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
  let full = urlPath;
  if (opts.query) {
    const qs = new URLSearchParams();
    for (const [key, value] of Object.entries(opts.query)) {
      if (value === undefined) continue;
      qs.set(key, String(value));
    }
    const s = qs.toString();
    if (s) full += '?' + s;
  }
  const payload = opts.body === undefined ? null : JSON.stringify(opts.body);
  return doReq(method, full, opts.token, payload);
}

async function createProduct(overrides = {}) {
  return prisma.product.create({
    data: {
      sku: `PUR-${Date.now()}-${Math.random().toString(16).slice(2,8)}`,
      name: 'Purchase Product',
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
  return prisma.supplier.create({
    data: { name: 'Purchase Supplier', phone: '+2000000001', email: 'supplier@example.com', balance: 0, ...overrides },
  });
}

test('1 create a purchase successfully', async () => {
  const supplier = await createSupplier();
  const product = await createProduct({ name: 'Purchase Stock Product', stock: 20, costPrice: 8, sellPrice: 18 });
  const res = await req('POST', '/api/purchases', {
    token: adminToken,
    body: { supplierId: supplier.id, items: [{ productId: product.id, quantity: 3, unitCost: 8 }] },
  });
  assert.equal(res.status, 201);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.purchase.totalAmount, 24);
  assert.equal(res.body.purchase.status, 'UNPAID');
  const updatedProduct = await prisma.product.findUnique({ where: { id: product.id } });
  assert.equal(updatedProduct.stock, 23);
  const updatedSupplier = await prisma.supplier.findUnique({ where: { id: supplier.id } });
  assert.equal(Number(updatedSupplier.balance), 24);
  const purchaseRow = await prisma.purchase.findUnique({ where: { id: res.body.purchase.id } });
  assert.equal(Number(purchaseRow.totalAmount), 24);
  assert.equal(Number(purchaseRow.paidAmount), 0);
  assert.equal(purchaseRow.status, 'UNPAID');
});

test('2 reject nonexistent supplier', async () => {
  const product = await createProduct({ name: 'NoSupplier Product', stock: 10 });
  const res = await req('POST', '/api/purchases', {
    token: adminToken,
    body: { supplierId: 999999, items: [{ productId: product.id, quantity: 1, unitCost: 10 }] },
  });
  assert.equal(res.status, 404);
});

test('3 reject nonexistent product', async () => {
  const supplier = await createSupplier({ name: 'Missing Product Supplier', phone: '+2000000002' });
  const res = await req('POST', '/api/purchases', {
    token: adminToken,
    body: { supplierId: supplier.id, items: [{ productId: 999999, quantity: 1, unitCost: 10 }] },
  });
  assert.equal(res.status, 404);
});

test('4 reject empty items array', async () => {
  const supplier = await createSupplier({ name: 'Empty Items Supplier', phone: '+2000000003' });
  const res = await req('POST', '/api/purchases', {
    token: adminToken,
    body: { supplierId: supplier.id, items: [] },
  });
  assert.equal(res.status, 400);
});

test('5 reject invalid quantity and cost', async () => {
  const supplier = await createSupplier({ name: 'Invalid Qty Supplier', phone: '+2000000004' });
  const product = await createProduct({ name: 'Invalid Qty Product', stock: 5 });
  const qtyRes = await req('POST', '/api/purchases', {
    token: adminToken,
    body: { supplierId: supplier.id, items: [{ productId: product.id, quantity: 0, unitCost: 10 }] },
  });
  const costRes = await req('POST', '/api/purchases', {
    token: adminToken,
    body: { supplierId: supplier.id, items: [{ productId: product.id, quantity: 1, unitCost: 0 }] },
  });
  assert.equal(qtyRes.status, 400);
  assert.equal(costRes.status, 400);
});

test('6 reject duplicate product IDs', async () => {
  const supplier = await createSupplier({ name: 'Duplicate Supplier', phone: '+2000000005' });
  const product = await createProduct({ name: 'Duplicate Product', stock: 5 });
  const res = await req('POST', '/api/purchases', {
    token: adminToken,
    body: { supplierId: supplier.id, items: [{ productId: product.id, quantity: 1, unitCost: 5 }, { productId: product.id, quantity: 2, unitCost: 5 }] },
  });
  assert.equal(res.status, 400);
});

test('7 verifies purchase items, stock, and supplier payable', async () => {
  const supplier = await createSupplier({ name: 'Verify Supplier', phone: '+2000000006' });
  const product = await createProduct({ name: 'Verify Product', stock: 7, costPrice: 12, sellPrice: 20 });
  const res = await req('POST', '/api/purchases', {
    token: adminToken,
    body: { supplierId: supplier.id, items: [{ productId: product.id, quantity: 4, unitCost: 12.5 }] },
  });
  assert.equal(res.status, 201);
  const purchaseItems = await prisma.purchaseItem.findMany({ where: { purchaseId: res.body.purchase.id } });
  assert.equal(purchaseItems.length, 1);
  assert.equal(Number(purchaseItems[0].total), 50);
  const updatedProduct = await prisma.product.findUnique({ where: { id: product.id } });
  assert.equal(updatedProduct.stock, 11);
  assert.equal(Number(updatedProduct.costPrice), 12.5);
  const updatedSupplier = await prisma.supplier.findUnique({ where: { id: supplier.id } });
  assert.equal(Number(updatedSupplier.balance), 50);
  const saleCount = await prisma.sale.count();
  assert.equal(saleCount, 0);
});

test('8 failed purchase rolls back all changes', async () => {
  const supplier = await createSupplier({ name: 'Rollback Supplier', phone: '+2000000007' });
  const product = await createProduct({ name: 'Rollback Product', stock: 2, costPrice: 5, sellPrice: 9 });
  const beforeStock = product.stock;
  const beforeBalance = Number((await prisma.supplier.findUnique({ where: { id: supplier.id } })).balance);
  const beforeItems = await prisma.purchaseItem.count();
  const res = await req('POST', '/api/purchases', {
    token: adminToken,
    body: { supplierId: supplier.id, items: [{ productId: product.id, quantity: 5, unitCost: 5 }] },
  });
  assert.equal(res.status, 400);
  const updatedProduct = await prisma.product.findUnique({ where: { id: product.id } });
  assert.equal(updatedProduct.stock, beforeStock);
  const updatedSupplier = await prisma.supplier.findUnique({ where: { id: supplier.id } });
  assert.equal(Number(updatedSupplier.balance), beforeBalance);
  assert.equal(await prisma.purchaseItem.count(), beforeItems);
});

test('9 concurrent purchases on same product do not lose stock increments', async () => {
  const supplierA = await createSupplier({ name: 'Concurrent A', phone: '+2000000008' });
  const supplierB = await createSupplier({ name: 'Concurrent B', phone: '+2000000009' });
  const product = await createProduct({ name: 'Concurrent Product', stock: 0, costPrice: 4, sellPrice: 12 });

  const requests = [
    req('POST', '/api/purchases', { token: adminToken, body: { supplierId: supplierA.id, items: [{ productId: product.id, quantity: 2, unitCost: 4 }] } }),
    req('POST', '/api/purchases', { token: adminToken, body: { supplierId: supplierB.id, items: [{ productId: product.id, quantity: 3, unitCost: 4 }] } }),
    req('POST', '/api/purchases', { token: adminToken, body: { supplierId: supplierA.id, items: [{ productId: product.id, quantity: 1, unitCost: 4 }] } }),
  ];

  const results = await Promise.all(requests);
  const success = results.filter((r) => r.status === 201).length;
  assert.equal(success, 3);
  const saved = await prisma.product.findUnique({ where: { id: product.id } });
  assert.equal(saved.stock, 6);
  assert.equal(await prisma.purchase.count({ where: { supplierId: { in: [supplierA.id, supplierB.id] } } }), 3);
});

test('10 purchases list supports pagination and supplier filtering', async () => {
  const supplier = await createSupplier({ name: 'List Supplier', phone: '+2000000010' });
  const product = await createProduct({ name: 'List Product', stock: 5, costPrice: 11, sellPrice: 22 });
  await req('POST', '/api/purchases', {
    token: adminToken,
    body: { supplierId: supplier.id, items: [{ productId: product.id, quantity: 2, unitCost: 11 }] },
  });
  const list = await req('GET', '/api/purchases', { token: adminToken, query: { supplierId: supplier.id, page: 1, limit: 10 } });
  assert.equal(list.status, 200);
  assert.equal(list.body.purchases.length >= 1, true);
  assert.equal(list.body.purchases.every((p) => p.supplier.id === supplier.id), true);
  assert.equal(list.body.total >= 1, true);
});

// route access tests

test('11 unauthenticated requests are rejected', async () => {
  const res = await req('GET', '/api/purchases');
  assert.equal(res.status, 401);
});

test('12 invalid route ids are handled correctly', async () => {
  const supplier = await createSupplier({ name: 'Bad Id Supplier', phone: '+2000000011' });
  const res = await req('POST', `/api/suppliers/${supplier.id}/payment`, { token: adminToken, body: { amount: 'bad' } });
  assert.equal(res.status, 400);
  const res2 = await req('GET', '/api/purchases/abc', { token: adminToken });
  assert.equal(res2.status, 400);
});
