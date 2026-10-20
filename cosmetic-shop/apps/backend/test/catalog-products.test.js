// Phase B product tests: CRUD, validation, search/filter/sort/page,
// auth, stock rules, guarded deletion, concurrency. Isolated tmp DB only.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { createTempDb, assertTmpDbUrl } from '../test-support/tempDb.js';
import { createUser, signToken } from '../test-support/auth.js';

const backendDir = path.resolve(import.meta.dirname, '..');
const backendUrl = pathToFileURL(backendDir + path.sep).href;
const ctx = await createTempDb({ prefix: 'catalog-b-', backendDir });
const { tmpDir, dbFile, dbUrl, realTmp } = ctx;
const SECRET = 'SECRET-VALUE-b4c2d8';
process.env.JWT_SECRET = 'test-jwt-secret-that-is-long-enough-0123456789';
process.env.NODE_ENV = 'test';

let prisma;
let app;
let catA;
let catB;
let brandA;
let tagSeq = 0;
let token;

function tag(p) {
  tagSeq += 1;
  return p + '-' + Date.now() + '-' + tagSeq + '-' + Math.floor(Math.random() * 1e9);
}

function baseProduct(over) {
  return Object.assign(
    { sku: tag('SKU'), name: 'Test Product', type: 'COSMETIC', costPrice: 100, sellPrice: 150, categoryId: catA.id },
    over || {},
  );
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

before(async () => {
  assertTmpDbUrl(dbUrl, realTmp);
  const db = await import(backendUrl + 'src/db/prisma.js');
  prisma = db.prisma;
  assert.equal(process.env.DATABASE_URL, dbUrl);
  const mod = await import(backendUrl + 'src/app.js');
  app = mod.createApp();
  const admin = await createUser(prisma, { role: 'ADMIN', tag: 'products-admin' });
  token = signToken(admin);
  catA = await prisma.category.create({ data: { name: tag('CatA'), type: 'COSMETIC' } });
  catB = await prisma.category.create({ data: { name: tag('CatB'), type: 'JEWELRY' } });
  brandA = await prisma.brand.create({ data: { name: tag('BrandA') } });
});

test('migrations are present and applied', async () => {
  const entries = fs
    .readdirSync(path.join(backendDir, 'prisma', 'migrations'), { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
  assert.ok(entries.length > 0, 'no migration folders found');
  const tables = await prisma.$queryRawUnsafe(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%';",
  );
  const names = tables.map((t) => t.name);
  for (const expected of ['User', 'Category', 'Brand', 'Product', 'Sale', 'SaleItem']) {
    assert.ok(names.includes(expected), `missing table ${expected}`);
  }
});

test('product CRUD happy path', async () => {
  const created = await req('POST', '/api/products', { token, body: baseProduct({ brandId: brandA.id }) });
  assert.equal(created.status, 201);
  const id = created.body.product.id;
  const detail = await req('GET', '/api/products/' + id, { token });
  assert.equal(detail.status, 200);
  const list = await req('GET', '/api/products', { token });
  assert.equal(list.status, 200);
  assert.ok(list.body.total >= 1);
  const updated = await req('PATCH', '/api/products/' + id, { token, body: { sellPrice: 199 } });
  assert.equal(updated.status, 200);
  assert.equal(updated.body.product.sellPrice, 199);
  const del = await req('DELETE', '/api/products/' + id, { token });
  assert.equal(del.status, 200);
  const gone = await req('GET', '/api/products/' + id, { token });
  assert.equal(gone.status, 404);
});

test('invalid inputs rejected safely', async () => {
  const badType = await req('POST', '/api/products', { token, body: baseProduct({ type: SECRET }) });
  assert.equal(badType.status, 400);
  assertSafe(badType);
  const neg = await req('POST', '/api/products', { token, body: baseProduct({ costPrice: -5 }) });
  assert.equal(neg.status, 400);
  const over = await req('POST', '/api/products', { token, body: baseProduct({ name: 'x'.repeat(500) }) });
  assert.equal(over.status, 400);
  const unk = await req('POST', '/api/products', { token, body: baseProduct({ password: SECRET }) });
  assert.equal(unk.status, 400);
  assertSafe(unk);
  const ok = await req('POST', '/api/products', { token, body: baseProduct() });
  assert.equal(ok.status, 201);
  const emptyUpd = await req('PATCH', '/api/products/' + ok.body.product.id, { token, body: {} });
  assert.equal(emptyUpd.status, 400);
  const stockUpd = await req('PATCH', '/api/products/' + ok.body.product.id, { token, body: { stock: 999 } });
  assert.equal(stockUpd.status, 400);
});

test('malformed ids give 400', async () => {
  const badIds = ['abc', '0', '-1', '1e3', String(Number.MAX_SAFE_INTEGER + 1)];
  for (const badId of badIds) {
    const r = await req('GET', '/api/products/' + encodeURIComponent(badId), { token });
    assert.equal(r.status, 400, 'id=' + badId + ' got ' + r.status);
    assertSafe(r);
  }
  const missing = await req('GET', '/api/products/999999', { token });
  assert.equal(missing.status, 404);
});

test('duplicate sku barcode give 409', async () => {
  const sku = tag('DUP');
  const bc = tag('BC');
  const a = await req('POST', '/api/products', { token, body: baseProduct({ sku, barcode: bc }) });
  assert.equal(a.status, 201);
  const dupSku = await req('POST', '/api/products', { token, body: baseProduct({ sku }) });
  assert.equal(dupSku.status, 409);
  assertSafe(dupSku);
  const dupBc = await req('POST', '/api/products', { token, body: baseProduct({ barcode: bc }) });
  assert.equal(dupBc.status, 409);
  const b = await req('POST', '/api/products', { token, body: baseProduct() });
  assert.equal(b.status, 201);
  const updDup = await req('PATCH', '/api/products/' + b.body.product.id, { token, body: { sku } });
  assert.equal(updDup.status, 409);
});

test('missing refs give 404', async () => {
  const noCat = await req('POST', '/api/products', { token, body: baseProduct({ categoryId: 999999 }) });
  assert.equal(noCat.status, 404);
  const noBrand = await req('POST', '/api/products', { token, body: baseProduct({ brandId: 999999 }) });
  assert.equal(noBrand.status, 404);
  const ok = await req('POST', '/api/products', { token, body: baseProduct() });
  assert.equal(ok.status, 201);
  const updNoCat = await req('PATCH', '/api/products/' + ok.body.product.id, { token, body: { categoryId: 999999 } });
  assert.equal(updNoCat.status, 404);
});

after(async () => {
  if (prisma) {
    try {
      if (process.env.DATABASE_URL) assertTmpDbUrl(process.env.DATABASE_URL, realTmp);
      await prisma.$disconnect();
    } catch (e) {}
  }
  ctx.cleanup();
});

function assertSafe(res) {
  const text = JSON.stringify(res.body);
  assert.ok(text.indexOf(SECRET) === -1, 'leaked: ' + text.slice(0, 300));
  assert.ok(text.indexOf('SECRET-VALUE') === -1, 'leaked');
}

test('search filters sort page', async () => {
  const uniq = tag('SEARCHABLE');
  await req('POST', '/api/products', { token, body: baseProduct({ name: 'Alpha ' + uniq, type: 'COSMETIC', costPrice: 10, sellPrice: 50, categoryId: catA.id, brandId: brandA.id }) });
  await req('POST', '/api/products', { token, body: baseProduct({ name: 'Beta ' + uniq, type: 'JEWELRY', costPrice: 20, sellPrice: 30, categoryId: catB.id }) });
  const search = await req('GET', '/api/products', { token, query: { search: uniq } });
  assert.equal(search.status, 200);
  assert.equal(search.body.total, 2);
  const catFilter = await req('GET', '/api/products', { token, query: { search: uniq, categoryId: catA.id } });
  assert.equal(catFilter.body.total, 1);
  const brandFilter = await req('GET', '/api/products', { token, query: { search: uniq, brandId: brandA.id } });
  assert.equal(brandFilter.body.total, 1);
  const typeFilter = await req('GET', '/api/products', { token, query: { search: uniq, type: 'JEWELRY' } });
  assert.equal(typeFilter.body.total, 1);
  const asc = await req('GET', '/api/products', { token, query: { search: uniq, sortBy: 'sellPrice', sortOrder: 'asc' } });
  assert.ok(asc.body.products[0].sellPrice <= asc.body.products[1].sellPrice);
  const desc = await req('GET', '/api/products', { token, query: { search: uniq, sortBy: 'sellPrice', sortOrder: 'desc' } });
  assert.ok(desc.body.products[0].sellPrice >= desc.body.products[1].sellPrice);
  const p1 = await req('GET', '/api/products', { token, query: { search: uniq, limit: 1, page: 1, sortBy: 'sku', sortOrder: 'asc' } });
  const p2 = await req('GET', '/api/products', { token, query: { search: uniq, limit: 1, page: 2, sortBy: 'sku', sortOrder: 'asc' } });
  assert.equal(p1.body.total, 2);
  assert.notEqual(p1.body.products[0].id, p2.body.products[0].id);
  const badPage = await req('GET', '/api/products', { token, query: { page: 0 } });
  assert.equal(badPage.status, 400);
  const badLimit = await req('GET', '/api/products', { token, query: { limit: 500 } });
  assert.equal(badLimit.status, 400);
  const badSort = await req('GET', '/api/products', { token, query: { sortBy: 'password' } });
  assert.equal(badSort.status, 400);
  assertSafe(badSort);
  const unkQ = await req('GET', '/api/products', { token, query: { nope: 'x' } });
  assert.equal(unkQ.status, 400);
});

test('auth required everywhere', async () => {
  const noTok = await req('GET', '/api/products');
  assert.equal(noTok.status, 401);
  const badTok = await req('GET', '/api/products', { token: 'bad.token.here' });
  assert.equal(badTok.status, 401);
  const noPost = await req('POST', '/api/products', { body: baseProduct() });
  assert.equal(noPost.status, 401);
  const noDel = await req('DELETE', '/api/products/1');
  assert.equal(noDel.status, 401);
});

test('stock create-only rules', async () => {
  const withStock = await req('POST', '/api/products', { token, body: baseProduct({ stock: 7, lowStockAt: 2 }) });
  assert.equal(withStock.status, 201);
  assert.equal(withStock.body.product.stock, 7);
  assert.equal(withStock.body.product.lowStockAt, 2);
  const noStock = await req('POST', '/api/products', { token, body: baseProduct() });
  assert.equal(noStock.status, 201);
  assert.equal(noStock.body.product.stock, 0);
  assert.equal(noStock.body.product.lowStockAt, 5);
});

test('guarded deletion with sale and stock refs', async () => {
  const created = await req('POST', '/api/products', { token, body: baseProduct() });
  assert.equal(created.status, 201);
  const pid = created.body.product.id;
  const delOk = await req('DELETE', '/api/products/' + pid, { token });
  assert.equal(delOk.status, 200);
  const delMissing = await req('DELETE', '/api/products/999999', { token });
  assert.equal(delMissing.status, 404);
  // Sale reference inserted directly via Prisma in the isolated test DB
  // (documented substitute for invoking out-of-scope sales code).
  const p2 = await req('POST', '/api/products', { token, body: baseProduct() });
  const sale = await prisma.sale.create({
    data: { invoiceNo: tag('INV'), subtotal: 100, total: 100, paymentMethod: 'CASH' },
  });
  await prisma.saleItem.create({
    data: { saleId: sale.id, productId: p2.body.product.id, quantity: 1, unitPrice: 100, total: 100 },
  });
  const delSale = await req('DELETE', '/api/products/' + p2.body.product.id, { token });
  assert.equal(delSale.status, 409);
  const still = await req('GET', '/api/products/' + p2.body.product.id, { token });
  assert.equal(still.status, 200);
  // Stock-history reference blocks deletion too; history is preserved.
  const p3 = await req('POST', '/api/products', { token, body: baseProduct() });
  await prisma.stockAdjust.create({
    data: { productId: p3.body.product.id, delta: 5, reason: 'PURCHASE' },
  });
  const delStock = await req('DELETE', '/api/products/' + p3.body.product.id, { token });
  assert.equal(delStock.status, 409);
  const itemsLeft = await prisma.saleItem.count({ where: { productId: p2.body.product.id } });
  const adjLeft = await prisma.stockAdjust.count({ where: { productId: p3.body.product.id } });
  assert.equal(itemsLeft, 1);
  assert.equal(adjLeft, 1);
});

test('concurrency races stay consistent', async () => {
  const tallies = { prodDelWins: 0, refWins: 0 };
  for (let i = 0; i < 25; i++) {
    const created = await req('POST', '/api/products', { token, body: baseProduct() });
    assert.equal(created.status, 201);
    const pid = created.body.product.id;
    const delP = req('DELETE', '/api/products/' + pid, { token });
    const refP = (async () => {
      // Forced orderings alternate: even rounds start delete first, odd
      // rounds start the reference first — plus true parallel dispatch.
      if (i % 2 === 1) await new Promise((r) => setTimeout(r, 5));
      try {
        const s = await prisma.sale.create({
          data: { invoiceNo: tag('INVR'), subtotal: 10, total: 10, paymentMethod: 'CASH' },
        });
        await prisma.saleItem.create({
          data: { saleId: s.id, productId: pid, quantity: 1, unitPrice: 10, total: 10 },
        });
        return { ref: 'created', saleId: s.id };
      } catch (e) {
        return { ref: 'failed', code: e && e.code };
      }
    })();
    const both = await Promise.all([delP, refP]);
    const delRes = both[0];
    const refRes = both[1];
    assert.ok(delRes.status === 200 || delRes.status === 409, 'race del got ' + delRes.status);
    assert.notEqual(delRes.status, 500);
    const prodRow = await prisma.product.findUnique({ where: { id: pid } });
    const itemCount = await prisma.saleItem.count({ where: { productId: pid } });
    if (prodRow === null) {
      assert.equal(itemCount, 0, 'sale item must not survive deleted product');
      assert.equal(delRes.status, 200);
      assert.equal(refRes.ref, 'failed');
      tallies.prodDelWins += 1;
    } else {
      assert.equal(delRes.status, 409);
      assert.equal(refRes.ref, 'created');
      tallies.refWins += 1;
    }
    // Cleanup iteration.
    await prisma.saleItem.deleteMany({ where: { productId: pid } });
    await prisma.sale.deleteMany({ where: { invoiceNo: { contains: 'INVR' } } });
    await prisma.product.deleteMany({ where: { id: pid } });
  }
  console.log('RACE-TALLY product-vs-sale-ref ' + JSON.stringify(tallies));
  assert.equal(tallies.prodDelWins + tallies.refWins, 25);
});

test('category brand races stay consistent', async () => {
  const tallies = { delWins: 0, refWins: 0 };
  const adminTok = token;
  for (let i = 0; i < 25; i++) {
    const cat = await prisma.category.create({ data: { name: tag('RCat'), type: 'COSMETIC' } });
    const sku = tag('RCSKU');
    // Delete-category HTTP (admin JWT) vs create-product Prisma, dispatched together.
    const delP = req('DELETE', '/api/categories/' + cat.id, { token: adminTok });
    const prodP = (async () => {
      if (i % 2 === 1) await new Promise((r) => setTimeout(r, 3));
      try {
        const p = await prisma.product.create({
          data: { sku, name: 'Race CB', type: 'COSMETIC', costPrice: 5, sellPrice: 9, stock: 0, categoryId: cat.id },
        });
        return { made: true, id: p.id };
      } catch (e) {
        return { made: false, code: e && e.code };
      }
    })();
    const both = await Promise.all([delP, prodP]);
    const delRes = both[0];
    const prodRes = both[1];
    assert.ok(delRes.status === 200 || delRes.status === 409, 'race cat del got ' + delRes.status);
    assert.notEqual(delRes.status, 500);
    const catRow = await prisma.category.findUnique({ where: { id: cat.id } });
    const prodRow = await prisma.product.findUnique({ where: { sku } });
    if (catRow === null) {
      assert.equal(prodRow, null, 'product must not dangle after category delete');
      tallies.delWins += 1;
    } else {
      tallies.refWins += 1;
      if (prodRes.made) assert.equal(prodRow.categoryId, cat.id);
    }
    if (prodRow) await prisma.product.deleteMany({ where: { sku } });
    await prisma.category.deleteMany({ where: { id: cat.id } });
  }
  console.log('RACE-TALLY category-vs-product-ref ' + JSON.stringify(tallies));
  assert.equal(tallies.delWins + tallies.refWins, 25);
});

test('db is isolated temp file', async () => {
  assertTmpDbUrl(process.env.DATABASE_URL, realTmp);
  assert.ok(path.resolve(dbFile).indexOf('shop.db') === -1);
});



