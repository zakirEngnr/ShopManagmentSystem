// INTEGRATION regression test of the frontend API layer against the REAL
// backend and a DISPOSABLE database.
//
// Everything here runs against a throw-away database and the real backend:
//   * the disposable database is built by replaying the migration SQL with
//     node:sqlite (no Prisma CLI command, no development database);
//   * the real backend is started as a child process against that database;
//   * the real frontend API helpers are used, with a real HTTP round trip.
//
// The level under test here is the WIRE: which key is sent, which body is
// sent, and what the backend does with it.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { startDisposableBackend, installLosingAdapter } from '../support/disposableBackend.js';

import client from '../../src/api/client.js';
import { createSale } from '../../src/api/sales.js';
import { createPurchase, buildPurchasePayload } from '../../src/api/purchases.js';
import {
  recordSupplierPayment,
  buildSupplierPaymentPayload,
} from '../../src/api/suppliers.js';
import {
  recordCustomerPayment,
  recordCustomerDebt,
  buildCustomerPaymentPayload,
  buildCustomerDebtPayload,
} from '../../src/api/customers.js';

let backend;
let losing;

before(async () => {
  backend = await startDisposableBackend();
  client.defaults.baseURL = `${backend.base}/api`;

  // The shared client reads the Bearer token from localStorage.
  globalThis.localStorage = {
    getItem: (key) => (key === 'cosmetic-shop-token' ? backend.token : null),
    setItem: () => {},
    removeItem: () => {},
  };

  losing = installLosingAdapter(client);
});

after(() => {
  if (backend) backend.stop();
});

test('a repeated key replays the ORIGINAL transaction, whatever the body is', async () => {
  // The backend contract the frontend has to respect: the key is the
  // authority. A repeated key returns the record that was created first, so
  // a retry with a DIFFERENT body would silently replay the original
  // transaction. That is exactly why the frontend must preserve the body and
  // refuse to send a different one.
  const body = {
    paymentMethod: 'CASH',
    cashReceived: 20,
    discount: 0,
    items: [{ productId: 1, quantity: 2, unitPrice: 10 }],
  };
  const key = crypto.randomUUID();

  losing.lose = false;
  const first = await createSale(body, key);
  assert.ok(first.id, 'the first sale must be created');

  const second = await createSale({ ...body, items: [{ productId: 1, quantity: 9, unitPrice: 10 }] }, key);

  assert.equal(second.id, first.id, 'the backend must replay the original sale');
  assert.equal(backend.row('SELECT COUNT(*) c FROM "Sale"').c, 1, 'exactly one sale may exist');
  assert.equal(
    backend.row('SELECT stock FROM "Product" WHERE sku = ?', 'AUD-001').stock,
    98,
    'the stock must be decremented exactly once',
  );
});

test('a lost response leaves the transaction committed and the key reusable', async () => {
  const body = {
    paymentMethod: 'CASH',
    cashReceived: 10,
    discount: 0,
    items: [{ productId: 1, quantity: 1, unitPrice: 10 }],
  };
  const key = crypto.randomUUID();
  const salesBefore = backend.row('SELECT COUNT(*) c FROM "Sale"').c;
  const stockBefore = backend.row('SELECT stock FROM "Product" WHERE sku = ?', 'AUD-001').stock;

  // The request really reaches the server, but the answer never arrives.
  losing.lose = true;
  await assert.rejects(
    () => createSale(body, key),
    (err) => {
      assert.equal(err.response, undefined, 'the client must not have received a response');
      return true;
    },
  );

  assert.equal(backend.row('SELECT COUNT(*) c FROM "Sale" WHERE "idempotencyKey" = ?', key).c, 1);
  assert.equal(
    backend.row('SELECT stock FROM "Product" WHERE sku = ?', 'AUD-001').stock,
    stockBefore - 1,
    'the stock must already be decremented',
  );

  // The retry with the SAME key and the SAME body returns the original sale.
  losing.lose = false;
  const replay = await createSale(body, key);
  assert.equal(
    backend.row('SELECT COUNT(*) c FROM "Sale"').c,
    salesBefore + 1,
    'the retry must not create a second sale',
  );
  assert.equal(
    backend.row('SELECT COUNT(*) c FROM "SaleItem" WHERE "saleId" = ?', replay.id).c,
    1,
    'the sale must keep exactly one item',
  );
  assert.equal(
    backend.row('SELECT stock FROM "Product" WHERE sku = ?', 'AUD-001').stock,
    stockBefore - 1,
    'the stock must be decremented exactly once',
  );
});

test('POST /sales sends the key and the body unchanged', async () => {
  losing.lose = false;
  const body = {
    paymentMethod: 'CASH',
    cashReceived: 10,
    discount: 0,
    items: [{ productId: 1, quantity: 1, unitPrice: 10 }],
  };
  const key = crypto.randomUUID();

  await createSale(body, key);
  const row = backend.row('SELECT "idempotencyKey", total FROM "Sale" ORDER BY id DESC LIMIT 1');
  assert.equal(row.idempotencyKey, key);
  assert.equal(row.total, 10);
});

test('POST /purchases sends the key and the body unchanged', async () => {
  losing.lose = false;
  const supplier = await backend.api('POST', '/suppliers', { name: 'Wire Supplier' });
  const key = crypto.randomUUID();

  const body = buildPurchasePayload({
    supplierId: supplier.body.supplier.id,
    items: [{ productId: 1, quantity: 3, unitCost: 7 }],
  });

  await createPurchase(body, key);
  const row = backend.row('SELECT "idempotencyKey", "totalAmount" FROM "Purchase" ORDER BY id DESC LIMIT 1');
  assert.equal(row.idempotencyKey, key);
  assert.equal(row.totalAmount, 21);
});

test('POST /suppliers/:id/payment sends the key and the body unchanged', async () => {
  losing.lose = false;
  const supplier = await backend.api('POST', '/suppliers', { name: 'Wire Payable' });
  const supplierId = supplier.body.supplier.id;
  await backend.api('POST', '/purchases', {
    supplierId,
    items: [{ productId: 1, quantity: 2, unitCost: 10 }],
  });

  const key = crypto.randomUUID();
  await recordSupplierPayment(
    supplierId,
    buildSupplierPaymentPayload({ amount: 10, description: 'wire' }),
    key,
  );

  const row = backend.row('SELECT "idempotencyKey", amount FROM "SupplierPayment" ORDER BY id DESC LIMIT 1');
  assert.equal(row.idempotencyKey, key);
  assert.equal(row.amount, 10);
});

test('POST /customers/:id/payment sends the key and the body unchanged', async () => {
  losing.lose = false;
  const customer = backend.row('SELECT id FROM "Customer" WHERE type = ?', 'RETAIL');
  await backend.api('POST', '/sales', {
    paymentMethod: 'KHATA',
    customerId: customer.id,
    discount: 0,
    items: [{ productId: 1, quantity: 1, unitPrice: 30 }],
  });

  const key = crypto.randomUUID();
  await recordCustomerPayment(
    customer.id,
    buildCustomerPaymentPayload({ amount: 30, description: 'wire' }),
    key,
  );

  const row = backend.row(
    'SELECT "idempotencyKey", amount FROM "KhataTransaction" WHERE type = ? ORDER BY id DESC LIMIT 1',
    'PAYMENT',
  );
  assert.equal(row.idempotencyKey, key);
  assert.equal(row.amount, 30);
});

test('POST /customers/:id/debt sends the key and the body unchanged', async () => {
  losing.lose = false;
  const customer = backend.row('SELECT id FROM "Customer" WHERE type = ?', 'BUSINESS');
  const key = crypto.randomUUID();

  await recordCustomerDebt(
    customer.id,
    buildCustomerDebtPayload({ amount: 45, description: 'wire debt' }),
    key,
  );

  const row = backend.row(
    'SELECT "idempotencyKey", amount FROM "KhataTransaction" WHERE type = ? ORDER BY id DESC LIMIT 1',
    'DEBT',
  );
  assert.equal(row.idempotencyKey, key);
  assert.equal(row.amount, 45);
});
