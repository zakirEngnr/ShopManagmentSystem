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
  ctx = await createTempDb({ prefix: 'sales-min-', backendDir });
  const { dbUrl, realTmp } = ctx;
  assertTmpDbUrl(dbUrl, realTmp);
  const db = await import(backendUrl + 'src/db/prisma.js');
  prisma = db.prisma;
  assert.equal(process.env.DATABASE_URL, dbUrl);
  const mod = await import(backendUrl + 'src/app.js');
  app = mod.createApp();
  adminToken = signToken(await prisma.user.create({ data: { name: 'Admin', email: 'admin@test.local', password: 'hash', role: 'ADMIN', isActive: true } }));
});

after(async () => {
  if (prisma) {
    try { await prisma.$disconnect(); } catch {}
  }
  ctx.cleanup();
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
      const r = http.request({ host: '127.0.0.1', port: port, path: full, method, headers }, (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => {
          server.close();
          let json = null;
          try { json = data ? JSON.parse(data) : null; } catch (e) { json = { _raw: data }; }
          resolve({ status: res.statusCode, body: json });
        });
      });
      r.on('error', (e) => { server.close(); reject(e); });
      if (payload !== null) r.write(payload);
      r.end();
    });
  });
}

function req(method, urlPath, opts) {
  const o = opts || {};
  let full = urlPath;
  if (o.query) {
    const qs = new URLSearchParams();
    for (const k of Object.keys(o.query)) {
      const v = o.query[k];
      if (v === undefined) continue;
      qs.set(k, String(v));
    }
    const s = qs.toString();
    if (s) full += '?' + s;
  }
  const payload = o.body === undefined ? null : JSON.stringify(o.body);
  return doReq(method, full, o.token, payload);
}

test('Valid CASH sale', async () => {
  const product = await prisma.product.create({ data: { sku: 'SKU-001', name: 'Lipstick', type: 'COSMETIC', costPrice: 5, sellPrice: 10, stock: 5, categoryId: 1, brandId: 1 } });
  const res = await req('POST', '/api/sales', {
    token: adminToken,
    body: { paymentMethod: 'CASH', items: [{ productId: product.id, quantity: 2, unitPrice: 10 }] }
  });
  assert.equal(res.status, 201);
  assert.ok(res.body.ok);
  assert.ok(res.body.sale.invoiceNo);
  assert.ok(res.body.sale.subtotal);
  assert.ok(res.body.sale.total);
  assert.ok(res.body.sale.paymentMethod);
  assert.ok(res.body.saleItems.length > 0);
  const updatedProduct = await prisma.product.findUnique({ where: { id: product.id } });
  assert.equal(updatedProduct.stock, 3);
});

test('Sale with discount', async () => {
  const product = await prisma.product.create({ data: { sku: 'SKU-002', name: 'Lipstick 2', type: 'COSMETIC', costPrice: 5, sellPrice: 10, stock: 10, categoryId: 1, brandId: 1 } });
  const res = await req('POST', '/api/sales', {
    token: adminToken,
    body: { paymentMethod: 'CASH', discount: 5, items: [{ productId: product.id, quantity: 2, unitPrice: 10 }] }
  });
  assert.equal(res.status, 201);
  assert.equal(res.body.sale.total, 15);
  assert.equal(res.body.sale.discount, 5);
});

test('Manual item', async () => {
  const res = await req('POST', '/api/sales', {
    token: adminToken,
    body: { paymentMethod: 'CASH', items: [{ manualName: 'Custom Gift Set', quantity: 1, unitPrice: 25 }] }
  });
  assert.equal(res.status, 201);
  assert.equal(res.body.saleItems[0].productId, null);
  assert.equal(res.body.saleItems[0].unitCost, null);
  const products = await prisma.product.findMany();
  assert.equal(products.length, 0);
});