import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { createTempDb, assertTmpDbUrl } from '../test-support/tempDb.js';
import { createUser, signToken } from '../test-support/auth.js';

const backendDir = path.resolve(import.meta.dirname, '..');
const backendUrl = pathToFileURL(backendDir + path.sep).href;
let prisma, app, adminToken, ctx, categoryId;

before(async () => {
  ctx = await createTempDb({ prefix: 'stock-', backendDir });
  assertTmpDbUrl(ctx.dbUrl, ctx.realTmp);
  const db = await import(backendUrl + 'src/db/prisma.js');
  prisma = db.prisma;
  app = (await import(backendUrl + 'src/app.js')).createApp();
  const admin = await prisma.user.create({ data: { name: 'Admin', email: 'admin@test.local', password: 'hash', role: 'ADMIN', isActive: true } });
  adminToken = signToken(admin);
  categoryId = (await prisma.category.create({ data: { name: 'StockCat', type: 'COSMETIC' } })).id;
});

after(async () => { if (prisma) await prisma.$disconnect(); if (ctx) ctx.cleanup(); });

function req(method, urlPath, opts = {}) {
  let full = urlPath;
  if (opts.query) full += '?' + new URLSearchParams(opts.query).toString();
  const payload = opts.body ? JSON.stringify(opts.body) : null;
  return new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const headers = {};
      if (payload) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(payload); }
      if (opts.token) headers.Authorization = 'Bearer ' + opts.token;
      const r = http.request({ host: '127.0.0.1', port: server.address().port, path: full, method, headers }, (res) => {
        let data = '';
        res.on('data', (c) => data += c);
        res.on('end', () => { server.close(); resolve({ status: res.statusCode, body: JSON.parse(data || '{}') }); });
      });
      r.on('error', (e) => { server.close(); reject(e); });
      if (payload) r.write(payload);
      r.end();
    });
  });
}

async function makeProduct(stock = 10) {
  return prisma.product.create({ data: { sku: `SKU-${Date.now()}`, name: 'Test', type: 'COSMETIC', costPrice: 5, sellPrice: 10, stock, categoryId } });
}

test('T1 Positive adjustment', async () => {
  const p = await makeProduct(5);
  const res = await req('POST', '/api/stock', { token: adminToken, body: { productId: p.id, delta: 10, reason: 'PURCHASE', unitCost: 8 } });
  assert.equal(res.status, 201);
  assert.equal((await prisma.product.findUnique({ where: { id: p.id } })).stock, 15);
});

test('T2 Negative adjustment', async () => {
  const p = await makeProduct(10);
  const res = await req('POST', '/api/stock', { token: adminToken, body: { productId: p.id, delta: -3, reason: 'DAMAGE' } });
  assert.equal(res.status, 201);
  assert.equal((await prisma.product.findUnique({ where: { id: p.id } })).stock, 7);
});

test('T3 Insufficient stock', async () => {
  const p = await makeProduct(5);
  const res = await req('POST', '/api/stock', { token: adminToken, body: { productId: p.id, delta: -999, reason: 'LOSS' } });
  assert.equal(res.status, 400);
  assert.equal((await prisma.product.findUnique({ where: { id: p.id } })).stock, 5);
});

test('T4 Invalid payloads', async () => {
  let res = await req('POST', '/api/stock', { token: adminToken, body: { productId: 1, delta: 0, reason: 'PURCHASE' } });
  assert.equal(res.status, 400);
});

test('T5 Nonexistent product', async () => {
  const res = await req('POST', '/api/stock', { token: adminToken, body: { productId: 9999, delta: 10, reason: 'PURCHASE' } });
  assert.equal(res.status, 404);
});

test('T6 Unauthenticated', async () => {
  const p = await makeProduct();
  const res = await req('POST', '/api/stock', { body: { productId: p.id, delta: 10, reason: 'PURCHASE' } });
  assert.equal(res.status, 401);
});

test('T7 List adjustments', async () => {
  const res = await req('GET', '/api/stock', { token: adminToken });
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body.adjustments));
});

test('T8 Filter by productId', async () => {
  const p = await makeProduct();
  await req('POST', '/api/stock', { token: adminToken, body: { productId: p.id, delta: 5, reason: 'PURCHASE' } });
  const res = await req('GET', '/api/stock', { token: adminToken, query: { productId: p.id } });
  assert.equal(res.status, 200);
  assert.equal(res.body.adjustments.length, 1);
});

test('T9 Product history', async () => {
  const p = await makeProduct();
  await req('POST', '/api/stock', { token: adminToken, body: { productId: p.id, delta: 5, reason: 'PURCHASE' } });
  const res = await req('GET', `/api/stock/product/${p.id}`, { token: adminToken });
  assert.equal(res.status, 200);
  assert.equal(res.body.adjustments.length, 1);
});

test('T10 Concurrent negative adjustments', async () => {
  const p = await makeProduct(5);
  const promises = Array.from({ length: 6 }, () => req('POST', '/api/stock', { token: adminToken, body: { productId: p.id, delta: -1, reason: 'DAMAGE' } }));
  const results = await Promise.all(promises);
  const succeeded = results.filter(r => r.status === 201).length;
  assert.equal(succeeded, 5);
  assert.equal((await prisma.product.findUnique({ where: { id: p.id } })).stock, 0);
});
