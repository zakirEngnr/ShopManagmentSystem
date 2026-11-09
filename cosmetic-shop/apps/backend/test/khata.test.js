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
  ctx = await createTempDb({ prefix: 'khata-', backendDir });
  const { dbUrl, realTmp } = ctx;
  assertTmpDbUrl(dbUrl, realTmp);
  const db = await import(backendUrl + 'src/db/prisma.js');
  prisma = db.prisma;
  assert.equal(process.env.DATABASE_URL, dbUrl);
  app = (await import(backendUrl + 'src/app.js')).createApp();
  const admin = await createUser(prisma, { role: 'ADMIN', tag: 'khata-admin' });
  adminToken = signToken(admin);
  categoryId = (await prisma.category.create({ data: { name: 'Khata Category', type: 'COSMETIC' } })).id;
  brandId = (await prisma.brand.create({ data: { name: 'Khata Brand' } })).id;
});

after(async () => {
  if (prisma) {
    try {
      await prisma.$disconnect();
    } catch {}
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
      sku: `KHATA-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
      name: 'Khata Product',
      type: 'COSMETIC',
      costPrice: 5,
      sellPrice: 10,
      stock: 10,
      categoryId,
      brandId,
      ...overrides,
    },
  });
}

async function createCustomer(payload = {}) {
  return req('POST', '/api/customers', {
    token: adminToken,
    body: { name: 'Walk-in Customer', phone: `+1${Date.now()}`, ...payload },
  });
}

// ---------------------------------------------------------------------------
// Customer tests
// ---------------------------------------------------------------------------

test('1 create customer: returns 201 and database balance is zero', async () => {
  const res = await createCustomer({ name: 'Alice', phone: '+1111111111' });
  assert.equal(res.status, 201);
  assert.equal(res.body.ok, true);
  const row = await prisma.customer.findUnique({ where: { id: res.body.customer.id } });
  assert.ok(row);
  assert.equal(Number(row.balance), 0);
  assert.equal(row.name, 'Alice');
  assert.equal(row.phone, '+1111111111');
});

test('2 duplicate phone: returns 409', async () => {
  const first = await createCustomer({ name: 'Dup', phone: '+1222222222' });
  assert.equal(first.status, 201);
  const second = await createCustomer({ name: 'Dup2', phone: '+1222222222' });
  assert.equal(second.status, 409);
  assert.equal(await prisma.customer.count({ where: { phone: '+1222222222' } }), 1);
});

test('3 invalid email: returns 400', async () => {
  const res = await createCustomer({ name: 'Bob', phone: '+1333333333', email: 'not-an-email' });
  assert.equal(res.status, 400);
  assert.equal(await prisma.customer.count({ where: { name: 'Bob' } }), 0);
});

test('4 list customers: returns all customers ordered by name', async () => {
  await createCustomer({ name: 'Zara', phone: '+1444444444' });
  await createCustomer({ name: 'Amy', phone: '+1555555555' });
  await createCustomer({ name: 'Mia', phone: '+1666666666' });
  const res = await req('GET', '/api/customers', { token: adminToken });
  assert.equal(res.status, 200);
  const names = res.body.customers.map((c) => c.name);
  assert.deepEqual(names, names.slice().sort());
  assert.ok(names.includes('Amy') && names.includes('Mia') && names.includes('Zara'));
});

test('5 update customer: updates permitted profile fields', async () => {
  const created = await createCustomer({ name: 'Old', phone: '+1777777777', address: 'Old St' });
  const id = created.body.customer.id;
  const res = await req('PATCH', `/api/customers/${id}`, {
    token: adminToken,
    body: { name: 'New Name', address: 'New St', notes: 'VIP' },
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.customer.name, 'New Name');
  assert.equal(res.body.customer.address, 'New St');
  assert.equal(res.body.customer.notes, 'VIP');
  assert.equal(res.body.customer.phone, '+1777777777');
  const row = await prisma.customer.findUnique({ where: { id } });
  assert.equal(Number(row.balance), 0);
});

test('6 empty update body: returns 400', async () => {
  const created = await createCustomer({ name: 'Nope', phone: '+1888888888' });
  const res = await req('PATCH', `/api/customers/${created.body.customer.id}`, {
    token: adminToken,
    body: {},
  });
  assert.equal(res.status, 400);
});

test('7 updating balance directly through the API is rejected', async () => {
  const created = await createCustomer({ name: 'Rich', phone: '+1999999999' });
  const res = await req('PATCH', `/api/customers/${created.body.customer.id}`, {
    token: adminToken,
    body: { balance: 12345 },
  });
  assert.equal(res.status, 400);
  const row = await prisma.customer.findUnique({ where: { id: created.body.customer.id } });
  assert.equal(Number(row.balance), 0);
});

test('8 delete customer without transactions: succeeds', async () => {
  const created = await createCustomer({ name: 'Temp', phone: '+1000000001' });
  const id = created.body.customer.id;
  const res = await req('DELETE', `/api/customers/${id}`, { token: adminToken });
  assert.equal(res.status, 200);
  assert.equal(await prisma.customer.findUnique({ where: { id } }), null);
});

test('9 delete customer with transactions: returns 409', async () => {
  const created = await createCustomer({ name: 'Debtor', phone: '+1000000002' });
  const id = created.body.customer.id;
  await prisma.khataTransaction.create({
    data: { customerId: id, type: 'SALE', amount: 10, description: 'old debt' },
  });
  const res = await req('DELETE', `/api/customers/${id}`, { token: adminToken });
  assert.equal(res.status, 409);
  assert.ok(await prisma.customer.findUnique({ where: { id } }));
  assert.equal(await prisma.khataTransaction.count({ where: { customerId: id } }), 1);
});

// ---------------------------------------------------------------------------
// Ledger tests
// ---------------------------------------------------------------------------

test('10 record payment: balance decreases', async () => {
  const customer = await prisma.customer.create({
    data: { name: 'Payer', phone: '+1000000010', balance: 100 },
  });
  const res = await req('POST', `/api/customers/${customer.id}/payment`, {
    token: adminToken,
    body: { amount: 30, description: 'Partial payment' },
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.transaction.type, 'PAYMENT');
  assert.equal(Number(res.body.customer.balance), 70);
  assert.equal(await prisma.khataTransaction.count({ where: { customerId: customer.id, type: 'PAYMENT' } }), 1);
});

test('11 payment larger than outstanding debt: negative balance allowed', async () => {
  const customer = await prisma.customer.create({
    data: { name: 'Overpayer', phone: '+1000000011', balance: 10 },
  });
  const res = await req('POST', `/api/customers/${customer.id}/payment`, {
    token: adminToken,
    body: { amount: 100, description: 'Advance payment' },
  });
  assert.equal(res.status, 200);
  assert.equal(Number(res.body.customer.balance), -90);
});

test('12 invalid or zero payment: rejected', async () => {
  const customer = await prisma.customer.create({
    data: { name: 'BadPay', phone: '+1000000012' },
  });
  const zero = await req('POST', `/api/customers/${customer.id}/payment`, {
    token: adminToken,
    body: { amount: 0 },
  });
  const negative = await req('POST', `/api/customers/${customer.id}/payment`, {
    token: adminToken,
    body: { amount: -5 },
  });
  const tooBig = await req('POST', `/api/customers/${customer.id}/payment`, {
    token: adminToken,
    body: { amount: 2e9 },
  });
  const nonNumeric = await req('POST', `/api/customers/${customer.id}/payment`, {
    token: adminToken,
    body: { amount: 'ten' },
  });
  assert.equal(zero.status, 400);
  assert.equal(negative.status, 400);
  assert.equal(tooBig.status, 400);
  assert.equal(nonNumeric.status, 400);
  assert.equal(await prisma.khataTransaction.count({ where: { customerId: customer.id } }), 0);
  assert.equal(Number((await prisma.customer.findUnique({ where: { id: customer.id } })).balance), 0);
});

test('13 ledger returns sale and payment transactions in deterministic order', async () => {
  const customer = await prisma.customer.create({
    data: { name: 'LedgerUser', phone: '+1000000013', balance: 0 },
  });
  await prisma.khataTransaction.create({
    data: { customerId: customer.id, type: 'SALE', amount: 10, description: 'first sale' },
  });
  await new Promise((r) => setTimeout(r, 10));
  await prisma.khataTransaction.create({
    data: { customerId: customer.id, type: 'PAYMENT', amount: 4, description: 'payment' },
  });
  const res = await req('GET', `/api/customers/${customer.id}/ledger`, { token: adminToken });
  assert.equal(res.status, 200);
  assert.equal(res.body.transactions.length, 2);
  assert.equal(res.body.transactions[0].type, 'PAYMENT');
  assert.equal(res.body.transactions[1].type, 'SALE');
  assert.equal(res.body.total, 2);
  assert.equal(res.body.page, 1);
  assert.equal(res.body.limit, 50);
  assert.equal(res.body.totalPages, 1);
});

test('14 pagination works correctly', async () => {
  const customer = await prisma.customer.create({
    data: { name: 'Pager', phone: '+1000000014', balance: 0 },
  });
  for (let i = 1; i <= 15; i += 1) {
    await prisma.khataTransaction.create({
      data: { customerId: customer.id, type: 'PAYMENT', amount: i, description: `tx ${i}` },
    });
  }
  const page1 = await req('GET', `/api/customers/${customer.id}/ledger?page=1&limit=5`, { token: adminToken });
  assert.equal(page1.status, 200);
  assert.equal(page1.body.transactions.length, 5);
  assert.equal(page1.body.total, 15);
  assert.equal(page1.body.page, 1);
  assert.equal(page1.body.limit, 5);
  assert.equal(page1.body.totalPages, 3);

  const page3 = await req('GET', `/api/customers/${customer.id}/ledger?page=3&limit=5`, { token: adminToken });
  assert.equal(page3.body.transactions.length, 5);
  assert.equal(page3.body.page, 3);
  assert.equal(page3.body.totalPages, 3);

  const invalidPage = await req('GET', `/api/customers/${customer.id}/ledger?page=0`, { token: adminToken });
  assert.equal(invalidPage.status, 400);
  const invalidLimit = await req('GET', `/api/customers/${customer.id}/ledger?limit=101`, { token: adminToken });
  assert.equal(invalidLimit.status, 400);
});

test('15 outstanding returns only customers with positive balances', async () => {
  await prisma.customer.create({ data: { name: 'Rich', phone: '+1000000015', balance: 100 } });
  await prisma.customer.create({ data: { name: 'Poor', phone: '+1000000016', balance: 0 } });
  await prisma.customer.create({ data: { name: 'Creditor', phone: '+1000000017', balance: -50 } });
  const res = await req('GET', '/api/customers/outstanding', { token: adminToken });
  assert.equal(res.status, 200);
  for (const c of res.body.customers) assert.ok(Number(c.balance) > 0);
  const expected = await prisma.customer.findMany({
    where: { balance: { gt: 0 } },
    orderBy: { balance: 'desc' },
  });
  assert.equal(res.body.customers.length, expected.length);
  assert.equal(
    res.body.totalOutstanding,
    expected.reduce((sum, c) => sum + Number(c.balance || 0), 0)
  );
});

test('16 outstanding total excludes negative balances', async () => {
  await prisma.customer.create({ data: { name: 'A', phone: '+1000000018', balance: 200 } });
  await prisma.customer.create({ data: { name: 'B', phone: '+1000000019', balance: -300 } });
  await prisma.customer.create({ data: { name: 'C', phone: '+1000000020', balance: 50 } });
  const res = await req('GET', '/api/customers/outstanding', { token: adminToken });
  assert.equal(res.status, 200);
  const expected = await prisma.customer.aggregate({
    where: { balance: { gt: 0 } },
    _sum: { balance: true },
  });
  assert.equal(res.body.totalOutstanding, Number((expected._sum.balance || 0).toFixed(2)));
  assert.ok(res.body.customers.every((c) => Number(c.balance) > 0));
  assert.ok(!res.body.customers.some((c) => c.name === 'B'));
});

// ---------------------------------------------------------------------------
// POS integration tests
// ---------------------------------------------------------------------------

async function khataSale(body, token = adminToken) {
  return req('POST', '/api/sales', { token, body });
}

test('17 KHATA sale without customerId: rejected', async () => {
  const product = await createProduct({ name: 'K1', stock: 3, sku: 'KHATA-S17' });
  const before = await prisma.khataTransaction.count();
  const res = await khataSale({
    paymentMethod: 'KHATA',
    items: [{ productId: product.id, quantity: 1, unitPrice: 10 }],
  });
  assert.equal(res.status, 400);
  assert.equal(await prisma.khataTransaction.count(), before);
});

test('18 KHATA sale with nonexistent customer: rejected', async () => {
  const product = await createProduct({ name: 'K2', stock: 3, sku: 'KHATA-S18' });
  const before = await prisma.khataTransaction.count();
  const res = await khataSale({
    paymentMethod: 'KHATA',
    customerId: 999999,
    items: [{ productId: product.id, quantity: 1, unitPrice: 10 }],
  });
  assert.equal(res.status, 404);
  const after = await prisma.khataTransaction.count();
  assert.equal(after, before);
});

test('19 valid KHATA sale: creates Sale and ledger transaction', async () => {
  const customer = await prisma.customer.create({ data: { name: 'Buyer', phone: '+1000000021', balance: 0 } });
  const product = await createProduct({ name: 'K3', stock: 3, sku: 'KHATA-S19' });
  const res = await khataSale({
    paymentMethod: 'KHATA',
    customerId: customer.id,
    items: [{ productId: product.id, quantity: 2, unitPrice: 10 }],
  });
  assert.equal(res.status, 201);
  assert.equal(res.body.sale.customerId, customer.id);
  assert.equal(res.body.sale.paymentMethod, 'KHATA');
  const txs = await prisma.khataTransaction.findMany({ where: { customerId: customer.id } });
  assert.equal(txs.length, 1);
  assert.equal(txs[0].type, 'SALE');
  assert.equal(txs[0].saleId, res.body.sale.id);
});

test('20 customer balance increases by final discounted Sale.total', async () => {
  const customer = await prisma.customer.create({ data: { name: 'Disc', phone: '+1000000022', balance: 0 } });
  const product = await createProduct({ name: 'K4', stock: 5, sku: 'KHATA-S20' });
  const res = await khataSale({
    paymentMethod: 'KHATA',
    customerId: customer.id,
    discount: 4,
    items: [{ productId: product.id, quantity: 2, unitPrice: 10 }],
  });
  assert.equal(res.status, 201);
  assert.equal(res.body.sale.subtotal, 20);
  assert.equal(res.body.sale.discount, 4);
  assert.equal(res.body.sale.total, 16);
  const row = await prisma.customer.findUnique({ where: { id: customer.id } });
  assert.equal(Number(row.balance), 16);
  const tx = await prisma.khataTransaction.findFirst({
    where: { customerId: customer.id, saleId: res.body.sale.id },
  });
  assert.ok(tx);
  assert.equal(tx.amount, 16);
});

test('21 normal payment methods do not create Khata transactions', async () => {
  const customer = await prisma.customer.create({ data: { name: 'Cash', phone: '+1000000023', balance: 0 } });
  const product = await createProduct({ name: 'K5', stock: 3, sku: 'KHATA-S21' });
  const res = await khataSale({
    paymentMethod: 'CASH',
    customerId: customer.id,
    items: [{ productId: product.id, quantity: 1, unitPrice: 10 }],
  });
  assert.equal(res.status, 201);
  assert.equal(await prisma.khataTransaction.count({ where: { customerId: customer.id } }), 0);
  assert.equal(Number((await prisma.customer.findUnique({ where: { id: customer.id } })).balance), 0);
});

test('22 failed sale transaction leaves no Khata transaction and no balance change', async () => {
  const customer = await prisma.customer.create({ data: { name: 'Fail', phone: '+1000000024', balance: 0 } });
  const product = await createProduct({ name: 'K6', stock: 1, sku: 'KHATA-S22' });
  const res = await khataSale({
    paymentMethod: 'KHATA',
    customerId: customer.id,
    items: [{ productId: product.id, quantity: 5, unitPrice: 10 }],
  });
  assert.equal(res.status, 400);
  assert.equal(await prisma.khataTransaction.count({ where: { customerId: customer.id } }), 0);
  assert.equal(Number((await prisma.customer.findUnique({ where: { id: customer.id } })).balance), 0);
  assert.equal(await prisma.sale.count({ where: { customerId: customer.id } }), 0);
});

test('23 concurrent KHATA sales to same customer: each successful sale reflected exactly once', async () => {
  const customer = await prisma.customer.create({ data: { name: 'Concurrent', phone: '+1000000025', balance: 0 } });
  const product = await createProduct({ name: 'K7', stock: 5, sku: 'KHATA-S23' });

  const requests = Array.from({ length: 5 }, () =>
    khataSale({
      paymentMethod: 'KHATA',
      customerId: customer.id,
      items: [{ productId: product.id, quantity: 1, unitPrice: 10 }],
    })
  );
  const results = await Promise.all(requests);
  const successes = results.filter((r) => r.status === 201);

  const row = await prisma.customer.findUnique({ where: { id: customer.id } });
  const expected = successes.length * 10;
  assert.equal(Number(row.balance), expected);
  const txs = await prisma.khataTransaction.count({ where: { customerId: customer.id, type: 'SALE' } });
  assert.equal(txs, successes.length);
  assert.ok(successes.length > 0, 'at least one concurrent sale should succeed');
});

// ---------------------------------------------------------------------------
// Authentication tests
// ---------------------------------------------------------------------------

test('24 unauthenticated access returns 401 for every new endpoint', async () => {
  const customer = await prisma.customer.create({ data: { name: 'Auth', phone: '+1000000026', balance: 0 } });
  const endpoints = [
    ['GET', '/api/customers'],
    ['GET', '/api/customers/outstanding'],
    ['GET', `/api/customers/${customer.id}`],
    ['GET', `/api/customers/${customer.id}/ledger`],
    ['POST', `/api/customers/${customer.id}/payment`],
    ['POST', '/api/customers'],
    ['PATCH', `/api/customers/${customer.id}`],
    ['DELETE', `/api/customers/${customer.id}`],
  ];
  for (const [method, url] of endpoints) {
    const res = await req(method, url, {
      body: method === 'POST' || method === 'PATCH' ? { amount: 1 } : undefined,
    });
    assert.equal(res.status, 401, `${method} ${url} should require authentication`);
  }
});




