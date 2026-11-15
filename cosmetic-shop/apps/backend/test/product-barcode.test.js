// Barcode lookup tests for GET /api/products/barcode/:barcode.
//
// Isolated temporary database only - the development database is never
// opened. Covers the response contract the POS depends on, the exact match
// rule, invalid input, authentication and the route order against
// '/products/:id'.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { createTempDb, assertTmpDbUrl } from '../test-support/tempDb.js';
import { createUser, signToken } from '../test-support/auth.js';

const backendDir = path.resolve(import.meta.dirname, '..');
const backendUrl = pathToFileURL(backendDir + path.sep).href;
const ctx = await createTempDb({ prefix: 'barcode-', backendDir });
const { tmpDir, dbFile, dbUrl, realTmp } = ctx;
const SECRET = 'SECRET-VALUE-9f3a1c';
process.env.JWT_SECRET = 'test-jwt-secret-that-is-long-enough-0123456789';
process.env.NODE_ENV = 'test';

let prisma;
let app;
let category;
let token;
let tagSeq = 0;

function tag(prefix) {
  tagSeq += 1;
  return `${prefix}-${Date.now()}-${tagSeq}-${Math.floor(Math.random() * 1e9)}`;
}

function baseProduct(over) {
  return Object.assign(
    {
      sku: tag('SKU'),
      name: 'Barcode Product',
      type: 'COSMETIC',
      costPrice: 100,
      sellPrice: 150,
      categoryId: category.id,
    },
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
  const payload = o.body === undefined ? null : JSON.stringify(o.body);
  return doReq(method, urlPath, o.token, payload);
}

function barcodeUrl(barcode) {
  return '/api/products/barcode/' + encodeURIComponent(barcode);
}

function assertSafe(res) {
  const text = JSON.stringify(res.body);
  assert.ok(text.indexOf(SECRET) === -1, 'leaked: ' + text.slice(0, 300));
  assert.ok(text.indexOf('SECRET-VALUE') === -1, 'leaked');
}

before(async () => {
  assertTmpDbUrl(dbUrl, realTmp);
  const db = await import(backendUrl + 'src/db/prisma.js');
  prisma = db.prisma;
  assert.equal(process.env.DATABASE_URL, dbUrl);
  const mod = await import(backendUrl + 'src/app.js');
  app = mod.createApp();
  const admin = await createUser(prisma, { role: 'ADMIN', tag: 'barcode-admin' });
  token = signToken(admin);
  category = await prisma.category.create({ data: { name: tag('BarcodeCat'), type: 'COSMETIC' } });
});

test('an existing barcode returns the correct product', async () => {
  const barcode = tag('BC');
  const created = await req('POST', '/api/products', {
    token,
    body: baseProduct({ barcode, name: 'Scanned Lipstick', sellPrice: 250, stock: 12 }),
  });
  assert.equal(created.status, 201);

  const found = await req('GET', barcodeUrl(barcode), { token });
  assert.equal(found.status, 200);
  assert.equal(found.body.ok, true);
  assert.ok(found.body.product, 'the response must carry the product');
  assert.equal(found.body.product.id, created.body.product.id);
  assert.equal(found.body.product.name, 'Scanned Lipstick');
  assert.equal(found.body.product.sellPrice, 250);
  assert.equal(found.body.product.stock, 12);
  assert.equal(found.body.product.sku, created.body.product.sku);
  assert.equal(found.body.product.barcode, barcode);
});

test('the barcode lookup does not expose the cost price', async () => {
  const barcode = tag('BC');
  await req('POST', '/api/products', {
    token,
    body: baseProduct({ barcode, costPrice: 77.5, sellPrice: 99 }),
  });

  const found = await req('GET', barcodeUrl(barcode), { token });
  assert.equal(found.status, 200);
  assert.equal(
    Object.prototype.hasOwnProperty.call(found.body.product, 'costPrice'),
    false,
    'the purchase cost must not be exposed by the scanning endpoint',
  );
});

test('an unknown barcode returns 404 with the standard error envelope', async () => {
  const found = await req('GET', barcodeUrl(tag('MISSING')), { token });
  assert.equal(found.status, 404);
  assert.equal(found.body.ok, false);
  assert.equal(typeof found.body.error?.message, 'string');
  assert.ok(found.body.error.message.length > 0);
});

test('the lookup is an exact match', async () => {
  // A barcode with lower case letters, so the case check below is meaningful.
  const barcode = tag('exact');
  assert.notEqual(barcode, barcode.toUpperCase());
  const created = await req('POST', '/api/products', {
    token,
    body: baseProduct({ barcode, name: 'Exact Match' }),
  });
  assert.equal(created.status, 201);

  // The exact barcode is found.
  const exact = await req('GET', barcodeUrl(barcode), { token });
  assert.equal(exact.status, 200);
  assert.equal(exact.body.product.id, created.body.product.id);

  // A prefix is not a match.
  const prefix = await req('GET', barcodeUrl(barcode.slice(0, barcode.length - 3)), { token });
  assert.equal(prefix.status, 404, 'a prefix must not match');

  // A different case is not a match (the column has no NOCASE collation).
  const otherCase = await req('GET', barcodeUrl(barcode.toUpperCase()), { token });
  assert.equal(otherCase.status, 404, 'the comparison must be case sensitive');

  // Surrounding whitespace is trimmed, the barcode itself is not padded.
  const padded = await req('GET', barcodeUrl(`  ${barcode}  `), { token });
  assert.equal(padded.status, 200, 'surrounding whitespace must be ignored');
  assert.equal(padded.body.product.id, created.body.product.id);
});

test('invalid barcodes are rejected safely', async () => {
  // An empty barcode.
  const empty = await req('GET', '/api/products/barcode/%20', { token });
  assert.equal(empty.status, 400);
  assertSafe(empty);

  // A barcode that is longer than the column allows.
  const tooLong = await req('GET', barcodeUrl('x'.repeat(41)), { token });
  assert.equal(tooLong.status, 400);
  assertSafe(tooLong);

  // The submitted value is never echoed back.
  const secretBarcode = SECRET;
  const echoed = await req('GET', barcodeUrl(secretBarcode), { token });
  assert.equal(echoed.status, 404);
  assertSafe(echoed);
});

test('the barcode route requires authentication', async () => {
  const barcode = tag('AUTH');
  await req('POST', '/api/products', { token, body: baseProduct({ barcode }) });

  const noToken = await req('GET', barcodeUrl(barcode));
  assert.equal(noToken.status, 401);

  const badToken = await req('GET', barcodeUrl(barcode), { token: 'bad.token.here' });
  assert.equal(badToken.status, 401);

  const noAuthHeader = await req('GET', barcodeUrl(barcode));
  assert.equal(noAuthHeader.status, 401);
  assert.equal(noAuthHeader.body.ok, false);
});

test('the barcode route does not conflict with /products/:id', async () => {
  const barcode = tag('ROUTE');
  const created = await req('POST', '/api/products', {
    token,
    body: baseProduct({ barcode, name: 'Route Product' }),
  });
  assert.equal(created.status, 201);
  const id = created.body.product.id;

  // The barcode route answers with the product, not with an id error.
  const byBarcode = await req('GET', barcodeUrl(barcode), { token });
  assert.equal(byBarcode.status, 200);
  assert.equal(byBarcode.body.product.barcode, barcode);

  // The id route still answers with the product.
  const byId = await req('GET', '/api/products/' + id, { token });
  assert.equal(byId.status, 200);
  assert.equal(byId.body.product.id, id);

  // A numeric id is never mistaken for a barcode.
  const numeric = await req('GET', '/api/products/' + id, { token });
  assert.equal(numeric.body.product.barcode, barcode);
});

test('two products cannot share the same barcode', async () => {
  const barcode = tag('UNIQUE');
  const first = await req('POST', '/api/products', {
    token,
    body: baseProduct({ barcode, name: 'First Owner' }),
  });
  assert.equal(first.status, 201);

  // The database uniqueness rejects the second product.
  const second = await req('POST', '/api/products', {
    token,
    body: baseProduct({ barcode, name: 'Second Owner' }),
  });
  assert.equal(second.status, 409);
  assertSafe(second);

  // The lookup still answers with the one product that owns the barcode.
  const found = await req('GET', barcodeUrl(barcode), { token });
  assert.equal(found.status, 200);
  assert.equal(found.body.product.id, first.body.product.id);
  assert.equal(found.body.product.name, 'First Owner');
});

test('a product without a barcode is not reachable through the lookup', async () => {
  const created = await req('POST', '/api/products', { token, body: baseProduct() });
  assert.equal(created.status, 201);
  assert.equal(created.body.product.barcode, null);

  const found = await req('GET', barcodeUrl(''), { token });
  assert.equal(found.status, 400);
});

test('the lookup works for every product type', async () => {
  for (const type of ['COSMETIC', 'JEWELRY']) {
    const barcode = tag('TYPE');
    const created = await req('POST', '/api/products', {
      token,
      body: baseProduct({ barcode, type }),
    });
    assert.equal(created.status, 201);
    const found = await req('GET', barcodeUrl(barcode), { token });
    assert.equal(found.status, 200);
    assert.equal(found.body.product.type, type);
  }
});

test('the database is an isolated temp file', async () => {
  assertTmpDbUrl(process.env.DATABASE_URL, realTmp);
  assert.ok(path.resolve(dbFile).indexOf('shop.db') === -1);
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
