import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { createTempDb, assertTmpDbUrl } from '../test-support/tempDb.js';
import { createUser, signToken } from '../test-support/auth.js';

const backendDir = path.resolve(import.meta.dirname, '..');
const backendUrl = pathToFileURL(backendDir + path.sep).href;

let testPrisma;
let app;
let adminToken;

let seq = 0;
function nextSeq() { return ++seq; }

function uuid() {
  return crypto.randomUUID();
}

function doReq(method, full, tok, payload, idempotencyKey) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      const headers = { Accept: 'application/json' };
      if (payload !== null) {
        headers['Content-Type'] = 'application/json';
        headers['Content-Length'] = Buffer.byteLength(payload);
      }
      if (tok) headers.Authorization = 'Bearer ' + tok;
      if (idempotencyKey !== undefined) headers['Idempotency-Key'] = idempotencyKey;
      const r = http.request({ host: '127.0.0.1', port, path: full, method, headers }, (res) => {
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

function req(method, urlPath, opts = {}) {
  const payload = opts.body === undefined ? null : JSON.stringify(opts.body);
  return doReq(method, urlPath, opts.token, payload, opts.idempotencyKey);
}

before(async () => {
  const ctx = await createTempDb({ prefix: 'idempotency-', backendDir });
  const { dbUrl, realTmp } = ctx;
  assertTmpDbUrl(dbUrl, realTmp);
  const db = await import(backendUrl + 'src/db/prisma.js');
  testPrisma = db.prisma;
  assert.equal(process.env.DATABASE_URL, dbUrl);
  app = (await import(backendUrl + 'src/app.js')).createApp();
  const admin = await createUser(testPrisma, { role: 'ADMIN', tag: 'idempotency-admin' });
  adminToken = signToken(admin);
  globalThis.__idempotencyCtx = ctx;
});

after(async () => {
  if (testPrisma) {
    try { await testPrisma.$disconnect(); } catch {}
  }
  const ctx = globalThis.__idempotencyCtx;
  if (ctx) ctx.cleanup();
});

async function createCustomer(overrides = {}) {
  const { balance, ...rest } = overrides;
  const res = await req('POST', '/api/customers', {
    token: adminToken,
    body: { name: 'Idem Customer', phone: `+1${Date.now()}${Math.floor(Math.random() * 1000)}`, ...rest },
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  let customer = res.body.customer;
  if (balance !== undefined) {
    customer = await testPrisma.customer.update({ where: { id: customer.id }, data: { balance } });
  }
  return customer;
}

async function createSupplierWithBalance(balance = 1000) {
  const res = await req('POST', '/api/suppliers', {
    token: adminToken,
    body: { name: 'Idem Supplier', phone: `+1${Date.now()}${Math.floor(Math.random() * 1000)}` },
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return testPrisma.supplier.update({ where: { id: res.body.supplier.id }, data: { balance } });
}

async function createProduct() {
  const category = await testPrisma.category.create({
    data: { name: `IdemCat-${nextSeq()}`, type: 'COSMETIC' },
  });
  const brand = await testPrisma.brand.create({ data: { name: `IdemBrand-${nextSeq()}` } });
  return testPrisma.product.create({
    data: {
      sku: `IDEM-${nextSeq()}`,
      name: 'Idem Product',
      type: 'COSMETIC',
      costPrice: 5,
      sellPrice: 10,
      stock: 100,
      categoryId: category.id,
      brandId: brand.id,
    },
  });
}

// Create a purchase for the supplier so supplier payments have purchases to
// allocate against (supplier payment requires remainingPaisa to reach 0).
async function createPurchaseForSupplier(supplierId, totalAmount = 200) {
  const product = await createProduct();
  const body = { supplierId, items: [{ productId: product.id, quantity: 2, unitCost: totalAmount / 2 }] };
  const res = await req('POST', '/api/purchases', { token: adminToken, body });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.purchase;
}

// ---------------------------------------------------------------------------
// Sales
// ---------------------------------------------------------------------------

test('sales: sequential duplicate idempotency key returns same record, one sale', async () => {
  const customer = await createCustomer({ balance: 1000 });
  const product = await createProduct();
  const key = uuid();
  const body = { paymentMethod: 'KHATA', customerId: customer.id, discount: 0, items: [{ productId: product.id, quantity: 2, unitPrice: 10 }] };

  const first = await req('POST', '/api/sales', { token: adminToken, body, idempotencyKey: key });
  assert.equal(first.status, 201, JSON.stringify(first.body));
  const firstId = first.body.sale.id;

  const second = await req('POST', '/api/sales', { token: adminToken, body, idempotencyKey: key });
  assert.equal(second.status, 201, JSON.stringify(second.body));
  assert.equal(second.body.sale.id, firstId, 'duplicate must return the original sale id');

  const sales = await testPrisma.sale.count({ where: { idempotencyKey: key } });
  assert.equal(sales, 1, 'exactly one sale row must exist');
  const stockAfter = await testPrisma.product.findUnique({ where: { id: product.id } });
  assert.equal(stockAfter.stock, 98, 'stock must be decremented exactly once');
  const ledger = await testPrisma.khataTransaction.count({ where: { customerId: customer.id, type: 'SALE' } });
  assert.equal(ledger, 1, 'exactly one SALE ledger row must exist');
});

test('sales: concurrent duplicate idempotency keys all return same record, one sale', async () => {
  const customer = await createCustomer({ balance: 1000 });
  const product = await createProduct();
  const key = uuid();
  const body = { paymentMethod: 'KHATA', customerId: customer.id, discount: 0, items: [{ productId: product.id, quantity: 1, unitPrice: 10 }] };

  const results = await Promise.all(Array.from({ length: 5 }, () =>
    req('POST', '/api/sales', { token: adminToken, body, idempotencyKey: key })));

  const ids = results.map((r) => r.body.sale.id);
  assert.ok(ids.every((id) => id === ids[0]), 'all concurrent responses must return the same sale id');
  assert.equal(results.every((r) => r.status === 201), true, 'all concurrent requests must succeed');

  const sales = await testPrisma.sale.count({ where: { idempotencyKey: key } });
  assert.equal(sales, 1, 'exactly one sale row must exist');
  const allocations = await testPrisma.paymentAllocation.count();
  assert.equal(allocations, 0, 'no payment allocations for a sale with no payments');
});

test('sales: invalid idempotency key returns 400 and creates nothing', async () => {
  const customer = await createCustomer({ balance: 1000 });
  const product = await createProduct();
  const body = { paymentMethod: 'KHATA', customerId: customer.id, discount: 0, items: [{ productId: product.id, quantity: 1, unitPrice: 10 }] };

  const res = await req('POST', '/api/sales', { token: adminToken, body, idempotencyKey: 'not-a-uuid' });
  assert.equal(res.status, 400, JSON.stringify(res.body));

  const sales = await testPrisma.sale.count({ where: { customerId: customer.id } });
  assert.equal(sales, 0, 'no sale must be created for an invalid key');
  const stockAfter = await testPrisma.product.findUnique({ where: { id: product.id } });
  assert.equal(stockAfter.stock, 100, 'stock must be unchanged');
});

test('sales: missing idempotency key continues to work (backward compatible)', async () => {
  const customer = await createCustomer({ balance: 1000 });
  const product = await createProduct();
  const body = { paymentMethod: 'KHATA', customerId: customer.id, discount: 0, items: [{ productId: product.id, quantity: 1, unitPrice: 10 }] };

  const first = await req('POST', '/api/sales', { token: adminToken, body });
  assert.equal(first.status, 201, JSON.stringify(first.body));
  const firstId = first.body.sale.id;

  const second = await req('POST', '/api/sales', { token: adminToken, body });
  assert.equal(second.status, 201, JSON.stringify(second.body));
  assert.notEqual(second.body.sale.id, firstId, 'without a key, a second sale is a new record');
  const count = await testPrisma.sale.count({ where: { customerId: customer.id } });
  assert.equal(count, 2, 'two sales without keys must both exist');
});

// ---------------------------------------------------------------------------
// Customer payments
// ---------------------------------------------------------------------------

test('customer payment: sequential duplicate idempotency key returns same record', async () => {
  const customer = await createCustomer({ type: 'RETAIL', balance: 100 });
  const key = uuid();

  const first = await req('POST', `/api/customers/${customer.id}/payment`, {
    token: adminToken, body: { amount: 30, description: 'p' }, idempotencyKey: key });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  const firstId = first.body.transaction.id;

  const second = await req('POST', `/api/customers/${customer.id}/payment`, {
    token: adminToken, body: { amount: 30, description: 'p' }, idempotencyKey: key });
  assert.equal(second.status, 200, JSON.stringify(second.body));
  assert.equal(second.body.transaction.id, firstId, 'duplicate must return the original transaction id');

  const payments = await testPrisma.khataTransaction.count({
    where: { customerId: customer.id, type: 'PAYMENT', idempotencyKey: key },
  });
  assert.equal(payments, 1, 'exactly one PAYMENT ledger row must exist');
  const after = await testPrisma.customer.findUnique({ where: { id: customer.id } });
  assert.equal(Number(after.balance), 70, 'balance must be decremented exactly once');
});

test('customer payment: concurrent duplicate idempotency keys all return same record', async () => {
  const customer = await createCustomer({ type: 'RETAIL', balance: 100 });
  const key = uuid();

  const results = await Promise.all(Array.from({ length: 5 }, () =>
    req('POST', `/api/customers/${customer.id}/payment`, {
      token: adminToken, body: { amount: 30, description: 'p' }, idempotencyKey: key })));

  const ids = results.map((r) => r.body.transaction.id);
  assert.ok(ids.every((id) => id === ids[0]), 'all concurrent responses must return the same transaction id');
  assert.ok(results.every((r) => r.status === 200), 'all concurrent requests must succeed');

  const payments = await testPrisma.khataTransaction.count({
    where: { customerId: customer.id, type: 'PAYMENT', idempotencyKey: key },
  });
  assert.equal(payments, 1, 'exactly one PAYMENT ledger row must exist');
  const allocations = await testPrisma.paymentAllocation.count();
  assert.equal(allocations, 0, 'no allocations must be duplicated');
});

test('customer payment: invalid idempotency key returns 400 and creates nothing', async () => {
  const customer = await createCustomer({ type: 'RETAIL', balance: 100 });

  const res = await req('POST', `/api/customers/${customer.id}/payment`, {
    token: adminToken, body: { amount: 10, description: 'p' }, idempotencyKey: 'bad-key' });
  assert.equal(res.status, 400, JSON.stringify(res.body));

  const payments = await testPrisma.khataTransaction.count({ where: { customerId: customer.id, type: 'PAYMENT' } });
  assert.equal(payments, 0, 'no payment must be created for an invalid key');
  const after = await testPrisma.customer.findUnique({ where: { id: customer.id } });
  assert.equal(Number(after.balance), 100, 'balance must be unchanged');
});

test('customer payment: missing idempotency key continues to work', async () => {
  const customer = await createCustomer({ type: 'RETAIL', balance: 100 });

  const first = await req('POST', `/api/customers/${customer.id}/payment`, {
    token: adminToken, body: { amount: 10, description: 'p' } });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  const firstId = first.body.transaction.id;

  const second = await req('POST', `/api/customers/${customer.id}/payment`, {
    token: adminToken, body: { amount: 10, description: 'p' } });
  assert.equal(second.status, 200, JSON.stringify(second.body));
  assert.notEqual(second.body.transaction.id, firstId, 'without a key, a second payment is a new record');
  const count = await testPrisma.khataTransaction.count({ where: { customerId: customer.id, type: 'PAYMENT' } });
  assert.equal(count, 2, 'two payments without keys must both exist');
});

// ---------------------------------------------------------------------------
// Purchases
// ---------------------------------------------------------------------------

test('purchase: sequential duplicate idempotency key returns same record', async () => {
  const supplier = await createSupplierWithBalance(0);
  const product = await createProduct();
  const key = uuid();
  const body = { supplierId: supplier.id, items: [{ productId: product.id, quantity: 5, unitCost: 10 }] };

  const first = await req('POST', '/api/purchases', { token: adminToken, body, idempotencyKey: key });
  assert.equal(first.status, 201, JSON.stringify(first.body));
  const firstId = first.body.purchase.id;

  const second = await req('POST', '/api/purchases', { token: adminToken, body, idempotencyKey: key });
  assert.equal(second.status, 201, JSON.stringify(second.body));
  assert.equal(second.body.purchase.id, firstId, 'duplicate must return the original purchase id');

  const purchases = await testPrisma.purchase.count({ where: { idempotencyKey: key } });
  assert.equal(purchases, 1, 'exactly one purchase row must exist');
  const stockAfter = await testPrisma.product.findUnique({ where: { id: product.id } });
  assert.equal(stockAfter.stock, 105, 'stock must be incremented exactly once (100 + 5)');
  const supplierAfter = await testPrisma.supplier.findUnique({ where: { id: supplier.id } });
  assert.equal(Number(supplierAfter.balance), 50, 'supplier payable must be incremented exactly once');
});

test('purchase: concurrent duplicate idempotency keys all return same record', async () => {
  const supplier = await createSupplierWithBalance(0);
  const product = await createProduct();
  const key = uuid();
  const body = { supplierId: supplier.id, items: [{ productId: product.id, quantity: 3, unitCost: 10 }] };

  const results = await Promise.all(Array.from({ length: 5 }, () =>
    req('POST', '/api/purchases', { token: adminToken, body, idempotencyKey: key })));

  const ids = results.map((r) => r.body.purchase.id);
  assert.ok(ids.every((id) => id === ids[0]), 'all concurrent responses must return the same purchase id');
  assert.ok(results.every((r) => r.status === 201), 'all concurrent requests must succeed');

  const purchases = await testPrisma.purchase.count({ where: { idempotencyKey: key } });
  assert.equal(purchases, 1, 'exactly one purchase row must exist');
  const stockAfter = await testPrisma.product.findUnique({ where: { id: product.id } });
  assert.equal(stockAfter.stock, 103, 'stock must be incremented exactly once');
});

test('purchase: invalid idempotency key returns 400 and creates nothing', async () => {
  const supplier = await createSupplierWithBalance(0);
  const product = await createProduct();
  const body = { supplierId: supplier.id, items: [{ productId: product.id, quantity: 2, unitCost: 10 }] };

  const res = await req('POST', '/api/purchases', { token: adminToken, body, idempotencyKey: 'not-a-uuid' });
  assert.equal(res.status, 400, JSON.stringify(res.body));

  const purchases = await testPrisma.purchase.count({ where: { supplierId: supplier.id } });
  assert.equal(purchases, 0, 'no purchase must be created for an invalid key');
  const stockAfter = await testPrisma.product.findUnique({ where: { id: product.id } });
  assert.equal(stockAfter.stock, 100, 'stock must be unchanged');
});

test('purchase: missing idempotency key continues to work', async () => {
  const supplier = await createSupplierWithBalance(0);
  const product = await createProduct();
  const body = { supplierId: supplier.id, items: [{ productId: product.id, quantity: 2, unitCost: 10 }] };

  const first = await req('POST', '/api/purchases', { token: adminToken, body });
  assert.equal(first.status, 201, JSON.stringify(first.body));
  const firstId = first.body.purchase.id;

  const second = await req('POST', '/api/purchases', { token: adminToken, body });
  assert.equal(second.status, 201, JSON.stringify(second.body));
  assert.notEqual(second.body.purchase.id, firstId, 'without a key, a second purchase is a new record');
  const count = await testPrisma.purchase.count({ where: { supplierId: supplier.id } });
  assert.equal(count, 2, 'two purchases without keys must both exist');
});

// ---------------------------------------------------------------------------
// Supplier payments
// ---------------------------------------------------------------------------

test('supplier payment: sequential duplicate idempotency key returns same record', async () => {
  const supplier = await createSupplierWithBalance(500);
  await createPurchaseForSupplier(supplier.id, 200);
  const key = uuid();

  const first = await req('POST', `/api/suppliers/${supplier.id}/payment`, {
    token: adminToken, body: { amount: 120, description: 'p' }, idempotencyKey: key });
  assert.equal(first.status, 201, JSON.stringify(first.body));
  const firstId = first.body.payment.id;

  const second = await req('POST', `/api/suppliers/${supplier.id}/payment`, {
    token: adminToken, body: { amount: 120, description: 'p' }, idempotencyKey: key });
  assert.equal(second.status, 201, JSON.stringify(second.body));
  assert.equal(second.body.payment.id, firstId, 'duplicate must return the original payment id');

  const payments = await testPrisma.supplierPayment.count({ where: { supplierId: supplier.id, idempotencyKey: key } });
  assert.equal(payments, 1, 'exactly one supplier payment row must exist');
  const after = await testPrisma.supplier.findUnique({ where: { id: supplier.id } });
  assert.equal(Number(after.balance), 580, 'supplier balance must be purchase minus payment exactly once');
});

test('supplier payment: concurrent duplicate idempotency keys all return same record', async () => {
  const supplier = await createSupplierWithBalance(500);
  await createPurchaseForSupplier(supplier.id, 200);
  const key = uuid();

  const results = await Promise.all(Array.from({ length: 5 }, () =>
    req('POST', `/api/suppliers/${supplier.id}/payment`, {
      token: adminToken, body: { amount: 120, description: 'p' }, idempotencyKey: key })));

  const ids = results.map((r) => r.body.payment.id);
  assert.ok(ids.every((id) => id === ids[0]), 'all concurrent responses must return the same payment id');
  assert.ok(results.every((r) => r.status === 201), 'all concurrent requests must succeed');

  const payments = await testPrisma.supplierPayment.count({ where: { supplierId: supplier.id, idempotencyKey: key } });
  assert.equal(payments, 1, 'exactly one supplier payment row must exist');
  const after = await testPrisma.supplier.findUnique({ where: { id: supplier.id } });
  assert.equal(Number(after.balance), 580, 'supplier balance must be purchase minus payment exactly once');
});

test('supplier payment: invalid idempotency key returns 400 and creates nothing', async () => {
  const supplier = await createSupplierWithBalance(500);

  const res = await req('POST', `/api/suppliers/${supplier.id}/payment`, {
    token: adminToken, body: { amount: 10, description: 'p' }, idempotencyKey: 'bad-key' });
  assert.equal(res.status, 400, JSON.stringify(res.body));

  const payments = await testPrisma.supplierPayment.count({ where: { supplierId: supplier.id } });
  assert.equal(payments, 0, 'no supplier payment must be created for an invalid key');
  const after = await testPrisma.supplier.findUnique({ where: { id: supplier.id } });
  assert.equal(Number(after.balance), 500, 'supplier balance must be unchanged');
});

test('supplier payment: missing idempotency key continues to work', async () => {
  const supplier = await createSupplierWithBalance(500);
  await createPurchaseForSupplier(supplier.id, 200);

  const first = await req('POST', `/api/suppliers/${supplier.id}/payment`, {
    token: adminToken, body: { amount: 10, description: 'p' } });
  assert.equal(first.status, 201, JSON.stringify(first.body));
  const firstId = first.body.payment.id;

  const second = await req('POST', `/api/suppliers/${supplier.id}/payment`, {
    token: adminToken, body: { amount: 10, description: 'p' } });
  assert.equal(second.status, 201, JSON.stringify(second.body));
  assert.notEqual(second.body.payment.id, firstId, 'without a key, a second payment is a new record');
  const count = await testPrisma.supplierPayment.count({ where: { supplierId: supplier.id } });
  assert.equal(count, 2, 'two supplier payments without keys must both exist');
});
