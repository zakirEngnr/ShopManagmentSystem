import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { createTempDb, assertTmpDbUrl } from '../test-support/tempDb.js';
import { createUser, signToken } from '../test-support/auth.js';
import { recordSale, recordPayment, recordDebt } from '../src/services/khata.service.js';

const backendDir = path.resolve(import.meta.dirname, '..');
const backendUrl = pathToFileURL(backendDir + path.sep).href;

let testPrisma;
let app;
let adminToken;
let ctx;

let seq = 0;
function nextSeq() { return ++seq; }

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

before(async () => {
  ctx = await createTempDb({ prefix: 'khata-conc-', backendDir });
  const { dbUrl, realTmp } = ctx;
  assertTmpDbUrl(dbUrl, realTmp);
  const db = await import(backendUrl + 'src/db/prisma.js');
  testPrisma = db.prisma;
  assert.equal(process.env.DATABASE_URL, dbUrl);
  app = (await import(backendUrl + 'src/app.js')).createApp();
  const admin = await createUser(testPrisma, { role: 'ADMIN', tag: 'khata-conc-admin' });
  adminToken = signToken(admin);
});

after(async () => {
  if (testPrisma) {
    try { await testPrisma.$disconnect(); } catch {}
  }
  if (ctx) ctx.cleanup();
});

async function createCategoryBrand() {
  const n = nextSeq();
  const category = await testPrisma.category.create({ data: { name: `ConcCat-${n}`, type: 'COSMETIC' } });
  const brand = await testPrisma.brand.create({ data: { name: `ConcBrand-${n}` } });
  return { categoryId: category.id, brandId: brand.id };
}

async function createCustomer(overrides = {}) {
  const { balance, ...rest } = overrides;
  const res = await req('POST', '/api/customers', {
    token: adminToken,
    body: { name: 'Conc Customer', phone: `+1${Date.now()}${Math.floor(Math.random() * 1000)}`, ...rest },
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  let customer = res.body.customer;
  if (balance !== undefined) {
    customer = await testPrisma.customer.update({ where: { id: customer.id }, data: { balance } });
  }
  return customer;
}

async function createKhataSale(customerId, total) {
  const { categoryId, brandId } = await createCategoryBrand();
  const product = await testPrisma.product.create({
    data: {
      sku: `CONC-SALE-${nextSeq()}`,
      name: 'Conc Product',
      type: 'COSMETIC',
      costPrice: 5,
      sellPrice: 10,
      stock: 1000,
      categoryId,
      brandId,
    },
  });
  const res = await req('POST', '/api/sales', {
    token: adminToken,
    body: { paymentMethod: 'KHATA', customerId, discount: 0, items: [{ productId: product.id, quantity: 1, unitPrice: total }] },
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.sale;
}

// ---------------------------------------------------------------------------
// Task 1: Concurrency
// ---------------------------------------------------------------------------

test('concurrent full-balance payments: atomic guarded decrement prevents overpayment', async () => {
  const customer = await createCustomer({ balance: 100 });

  // Two concurrent atomic guarded decrements of the entire balance. SQLite
  // serializes write statements, so exactly one UPDATE matches 1 row and the
  // other matches 0 rows (balance < 100 once the first commits). The guard
  // `balance: { gte: amount }` is the authority, so neither request can drive
  // the balance negative. This is deterministic: unlike the HTTP-level
  // interleaving (where one request often completes before the other reads,
  // yielding a 400 pre-check instead of a 409 guard rejection), the atomic
  // decrement itself always serializes correctly.
  const [first, second] = await Promise.all([
    testPrisma.customer.updateMany({
      where: { id: customer.id, balance: { gte: 100 } },
      data: { balance: { decrement: 100 } },
    }),
    testPrisma.customer.updateMany({
      where: { id: customer.id, balance: { gte: 100 } },
      data: { balance: { decrement: 100 } },
    }),
  ]);

  const succeeded = [first.count, second.count].filter((count) => count === 1).length;
  const rejected = [first.count, second.count].filter((count) => count === 0).length;
  assert.equal(succeeded, 1, 'exactly one concurrent decrement must succeed');
  assert.equal(rejected, 1, 'exactly one concurrent decrement must be rejected by the guard');

  const final = await testPrisma.customer.findUnique({ where: { id: customer.id } });
  assert.equal(Number(final.balance), 0, 'balance must be exactly zero, never negative');
});

test('recordPayment service: concurrent full-balance payments — exactly one succeeds, balance never negative', async () => {
  // RETAIL customer with a KHATA sale of 100, so balance = 100 and a debt
  // record exists for FIFO allocation.
  const customer = await createCustomer();
  await createKhataSale(customer.id, 100);
  const before = await testPrisma.customer.findUnique({ where: { id: customer.id } });
  assert.equal(Number(before.balance), 100, 'customer must start with exactly 100 outstanding');

  // Two independent recordPayment() service calls, each in its own Prisma
  // transaction, both attempting to pay the entire Rs. 100 balance.
  const results = await Promise.allSettled([
    recordPayment(customer.id, 100, 'Concurrent payment A'),
    recordPayment(customer.id, 100, 'Concurrent payment B'),
  ]);

  const fulfilled = results.filter((r) => r.status === 'fulfilled');
  const rejected = results.filter((r) => r.status === 'rejected');
  assert.equal(fulfilled.length, 1, 'exactly one concurrent payment must succeed');
  assert.equal(rejected.length, 1, 'exactly one concurrent payment must fail');

  const winner = fulfilled[0].value;
  assert.equal(winner.transaction.type, 'PAYMENT', 'successful transaction must be a PAYMENT');
  assert.equal(winner.transaction.amount, 100, 'successful payment amount must be 100');

  const loser = rejected[0].reason;
  assert.ok(loser.status === 400 || loser.status === 409,
    `expected 400 (insufficient balance) or 409 (guard conflict), got status ${loser.status}: ${loser.message}`);

  const after = await testPrisma.customer.findUnique({ where: { id: customer.id } });
  assert.equal(Number(after.balance), 0, 'final balance must be exactly 0, never negative');

  const paymentCount = await testPrisma.khataTransaction.count({
    where: { customerId: customer.id, type: 'PAYMENT' },
  });
  assert.equal(paymentCount, 1, 'exactly one PAYMENT ledger row must exist');

  const allocationCount = await testPrisma.paymentAllocation.count();
  assert.equal(allocationCount, 1, 'exactly one payment allocation must exist');

  const sale = await testPrisma.sale.findFirst({
    where: { customerId: customer.id, paymentMethod: 'KHATA' },
  });
  assert.equal(Number(sale.recognizedAmount), 100, 'FIFO allocation must fully recognize the sale');
});

test('mid-transaction failure rolls back the entire payment', async () => {
  const customer = await createCustomer({ type: 'RETAIL', balance: 100 });
  const sale = await createKhataSale(customer.id, 50);

  const beforeBalance = Number((await testPrisma.customer.findUnique({ where: { id: customer.id } })).balance);
  const beforeRecognized = Number((await testPrisma.sale.findUnique({ where: { id: sale.id } })).recognizedAmount);

  await assert.rejects(
    testPrisma.$transaction(async (tx) => {
      const throwingTx = new Proxy(tx, {
        get(target, prop) {
          if (prop === 'paymentAllocation') {
            return new Proxy(target.paymentAllocation, {
              get(t, p) {
                if (p === 'create') return () => { throw new Error('injected allocation failure'); };
                return t[p];
              }
            });
          }
          return target[prop];
        }
      });
      await recordPayment(customer.id, 30, 'Injected failure payment', throwingTx);
    }),
    /injected allocation failure/
  );

  const after = await testPrisma.customer.findUnique({ where: { id: customer.id } });
  assert.equal(Number(after.balance), beforeBalance, 'customer balance must be unchanged');

  const paymentCount = await testPrisma.khataTransaction.count({
    where: { customerId: customer.id, type: 'PAYMENT' },
  });
  assert.equal(paymentCount, 0, 'no PAYMENT ledger row must remain');

  const allocationCount = await testPrisma.paymentAllocation.count({
    where: { saleId: sale.id },
  });
  assert.equal(allocationCount, 0, 'no allocation must remain');

  const saleAfter = await testPrisma.sale.findUnique({ where: { id: sale.id } });
  assert.equal(Number(saleAfter.recognizedAmount), beforeRecognized, 'sale recognizedAmount must be unchanged');
});

test('recordSale increments balance and creates a consistent ledger entry', async () => {
  const customer = await createCustomer({ balance: 10 });
  const sale = await createKhataSale(customer.id, 40);
  const before = await testPrisma.customer.findUnique({ where: { id: customer.id } });
  const beforeSaleTxs = await testPrisma.khataTransaction.count({ where: { customerId: customer.id, type: 'SALE' } });

  const result = await testPrisma.$transaction(async (tx) => {
    return recordSale(customer.id, sale.id, 25, 'Credit sale test', tx);
  });
  assert.equal(result.transaction.type, 'SALE');
  assert.equal(result.transaction.amount, 25);
  const customerAfter = await testPrisma.customer.findUnique({ where: { id: customer.id } });
  assert.equal(Number(customerAfter.balance), Number(before.balance) + 25, 'balance must increment by the sale amount');
  const txs = await testPrisma.khataTransaction.count({ where: { customerId: customer.id, type: 'SALE' } });
  assert.equal(txs, beforeSaleTxs + 1, 'exactly one additional SALE ledger row');
});

test('recordDebt increments balance and reuses a supplied transaction', async () => {
  const customer = await createCustomer({ type: 'BUSINESS', balance: 100 });
  let txReceived = null;
  const result = await testPrisma.$transaction(async (tx) => {
    txReceived = tx;
    return recordDebt(customer.id, 200, 'Manual debt', tx);
  });
  assert.equal(result.transaction.type, 'DEBT');
  assert.ok(txReceived, 'supplied transaction must be received by the service');
  const customerAfter = await testPrisma.customer.findUnique({ where: { id: customer.id } });
  assert.equal(Number(customerAfter.balance), 300, 'balance must increment by the debt amount');
});
