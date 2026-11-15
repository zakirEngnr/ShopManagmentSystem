// Regression tests for the KHATA sale idempotency contract.
//
// POST /api/sales accepts an `Idempotency-Key` header. A retry of the same
// request must be a complete no-op: it returns the original sale and must not
// create a second sale, decrement stock again, advance the invoice counter
// again, increase the customer's debt again, or write a second KHATA ledger
// entry.
//
// These tests pin the whole contract for the KHATA path and compare it with
// the CASH path, which must behave identically.
//
// Every test runs against an isolated temporary database.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { createTempDb, assertTmpDbUrl } from '../test-support/tempDb.js';
import { createUser, signToken } from '../test-support/auth.js';

const backendDir = path.resolve(import.meta.dirname, '..');
const backendUrl = pathToFileURL(backendDir + path.sep).href;

const INVOICE_PREFIX = 'INV';
const counterKey = `invoice-${new Date().getFullYear()}`;

let prisma;
let app;
let adminToken;
let ctx;
let categoryId;
let brandId;
let seq = 0;

before(async () => {
  ctx = await createTempDb({ prefix: 'khata-sale-idem-', backendDir });
  const { dbUrl, realTmp } = ctx;
  assertTmpDbUrl(dbUrl, realTmp);
  const db = await import(backendUrl + 'src/db/prisma.js');
  prisma = db.prisma;
  assert.equal(process.env.DATABASE_URL, dbUrl);
  app = (await import(backendUrl + 'src/app.js')).createApp();
  const admin = await createUser(prisma, { role: 'ADMIN', tag: 'khata-sale-idem-admin' });
  adminToken = signToken(admin);
  const category = await prisma.category.create({ data: { name: 'KhataSaleCat', type: 'COSMETIC' } });
  categoryId = category.id;
  const brand = await prisma.brand.create({ data: { name: 'KhataSaleBrand' } });
  brandId = brand.id;
});

after(async () => {
  if (prisma) {
    try { await prisma.$disconnect(); } catch {}
  }
  if (ctx) ctx.cleanup();
});

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
  return doReq(method, urlPath, opts.token, payload, opts.idempotencyKey);
}

function uuid() {
  return crypto.randomUUID();
}

async function createProduct(stock = 100) {
  const n = ++seq;
  return prisma.product.create({
    data: {
      sku: `KHIDEM-${Date.now()}-${n}`,
      name: `Khata Idem Product ${n}`,
      type: 'COSMETIC',
      costPrice: 5,
      sellPrice: 10,
      stock,
      categoryId,
      brandId,
    },
  });
}

async function createCustomer(overrides = {}) {
  const n = ++seq;
  return prisma.customer.create({
    data: { name: `Khata Idem Customer ${n}`, phone: `+3${String(n).padStart(8, '0')}`, type: 'RETAIL', ...overrides },
  });
}

/** The full observable side-effect state of a sale. */
async function readState({ productId, customerId }) {
  const counter = await prisma.counter.findUnique({ where: { key: counterKey } });
  const customer = customerId ? await prisma.customer.findUnique({ where: { id: customerId } }) : null;
  const product = productId ? await prisma.product.findUnique({ where: { id: productId } }) : null;
  const ledger = customerId
    ? await prisma.khataTransaction.count({ where: { customerId, type: 'SALE' } })
    : 0;
  const sales = await prisma.sale.count();
  return {
    counter: counter ? counter.value : 0,
    balance: customer ? Number(customer.balance) : 0,
    stock: product ? product.stock : 0,
    ledger,
    sales,
  };
}

function assertSameState(actual, expected, label) {
  assert.equal(actual.counter, expected.counter, `${label}: the invoice counter must not advance again`);
  assert.equal(actual.balance, expected.balance, `${label}: the customer debt must not increase again`);
  assert.equal(actual.stock, expected.stock, `${label}: the stock must not be decremented again`);
  assert.equal(actual.ledger, expected.ledger, `${label}: no duplicate KHATA ledger entry may be created`);
}

// ---------------------------------------------------------------------------
// KHATA
// ---------------------------------------------------------------------------

test('khata sale: the idempotency key is persisted on the Sale row', async () => {
  const customer = await createCustomer();
  const product = await createProduct();
  const key = uuid();
  const body = {
    paymentMethod: 'KHATA',
    customerId: customer.id,
    discount: 0,
    items: [{ productId: product.id, quantity: 2, unitPrice: 10 }],
  };

  const res = await req('POST', '/api/sales', { token: adminToken, body, idempotencyKey: key });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(res.body.sale.idempotencyKey, key, 'the response must echo the idempotency key');

  const row = await prisma.sale.findUnique({ where: { id: res.body.sale.id } });
  assert.equal(row.idempotencyKey, key, 'the Sale row must persist the idempotency key');
  assert.equal(row.paymentMethod, 'KHATA');
});

test('khata sale: retrying the same key returns the original sale and changes nothing', async () => {
  const customer = await createCustomer();
  const product = await createProduct(100);
  const key = uuid();
  const body = {
    paymentMethod: 'KHATA',
    customerId: customer.id,
    discount: 0,
    items: [{ productId: product.id, quantity: 2, unitPrice: 10 }],
  };

  const before = await readState({ productId: product.id, customerId: customer.id });

  const first = await req('POST', '/api/sales', { token: adminToken, body, idempotencyKey: key });
  assert.equal(first.status, 201, JSON.stringify(first.body));
  const firstSaleId = first.body.sale.id;
  const firstInvoiceNo = first.body.sale.invoiceNo;
  assert.ok(firstInvoiceNo.startsWith(`${INVOICE_PREFIX}-`), `unexpected invoice number ${firstInvoiceNo}`);

  const afterFirst = await readState({ productId: product.id, customerId: customer.id });
  assert.equal(afterFirst.stock, before.stock - 2, 'the stock must be decremented exactly once');
  assert.equal(afterFirst.balance, before.balance + 20, 'the customer debt must increase exactly once');
  assert.equal(afterFirst.ledger, before.ledger + 1, 'exactly one KHATA ledger entry must exist');
  assert.equal(afterFirst.counter, before.counter + 1, 'the invoice counter must advance exactly once');

  const second = await req('POST', '/api/sales', { token: adminToken, body, idempotencyKey: key });
  assert.equal(second.status, 201, JSON.stringify(second.body));

  // Returns the original sale.
  assert.equal(second.body.sale.id, firstSaleId, 'the retry must return the original sale');
  assert.equal(second.body.sale.invoiceNo, firstInvoiceNo, 'the retry must return the original invoice number');
  assert.equal(second.body.sale.idempotencyKey, key);

  // Does not create another sale.
  const withKey = await prisma.sale.count({ where: { idempotencyKey: key } });
  assert.equal(withKey, 1, 'exactly one sale row may exist for the key');
  const totalSales = await prisma.sale.count();
  assert.equal(totalSales, afterFirst.sales, 'no additional sale row may be created');

  // Does not decrement stock again / advance the counter again / increase the
  // debt again / duplicate the ledger entry.
  const afterSecond = await readState({ productId: product.id, customerId: customer.id });
  assertSameState(afterSecond, afterFirst, 'retry');
});

test('khata sale: concurrent duplicate requests with the same key produce exactly one sale', async () => {
  const customer = await createCustomer();
  const product = await createProduct(100);
  const key = uuid();
  const body = {
    paymentMethod: 'KHATA',
    customerId: customer.id,
    discount: 0,
    items: [{ productId: product.id, quantity: 3, unitPrice: 10 }],
  };

  const before = await readState({ productId: product.id, customerId: customer.id });

  const results = await Promise.all(
    Array.from({ length: 5 }, () =>
      req('POST', '/api/sales', { token: adminToken, body, idempotencyKey: key })),
  );

  const ids = results.map((r) => r.body?.sale?.id);
  assert.equal(results.every((r) => r.status === 201), true, `all requests must succeed: ${JSON.stringify(results.map((r) => r.status))}`);
  assert.ok(ids.every((id) => id === ids[0]), `all responses must return the same sale id: ${ids.join(',')}`);
  assert.ok(ids[0] !== undefined, 'a sale id must be returned');

  const withKey = await prisma.sale.count({ where: { idempotencyKey: key } });
  assert.equal(withKey, 1, 'exactly one sale row may exist for the key');

  const after = await readState({ productId: product.id, customerId: customer.id });
  assert.equal(after.sales, before.sales + 1, 'exactly one sale must be created');
  assert.equal(after.stock, before.stock - 3, 'the stock must be decremented exactly once');
  assert.equal(after.balance, before.balance + 30, 'the customer debt must increase exactly once');
  assert.equal(after.ledger, before.ledger + 1, 'exactly one KHATA ledger entry must be created');
  assert.equal(after.counter, before.counter + 1, 'the invoice counter must advance exactly once');
});

test('khata sale: a retry does not create a second sale item row', async () => {
  const customer = await createCustomer();
  const product = await createProduct(100);
  const key = uuid();
  const body = {
    paymentMethod: 'KHATA',
    customerId: customer.id,
    discount: 0,
    items: [{ productId: product.id, quantity: 1, unitPrice: 10 }],
  };

  const first = await req('POST', '/api/sales', { token: adminToken, body, idempotencyKey: key });
  assert.equal(first.status, 201, JSON.stringify(first.body));
  const saleId = first.body.sale.id;

  const second = await req('POST', '/api/sales', { token: adminToken, body, idempotencyKey: key });
  assert.equal(second.status, 201);
  assert.equal(second.body.sale.id, saleId);

  const items = await prisma.saleItem.count({ where: { saleId } });
  assert.equal(items, 1, 'the original sale must keep exactly one item row');
});

test('khata sale: without a key every request creates its own sale', async () => {
  const customer = await createCustomer();
  const product = await createProduct(100);
  const body = {
    paymentMethod: 'KHATA',
    customerId: customer.id,
    discount: 0,
    items: [{ productId: product.id, quantity: 1, unitPrice: 10 }],
  };

  const first = await req('POST', '/api/sales', { token: adminToken, body });
  const second = await req('POST', '/api/sales', { token: adminToken, body });
  assert.equal(first.status, 201);
  assert.equal(second.status, 201);
  assert.notEqual(first.body.sale.id, second.body.sale.id, 'without a key each request is a new sale');
  assert.equal(first.body.sale.idempotencyKey, null);
  assert.equal(second.body.sale.idempotencyKey, null);
});

// ---------------------------------------------------------------------------
// CASH — the contract the KHATA path must match
// ---------------------------------------------------------------------------

test('cash sale: the idempotency contract matches the KHATA path', async () => {
  const product = await createProduct(100);
  const key = uuid();
  const body = {
    paymentMethod: 'CASH',
    cashReceived: 20,
    discount: 0,
    items: [{ productId: product.id, quantity: 2, unitPrice: 10 }],
  };

  const before = await readState({ productId: product.id });

  const first = await req('POST', '/api/sales', { token: adminToken, body, idempotencyKey: key });
  assert.equal(first.status, 201, JSON.stringify(first.body));
  const firstSaleId = first.body.sale.id;
  const firstInvoiceNo = first.body.sale.invoiceNo;

  const afterFirst = await readState({ productId: product.id });
  assert.equal(afterFirst.stock, before.stock - 2);
  assert.equal(afterFirst.counter, before.counter + 1);

  const second = await req('POST', '/api/sales', { token: adminToken, body, idempotencyKey: key });
  assert.equal(second.status, 201);
  assert.equal(second.body.sale.id, firstSaleId, 'the retry must return the original sale');
  assert.equal(second.body.sale.invoiceNo, firstInvoiceNo);

  const afterSecond = await readState({ productId: product.id });
  assert.equal(afterSecond.sales, afterFirst.sales, 'no additional sale row may be created');
  assert.equal(afterSecond.stock, afterFirst.stock, 'the stock must not be decremented again');
  assert.equal(afterSecond.counter, afterFirst.counter, 'the invoice counter must not advance again');
});
