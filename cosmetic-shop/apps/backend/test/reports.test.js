import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { createTempDb, assertTmpDbUrl } from '../test-support/tempDb.js';
import { signToken } from '../test-support/auth.js';

const backendDir = path.resolve(import.meta.dirname, '..');
const backendUrl = pathToFileURL(backendDir + path.sep).href;

let prisma;
let app;
let adminToken;
let ctx;
let categoryId;

const REPORTS = '/api/reports';

before(async () => {
  ctx = await createTempDb({ prefix: 'reports-', backendDir });
  const { dbUrl, realTmp } = ctx;
  assertTmpDbUrl(dbUrl, realTmp);
  const db = await import(backendUrl + 'src/db/prisma.js');
  prisma = db.prisma;
  assert.equal(process.env.DATABASE_URL, dbUrl);
  const mod = await import(backendUrl + 'src/app.js');
  app = mod.createApp();
  const admin = await prisma.user.create({
    data: {
      name: 'Admin',
      email: 'admin@reports.local',
      password: 'hash',
      role: 'ADMIN',
      isActive: true,
    },
  });
  adminToken = signToken(admin);
  categoryId = (
    await prisma.category.create({ data: { name: 'Reports Category', type: 'COSMETIC' } })
  ).id;
});

beforeEach(async () => {
  // Full isolation between tests within the shared temp database.
  await prisma.saleItem.deleteMany();
  await prisma.sale.deleteMany();
  await prisma.expense.deleteMany();
  await prisma.product.deleteMany();
});

after(async () => {
  if (prisma) {
    try {
      await prisma.$disconnect();
    } catch {}
  }
  if (ctx) ctx.cleanup();
});

function req(method, urlPath, opts = {}) {
  let full = urlPath;
  if (opts.query) {
    full += '?' + new URLSearchParams(opts.query).toString();
  }
  const payload = opts.body === undefined ? null : JSON.stringify(opts.body);
  return new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      const headers = { Accept: 'application/json' };
      if (payload) {
        headers['Content-Type'] = 'application/json';
        headers['Content-Length'] = Buffer.byteLength(payload);
      }
      if (opts.token) headers.Authorization = 'Bearer ' + opts.token;
      const r = http.request(
        { host: '127.0.0.1', port, path: full, method, headers },
        (res) => {
          let data = '';
          res.on('data', (chunk) => { data += chunk; });
          res.on('end', () => {
            server.close();
            let body = {};
            try {
              body = data ? JSON.parse(data) : {};
            } catch {
              body = { _raw: data };
            }
            resolve({ status: res.statusCode, body });
          });
        },
      );
      r.on('error', (err) => {
        server.close();
        reject(err);
      });
      if (payload) r.write(payload);
      r.end();
    });
  });
}

function utc(y, m, d, h = 10, minute = 0, s = 0, ms = 0) {
  return new Date(Date.UTC(y, m - 1, d, h, minute, s, ms));
}

function isoDate(d) {
  return d.toISOString().slice(0, 10);
}

async function createProduct(data = {}) {
  return prisma.product.create({
    data: {
      sku: `RP-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
      name: 'Reports Product',
      type: 'COSMETIC',
      costPrice: 10,
      sellPrice: 20,
      stock: 10,
      categoryId,
      ...data,
    },
  });
}

async function createSaleDirect({ invoiceNo, createdAt, subtotal, discount, items = [] }) {
  const sale = await prisma.sale.create({
    data: {
      invoiceNo,
      subtotal,
      discount,
      total: Number((subtotal - discount).toFixed(2)),
      paymentMethod: 'CASH',
      createdAt,
    },
  });
  for (const it of items) {
    await prisma.saleItem.create({
      data: {
        saleId: sale.id,
        productId: it.productId === undefined ? null : it.productId,
        manualName: it.manualName === undefined ? null : it.manualName,
        quantity: it.quantity,
        unitPrice: it.unitPrice,
        unitCost: it.unitCost === undefined ? null : it.unitCost,
        total: Number((it.unitPrice * it.quantity).toFixed(2)),
      },
    });
  }
  return sale;
}

async function createExpenseDirect({ date, category = 'RENT', description, amount }) {
  return prisma.expense.create({
    data: { date, category, description, amount },
  });
}

// ---------------------------------------------------------------------------
// T1. Daily report totals
// ---------------------------------------------------------------------------
test('T1 daily report totals', async () => {
  const productA = await createProduct({ name: 'Product A', costPrice: 20, sku: 'RP-A-1' });
  const productB = await createProduct({ name: 'Product B', costPrice: 5, sku: 'RP-B-1' });

  const when = utc(2026, 1, 15, 10, 0, 0);
  await createSaleDirect({
    invoiceNo: 'INV-T1-1',
    createdAt: when,
    subtotal: 100,
    discount: 10,
    items: [
      { productId: productA.id, quantity: 2, unitPrice: 50, unitCost: 20 },
    ],
  });
  await createSaleDirect({
    invoiceNo: 'INV-T1-2',
    createdAt: utc(2026, 1, 15, 11, 0, 0),
    subtotal: 200,
    discount: 0,
    items: [
      { productId: productB.id, quantity: 10, unitPrice: 20, unitCost: 5 },
    ],
  });
  await createExpenseDirect({
    date: utc(2026, 1, 15, 12, 0, 0),
    description: 'Rent',
    amount: 100,
  });

  const res = await req('GET', `${REPORTS}/daily`, {
    token: adminToken,
    query: { date: '2026-01-15' },
  });
  assert.equal(res.status, 200);
  const report = res.body.report;
  assert.equal(report.date, '2026-01-15');
  assert.equal(report.salesCount, 2);
  assert.equal(report.revenue, 300);
  assert.equal(report.discount, 10);
  assert.equal(report.netSales, 290);
  assert.equal(report.netSales, report.revenue - report.discount);
  assert.equal(report.cogs, 90);
  assert.equal(report.grossProfit, 200);
  assert.equal(report.expenses, 100);
  assert.equal(report.netProfit, 100);
});

// ---------------------------------------------------------------------------
// T2. Daily report date isolation
// ---------------------------------------------------------------------------
test('T2 daily report date isolation', async () => {
  const product = await createProduct({ name: 'Iso Product', sku: 'RP-ISO-1' });
  await createSaleDirect({
    invoiceNo: 'INV-ISO-1',
    createdAt: utc(2026, 1, 15, 9, 0, 0),
    subtotal: 100,
    discount: 0,
    items: [{ productId: product.id, quantity: 1, unitPrice: 100, unitCost: 40 }],
  });
  await createSaleDirect({
    invoiceNo: 'INV-ISO-2',
    createdAt: utc(2026, 1, 16, 9, 0, 0),
    subtotal: 777,
    discount: 0,
    items: [{ productId: product.id, quantity: 1, unitPrice: 777, unitCost: 1 }],
  });

  const res = await req('GET', `${REPORTS}/daily`, {
    token: adminToken,
    query: { date: '2026-01-15' },
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.report.salesCount, 1);
  assert.equal(res.body.report.revenue, 100);
  assert.equal(res.body.report.cogs, 40);
});
// ---------------------------------------------------------------------------
// T3. P&L date range (inclusive, both dates)
// ---------------------------------------------------------------------------
test('T3 P&L date range', async () => {
  const product = await createProduct({ name: 'PNL Product', sku: 'RP-PNL-1' });
  await createSaleDirect({
    invoiceNo: 'INV-PNL-1',
    createdAt: utc(2026, 1, 15, 9, 0, 0),
    subtotal: 100,
    discount: 10,
    items: [{ productId: product.id, quantity: 2, unitPrice: 50, unitCost: 20 }],
  });
  await createSaleDirect({
    invoiceNo: 'INV-PNL-2',
    createdAt: utc(2026, 1, 16, 9, 0, 0),
    subtotal: 200,
    discount: 0,
    items: [{ productId: product.id, quantity: 4, unitPrice: 50, unitCost: 10 }],
  });
  await createExpenseDirect({ date: utc(2026, 1, 15, 9, 0, 0), description: 'E1', amount: 30 });
  await createExpenseDirect({ date: utc(2026, 1, 16, 9, 0, 0), description: 'E2', amount: 20 });

  const res = await req('GET', `${REPORTS}/pnl`, {
    token: adminToken,
    query: { from: '2026-01-15', to: '2026-01-16' },
  });
  assert.equal(res.status, 200);
  const report = res.body.report;
  assert.equal(report.from, '2026-01-15');
  assert.equal(report.to, '2026-01-16');
  assert.equal(report.revenue, 300);
  assert.equal(report.discount, 10);
  assert.equal(report.netSales, 290);
  assert.equal(report.cogs, 80);
  assert.equal(report.grossProfit, 210);
  assert.equal(report.expenses, 50);
  assert.equal(report.netProfit, 160);
});

// ---------------------------------------------------------------------------
// T4. Invalid P&L date range (from later than to) -> 400
// ---------------------------------------------------------------------------
test('T4 invalid P&L date range', async () => {
  const res = await req('GET', `${REPORTS}/pnl`, {
    token: adminToken,
    query: { from: '2026-01-16', to: '2026-01-15' },
  });
  assert.equal(res.status, 400);
});

// ---------------------------------------------------------------------------
// T5. Top products ranking
// ---------------------------------------------------------------------------
test('T5 top products', async () => {
  const productA = await createProduct({ name: 'Product A', sku: 'RP-TP-A' });
  const productB = await createProduct({ name: 'Product B', sku: 'RP-TP-B' });
  const when = utc(2026, 1, 15, 9, 0, 0);
  await createSaleDirect({
    invoiceNo: 'INV-TP-1',
    createdAt: when,
    subtotal: 250,
    discount: 0,
    items: [
      { productId: productA.id, quantity: 5, unitPrice: 10, unitCost: 4 },
      { productId: productB.id, quantity: 10, unitPrice: 20, unitCost: 8 },
    ],
  });

  const res = await req('GET', `${REPORTS}/top-products`, {
    token: adminToken,
    query: { from: '2026-01-15', to: '2026-01-15' },
  });
  assert.equal(res.status, 200);
  const products = res.body.products;
  assert.equal(products.length, 2);
  assert.equal(products[0].productId, productB.id);
  assert.equal(products[0].productName, 'Product B');
  assert.equal(products[0].quantitySold, 10);
  assert.equal(products[0].revenue, 200);
  assert.equal(products[1].productId, productA.id);
  assert.equal(products[1].productName, 'Product A');
  assert.equal(products[1].quantitySold, 5);
  assert.equal(products[1].revenue, 50);
});

test('T5b top products tie-break is deterministic at the limit boundary', async () => {
  const productA = await createProduct({ name: 'Tie A', sku: 'RP-TIE-A' });
  const productB = await createProduct({ name: 'Tie B', sku: 'RP-TIE-B' });
  const productC = await createProduct({ name: 'Tie C', sku: 'RP-TIE-C' });
  const productD = await createProduct({ name: 'Tie D', sku: 'RP-TIE-D' });
  const productE = await createProduct({ name: 'Tie E', sku: 'RP-TIE-E' });
  const when = utc(2026, 2, 10, 9, 0, 0);

  const saleIds = ['INV-TIE-1', 'INV-TIE-2', 'INV-TIE-3', 'INV-TIE-4', 'INV-TIE-5'];
  for (let i = 0; i < saleIds.length; i += 1) {
    const product = [productA, productB, productC, productD, productE][i];
    await createSaleDirect({
      invoiceNo: saleIds[i],
      createdAt: when,
      subtotal: 50,
      discount: 0,
      items: [{ productId: product.id, quantity: 5, unitPrice: 10, unitCost: 4 }],
    });
  }

  const expected = [productA.id, productB.id];
  for (let i = 0; i < 5; i += 1) {
    const res = await req('GET', `${REPORTS}/top-products`, {
      token: adminToken,
      query: { from: '2026-02-10', to: '2026-02-10', limit: '2' },
    });
    assert.equal(res.status, 200);
    assert.deepEqual(
      res.body.products.map((p) => p.productId),
      expected,
      'tied quantities must be ordered by productId at the take boundary',
    );
    assert.deepEqual(
      res.body.products.map((p) => p.quantitySold),
      [5, 5],
    );
  }
});

// ---------------------------------------------------------------------------
// T6. Low stock
// ---------------------------------------------------------------------------
test('T6 low stock', async () => {
  const low = await createProduct({
    name: 'Low Stock',
    sku: 'RP-LS-1',
    stock: 3,
    lowStockAt: 5,
  });
  await createProduct({
    name: 'Ok Stock',
    sku: 'RP-LS-2',
    stock: 20,
    lowStockAt: 5,
  });

  const res = await req('GET', `${REPORTS}/low-stock`, { token: adminToken });
  assert.equal(res.status, 200);
  const products = res.body.products;
  assert.equal(products.length, 1);
  assert.equal(products[0].id, low.id);
  assert.equal(products[0].sku, 'RP-LS-1');
  assert.equal(products[0].stock, 3);
  assert.equal(products[0].lowStockAt, 5);
});

// ---------------------------------------------------------------------------
// T7. Expiring soon (relative dates, deterministic regardless of run date)
// ---------------------------------------------------------------------------
test('T7 expiring soon', async () => {
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const todayStr = isoDate(today);

  const expiresSoon = await createProduct({
    name: 'Soon',
    sku: 'RP-ES-1',
    expiryDate: utc(today.getUTCFullYear(), today.getUTCMonth() + 1, today.getUTCDate() + 10),
  });
  await createProduct({
    name: 'Late',
    sku: 'RP-ES-2',
    expiryDate: utc(today.getUTCFullYear(), today.getUTCMonth() + 1, today.getUTCDate() + 60),
  });
  const expired = await createProduct({
    name: 'Expired',
    sku: 'RP-ES-3',
    expiryDate: utc(today.getUTCFullYear(), today.getUTCMonth() + 1, today.getUTCDate() - 1),
  });
  await createProduct({
    name: 'No Expiry',
    sku: 'RP-ES-4',
    expiryDate: null,
  });

  const res = await req('GET', `${REPORTS}/expiring-soon`, {
    token: adminToken,
    query: { days: '30' },
  });
  assert.equal(res.status, 200);
  const products = res.body.products;
  assert.equal(products.length, 1);
  assert.equal(products[0].id, expiresSoon.id);
  assert.equal(products[0].sku, 'RP-ES-1');
});

// ---------------------------------------------------------------------------
// T8. Authentication required on all five endpoints
// ---------------------------------------------------------------------------
test('T8 authentication required', async () => {
  const endpoints = [
    ['GET', `${REPORTS}/daily`, { date: '2026-01-15' }],
    ['GET', `${REPORTS}/pnl`, { from: '2026-01-15', to: '2026-01-16' }],
    ['GET', `${REPORTS}/top-products`, { from: '2026-01-15', to: '2026-01-16' }],
    ['GET', `${REPORTS}/low-stock`, {}],
    ['GET', `${REPORTS}/expiring-soon`, {}],
  ];
  for (const [method, urlPath, query] of endpoints) {
    const res = await req(method, urlPath, { query });
    assert.equal(res.status, 401, `${method} ${urlPath} should require auth`);
  }
});

// ---------------------------------------------------------------------------
// T9. Invalid calendar dates
// ---------------------------------------------------------------------------
test('T9 invalid calendar dates rejected', async () => {
  const dailyBad = await req('GET', `${REPORTS}/daily`, {
    token: adminToken,
    query: { date: '2026-02-30' },
  });
  assert.equal(dailyBad.status, 400);

  const fromBad = await req('GET', `${REPORTS}/pnl`, {
    token: adminToken,
    query: { from: '2026-02-30', to: '2026-03-01' },
  });
  assert.equal(fromBad.status, 400);

  const toBad = await req('GET', `${REPORTS}/pnl`, {
    token: adminToken,
    query: { from: '2026-01-01', to: '2026-02-30' },
  });
  assert.equal(toBad.status, 400);

  const garbage = await req('GET', `${REPORTS}/daily`, {
    token: adminToken,
    query: { date: 'not-a-date' },
  });
  assert.equal(garbage.status, 400);

  const monthBad = await req('GET', `${REPORTS}/daily`, {
    token: adminToken,
    query: { date: '2026-13-01' },
  });
  assert.equal(monthBad.status, 400);
});

// ---------------------------------------------------------------------------
// T10. Invalid limit values
// ---------------------------------------------------------------------------
test('T10 invalid limit values', async () => {
  for (const limit of ['0', '-1', '51', '100', 'abc', '2.5']) {
    const res = await req('GET', `${REPORTS}/top-products`, {
      token: adminToken,
      query: { from: '2026-01-01', to: '2026-01-31', limit },
    });
    assert.equal(res.status, 400, `limit=${limit} should be 400`);
  }

  const ok = await req('GET', `${REPORTS}/top-products`, {
    token: adminToken,
    query: { from: '2026-01-01', to: '2026-01-31', limit: '2' },
  });
  assert.equal(ok.status, 200);
});

// ---------------------------------------------------------------------------
// T11. Invalid days values
// ---------------------------------------------------------------------------
test('T11 invalid days values', async () => {
  for (const days of ['0', '-5', '366', 'abc']) {
    const res = await req('GET', `${REPORTS}/expiring-soon`, {
      token: adminToken,
      query: { days },
    });
    assert.equal(res.status, 400, `days=${days} should be 400`);
  }
});

// ---------------------------------------------------------------------------
// T12. Empty database reports
// ---------------------------------------------------------------------------
test('T12 empty database returns zeros and empty arrays', async () => {
  const daily = await req('GET', `${REPORTS}/daily`, {
    token: adminToken,
    query: { date: '2026-01-01' },
  });
  assert.equal(daily.status, 200);
  assert.equal(daily.body.report.salesCount, 0);
  assert.equal(daily.body.report.revenue, 0);
  assert.equal(daily.body.report.discount, 0);
  assert.equal(daily.body.report.netSales, 0);
  assert.equal(daily.body.report.cogs, 0);
  assert.equal(daily.body.report.grossProfit, 0);
  assert.equal(daily.body.report.expenses, 0);
  assert.equal(daily.body.report.netProfit, 0);

  const pnl = await req('GET', `${REPORTS}/pnl`, {
    token: adminToken,
    query: { from: '2026-01-01', to: '2026-01-31' },
  });
  assert.equal(pnl.status, 200);
  assert.equal(pnl.body.report.revenue, 0);
  assert.equal(pnl.body.report.netProfit, 0);

  const top = await req('GET', `${REPORTS}/top-products`, {
    token: adminToken,
    query: { from: '2026-01-01', to: '2026-01-31' },
  });
  assert.equal(top.status, 200);
  assert.deepEqual(top.body.products, []);

  const low = await req('GET', `${REPORTS}/low-stock`, { token: adminToken });
  assert.equal(low.status, 200);
  assert.deepEqual(low.body.products, []);

  const exp = await req('GET', `${REPORTS}/expiring-soon`, {
    token: adminToken,
    query: { days: '30' },
  });
  assert.equal(exp.status, 200);
  assert.deepEqual(exp.body.products, []);
});

// ---------------------------------------------------------------------------
// T13/T17. UTC date boundary behavior
// ---------------------------------------------------------------------------
test('T13/T17 UTC date boundaries are inclusive at start and end', async () => {
  const product = await createProduct({ name: 'Boundary', sku: 'RP-BD-1' });
  await createSaleDirect({
    invoiceNo: 'INV-BD-1',
    createdAt: utc(2026, 1, 15, 0, 0, 0),
    subtotal: 10,
    discount: 0,
    items: [{ productId: product.id, quantity: 1, unitPrice: 10, unitCost: 4 }],
  });
  await createSaleDirect({
    invoiceNo: 'INV-BD-2',
    createdAt: utc(2026, 1, 15, 23, 59, 59, 999),
    subtotal: 20,
    discount: 0,
    items: [{ productId: product.id, quantity: 2, unitPrice: 10, unitCost: 4 }],
  });
  await createSaleDirect({
    invoiceNo: 'INV-BD-3',
    createdAt: utc(2026, 1, 14, 23, 59, 59, 999),
    subtotal: 999,
    discount: 0,
    items: [{ productId: product.id, quantity: 1, unitPrice: 999, unitCost: 1 }],
  });
  await createExpenseDirect({
    date: utc(2026, 1, 15, 23, 59, 59, 999),
    description: 'Edge expense',
    amount: 7,
  });
  await createExpenseDirect({
    date: utc(2026, 1, 16, 0, 0, 0),
    description: 'Next day expense',
    amount: 999,
  });

  const res = await req('GET', `${REPORTS}/daily`, {
    token: adminToken,
    query: { date: '2026-01-15' },
  });
  assert.equal(res.status, 200);
  const report = res.body.report;
  assert.equal(report.salesCount, 2);
  assert.equal(report.revenue, 30);
  assert.equal(report.cogs, 12);
  assert.equal(report.expenses, 7);
});

// ---------------------------------------------------------------------------
// T14. Manual sale items (productId null) excluded from top-product rankings
// ---------------------------------------------------------------------------
test('T14 manual sale items excluded from top products', async () => {
  const product = await createProduct({ name: 'Real Product', sku: 'RP-M-1' });
  await createSaleDirect({
    invoiceNo: 'INV-M-1',
    createdAt: utc(2026, 1, 15, 9, 0, 0),
    subtotal: 9999,
    discount: 0,
    items: [
      { manualName: 'Manual Repair', quantity: 999, unitPrice: 10, unitCost: null },
      { productId: product.id, quantity: 3, unitPrice: 10, unitCost: 2 },
    ],
  });

  const res = await req('GET', `${REPORTS}/top-products`, {
    token: adminToken,
    query: { from: '2026-01-15', to: '2026-01-15' },
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.products.length, 1);
  assert.equal(res.body.products[0].productId, product.id);
  assert.equal(res.body.products[0].quantitySold, 3);
});

// ---------------------------------------------------------------------------
// T15. Discounts are not subtracted twice
// ---------------------------------------------------------------------------
test('T15 discounts not subtracted twice', async () => {
  const product = await createProduct({ name: 'Disc Product', sku: 'RP-D-1' });
  await createSaleDirect({
    invoiceNo: 'INV-D-1',
    createdAt: utc(2026, 1, 15, 9, 0, 0),
    subtotal: 100,
    discount: 20,
    items: [{ productId: product.id, quantity: 2, unitPrice: 50, unitCost: 5 }],
  });

  const res = await req('GET', `${REPORTS}/daily`, {
    token: adminToken,
    query: { date: '2026-01-15' },
  });
  assert.equal(res.status, 200);
  const report = res.body.report;
  assert.equal(report.revenue, 100);
  assert.equal(report.discount, 20);
  assert.equal(report.netSales, 80);
  assert.notEqual(report.netSales, 60);
});

// ---------------------------------------------------------------------------
// T16. Historical COGS uses SaleItem.unitCost, not current Product cost
// ---------------------------------------------------------------------------
test('T16 historical COGS ignores current product cost', async () => {
  const product = await createProduct({
    name: 'Cost Product',
    sku: 'RP-C-1',
    costPrice: 5,
  });
  await createSaleDirect({
    invoiceNo: 'INV-C-1',
    createdAt: utc(2026, 1, 15, 9, 0, 0),
    subtotal: 100,
    discount: 0,
    items: [{ productId: product.id, quantity: 2, unitPrice: 50, unitCost: 50 }],
  });
  await prisma.product.update({
    where: { id: product.id },
    data: { costPrice: 999 },
  });

  const res = await req('GET', `${REPORTS}/daily`, {
    token: adminToken,
    query: { date: '2026-01-15' },
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.report.cogs, 100);
});

// ---------------------------------------------------------------------------
// T18. Manual sale item COGS: null unitCost contributes nothing
// ---------------------------------------------------------------------------
test('T18 manual sale item COGS handled via historical unitCost', async () => {
  const product = await createProduct({ name: 'Mixed Product', sku: 'RP-MX-1' });
  await createSaleDirect({
    invoiceNo: 'INV-MX-1',
    createdAt: utc(2026, 1, 15, 9, 0, 0),
    subtotal: 50,
    discount: 0,
    items: [
      { productId: product.id, quantity: 2, unitPrice: 10, unitCost: 6 },
      { manualName: 'Manual item', quantity: 100, unitPrice: 1, unitCost: null },
    ],
  });

  const res = await req('GET', `${REPORTS}/daily`, {
    token: adminToken,
    query: { date: '2026-01-15' },
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.report.cogs, 12);
});

// ---------------------------------------------------------------------------
// Daily report defaults to today's UTC date when date is omitted
// ---------------------------------------------------------------------------
test('daily report defaults to today', async () => {
  const product = await createProduct({ name: 'Today Product', sku: 'RP-TD-1' });
  const todayStr = isoDate(new Date());
  const now = new Date();
  await createSaleDirect({
    invoiceNo: 'INV-TD-1',
    createdAt: utc(now.getUTCFullYear(), now.getUTCMonth() + 1, now.getUTCDate(), 9, 0, 0),
    subtotal: 42,
    discount: 0,
    items: [{ productId: product.id, quantity: 1, unitPrice: 42, unitCost: 10 }],
  });

  const res = await req('GET', `${REPORTS}/daily`, { token: adminToken });
  assert.equal(res.status, 200);
  assert.equal(res.body.report.date, todayStr);
  assert.equal(res.body.report.revenue, 42);
});

