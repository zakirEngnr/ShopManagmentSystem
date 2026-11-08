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
  ctx = await createTempDb({ prefix: 'sales-min-', backendDir });
  const { dbUrl, realTmp } = ctx;
  assertTmpDbUrl(dbUrl, realTmp);
  const db = await import(backendUrl + 'src/db/prisma.js');
  prisma = db.prisma;
  assert.equal(process.env.DATABASE_URL, dbUrl);
  const mod = await import(backendUrl + 'src/app.js');
  app = mod.createApp();
  const admin = await prisma.user.create({
    data: { name: 'Admin', email: 'admin@test.local', password: 'hash', role: 'ADMIN', isActive: true },
  });
  adminToken = signToken(admin);
  categoryId = (await prisma.category.create({ data: { name: 'Sales Category', type: 'COSMETIC' } })).id;
  brandId = (await prisma.brand.create({ data: { name: 'Sales Brand' } })).id;
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
      sku: `SALE-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
      name: 'Sales Product',
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

test('1 valid cash sale updates stock and returns invoice', async () => {
  const product = await createProduct({ name: 'Cash Product', stock: 5, sku: 'SALE-CASH-1' });
  const res = await req('POST', '/api/sales', {
    token: adminToken,
    body: { paymentMethod: 'CASH', items: [{ productId: product.id, quantity: 2, unitPrice: 10 }] },
  });

  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(res.body.ok, true);
  assert.ok(res.body.sale.invoiceNo);
  assert.equal(res.body.sale.subtotal, 20);
  assert.equal(res.body.sale.total, 20);
  assert.equal(res.body.sale.paymentMethod, 'CASH');
  assert.equal(res.body.saleItems.length, 1);
  assert.equal(res.body.saleItems[0].productId, product.id);
  assert.equal((await prisma.product.findUnique({ where: { id: product.id } })).stock, 3);
});

test('2 valid card and mobile methods are accepted', async () => {
  const card = await createProduct({ name: 'Card Product', stock: 3, sku: 'SALE-CARD-1' });
  const mobile = await createProduct({ name: 'Mobile Product', stock: 4, sku: 'SALE-MOBILE-1' });

  const cardRes = await req('POST', '/api/sales', {
    token: adminToken,
    body: { paymentMethod: 'CARD', items: [{ productId: card.id, quantity: 1, unitPrice: 8 }] },
  });
  const mobileRes = await req('POST', '/api/sales', {
    token: adminToken,
    body: { paymentMethod: 'MOBILE', items: [{ productId: mobile.id, quantity: 2, unitPrice: 12 }] },
  });

  assert.equal(cardRes.status, 201);
  assert.equal(mobileRes.status, 201);
  assert.equal(cardRes.body.sale.paymentMethod, 'CARD');
  assert.equal(mobileRes.body.sale.paymentMethod, 'MOBILE');
  assert.equal((await prisma.product.findUnique({ where: { id: card.id } })).stock, 2);
  assert.equal((await prisma.product.findUnique({ where: { id: mobile.id } })).stock, 2);
});

test('3 discounts reduce total and store exact totals', async () => {
  const product = await createProduct({ name: 'Discount Product', stock: 8, sku: 'SALE-DISC-1' });
  const res = await req('POST', '/api/sales', {
    token: adminToken,
    body: { paymentMethod: 'CASH', discount: 5, items: [{ productId: product.id, quantity: 2, unitPrice: 10 }] },
  });

  assert.equal(res.status, 201);
  assert.equal(res.body.sale.subtotal, 20);
  assert.equal(res.body.sale.discount, 5);
  assert.equal(res.body.sale.total, 15);
  assert.equal(res.body.saleItems[0].total, 20);
});

test('4 manual items are allowed and unitCost stays null', async () => {
  const beforeProducts = await prisma.product.count();
  const beforeSales = await prisma.sale.count();
  const res = await req('POST', '/api/sales', {
    token: adminToken,
    body: { paymentMethod: 'CASH', items: [{ manualName: 'Custom Gift Set', quantity: 1, unitPrice: 25 }] },
  });

  assert.equal(res.status, 201);
  assert.equal(res.body.saleItems[0].productId, null);
  assert.equal(res.body.saleItems[0].manualName, 'Custom Gift Set');
  assert.equal(res.body.saleItems[0].unitCost, null);
  assert.equal(await prisma.product.count(), beforeProducts);
  assert.equal(await prisma.sale.count(), beforeSales + 1);
});

test('5 invalid payloads reject malformed sales', async () => {
  const bad = await req('POST', '/api/sales', { token: adminToken, body: { paymentMethod: 'CASH', items: [] } });
  const both = await req('POST', '/api/sales', {
    token: adminToken,
    body: { paymentMethod: 'CASH', items: [{ productId: 999, manualName: 'Bad', quantity: 1, unitPrice: 5 }] },
  });
  const badPayment = await req('POST', '/api/sales', {
    token: adminToken,
    body: { paymentMethod: 'BANK', items: [{ manualName: 'Bad Bank', quantity: 1, unitPrice: 5 }] },
  });

  assert.equal(bad.status, 400);
  assert.equal(both.status, 400);
  assert.equal(badPayment.status, 400);
});

test('6 missing product returns 404 and no sale row is created', async () => {
  const beforeSales = await prisma.sale.count();
  const res = await req('POST', '/api/sales', {
    token: adminToken,
    body: { paymentMethod: 'CASH', items: [{ productId: 999999, quantity: 1, unitPrice: 10 }] },
  });

  assert.equal(res.status, 404);
  assert.equal(await prisma.sale.count(), beforeSales);
});

test('7 insufficient stock blocks the sale', async () => {
  const product = await createProduct({ name: 'Low Stock Product', stock: 2, sku: 'SALE-LOW-1' });
  const res = await req('POST', '/api/sales', {
    token: adminToken,
    body: { paymentMethod: 'CASH', items: [{ productId: product.id, quantity: 3, unitPrice: 10 }] },
  });

  assert.equal(res.status, 400);
  assert.match(String(res.body.error.message), /Insufficient stock/i);
  assert.equal((await prisma.product.findUnique({ where: { id: product.id } })).stock, 2);
});

test('8 duplicate product lines are preserved and aggregated', async () => {
  const product = await createProduct({ name: 'Duplicate Product', stock: 5, sku: 'SALE-DUP-1' });
  const res = await req('POST', '/api/sales', {
    token: adminToken,
    body: {
      paymentMethod: 'CASH',
      items: [
        { productId: product.id, quantity: 2, unitPrice: 10 },
        { productId: product.id, quantity: 1, unitPrice: 10 },
        { productId: product.id, quantity: 1, unitPrice: 12 },
      ],
    },
  });

  assert.equal(res.status, 201);
  assert.equal(res.body.saleItems.length, 3);
  assert.deepEqual(res.body.saleItems.map((item) => item.quantity), [2, 1, 1]);
  assert.equal(res.body.saleItems[0].total, 20);
  assert.equal(res.body.saleItems[1].total, 10);
  assert.equal(res.body.saleItems[2].total, 12);
  assert.equal((await prisma.product.findUnique({ where: { id: product.id } })).stock, 1);
});

test('9 aggregate stock decrement sums repeated quantities of the same product', async () => {
  const product = await createProduct({ name: 'Aggregated Product', stock: 10, sku: 'SALE-AGG-1' });
  const res = await req('POST', '/api/sales', {
    token: adminToken,
    body: {
      paymentMethod: 'CASH',
      items: [
        { productId: product.id, quantity: 2, unitPrice: 12 },
        { productId: product.id, quantity: 3, unitPrice: 12 },
      ],
    },
  });

  assert.equal(res.status, 201);
  assert.equal(res.body.saleItems.reduce((sum, item) => sum + item.quantity, 0), 5);
  assert.equal((await prisma.product.findUnique({ where: { id: product.id } })).stock, 5);
});

test('10 insufficient aggregated stock rejects the entire sale', async () => {
  const product = await createProduct({ name: 'Insufficient Aggregated Product', stock: 3, sku: 'SALE-AGG-FAIL-1' });
  const beforeSaleCount = await prisma.sale.count();
  const beforeSaleItemCount = await prisma.saleItem.count();

  const res = await req('POST', '/api/sales', {
    token: adminToken,
    body: {
      paymentMethod: 'CASH',
      items: [
        { productId: product.id, quantity: 2, unitPrice: 10 },
        { productId: product.id, quantity: 2, unitPrice: 10 },
      ],
    },
  });

  assert.equal(res.status, 400);
  assert.match(String(res.body.error.message), /Insufficient stock/i);
  assert.equal(await prisma.sale.count(), beforeSaleCount);
  assert.equal(await prisma.saleItem.count(), beforeSaleItemCount);
  assert.equal((await prisma.product.findUnique({ where: { id: product.id } })).stock, 3);
});

test('11 client-supplied unitCost is ignored', async () => {
  const product = await createProduct({ name: 'Cost Product', stock: 5, sku: 'SALE-COST-1' });
  const res = await req('POST', '/api/sales', {
    token: adminToken,
    body: {
      paymentMethod: 'CASH',
      items: [{ productId: product.id, quantity: 1, unitPrice: 8, unitCost: 999 }],
    },
  });

  assert.equal(res.status, 201);
  assert.equal(res.body.saleItems[0].unitCost, product.costPrice);
  assert.notEqual(res.body.saleItems[0].unitCost, 999);
});

test('11 invoice numbering increments by year and creates unique invoice numbers', async () => {
  const p1 = await createProduct({ name: 'Invoice A', stock: 5, sku: 'SALE-INV-1' });
  const p2 = await createProduct({ name: 'Invoice B', stock: 5, sku: 'SALE-INV-2' });
  const a = await req('POST', '/api/sales', { token: adminToken, body: { paymentMethod: 'CASH', items: [{ productId: p1.id, quantity: 1, unitPrice: 10 }] } });
  const b = await req('POST', '/api/sales', { token: adminToken, body: { paymentMethod: 'CASH', items: [{ productId: p2.id, quantity: 1, unitPrice: 12 }] } });

  assert.equal(a.status, 201);
  assert.equal(b.status, 201);
  assert.notEqual(a.body.sale.invoiceNo, b.body.sale.invoiceNo);
  assert.match(a.body.sale.invoiceNo, /^INV-\d{4}-\d{4}$/);
  assert.match(b.body.sale.invoiceNo, /^INV-\d{4}-\d{4}$/);
  const existing = await prisma.sale.findMany({ orderBy: { id: 'asc' } });
  const invoiceSequence = existing.map((sale) => sale.invoiceNo).filter((no) => no.startsWith(`INV-${new Date().getFullYear()}-`));
  assert.equal(new Set(invoiceSequence).size, invoiceSequence.length);
});

test('13 concurrent sales on the same product do not oversell', async () => {
  const product = await createProduct({ name: 'Concurrent Product', stock: 4, sku: 'SALE-CONC-1' });
  const requests = Array.from({ length: 4 }, () =>
    req('POST', '/api/sales', {
      token: adminToken,
      body: { paymentMethod: 'CASH', items: [{ productId: product.id, quantity: 2, unitPrice: 10 }] },
    }),
  );

  const results = await Promise.all(requests);
  const accepted = results.filter((r) => r.status === 201);
  const soldQty = accepted.reduce((sum, r) => sum + r.body.saleItems.reduce((lineSum, item) => lineSum + item.quantity, 0), 0);

  assert.ok(accepted.length >= 1, 'At least one sale should succeed');
  assert.ok(soldQty <= 4, 'Total sold quantity must not exceed stock');
  assert.equal((await prisma.product.findUnique({ where: { id: product.id } })).stock, 4 - soldQty);
});

test('13 concurrent invoice generation keeps invoice numbers unique', async () => {
  const product = await createProduct({ name: 'Invoice Race Product', stock: 10, sku: 'SALE-RACE-1' });
  const requests = Array.from({ length: 5 }, () =>
    req('POST', '/api/sales', {
      token: adminToken,
      body: { paymentMethod: 'CARD', items: [{ productId: product.id, quantity: 1, unitPrice: 10 }] },
    }),
  );

  const results = await Promise.all(requests);
  const invoiceNos = results.filter((r) => r.status === 201).map((r) => r.body.sale.invoiceNo);
  assert.equal(new Set(invoiceNos).size, invoiceNos.length, 'invoice numbers must be unique');
});

test('15 transaction rollback prevents partial writes and keeps stock unchanged', async () => {
  const okProduct = await createProduct({ name: 'Rollback Product', stock: 3, sku: 'SALE-ROLL-1' });
  const beforeSaleCount = await prisma.sale.count();
  const beforeStock = (await prisma.product.findUnique({ where: { id: okProduct.id } })).stock;

  const res = await req('POST', '/api/sales', {
    token: adminToken,
    body: {
      paymentMethod: 'CASH',
      items: [
        { productId: okProduct.id, quantity: 2, unitPrice: 10 },
        { productId: 999999, quantity: 1, unitPrice: 15 },
      ],
    },
  });

  assert.equal(res.status, 404);
  assert.equal(await prisma.sale.count(), beforeSaleCount);
  assert.equal((await prisma.product.findUnique({ where: { id: okProduct.id } })).stock, beforeStock);
});

test('16 lock cleanup after an error allows the next sale to succeed', async () => {
  const product = await createProduct({ name: 'Cleanup Product', stock: 3, sku: 'SALE-CLEAN-1' });
  const failed = await req('POST', '/api/sales', {
    token: adminToken,
    body: { paymentMethod: 'CASH', items: [{ productId: product.id, quantity: 4, unitPrice: 10 }] },
  });
  const ok = await req('POST', '/api/sales', {
    token: adminToken,
    body: { paymentMethod: 'CASH', items: [{ productId: product.id, quantity: 2, unitPrice: 10 }] },
  });

  assert.equal(failed.status, 400);
  assert.equal(ok.status, 201);
  assert.equal((await prisma.product.findUnique({ where: { id: product.id } })).stock, 1);
});

test('17 reversed overlapping product locks do not deadlock', async () => {
  const p1 = await createProduct({ name: 'Lock A', stock: 5, sku: 'SALE-LOCK-A' });
  const p2 = await createProduct({ name: 'Lock B', stock: 5, sku: 'SALE-LOCK-B' });

  const first = req('POST', '/api/sales', {
    token: adminToken,
    body: { paymentMethod: 'CASH', items: [{ productId: p1.id, quantity: 1, unitPrice: 8 }, { productId: p2.id, quantity: 1, unitPrice: 9 }] },
  });
  const second = req('POST', '/api/sales', {
    token: adminToken,
    body: { paymentMethod: 'CARD', items: [{ productId: p2.id, quantity: 1, unitPrice: 9 }, { productId: p1.id, quantity: 1, unitPrice: 8 }] },
  });

  const [a, b] = await Promise.all([first, second]);
  assert.ok((a.status === 201 && b.status === 201) || (a.status === 400 && b.status === 201) || (a.status === 201 && b.status === 400));
  const remaining = (await prisma.product.findMany({ where: { id: { in: [p1.id, p2.id] } }, orderBy: { id: 'asc' } }));
  assert.ok(remaining.every((product) => product.stock >= 0));
});

test('18 authentication is required for sales creation', async () => {
  const product = await createProduct({ name: 'Auth Product', stock: 3, sku: 'SALE-AUTH-1' });
  const res = await req('POST', '/api/sales', {
    body: { paymentMethod: 'CASH', items: [{ productId: product.id, quantity: 1, unitPrice: 10 }] },
  });

  assert.equal(res.status, 401);
});

test('19 successful sale after failed transaction still works', async () => {
  const product = await createProduct({ name: 'Recovery Product', stock: 4, sku: 'SALE-REC-1' });
  const failed = await req('POST', '/api/sales', {
    token: adminToken,
    body: { paymentMethod: 'CASH', items: [{ productId: product.id, quantity: 5, unitPrice: 10 }] },
  });
  const ok = await req('POST', '/api/sales', {
    token: adminToken,
    body: { paymentMethod: 'CASH', items: [{ productId: product.id, quantity: 2, unitPrice: 10 }] },
  });

  assert.equal(failed.status, 400);
  assert.equal(ok.status, 201);
  assert.equal((await prisma.product.findUnique({ where: { id: product.id } })).stock, 2);
});

test('20 invalid productId or negative quantity is rejected', async () => {
  const product = await createProduct({ name: 'Negative Product', stock: 3, sku: 'SALE-NEG-1' });
  const zeroQty = await req('POST', '/api/sales', {
    token: adminToken,
    body: { paymentMethod: 'CASH', items: [{ productId: product.id, quantity: 0, unitPrice: 10 }] },
  });
  const negativePrice = await req('POST', '/api/sales', {
    token: adminToken,
    body: { paymentMethod: 'CASH', items: [{ productId: product.id, quantity: 1, unitPrice: -1 }] },
  });

  assert.equal(zeroQty.status, 400);
  assert.equal(negativePrice.status, 400);
});

test('20 manual items are added to subtotal without stock changes', async () => {
  const before = await prisma.product.count();
  const beforeSales = await prisma.sale.count();
  const res = await req('POST', '/api/sales', {
    token: adminToken,
    body: { paymentMethod: 'MOBILE', items: [{ manualName: 'Manual Repair Kit', quantity: 3, unitPrice: 6.5 }] },
  });

  assert.equal(res.status, 201);
  assert.equal(res.body.sale.subtotal, 19.5);
  assert.equal(res.body.sale.total, 19.5);
  assert.equal(await prisma.product.count(), before);
  assert.equal(await prisma.sale.count(), beforeSales + 1);
});