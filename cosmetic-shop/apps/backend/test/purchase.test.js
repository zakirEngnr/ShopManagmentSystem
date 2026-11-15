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
  ctx = await createTempDb({ prefix: 'purchases-', backendDir });
  const { dbUrl, realTmp } = ctx;
  assertTmpDbUrl(dbUrl, realTmp);
  const db = await import(backendUrl + 'src/db/prisma.js');
  prisma = db.prisma;
  assert.equal(process.env.DATABASE_URL, dbUrl);
  app = (await import(backendUrl + 'src/app.js')).createApp();
  const admin = await createUser(prisma, { role: 'ADMIN', tag: 'purchase-admin' });
  adminToken = signToken(admin);
  const category = await prisma.category.create({ data: { name: 'Purchase Category', type: 'COSMETIC' } });
  categoryId = category.id;
  const brand = await prisma.brand.create({ data: { name: 'Purchase Brand' } });
  brandId = brand.id;
});

after(async () => {
  if (prisma) {
    try { await prisma.$disconnect(); } catch {}
  }
  if (ctx) ctx.cleanup();
});

beforeEach(async () => {
  // Full isolation between tests within the shared temp database.
  await prisma.purchaseItem.deleteMany();
  await prisma.purchase.deleteMany();
  await prisma.saleItem.deleteMany();
  await prisma.sale.deleteMany();
  await prisma.expense.deleteMany();
  await prisma.product.deleteMany();
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
      sku: `PUR-${Date.now()}-${Math.random().toString(16).slice(2,8)}`,
      name: 'Purchase Product',
      type: 'COSMETIC',
      costPrice: 10,
      sellPrice: 25,
      stock: 10,
      categoryId,
      brandId,
      ...overrides,
    },
  });
}

async function createSupplier(overrides = {}) {
  return prisma.supplier.create({
    data: { name: 'Purchase Supplier', phone: '+2000000001', email: 'supplier@example.com', balance: 0, ...overrides },
  });
}

test('1 create a purchase successfully', async () => {
  const supplier = await createSupplier();
  const product = await createProduct({ name: 'Purchase Stock Product', stock: 20, costPrice: 8, sellPrice: 18 });
  const res = await req('POST', '/api/purchases', {
    token: adminToken,
    body: { supplierId: supplier.id, items: [{ productId: product.id, quantity: 3, unitCost: 8 }] },
  });
  assert.equal(res.status, 201);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.purchase.totalAmount, 24);
  assert.equal(res.body.purchase.status, 'UNPAID');
  const updatedProduct = await prisma.product.findUnique({ where: { id: product.id } });
  assert.equal(updatedProduct.stock, 23);
  const updatedSupplier = await prisma.supplier.findUnique({ where: { id: supplier.id } });
  assert.equal(Number(updatedSupplier.balance), 24);
  const purchaseRow = await prisma.purchase.findUnique({ where: { id: res.body.purchase.id } });
  assert.equal(Number(purchaseRow.totalAmount), 24);
  assert.equal(Number(purchaseRow.paidAmount), 0);
  assert.equal(purchaseRow.status, 'UNPAID');
});

test('2 reject nonexistent supplier', async () => {
  const product = await createProduct({ name: 'NoSupplier Product', stock: 10 });
  const res = await req('POST', '/api/purchases', {
    token: adminToken,
    body: { supplierId: 999999, items: [{ productId: product.id, quantity: 1, unitCost: 10 }] },
  });
  assert.equal(res.status, 404);
});

test('3 reject nonexistent product', async () => {
  const supplier = await createSupplier({ name: 'Missing Product Supplier', phone: '+2000000002' });
  const res = await req('POST', '/api/purchases', {
    token: adminToken,
    body: { supplierId: supplier.id, items: [{ productId: 999999, quantity: 1, unitCost: 10 }] },
  });
  assert.equal(res.status, 404);
});

test('4 reject empty items array', async () => {
  const supplier = await createSupplier({ name: 'Empty Items Supplier', phone: '+2000000003' });
  const res = await req('POST', '/api/purchases', {
    token: adminToken,
    body: { supplierId: supplier.id, items: [] },
  });
  assert.equal(res.status, 400);
});

test('5 reject invalid quantity and cost', async () => {
  const supplier = await createSupplier({ name: 'Invalid Qty Supplier', phone: '+2000000004' });
  const product = await createProduct({ name: 'Invalid Qty Product', stock: 5 });
  const qtyRes = await req('POST', '/api/purchases', {
    token: adminToken,
    body: { supplierId: supplier.id, items: [{ productId: product.id, quantity: 0, unitCost: 10 }] },
  });
  const costRes = await req('POST', '/api/purchases', {
    token: adminToken,
    body: { supplierId: supplier.id, items: [{ productId: product.id, quantity: 1, unitCost: 0 }] },
  });
  assert.equal(qtyRes.status, 400);
  assert.equal(costRes.status, 400);
});

test('6 reject duplicate product IDs', async () => {
  const supplier = await createSupplier({ name: 'Duplicate Supplier', phone: '+2000000005' });
  const product = await createProduct({ name: 'Duplicate Product', stock: 5 });
  const res = await req('POST', '/api/purchases', {
    token: adminToken,
    body: { supplierId: supplier.id, items: [{ productId: product.id, quantity: 1, unitCost: 5 }, { productId: product.id, quantity: 2, unitCost: 5 }] },
  });
  assert.equal(res.status, 400);
});

test('7 verifies purchase items, stock, and supplier payable', async () => {
  const supplier = await createSupplier({ name: 'Verify Supplier', phone: '+2000000006' });
  const product = await createProduct({ name: 'Verify Product', stock: 7, costPrice: 12, sellPrice: 20 });
  const res = await req('POST', '/api/purchases', {
    token: adminToken,
    body: { supplierId: supplier.id, items: [{ productId: product.id, quantity: 4, unitCost: 12.5 }] },
  });
  assert.equal(res.status, 201);
  const purchaseItems = await prisma.purchaseItem.findMany({ where: { purchaseId: res.body.purchase.id } });
  assert.equal(purchaseItems.length, 1);
  assert.equal(Number(purchaseItems[0].total), 50);
  const updatedProduct = await prisma.product.findUnique({ where: { id: product.id } });
  assert.equal(updatedProduct.stock, 11);
  assert.equal(Number(updatedProduct.costPrice), 12.5);
  const updatedSupplier = await prisma.supplier.findUnique({ where: { id: supplier.id } });
  assert.equal(Number(updatedSupplier.balance), 50);
  const saleCount = await prisma.sale.count();
  assert.equal(saleCount, 0);
});

test('8 failed purchase rolls back all changes', async () => {
  const supplier = await createSupplier({ name: 'Rollback Supplier', phone: '+2000000007' });
  const product = await createProduct({ name: 'Rollback Product', stock: 2, costPrice: 5, sellPrice: 9 });
  const beforeStock = product.stock;
  const beforeBalance = Number((await prisma.supplier.findUnique({ where: { id: supplier.id } })).balance);
  const beforeItems = await prisma.purchaseItem.count();
  const res = await req('POST', '/api/purchases', {
    token: adminToken,
    body: { supplierId: supplier.id, items: [{ productId: product.id, quantity: 0, unitCost: 5 }] },
  });
  assert.equal(res.status, 400);
  const updatedProduct = await prisma.product.findUnique({ where: { id: product.id } });
  assert.equal(updatedProduct.stock, beforeStock);
  const updatedSupplier = await prisma.supplier.findUnique({ where: { id: supplier.id } });
  assert.equal(Number(updatedSupplier.balance), beforeBalance);
  assert.equal(await prisma.purchaseItem.count(), beforeItems);
});

test('9 concurrent purchases on same product do not lose stock increments', async () => {
  const supplierA = await createSupplier({ name: 'Concurrent A', phone: '+2000000008' });
  const supplierB = await createSupplier({ name: 'Concurrent B', phone: '+2000000009' });
  const product = await createProduct({ name: 'Concurrent Product', stock: 0, costPrice: 4, sellPrice: 12 });

  const requests = [
    req('POST', '/api/purchases', { token: adminToken, body: { supplierId: supplierA.id, items: [{ productId: product.id, quantity: 2, unitCost: 4 }] } }),
    req('POST', '/api/purchases', { token: adminToken, body: { supplierId: supplierB.id, items: [{ productId: product.id, quantity: 3, unitCost: 4 }] } }),
    req('POST', '/api/purchases', { token: adminToken, body: { supplierId: supplierA.id, items: [{ productId: product.id, quantity: 1, unitCost: 4 }] } }),
  ];

  const results = await Promise.all(requests);
  const success = results.filter((r) => r.status === 201).length;
  assert.equal(success, 3);
  const saved = await prisma.product.findUnique({ where: { id: product.id } });
  assert.equal(saved.stock, 6);
  assert.equal(await prisma.purchase.count({ where: { supplierId: { in: [supplierA.id, supplierB.id] } } }), 3);
});

test('9a create a new product directly during purchase creation', async () => {
  const supplier = await createSupplier({ name: 'Custom Product Supplier', phone: '+2000000012' });
  const sku = `NP-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  const barcode = `BC-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;

  const res = await req('POST', '/api/purchases', {
    token: adminToken,
    body: {
      supplierId: supplier.id,
      items: [{
        newProduct: {
          name: 'New Custom Product',
          sku,
          barcode,
          type: 'COSMETIC',
          categoryId,
          brandId,
          costPrice: 45,
          sellPrice: 70,
        },
        quantity: 4,
        unitCost: 45,
      }],
    },
  });

  assert.equal(res.status, 201);
  const createdProduct = await prisma.product.findUnique({ where: { sku } });
  assert.ok(createdProduct);
  assert.equal(createdProduct.name, 'New Custom Product');
  assert.equal(Number(createdProduct.costPrice), 45);
  assert.equal(Number(createdProduct.sellPrice), 70);
  assert.equal(createdProduct.stock, 4);
  assert.equal(Number(createdProduct.categoryId), categoryId);

  const purchaseItems = await prisma.purchaseItem.findMany({ where: { purchaseId: res.body.purchase.id } });
  assert.equal(purchaseItems.length, 1);
  assert.equal(purchaseItems[0].productId, createdProduct.id);
  assert.equal(Number(purchaseItems[0].unitCost), 45);
  assert.equal(Number(purchaseItems[0].total), 180);

  const updatedSupplier = await prisma.supplier.findUnique({ where: { id: supplier.id } });
  assert.equal(Number(updatedSupplier.balance), 180);
});

test('9b mixed new and existing product purchase works atomically', async () => {
  const supplier = await createSupplier({ name: 'Mixed Supplier', phone: '+2000000013' });
  const existingProduct = await createProduct({ name: 'Mixed Existing Product', stock: 2, costPrice: 16, sellPrice: 30 });
  const newSku = `MIX-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;

  const res = await req('POST', '/api/purchases', {
    token: adminToken,
    body: {
      supplierId: supplier.id,
      items: [
        { productId: existingProduct.id, quantity: 3, unitCost: 16 },
        {
          newProduct: {
            name: 'Mixed New Product',
            sku: newSku,
            type: 'COSMETIC',
            categoryId,
            brandId,
            costPrice: 12,
            sellPrice: 24,
          },
          quantity: 5,
          unitCost: 12,
        },
      ],
    },
  });

  assert.equal(res.status, 201);
  const existingUpdated = await prisma.product.findUnique({ where: { id: existingProduct.id } });
  assert.equal(existingUpdated.stock, 5);
  const newProduct = await prisma.product.findUnique({ where: { sku: newSku } });
  assert.ok(newProduct);
  assert.equal(newProduct.stock, 5);
  assert.equal(Number(newProduct.costPrice), 12);
});

test('9c rejects invalid new product payloads and rolls back failed transactions', async () => {
  const supplier = await createSupplier({ name: 'Rollback Supplier', phone: '+2000000014' });
  const duplicateTarget = await createProduct({
    name: 'Duplicate Target Product',
    sku: 'DUP-SKU-1',
    type: 'COSMETIC',
    categoryId,
    brandId,
    costPrice: 12,
    sellPrice: 20,
    stock: 0,
  });
  const beforePurchaseCount = await prisma.purchase.count();
  const beforeProductCount = await prisma.product.count();
  const beforeBalance = Number((await prisma.supplier.findUnique({ where: { id: supplier.id } })).balance);

  const missingName = await req('POST', '/api/purchases', {
    token: adminToken,
    body: {
      supplierId: supplier.id,
      items: [{
        newProduct: { sku: 'BAD-NAME-1', type: 'COSMETIC', categoryId, brandId, costPrice: 10, sellPrice: 20 },
        quantity: 2,
        unitCost: 10,
      }],
    },
  });
  assert.equal(missingName.status, 400);

  const badType = await req('POST', '/api/purchases', {
    token: adminToken,
    body: {
      supplierId: supplier.id,
      items: [{
        newProduct: { name: 'Bad Type Product', sku: `BADTYPE-${Date.now()}`, type: 'INVALID', categoryId, brandId, costPrice: 10, sellPrice: 20 },
        quantity: 2,
        unitCost: 10,
      }],
    },
  });
  assert.equal(badType.status, 400);

  const duplicateSku = await req('POST', '/api/purchases', {
    token: adminToken,
    body: {
      supplierId: supplier.id,
      items: [{
        newProduct: { name: 'Duplicate SKU Product', sku: duplicateTarget.sku, type: 'COSMETIC', categoryId, brandId, costPrice: 10, sellPrice: 20 },
        quantity: 2,
        unitCost: 10,
      }],
    },
  });
  assert.equal(duplicateSku.status, 409);

  const bothFields = await req('POST', '/api/purchases', {
    token: adminToken,
    body: {
      supplierId: supplier.id,
      items: [{
        productId: 999,
        newProduct: { name: 'Both Product', sku: `BOTH-${Date.now()}`, type: 'COSMETIC', categoryId, brandId, costPrice: 10, sellPrice: 20 },
        quantity: 2,
        unitCost: 10,
      }],
    },
  });
  assert.equal(bothFields.status, 400);

  const noneFields = await req('POST', '/api/purchases', {
    token: adminToken,
    body: {
      supplierId: supplier.id,
      items: [{ quantity: 2, unitCost: 10 }],
    },
  });
  assert.equal(noneFields.status, 400);

  assert.equal(await prisma.product.count(), beforeProductCount);
  assert.equal(await prisma.purchase.count(), beforePurchaseCount);
  const supplierAfter = await prisma.supplier.findUnique({ where: { id: supplier.id } });
  assert.equal(Number(supplierAfter.balance), beforeBalance);
});

test('9d rejects duplicate barcode and invalid quantity/cost for new products', async () => {
  const supplier = await createSupplier({ name: 'Validation Supplier', phone: '+2000000015' });
  const baseProduct = await createProduct({ name: 'Existing Validation Product', sku: 'VAL-EXIST', barcode: 'VAL-BC-EXIST', costPrice: 10, sellPrice: 20, stock: 1, categoryId, brandId, type: 'COSMETIC' });

  const duplicateBarcode = await req('POST', '/api/purchases', {
    token: adminToken,
    body: {
      supplierId: supplier.id,
      items: [{
        newProduct: {
          name: 'Barcode Clone',
          sku: `BC-${Date.now()}`,
          barcode: 'VAL-BC-EXIST',
          type: 'COSMETIC',
          categoryId,
          brandId,
          costPrice: 10,
          sellPrice: 20,
        },
        quantity: 2,
        unitCost: 10,
      }],
    },
  });
  assert.equal(duplicateBarcode.status, 409);

  const invalidQuantity = await req('POST', '/api/purchases', {
    token: adminToken,
    body: {
      supplierId: supplier.id,
      items: [{
        newProduct: {
          name: 'Zero Qty',
          sku: `ZERO-${Date.now()}`,
          type: 'COSMETIC',
          categoryId,
          brandId,
          costPrice: 10,
          sellPrice: 20,
        },
        quantity: 0,
        unitCost: 10,
      }],
    },
  });
  assert.equal(invalidQuantity.status, 400);

  const invalidUnitCost = await req('POST', '/api/purchases', {
    token: adminToken,
    body: {
      supplierId: supplier.id,
      items: [{
        newProduct: {
          name: 'Bad Cost',
          sku: `COST-${Date.now()}`,
          type: 'COSMETIC',
          categoryId,
          brandId,
          costPrice: 10,
          sellPrice: 20,
        },
        quantity: 2,
        unitCost: -1,
      }],
    },
  });
  assert.equal(invalidUnitCost.status, 400);

  assert.ok(baseProduct);
});

test('10 purchases list supports pagination and supplier filtering', async () => {
  const supplier = await createSupplier({ name: 'List Supplier', phone: '+2000000010' });
  const product = await createProduct({ name: 'List Product', stock: 5, costPrice: 11, sellPrice: 22 });
  await req('POST', '/api/purchases', {
    token: adminToken,
    body: { supplierId: supplier.id, items: [{ productId: product.id, quantity: 2, unitCost: 11 }] },
  });
  const list = await req('GET', '/api/purchases', { token: adminToken, query: { supplierId: supplier.id, page: 1, limit: 10 } });
  assert.equal(list.status, 200);
  assert.equal(list.body.purchases.length >= 1, true);
  assert.equal(list.body.purchases.every((p) => p.supplier.id === supplier.id), true);
  assert.equal(list.body.total >= 1, true);
});

// route access tests

test('11 unauthenticated requests are rejected', async () => {
  const res = await req('GET', '/api/purchases');
  assert.equal(res.status, 401);
});

test('12 invalid route ids are handled correctly', async () => {
  const supplier = await createSupplier({ name: 'Bad Id Supplier', phone: '+2000000011' });
  const res = await req('POST', `/api/suppliers/${supplier.id}/payment`, { token: adminToken, body: { amount: 'bad' } });
  assert.equal(res.status, 400);
  const res2 = await req('GET', '/api/purchases/abc', { token: adminToken });
  assert.equal(res2.status, 400);
});

// ---------------------------------------------------------------------------
// Purchase search tests (T13-T23)
// ---------------------------------------------------------------------------

test('T13 search finds a purchase beyond page 1', async () => {
  const supplier = await createSupplier({ name: 'Search Supplier', phone: '+2000000020' });
  const product = await createProduct({ name: 'Search Product', stock: 100, costPrice: 5, sellPrice: 10 });

  // Create 12 purchases so one falls on page 2 (limit 10).
  for (let i = 0; i < 12; i += 1) {
    await req('POST', '/api/purchases', {
      token: adminToken,
      body: { supplierId: supplier.id, items: [{ productId: product.id, quantity: 1, unitCost: 5 }] },
    });
  }

  // Search by supplier name should find all 12 regardless of page.
  const res = await req('GET', '/api/purchases', {
    token: adminToken,
    query: { search: 'Search Supplier', page: 1, limit: 10 },
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.total, 12, `expected 12 matching purchases, got ${res.body.total}`);
  assert.ok(res.body.purchases.length > 0, 'should return at least one matching purchase');
});

test('T14 purchase reference search by ID', async () => {
  const supplier = await createSupplier({ name: 'Ref Supplier', phone: '+2000000021' });
  const product = await createProduct({ name: 'Ref Product', stock: 10, costPrice: 5, sellPrice: 10 });
  const created = await req('POST', '/api/purchases', {
    token: adminToken,
    body: { supplierId: supplier.id, items: [{ productId: product.id, quantity: 1, unitCost: 5 }] },
  });
  const purchaseId = created.body.purchase.id;

  const res = await req('GET', '/api/purchases', {
    token: adminToken,
    query: { search: String(purchaseId), page: 1, limit: 10 },
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.total, 1);
  assert.equal(res.body.purchases[0].id, purchaseId);
});

test('T15 supplier name search is partial match', async () => {
  const supplier = await createSupplier({ name: 'Acme Trading Co', phone: '+2000000022' });
  const product = await createProduct({ name: 'Acme Product', stock: 10, costPrice: 5, sellPrice: 10 });
  await req('POST', '/api/purchases', {
    token: adminToken,
    body: { supplierId: supplier.id, items: [{ productId: product.id, quantity: 1, unitCost: 5 }] },
  });

  // Partial supplier name should match.
  const res = await req('GET', '/api/purchases', {
    token: adminToken,
    query: { search: 'Acme', page: 1, limit: 10 },
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.total, 1);
  assert.equal(res.body.purchases[0].supplier.name, 'Acme Trading Co');
});

test('T16 search is case-insensitive on supplier name', async () => {
  const supplier = await createSupplier({ name: 'CaseTest Supplier', phone: '+2000000023' });
  const product = await createProduct({ name: 'Case Product', stock: 10, costPrice: 5, sellPrice: 10 });
  await req('POST', '/api/purchases', {
    token: adminToken,
    body: { supplierId: supplier.id, items: [{ productId: product.id, quantity: 1, unitCost: 5 }] },
  });

  const lower = await req('GET', '/api/purchases', {
    token: adminToken,
    query: { search: 'casetest', page: 1, limit: 10 },
  });
  assert.equal(lower.status, 200);
  assert.equal(lower.body.total, 1, 'lowercase search should match');

  const mixed = await req('GET', '/api/purchases', {
    token: adminToken,
    query: { search: 'CaseTest', page: 1, limit: 10 },
  });
  assert.equal(mixed.status, 200);
  assert.equal(mixed.body.total, 1, 'mixed case search should match');
});

test('T17 search with no matches returns empty and total 0', async () => {
  const supplier = await createSupplier({ name: 'NoMatch Supplier', phone: '+2000000024' });
  const product = await createProduct({ name: 'NoMatch Product', stock: 10, costPrice: 5, sellPrice: 10 });
  await req('POST', '/api/purchases', {
    token: adminToken,
    body: { supplierId: supplier.id, items: [{ productId: product.id, quantity: 1, unitCost: 5 }] },
  });

  const res = await req('GET', '/api/purchases', {
    token: adminToken,
    query: { search: 'NonexistentVendor', page: 1, limit: 10 },
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.total, 0);
  assert.equal(res.body.purchases.length, 0);
});

test('T18 filtered pagination returns distinct results per page', async () => {
  const supplier = await createSupplier({ name: 'Page Supplier', phone: '+2000000025' });
  const product = await createProduct({ name: 'Page Product', stock: 100, costPrice: 5, sellPrice: 10 });

  // Create 15 matching purchases.
  for (let i = 0; i < 15; i += 1) {
    await req('POST', '/api/purchases', {
      token: adminToken,
      body: { supplierId: supplier.id, items: [{ productId: product.id, quantity: 1, unitCost: 5 }] },
    });
  }

  const page1 = await req('GET', '/api/purchases', {
    token: adminToken,
    query: { search: 'Page Supplier', page: 1, limit: 10 },
  });
  assert.equal(page1.status, 200);
  assert.equal(page1.body.total, 15);
  assert.equal(page1.body.purchases.length, 10);

  const page2 = await req('GET', '/api/purchases', {
    token: adminToken,
    query: { search: 'Page Supplier', page: 2, limit: 10 },
  });
  assert.equal(page2.status, 200);
  assert.equal(page2.body.total, 15);
  assert.equal(page2.body.purchases.length, 5);

  // Page 1 and page 2 must not overlap.
  const page1Ids = new Set(page1.body.purchases.map((p) => p.id));
  const page2Ids = new Set(page2.body.purchases.map((p) => p.id));
  for (const id of page2Ids) {
    assert.ok(!page1Ids.has(id), `purchase ${id} appears on both page 1 and page 2`);
  }
});

test('T19 filtered total represents all matching purchases', async () => {
  const supplier = await createSupplier({ name: 'Total Supplier', phone: '+2000000026' });
  const product = await createProduct({ name: 'Total Product', stock: 100, costPrice: 5, sellPrice: 10 });

  // Create 7 matching purchases.
  for (let i = 0; i < 7; i += 1) {
    await req('POST', '/api/purchases', {
      token: adminToken,
      body: { supplierId: supplier.id, items: [{ productId: product.id, quantity: 1, unitCost: 5 }] },
    });
  }

  // Also create a non-matching purchase from a different supplier.
  const otherSupplier = await createSupplier({ name: 'Other Supplier', phone: '+2000000027' });
  await req('POST', '/api/purchases', {
    token: adminToken,
    body: { supplierId: otherSupplier.id, items: [{ productId: product.id, quantity: 1, unitCost: 5 }] },
  });

  const res = await req('GET', '/api/purchases', {
    token: adminToken,
    query: { search: 'Total Supplier', page: 1, limit: 10 },
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.total, 7, `expected total 7, got ${res.body.total}`);
  assert.equal(res.body.purchases.length, 7);
});

test('T20 search combines with supplierId filter', async () => {
  const matchingSupplier = await createSupplier({ name: 'Combined Supplier', phone: '+2000000028' });
  const otherSupplier = await createSupplier({ name: 'Combined Supplier Too', phone: '+2000000029' });
  const product = await createProduct({ name: 'Combined Product', stock: 100, costPrice: 5, sellPrice: 10 });

  await req('POST', '/api/purchases', {
    token: adminToken,
    body: { supplierId: matchingSupplier.id, items: [{ productId: product.id, quantity: 1, unitCost: 5 }] },
  });
  await req('POST', '/api/purchases', {
    token: adminToken,
    body: { supplierId: otherSupplier.id, items: [{ productId: product.id, quantity: 1, unitCost: 5 }] },
  });

  // Search for "Combined" with supplierId filter matching only the first supplier.
  const res = await req('GET', '/api/purchases', {
    token: adminToken,
    query: { search: 'Combined', supplierId: matchingSupplier.id, page: 1, limit: 10 },
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.total, 1);
  assert.equal(res.body.purchases[0].supplier.id, matchingSupplier.id);
});

test('T21 empty search behaves like unfiltered list', async () => {
  const supplier = await createSupplier({ name: 'Empty Search Supplier', phone: '+2000000030' });
  const product = await createProduct({ name: 'Empty Search Product', stock: 10, costPrice: 5, sellPrice: 10 });
  await req('POST', '/api/purchases', {
    token: adminToken,
    body: { supplierId: supplier.id, items: [{ productId: product.id, quantity: 1, unitCost: 5 }] },
  });

  // Empty string search.
  const empty = await req('GET', '/api/purchases', {
    token: adminToken,
    query: { search: '', page: 1, limit: 10 },
  });
  assert.equal(empty.status, 200);
  assert.equal(empty.body.total, 1);

  // Whitespace-only search.
  const spaces = await req('GET', '/api/purchases', {
    token: adminToken,
    query: { search: '   ', page: 1, limit: 10 },
  });
  assert.equal(spaces.status, 200);
  assert.equal(spaces.body.total, 1);

  // Omitted search.
  const omitted = await req('GET', '/api/purchases', {
    token: adminToken,
    query: { page: 1, limit: 10 },
  });
  assert.equal(omitted.status, 200);
  assert.equal(omitted.body.total, 1);
});

test('T22 search handles special characters safely', async () => {
  const supplier = await createSupplier({ name: 'Special Chars Supplier', phone: '+2000000031' });
  const product = await createProduct({ name: 'Special Product', stock: 10, costPrice: 5, sellPrice: 10 });
  await req('POST', '/api/purchases', {
    token: adminToken,
    body: { supplierId: supplier.id, items: [{ productId: product.id, quantity: 1, unitCost: 5 }] },
  });

  // Search with SQL wildcard-like characters should not cause errors or unintended matches.
  const percent = await req('GET', '/api/purchases', {
    token: adminToken,
    query: { search: '%', page: 1, limit: 10 },
  });
  assert.equal(percent.status, 200);

  const quote = await req('GET', '/api/purchases', {
    token: adminToken,
    query: { search: "'", page: 1, limit: 10 },
  });
  assert.equal(quote.status, 200);

  const underscore = await req('GET', '/api/purchases', {
    token: adminToken,
    query: { search: '_', page: 1, limit: 10 },
  });
  assert.equal(underscore.status, 200);
});

test('T23 clearing search returns unfiltered list', async () => {
  const supplier = await createSupplier({ name: 'Clear Search Supplier', phone: '+2000000032' });
  const product = await createProduct({ name: 'Clear Search Product', stock: 10, costPrice: 5, sellPrice: 10 });
  await req('POST', '/api/purchases', {
    token: adminToken,
    body: { supplierId: supplier.id, items: [{ productId: product.id, quantity: 1, unitCost: 5 }] },
  });

  const withSearch = await req('GET', '/api/purchases', {
    token: adminToken,
    query: { search: 'Clear Search', page: 1, limit: 10 },
  });
  assert.equal(withSearch.status, 200);
  assert.equal(withSearch.body.total, 1);

  const withoutSearch = await req('GET', '/api/purchases', {
    token: adminToken,
    query: { page: 1, limit: 10 },
  });
  assert.equal(withoutSearch.status, 200);
  assert.equal(withoutSearch.body.total, 1);
  assert.equal(withoutSearch.body.purchases.length, 1);
});
