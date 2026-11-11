// Task 4: Money math tests.
// - toPaisa/fromPaisa/add/subtract/multiply avoid float residue
// - moneyAmount()/withTwoDecimals() reject >2 decimal places
// - Schema rejection of 100.123
// - FIFO allocation and balance precision
//
// Uses throwaway SQLite files under os.tmpdir() via test-support/tempDb.js.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import http from 'node:http';
import jwt from 'jsonwebtoken';
import { createTempDb, assertTmpDbUrl } from '../test-support/tempDb.js';
import { createUser, signToken } from '../test-support/auth.js';

const backendDir = path.resolve(import.meta.dirname, '..');
const ctx = await createTempDb({ prefix: 'money-', backendDir });
const { dbUrl, realTmp } = ctx;
process.env.JWT_SECRET = 'test-jwt-secret-that-is-long-enough-0123456789';
process.env.NODE_ENV = 'test';

let prisma;
let app;
let adminToken;

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
        res.on('end', () => { server.close(); resolve({ status: res.statusCode, body: tryJson(data) }); });
      });
      r.on('error', (e) => { server.close(); reject(e); });
      if (payload !== null) r.write(payload);
      r.end();
    });
  });
}
function tryJson(data) { try { return data ? JSON.parse(data) : null; } catch { return { _raw: data }; } }

before(async () => {
  assertTmpDbUrl(dbUrl, realTmp);
  assert.equal(process.env.DATABASE_URL, dbUrl);
  const db = await import('../src/db/prisma.js');
  prisma = db.prisma;
  const { createApp } = await import('../src/app.js');
  app = createApp();

  // Seed an admin user + token
  const { hashPassword } = await import('../src/utils/password.js');
  const admin = await prisma.user.create({
    data: { name: 'Admin', email: `money-admin-${Date.now()}@shop.local`, password: await hashPassword('AdminPass-12345-Long'), role: 'ADMIN', isActive: true },
  });
  adminToken = jwt.sign({ userId: admin.id, role: admin.role, tokenVersion: admin.tokenVersion }, process.env.JWT_SECRET, { algorithm: 'HS256' });
});

after(async () => {
  if (prisma) { try { await prisma.$disconnect(); } catch {} }
  ctx.cleanup();
});

async function createCustomer(name = 'Money Customer') {
  return prisma.customer.create({
    data: { name, phone: `+92300${Date.now()}${Math.floor(Math.random() * 1000)}`, type: 'RETAIL' },
  });
}

async function createProduct(name = 'Money Product', cost = 50, price = 100) {
  let category = await prisma.category.findFirst({ where: { name: 'Money Test Cat' } });
  if (!category) {
    category = await prisma.category.create({ data: { name: 'Money Test Cat', type: 'COSMETIC' } });
  }
  return prisma.product.create({
    data: { sku: `MONEY-${Date.now()}-${Math.floor(Math.random() * 10000)}`, name, type: 'COSMETIC', costPrice: cost, sellPrice: price, stock: 1000, lowStockAt: 5, categoryId: category.id },
  });
}

// ---- Test 1: 33.33 + 33.33 + 33.34 against 100.00 sale leaves exactly 0 ----
test('three payments of 33.33/33.33/33.34 fully clear a 100.00 khata sale', async () => {
  const customer = await createCustomer();
  const product = await createProduct();

  // Create a 100.00 KHATA sale
  const saleRes = await call('POST', '/api/sales', {
    token: adminToken,
    body: {
      paymentMethod: 'KHATA',
      customerId: customer.id,
      items: [{ productId: product.id, quantity: 1, unitPrice: 100.00 }],
    },
  });
  assert.equal(saleRes.status, 201, JSON.stringify(saleRes.body));
  const saleId = saleRes.body.sale.id;

  // Verify customer balance = 100
  const custAfterSale = await prisma.customer.findUnique({ where: { id: customer.id } });
  assert.equal(custAfterSale.balance, 100, `Expected balance 100 after sale, got ${custAfterSale.balance}`);

  // Payment 1: 33.33
  await call('POST', `/api/customers/${customer.id}/payment`, {
    token: adminToken,
    body: { amount: 33.33, description: 'partial' },
  });

  // Payment 2: 33.33
  await call('POST', `/api/customers/${customer.id}/payment`, {
    token: adminToken,
    body: { amount: 33.33, description: 'partial' },
  });

  // Payment 3: 33.34 -> should clear exactly
  const p3 = await call('POST', `/api/customers/${customer.id}/payment`, {
    token: adminToken,
    body: { amount: 33.34, description: 'final' },
  });
  assert.ok(p3.status === 200 || p3.status === 201, JSON.stringify(p3.body));

  // Balance must be exactly 0 (0 paisa)
  const cust = await prisma.customer.findUnique({ where: { id: customer.id } });
  assert.equal(cust.balance, 0, `Expected balance 0, got ${cust.balance}`);

  // Sale fully recognized
  const updatedSale = await prisma.sale.findUnique({ where: { id: saleId } });
  assert.equal(updatedSale.recognizedAmount, 100, `Expected recognized 100, got ${updatedSale.recognizedAmount}`);
});

// ---- Test 2: Schema rejects >2 decimal places ----
test('moneyAmount rejects 100.123 (>2 decimal places)', async () => {
  const { createSaleSchema } = await import('../src/schemas/sale.schema.js');
  assert.throws(() => createSaleSchema.parse({
    paymentMethod: 'CASH',
    items: [{ productId: 1, quantity: 1, unitPrice: 100.123 }],
  }), /Amount can have at most 2 decimal places/);
});

test('moneyAmount accepts 100.12 (exactly 2 decimal places)', async () => {
  const { createSaleSchema } = await import('../src/schemas/sale.schema.js');
  const parsed = createSaleSchema.parse({
    paymentMethod: 'CASH',
    items: [{ manualName: 'Test', quantity: 1, unitPrice: 100.12 }],
  });
  assert.equal(parsed.items[0].unitPrice, 100.12);
});

// ---- Test 3: 100 payments of 0.01 against 1.00 balance -> exactly 0 ----
test('100 payments of 0.01 leave exactly 0 balance (no 1e-13 residue)', async () => {
  const customer = await createCustomer('Residue Customer');

  // Create a 1.00 KHATA sale (manual item)
  const saleRes = await call('POST', '/api/sales', {
    token: adminToken,
    body: {
      paymentMethod: 'KHATA',
      customerId: customer.id,
      items: [{ manualName: 'Residue item', quantity: 1, unitPrice: 1.00 }],
    },
  });
  assert.equal(saleRes.status, 201, JSON.stringify(saleRes.body));

  // 100 payments of 0.01
  for (let i = 0; i < 100; i += 1) {
    const res = await call('POST', `/api/customers/${customer.id}/payment`, {
      token: adminToken,
      body: { amount: 0.01, description: `payment ${i + 1}` },
    });
    assert.ok(res.status === 200 || res.status === 201, `Payment ${i + 1} failed: ${JSON.stringify(res.body)}`);
  }

  const cust = await prisma.customer.findUnique({ where: { id: customer.id } });
  assert.equal(cust.balance, 0, `Expected balance 0 after 100x0.01, got ${cust.balance}`);
});

// ---- Test 4: FIFO allocation ----
test('FIFO allocation: three KHATA sales then one 100.00 payment', async () => {
  const customer = await createCustomer('FIFO Customer');
  const product = await createProduct();

  // Three KHATA sales: 33.33, 33.33, 33.34 (oldest first)
  const sales = [];
  for (const price of [33.33, 33.33, 33.34]) {
    const res = await call('POST', '/api/sales', {
      token: adminToken,
      body: {
        paymentMethod: 'KHATA',
        customerId: customer.id,
        items: [{ productId: product.id, quantity: 1, unitPrice: price }],
      },
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    sales.push(res.body);
  }
  assert.equal(sales.length, 3);

  // One payment of 100.00
  const payRes = await call('POST', `/api/customers/${customer.id}/payment`, {
    token: adminToken,
    body: { amount: 100.00, description: 'fifo clear' },
  });
  assert.ok(payRes.status === 200 || payRes.status === 201, JSON.stringify(payRes.body));

  // Fetch sales in creation order
  const fetched = await prisma.sale.findMany({
    where: { customerId: customer.id, paymentMethod: 'KHATA' },
    orderBy: { createdAt: 'asc' },
  });
  assert.equal(fetched.length, 3);

  // sale1.recognized = 33.33, sale2.recognized = 33.33, sale3.recognized = 33.34
  assert.equal(fetched[0].recognizedAmount, 33.33, `sale1 recognized: ${fetched[0].recognizedAmount}`);
  assert.equal(fetched[1].recognizedAmount, 33.33, `sale2 recognized: ${fetched[1].recognizedAmount}`);
  assert.equal(fetched[2].recognizedAmount, 33.34, `sale3 recognized: ${fetched[2].recognizedAmount}`);

  // Customer balance = 0
  const cust = await prisma.customer.findUnique({ where: { id: customer.id } });
  assert.equal(cust.balance, 0, `Expected balance 0, got ${cust.balance}`);
});

// ---- moneyAmount unit checks ----
test('toPaisa/fromPaisa round-trip', async () => {
  const { toPaisa, fromPaisa, add, subtract, multiply } = await import('../src/utils/money.js');
  assert.equal(toPaisa(100.00), 10000);
  assert.equal(fromPaisa(10000), 100);
  assert.equal(add(33.33, 33.33), 66.66);
  assert.equal(add(33.33, add(33.33, 33.34)), 100);
  assert.equal(subtract(100, 33.33), 66.67);
  assert.equal(multiply(100.00, 3), 300);
  assert.equal(multiply(33.33, 3), 99.99);
});
