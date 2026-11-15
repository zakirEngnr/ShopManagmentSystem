import { test, before, beforeEach, after } from 'node:test';
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
let allocateInvoiceSequence;

function uuid() {
  return crypto.randomUUID();
}

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
  const payload = opts.body === undefined ? null : JSON.stringify(opts.body);
  return doReq(method, urlPath, opts.token, payload);
}

before(async () => {
  // Import createTempDb FIRST so the Prisma client is bound to the isolated
  // temp database (not shop.db via dotenv). Sale/service imports are loaded
  // dynamically inside `before` after DATABASE_URL points at the temp DB.
  const ctx = await createTempDb({ prefix: 'invoice-', backendDir });
  const { dbUrl, realTmp } = ctx;
  assertTmpDbUrl(dbUrl, realTmp);
  const db = await import(backendUrl + 'src/db/prisma.js');
  testPrisma = db.prisma;
  assert.equal(process.env.DATABASE_URL, dbUrl);
  const saleService = await import(backendUrl + 'src/services/sale.service.js');
  allocateInvoiceSequence = saleService.allocateInvoiceSequence;
  app = (await import(backendUrl + 'src/app.js')).createApp();
  const admin = await createUser(testPrisma, { role: 'ADMIN', tag: 'invoice-admin' });
  adminToken = signToken(admin);
  globalThis.__invoiceCtx = ctx;
});

// Reset shared invoice/counter state between tests so each suite starts from a
// fresh counter and no pre-existing invoice numbers collide (temp DB only).
beforeEach(async () => {
  await testPrisma.paymentAllocation.deleteMany({});
  await testPrisma.saleItem.deleteMany({});
  await testPrisma.khataTransaction.deleteMany({});
  await testPrisma.sale.deleteMany({});
  await testPrisma.counter.deleteMany({});
});

after(async () => {
  if (testPrisma) {
    try { await testPrisma.$disconnect(); } catch {}
  }
  const ctx = globalThis.__invoiceCtx;
  if (ctx) ctx.cleanup();
});

async function createProduct(stock = 100) {
  const category = await testPrisma.category.create({
    data: { name: `InvCat-${crypto.randomUUID().slice(0, 6)}`, type: 'COSMETIC' },
  });
  const brand = await testPrisma.brand.create({
    data: { name: `InvBrand-${crypto.randomUUID().slice(0, 6)}` },
  });
  return testPrisma.product.create({
    data: {
      sku: `INV-${crypto.randomUUID().slice(0, 6)}`,
      name: 'Inv Product',
      type: 'COSMETIC',
      costPrice: 5,
      sellPrice: 10,
      stock,
      categoryId: category.id,
      brandId: brand.id,
    },
  });
}

// ---------------------------------------------------------------------------
// Task 3: Safe invoice numbering
// ---------------------------------------------------------------------------

test('concurrent sales: 20 concurrent sales get distinct, sequential, gap-free invoice numbers', async () => {
  const product = await createProduct(100);
  const body = { paymentMethod: 'CASH', cashReceived: 10, discount: 0, items: [{ productId: product.id, quantity: 1, unitPrice: 10 }] };

  const results = await Promise.all(Array.from({ length: 20 }, () =>
    req('POST', '/api/sales', { token: adminToken, body })));

  const statuses = results.map((r) => r.status);
  assert.ok(statuses.every((s) => s === 201), `all sales must succeed, got ${JSON.stringify(statuses)}`);
  const invoiceNos = results.map((r) => r.body.sale.invoiceNo);
  assert.equal(new Set(invoiceNos).size, 20, 'all invoice numbers must be distinct');

  const sequences = invoiceNos.map((inv) => Number.parseInt(inv.split('-').pop(), 10)).sort((a, b) => a - b);
  assert.equal(sequences[0], 1, 'first invoice number must start at 1');
  for (let i = 1; i < sequences.length; i += 1) {
    assert.equal(sequences[i], sequences[i - 1] + 1, 'invoice numbers must be sequential and gap-free');
  }

  const productAfter = await testPrisma.product.findUnique({ where: { id: product.id } });
  assert.equal(productAfter.stock, 80, 'stock must be decremented exactly 20 times (100 -> 80)');
  const saleCount = await testPrisma.sale.count();
  assert.equal(saleCount, 20, 'exactly 20 sales must exist');
});

test('failed sale: counter does not advance when a sale fails after counter allocation', async () => {
  const product = await createProduct(1);
  const overBody = { paymentMethod: 'CASH', cashReceived: 20, discount: 0, items: [{ productId: product.id, quantity: 2, unitPrice: 10 }] };

  const over = await req('POST', '/api/sales', { token: adminToken, body: overBody });
  assert.equal(over.status, 400, 'overstock sale must be rejected');

  const ok = await req('POST', '/api/sales', { token: adminToken, body: { paymentMethod: 'CASH', cashReceived: 10, discount: 0, items: [{ productId: product.id, quantity: 1, unitPrice: 10 }] } });
  assert.equal(ok.status, 201, 'subsequent sale must succeed');
  assert.equal(ok.body.sale.invoiceNo, 'INV-2026-0001', 'counter must not have advanced after the failed sale');

  const count = await testPrisma.sale.count();
  assert.equal(count, 1, 'exactly one sale must exist');
  const productAfter = await testPrisma.product.findUnique({ where: { id: product.id } });
  assert.equal(productAfter.stock, 0, 'stock must be 0 (1 - 1)');
});

test('legacy initialization: next invoice continues after the highest parsed sequence, not the record count', async () => {
  await testPrisma.sale.create({
    data: {
      invoiceNo: 'INV-2026-0005',
      subtotal: 10, discount: 0, total: 10, recognizedAmount: 10,
      paymentMethod: 'CASH', createdAt: new Date(),
    },
  });
  await testPrisma.sale.create({
    data: {
      invoiceNo: 'INV-2026-0003',
      subtotal: 10, discount: 0, total: 10, recognizedAmount: 10,
      paymentMethod: 'CASH', createdAt: new Date(),
    },
  });
  await testPrisma.sale.create({
    data: {
      invoiceNo: 'INV-2026-0007',
      subtotal: 10, discount: 0, total: 10, recognizedAmount: 10,
      paymentMethod: 'CASH', createdAt: new Date(),
    },
  });

  // 3 records but highest sequence is 7 -> next must be 8, not 4.
  const product = await createProduct(100);
  const res = await req('POST', '/api/sales', { token: adminToken, body: { paymentMethod: 'CASH', cashReceived: 10, discount: 0, items: [{ productId: product.id, quantity: 1, unitPrice: 10 }] } });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(res.body.sale.invoiceNo, 'INV-2026-0008', 'next invoice must continue after highest parsed sequence (7), not record count (3)');
});

test('multiple years: separate counters are used for different years', async () => {
  const seq2025 = await allocateInvoiceSequence(testPrisma, 2025);
  const seq2026a = await allocateInvoiceSequence(testPrisma, 2026);
  const seq2026b = await allocateInvoiceSequence(testPrisma, 2026);
  const seq2025b = await allocateInvoiceSequence(testPrisma, 2025);

  assert.equal(seq2025, 1, '2025 counter starts at 1');
  assert.equal(seq2025b, 2, '2025 counter increments independently');
  assert.equal(seq2026a, 1, '2026 counter starts at 1 (separate from 2025)');
  assert.equal(seq2026b, 2, '2026 counter increments independently');
});
