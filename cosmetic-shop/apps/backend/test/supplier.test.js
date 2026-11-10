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

before(async () => {
  ctx = await createTempDb({ prefix: 'suppliers-', backendDir });
  const { dbUrl, realTmp } = ctx;
  assertTmpDbUrl(dbUrl, realTmp);
  const db = await import(backendUrl + 'src/db/prisma.js');
  prisma = db.prisma;
  assert.equal(process.env.DATABASE_URL, dbUrl);
  app = (await import(backendUrl + 'src/app.js')).createApp();
  const admin = await createUser(prisma, { role: 'ADMIN', tag: 'supplier-admin' });
  adminToken = signToken(admin);
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

async function createCategory() {
  return prisma.category.create({
    data: { name: `Supplier Cat ${Date.now()}-${Math.random().toString(16).slice(2,6)}`, type: 'COSMETIC' },
  });
}

async function createBrand() {
  return prisma.brand.create({
    data: { name: `Supplier Brand ${Date.now()}-${Math.random().toString(16).slice(2,6)}` },
  });
}

async function createProduct(overrides = {}) {
  const category = await createCategory();
  const brand = await createBrand();
  return prisma.product.create({
    data: {
      sku: `SUP-${Date.now()}-${Math.random().toString(16).slice(2,8)}`,
      name: 'Supplier Product',
      type: 'COSMETIC',
      costPrice: 10,
      sellPrice: 20,
      stock: 10,
      categoryId: category.id,
      brandId: brand.id,
      ...overrides,
    },
  });
}

async function createSupplierRecord(overrides = {}) {
  return prisma.supplier.create({ data: { name: 'Acme', phone: '+123', email: 'acme@example.com', ...overrides } });
}

test('1 create supplier successfully', async () => {
  const res = await req('POST', '/api/suppliers', {
    token: adminToken,
    body: { name: 'Alpha Supplier', phone: '+1000000001', email: 'alpha@example.com', address: 'Main St', notes: 'Preferred' },
  });
  assert.equal(res.status, 201);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.supplier.name, 'Alpha Supplier');
  assert.equal(Number(res.body.supplier.balance), 0);
  const row = await prisma.supplier.findUnique({ where: { id: res.body.supplier.id } });
  assert.ok(row);
  assert.equal(Number(row.balance), 0);
});

test('2 reject missing supplier name', async () => {
  const res = await req('POST', '/api/suppliers', {
    token: adminToken,
    body: { phone: '+1000000002' },
  });
  assert.equal(res.status, 400);
});

test('3 list suppliers with pagination and search', async () => {
  await prisma.supplier.createMany({ data: [
    { name: 'Beta Supplier', phone: '+1000000003', email: 'beta@example.com', balance: 0 },
    { name: 'Gamma Supplier', phone: '+1000000004', email: 'gamma@example.com', balance: 0 },
    { name: 'Omega Supplier', phone: '+1000000005', email: 'omega@example.com', balance: 0 },
  ] });

  const all = await req('GET', '/api/suppliers', { token: adminToken, query: { page: 1, limit: 2 } });
  assert.equal(all.status, 200);
  assert.equal(all.body.suppliers.length, 2);
  assert.equal(all.body.total >= 2, true);
  const search = await req('GET', '/api/suppliers', { token: adminToken, query: { page: 1, limit: 10, search: 'Gamma' } });
  assert.equal(search.status, 200);
  assert.equal(search.body.suppliers.length, 1);
  assert.equal(search.body.suppliers[0].name, 'Gamma Supplier');
});

test('4 reject payment for nonexistent supplier', async () => {
  const res = await req('POST', '/api/suppliers/999999/payment', {
    token: adminToken,
    body: { amount: 10 },
  });
  assert.equal(res.status, 404);
});

test('5 reject zero or negative payment', async () => {
  const supplier = await createSupplierRecord({ name: 'Zero Payment', phone: '+1000000006', balance: 100 });
  const zero = await req('POST', `/api/suppliers/${supplier.id}/payment`, { token: adminToken, body: { amount: 0 } });
  const neg = await req('POST', `/api/suppliers/${supplier.id}/payment`, { token: adminToken, body: { amount: -1 } });
  assert.equal(zero.status, 400);
  assert.equal(neg.status, 400);
  const row = await prisma.supplier.findUnique({ where: { id: supplier.id } });
  assert.equal(Number(row.balance), 100);
});

test('6 reject payment when supplier balance is zero', async () => {
  const supplier = await createSupplierRecord({ name: 'No Balance', phone: '+1000000007', balance: 0 });
  const res = await req('POST', `/api/suppliers/${supplier.id}/payment`, { token: adminToken, body: { amount: 50 } });
  assert.equal(res.status, 400);
});

test('7 reject payment greater than supplier balance', async () => {
  const supplier = await createSupplierRecord({ name: 'Overpay', phone: '+1000000008', balance: 50 });
  const before = await prisma.supplierPayment.count({ where: { supplierId: supplier.id } });
  const res = await req('POST', `/api/suppliers/${supplier.id}/payment`, { token: adminToken, body: { amount: 60 } });
  assert.equal(res.status, 400);
  assert.equal(await prisma.supplierPayment.count({ where: { supplierId: supplier.id } }), before);
  const row = await prisma.supplier.findUnique({ where: { id: supplier.id } });
  assert.equal(Number(row.balance), 50);
});

test('8 record a payment below outstanding balance', async () => {
  const supplier = await createSupplierRecord({ name: 'Partial Pay', phone: '+1000000009', balance: 0 });
  const category = await createCategory();
  const brand = await createBrand();
  const productA = await prisma.product.create({
    data: { sku: `SPA-${Date.now()}-${Math.random().toString(16).slice(2,8)}`, name: 'Product A', type: 'COSMETIC', costPrice: 10, sellPrice: 25, stock: 5, categoryId: category.id, brandId: brand.id },
  });
  const productB = await prisma.product.create({
    data: { sku: `SPB-${Date.now()}-${Math.random().toString(16).slice(2,8)}`, name: 'Product B', type: 'COSMETIC', costPrice: 20, sellPrice: 40, stock: 5, categoryId: category.id, brandId: brand.id },
  });

  const first = await prisma.purchase.create({
    data: {
      supplierId: supplier.id,
      totalAmount: 100,
      paidAmount: 0,
      status: 'UNPAID',
      items: { create: [{ productId: productA.id, quantity: 5, unitCost: 10, total: 50 }, { productId: productB.id, quantity: 2, unitCost: 20, total: 40 }] },
    },
  });

  const second = await prisma.purchase.create({
    data: {
      supplierId: supplier.id,
      totalAmount: 200,
      paidAmount: 0,
      status: 'UNPAID',
      items: { create: [{ productId: productA.id, quantity: 10, unitCost: 20, total: 200 }] },
    },
  });

  await prisma.supplier.update({ where: { id: supplier.id }, data: { balance: 300 } });
  const res = await req('POST', `/api/suppliers/${supplier.id}/payment`, { token: adminToken, body: { amount: 120 } });
  assert.equal(res.status, 201);
  assert.equal(res.body.payment.amount, 120);
  const updatedSupplier = await prisma.supplier.findUnique({ where: { id: supplier.id } });
  assert.equal(Number(updatedSupplier.balance), 180);
  const allocations = await prisma.supplierPaymentAllocation.findMany({ where: { supplierPaymentId: res.body.payment.id }, orderBy: { id: 'asc' } });
  assert.equal(allocations.reduce((sum, row) => sum + Number(row.amount), 0), 120);

  const firstPurchase = await prisma.purchase.findUnique({ where: { id: first.id } });
  const secondPurchase = await prisma.purchase.findUnique({ where: { id: second.id } });
  assert.equal(firstPurchase.status, 'PAID');
  assert.equal(secondPurchase.status, 'PARTIAL');
  assert.equal(Number(firstPurchase.paidAmount), 100);
  assert.equal(Number(secondPurchase.paidAmount), 20);
});
