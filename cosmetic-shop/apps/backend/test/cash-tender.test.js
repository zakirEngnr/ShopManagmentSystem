// Behavioural tests for the CASH tender of a sale.
//
// The tender is what the customer handed over. It is stored next to the sale,
// it never replaces the sale total, and it is compared against the total in
// INTEGER PAISA so that a one-paisa difference is exact.
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

let prisma;
let app;
let adminToken;
let ctx;
let categoryId;
let brandId;
let seq = 0;

before(async () => {
  ctx = await createTempDb({ prefix: 'cash-tender-', backendDir });
  const { dbUrl, realTmp } = ctx;
  assertTmpDbUrl(dbUrl, realTmp);
  const db = await import(backendUrl + 'src/db/prisma.js');
  prisma = db.prisma;
  assert.equal(process.env.DATABASE_URL, dbUrl);
  app = (await import(backendUrl + 'src/app.js')).createApp();
  const admin = await createUser(prisma, { role: 'ADMIN', tag: 'cash-tender-admin' });
  adminToken = signToken(admin);
  categoryId = (await prisma.category.create({ data: { name: 'CashTenderCat', type: 'COSMETIC' } })).id;
  brandId = (await prisma.brand.create({ data: { name: 'CashTenderBrand' } })).id;
});

after(async () => {
  if (prisma) {
    try { await prisma.$disconnect(); } catch {}
  }
  if (ctx) ctx.cleanup();
});

/** Send a request. `rawBody` is sent verbatim, `body` is serialised as JSON. */
function doReq(method, full, tok, rawBody, idempotencyKey) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      const headers = { Accept: 'application/json' };
      if (rawBody !== null) {
        headers['Content-Type'] = 'application/json';
        headers['Content-Length'] = Buffer.byteLength(rawBody);
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
      if (rawBody !== null) r.write(rawBody);
      r.end();
    });
  });
}

function req(method, urlPath, opts = {}) {
  const payload = opts.body === undefined ? null : JSON.stringify(opts.body);
  return doReq(method, urlPath, opts.token, payload, opts.idempotencyKey);
}

async function createProduct(overrides = {}) {
  seq += 1;
  return prisma.product.create({
    data: {
      sku: `CASH-${Date.now()}-${seq}`,
      name: 'Cash Tender Product',
      type: 'COSMETIC',
      costPrice: 5,
      sellPrice: 10,
      stock: 100,
      categoryId,
      brandId,
      ...overrides,
    },
  });
}

async function createCustomer(overrides = {}) {
  seq += 1;
  return prisma.customer.create({
    data: { name: `Cash Tender Customer ${seq}`, phone: `+9${String(seq).padStart(8, '0')}`, type: 'RETAIL', ...overrides },
  });
}

function uuid() {
  return crypto.randomUUID();
}

/* ------------------------------------------------------------------ */
/* 1 & 2. Exact payment and overpayment                                */
/* ------------------------------------------------------------------ */

test('CASH: an exact payment is accepted and the tender is persisted', async () => {
  const product = await createProduct();
  const res = await req('POST', '/api/sales', {
    token: adminToken,
    body: {
      paymentMethod: 'CASH',
      cashReceived: 20,
      items: [{ productId: product.id, quantity: 2, unitPrice: 10 }],
    },
  });

  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(res.body.sale.total, 20);
  assert.equal(res.body.sale.cashReceived, 20, 'the tender must be persisted');

  const row = await prisma.sale.findUnique({ where: { id: res.body.sale.id } });
  assert.equal(row.cashReceived, 20, 'the Sale row must store the tender');
  assert.equal(row.total, 20);
});

test('CASH: an overpayment is accepted, the tender is stored and the change is exact', async () => {
  const product = await createProduct();
  const res = await req('POST', '/api/sales', {
    token: adminToken,
    body: {
      paymentMethod: 'CASH',
      cashReceived: 50,
      items: [{ productId: product.id, quantity: 2, unitPrice: 10 }],
    },
  });

  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(res.body.sale.total, 20, 'the total must stay the sale amount');
  assert.equal(res.body.sale.cashReceived, 50, 'the tender must be stored');

  // The change is derived from the stored tender and the stored total.
  const changePaisa = Math.round(res.body.sale.cashReceived * 100) - Math.round(res.body.sale.total * 100);
  assert.equal(changePaisa, 3000, 'the change must be 30.00');
});

/* ------------------------------------------------------------------ */
/* 3 & 4. Insufficient tender                                          */
/* ------------------------------------------------------------------ */

test('CASH: a tender that is one paisa short is rejected', async () => {
  const product = await createProduct();
  const salesBefore = await prisma.sale.count();
  const res = await req('POST', '/api/sales', {
    token: adminToken,
    body: {
      paymentMethod: 'CASH',
      cashReceived: 19.99,
      items: [{ productId: product.id, quantity: 2, unitPrice: 10 }],
    },
  });

  assert.equal(res.status, 400, JSON.stringify(res.body));
  assert.equal(await prisma.sale.count(), salesBefore, 'no sale may be created');
});

test('CASH: an insufficient tender is rejected and creates no sale', async () => {
  const product = await createProduct();
  const salesBefore = await prisma.sale.count();
  const itemsBefore = await prisma.saleItem.count();
  const stockBefore = (await prisma.product.findUnique({ where: { id: product.id } })).stock;

  const res = await req('POST', '/api/sales', {
    token: adminToken,
    body: {
      paymentMethod: 'CASH',
      cashReceived: 5,
      items: [{ productId: product.id, quantity: 1, unitPrice: 10 }],
    },
  });

  assert.equal(res.status, 400, JSON.stringify(res.body));
  assert.match(String(res.body.error.message), /less than/i);
  assert.equal(await prisma.sale.count(), salesBefore, 'no sale may be created');
  assert.equal(await prisma.saleItem.count(), itemsBefore, 'no sale item may be created');
  assert.equal((await prisma.product.findUnique({ where: { id: product.id } })).stock, stockBefore, 'the stock must be untouched');
});

/* ------------------------------------------------------------------ */
/* 5, 6, 7, 8, 9. Missing, null, negative, invalid, imprecise tender   */
/* ------------------------------------------------------------------ */

test('CASH: a missing tender is rejected', async () => {
  const product = await createProduct();
  const res = await req('POST', '/api/sales', {
    token: adminToken,
    body: {
      paymentMethod: 'CASH',
      items: [{ productId: product.id, quantity: 1, unitPrice: 10 }],
    },
  });

  assert.equal(res.status, 400, JSON.stringify(res.body));
  assert.match(String(res.body.error.message), /cashReceived is required/i);
});

test('CASH: an explicit null tender is rejected', async () => {
  const product = await createProduct();
  const salesBefore = await prisma.sale.count();
  const res = await req('POST', '/api/sales', {
    token: adminToken,
    body: {
      paymentMethod: 'CASH',
      cashReceived: null,
      items: [{ productId: product.id, quantity: 1, unitPrice: 10 }],
    },
  });

  assert.equal(res.status, 400, JSON.stringify(res.body));
  assert.match(String(res.body.error.message), /cashReceived is required/i);
  assert.equal(await prisma.sale.count(), salesBefore, 'no sale may be created');
});

test('CASH: a negative tender is rejected', async () => {
  const product = await createProduct();
  const salesBefore = await prisma.sale.count();
  const res = await req('POST', '/api/sales', {
    token: adminToken,
    body: {
      paymentMethod: 'CASH',
      cashReceived: -50,
      items: [{ productId: product.id, quantity: 1, unitPrice: 10 }],
    },
  });

  assert.equal(res.status, 400, JSON.stringify(res.body));
  assert.match(String(res.body.error.message), /negative/i);
  assert.equal(await prisma.sale.count(), salesBefore, 'no sale may be created');
});

test('CASH: a tender that is not a number is rejected', async () => {
  const product = await createProduct();
  const res = await req('POST', '/api/sales', {
    token: adminToken,
    body: {
      paymentMethod: 'CASH',
      cashReceived: 'ten',
      items: [{ productId: product.id, quantity: 1, unitPrice: 10 }],
    },
  });

  assert.equal(res.status, 400, JSON.stringify(res.body));
});

test('CASH: a non-finite tender is rejected', async () => {
  const product = await createProduct();
  // 1e999 is valid JSON and parses to Infinity.
  const raw = `{"paymentMethod":"CASH","cashReceived":1e999,"items":[{"productId":${product.id},"quantity":1,"unitPrice":10}]}`;
  const res = await doReq('POST', '/api/sales', adminToken, raw);

  assert.equal(res.status, 400, JSON.stringify(res.body));
});

test('CASH: a tender with more than two decimals is rejected', async () => {
  const product = await createProduct();
  const res = await req('POST', '/api/sales', {
    token: adminToken,
    body: {
      paymentMethod: 'CASH',
      cashReceived: 10.123,
      items: [{ productId: product.id, quantity: 1, unitPrice: 10 }],
    },
  });

  assert.equal(res.status, 400, JSON.stringify(res.body));
});

/* ------------------------------------------------------------------ */
/* 10 & 11. The other payment methods                                  */
/* ------------------------------------------------------------------ */

for (const method of ['CARD', 'JAZZCASH', 'MOBILE']) {
  test(`${method}: an omitted tender is accepted and stored as NULL`, async () => {
    const product = await createProduct();
    const res = await req('POST', '/api/sales', {
      token: adminToken,
      body: {
        paymentMethod: method,
        items: [{ productId: product.id, quantity: 1, unitPrice: 10 }],
      },
    });

    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.sale.cashReceived, null);
    const row = await prisma.sale.findUnique({ where: { id: res.body.sale.id } });
    assert.equal(row.cashReceived, null, 'the Sale row must store NULL');
  });

  test(`${method}: an explicit null tender is accepted and stored as NULL`, async () => {
    const product = await createProduct();
    const res = await req('POST', '/api/sales', {
      token: adminToken,
      body: {
        paymentMethod: method,
        cashReceived: null,
        items: [{ productId: product.id, quantity: 1, unitPrice: 10 }],
      },
    });

    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.sale.cashReceived, null);
  });

  test(`${method}: a non-null tender is rejected`, async () => {
    const product = await createProduct();
    const salesBefore = await prisma.sale.count();
    const res = await req('POST', '/api/sales', {
      token: adminToken,
      body: {
        paymentMethod: method,
        cashReceived: 100,
        items: [{ productId: product.id, quantity: 1, unitPrice: 10 }],
      },
    });

    assert.equal(res.status, 400, JSON.stringify(res.body));
    assert.match(String(res.body.error.message), /not applicable/i);
    assert.equal(await prisma.sale.count(), salesBefore, 'no sale may be created');
  });
}

/* ------------------------------------------------------------------ */
/* 12. KHATA                                                            */
/* ------------------------------------------------------------------ */

test('KHATA: the tender is NULL and the ledger behaviour is unchanged', async () => {
  const customer = await createCustomer();
  const product = await createProduct();
  const res = await req('POST', '/api/sales', {
    token: adminToken,
    body: {
      paymentMethod: 'KHATA',
      customerId: customer.id,
      items: [{ productId: product.id, quantity: 2, unitPrice: 10 }],
    },
  });

  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(res.body.sale.cashReceived, null, 'a KHATA sale stores no tender');
  assert.equal(res.body.sale.total, 20);
  assert.equal(res.body.sale.recognizedAmount, 0, 'a KHATA sale recognizes nothing up front');

  const ledger = await prisma.khataTransaction.count({ where: { customerId: customer.id, type: 'SALE' } });
  assert.equal(ledger, 1, 'exactly one ledger entry');
  const updated = await prisma.customer.findUnique({ where: { id: customer.id } });
  assert.equal(Number(updated.balance), 20, 'the customer owes the sale amount');
});

test('KHATA: a non-null tender is rejected', async () => {
  const customer = await createCustomer();
  const product = await createProduct();
  const res = await req('POST', '/api/sales', {
    token: adminToken,
    body: {
      paymentMethod: 'KHATA',
      customerId: customer.id,
      cashReceived: 100,
      items: [{ productId: product.id, quantity: 1, unitPrice: 10 }],
    },
  });

  assert.equal(res.status, 400, JSON.stringify(res.body));
  assert.match(String(res.body.error.message), /not applicable/i);
});

/* ------------------------------------------------------------------ */
/* 13, 14, 15, 18. Idempotency                                          */
/* ------------------------------------------------------------------ */

test('the same idempotency key and the same tender return the original sale', async () => {
  const product = await createProduct();
  const key = uuid();
  const body = {
    paymentMethod: 'CASH',
    cashReceived: 20,
    items: [{ productId: product.id, quantity: 2, unitPrice: 10 }],
  };

  const first = await req('POST', '/api/sales', { token: adminToken, body, idempotencyKey: key });
  assert.equal(first.status, 201, JSON.stringify(first.body));

  const second = await req('POST', '/api/sales', { token: adminToken, body, idempotencyKey: key });
  assert.equal(second.status, 201, JSON.stringify(second.body));
  assert.equal(second.body.sale.id, first.body.sale.id, 'the retry must return the original sale');
  assert.equal(second.body.sale.cashReceived, 20, 'the retry must return the original tender');
  assert.equal(second.body.sale.invoiceNo, first.body.sale.invoiceNo);

  assert.equal(await prisma.sale.count({ where: { idempotencyKey: key } }), 1, 'exactly one sale');
});

test('the same idempotency key with a changed tender returns the original sale and tender', async () => {
  const product = await createProduct();
  const key = uuid();

  const first = await req('POST', '/api/sales', {
    token: adminToken,
    body: {
      paymentMethod: 'CASH',
      cashReceived: 20,
      items: [{ productId: product.id, quantity: 2, unitPrice: 10 }],
    },
    idempotencyKey: key,
  });
  assert.equal(first.status, 201, JSON.stringify(first.body));

  // The same key with a different tender must NOT change the stored sale.
  const second = await req('POST', '/api/sales', {
    token: adminToken,
    body: {
      paymentMethod: 'CASH',
      cashReceived: 999,
      items: [{ productId: product.id, quantity: 2, unitPrice: 10 }],
    },
    idempotencyKey: key,
  });
  assert.equal(second.status, 201, JSON.stringify(second.body));
  assert.equal(second.body.sale.id, first.body.sale.id, 'the original sale must be returned');
  assert.equal(second.body.sale.cashReceived, 20, 'the original tender must be returned');

  const rows = await prisma.sale.findMany({ where: { idempotencyKey: key } });
  assert.equal(rows.length, 1, 'no second sale may be created');
  assert.equal(Number(rows[0].cashReceived), 20, 'the stored tender must not be overwritten');
});

test('concurrent duplicate requests with the same key create exactly one sale', async () => {
  const product = await createProduct();
  const key = uuid();
  const body = {
    paymentMethod: 'CASH',
    cashReceived: 20,
    items: [{ productId: product.id, quantity: 2, unitPrice: 10 }],
  };

  const results = await Promise.all(
    Array.from({ length: 5 }, () => req('POST', '/api/sales', { token: adminToken, body, idempotencyKey: key })),
  );

  assert.ok(results.every((r) => r.status === 201), `all requests must succeed: ${JSON.stringify(results.map((r) => r.status))}`);
  const ids = results.map((r) => r.body?.sale?.id);
  assert.ok(ids.every((id) => id === ids[0]), `all responses must return the same sale id: ${ids.join(',')}`);

  assert.equal(await prisma.sale.count({ where: { idempotencyKey: key } }), 1, 'exactly one sale');
  assert.equal((await prisma.product.findUnique({ where: { id: product.id } })).stock, 98, 'the stock must be decremented once');
});

test('an idempotent retry has no second stock decrement, invoice number or sale item', async () => {
  const product = await createProduct();
  const key = uuid();
  const body = {
    paymentMethod: 'CASH',
    cashReceived: 20,
    items: [{ productId: product.id, quantity: 2, unitPrice: 10 }],
  };

  const counterKey = `invoice-${new Date().getFullYear()}`;
  const first = await req('POST', '/api/sales', { token: adminToken, body, idempotencyKey: key });
  assert.equal(first.status, 201, JSON.stringify(first.body));

  const counterAfterFirst = (await prisma.counter.findUnique({ where: { key: counterKey } }))?.value ?? 0;
  const stockAfterFirst = (await prisma.product.findUnique({ where: { id: product.id } })).stock;
  const salesAfterFirst = await prisma.sale.count();

  const second = await req('POST', '/api/sales', { token: adminToken, body, idempotencyKey: key });
  assert.equal(second.status, 201);
  assert.equal(second.body.sale.id, first.body.sale.id);

  assert.equal(await prisma.sale.count(), salesAfterFirst, 'no second sale row');
  assert.equal((await prisma.product.findUnique({ where: { id: product.id } })).stock, stockAfterFirst, 'the stock must not be decremented again');
  const counterAfterSecond = (await prisma.counter.findUnique({ where: { key: counterKey } }))?.value ?? 0;
  assert.equal(counterAfterSecond, counterAfterFirst, 'the invoice counter must not advance again');
  assert.equal(await prisma.saleItem.count({ where: { saleId: first.body.sale.id } }), 1, 'exactly one sale item');
});

/* ------------------------------------------------------------------ */
/* 16. Historical rows                                                  */
/* ------------------------------------------------------------------ */

test('a historical sale row without a tender stays readable with NULL', async () => {
  const created = await prisma.sale.create({
    data: {
      invoiceNo: `CASH-TENDER-HIST-${Date.now()}`,
      subtotal: 10,
      discount: 0,
      total: 10,
      recognizedAmount: 10,
      paymentMethod: 'CASH',
      createdAt: new Date(),
    },
  });

  const found = await prisma.sale.findUnique({ where: { id: created.id } });
  assert.equal(found.cashReceived, null, 'a historical row has no tender');
  assert.equal(found.total, 10, 'the historical total must not change');
  assert.equal(found.recognizedAmount, 10, 'the historical recognized amount must not change');
});

/* ------------------------------------------------------------------ */
/* 17. The total and the recognized amount are independent of the tender */
/* ------------------------------------------------------------------ */

test('the sale total and the recognized amount do not depend on the tender', async () => {
  const product = await createProduct();

  const exact = await req('POST', '/api/sales', {
    token: adminToken,
    body: {
      paymentMethod: 'CASH',
      cashReceived: 30,
      items: [{ productId: product.id, quantity: 3, unitPrice: 10 }],
    },
  });
  assert.equal(exact.status, 201, JSON.stringify(exact.body));

  const over = await req('POST', '/api/sales', {
    token: adminToken,
    body: {
      paymentMethod: 'CASH',
      cashReceived: 100,
      items: [{ productId: product.id, quantity: 3, unitPrice: 10 }],
    },
  });
  assert.equal(over.status, 201, JSON.stringify(over.body));

  assert.equal(exact.body.sale.total, 30);
  assert.equal(over.body.sale.total, 30, 'the tender must not change the total');
  assert.equal(exact.body.sale.recognizedAmount, 30);
  assert.equal(over.body.sale.recognizedAmount, 30, 'the recognized amount is the sale amount, not the tender');
  assert.equal(exact.body.sale.cashReceived, 30);
  assert.equal(over.body.sale.cashReceived, 100);
});
