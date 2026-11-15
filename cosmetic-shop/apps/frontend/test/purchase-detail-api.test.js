// Unit tests for the purchase detail API helper.
//
// Uses a fake Axios adapter, so no network and no mocking library is involved.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import client from '../src/api/client.js';
import { fetchPurchase } from '../src/api/purchases.js';

const PURCHASE = {
  id: 7,
  supplierId: 3,
  totalAmount: 200,
  paidAmount: 50,
  status: 'PARTIAL',
  idempotencyKey: 'key-123',
  createdAt: '2026-01-15T10:00:00Z',
  supplier: { id: 3, name: 'Audit Supplier', phone: '03001239999' },
  items: [
    {
      id: 1,
      purchaseId: 7,
      productId: 10,
      quantity: 2,
      unitCost: 40,
      total: 80,
      product: { id: 10, name: 'Soap', sku: 'S-10', barcode: '123', costPrice: 20, sellPrice: 50 },
    },
    {
      id: 2,
      purchaseId: 7,
      productId: 11,
      quantity: 1,
      unitCost: 120,
      total: 120,
      product: { id: 11, name: 'Lotion', sku: 'S-11', barcode: null, costPrice: 60, sellPrice: 100 },
    },
  ],
};

let requests = [];
let originalAdapter = null;

beforeEach(() => {
  requests = [];
  originalAdapter = client.defaults.adapter;
});

afterEach(() => {
  client.defaults.adapter = originalAdapter;
});

/** Install an adapter that answers with the given status and body. */
function answerWith(status, body) {
  client.defaults.adapter = async (config) => {
    requests.push({ url: config.url, method: config.method });
    if (status >= 400) {
      const err = new Error(`Request failed with status code ${status}`);
      err.response = { status, data: body };
      throw err;
    }
    return { data: body, status, statusText: 'OK', headers: {}, config, request: {} };
  };
}

test('fetchPurchase returns the purchase with supplier and line items', async () => {
  answerWith(200, { ok: true, purchase: PURCHASE });

  const purchase = await fetchPurchase(7);

  assert.equal(requests.length, 1);
  assert.equal(requests[0].method, 'get');
  assert.equal(requests[0].url, '/purchases/7');
  assert.deepEqual(purchase, PURCHASE);
  assert.equal(purchase.supplier.name, 'Audit Supplier');
  assert.equal(purchase.items.length, 2);
  // Historical amounts come from the stored line items (unitCost / total),
  // not from the current product price.
  assert.equal(purchase.items[0].unitCost, 40);
  assert.equal(purchase.items[0].total, 80);
  assert.equal(purchase.items[1].unitCost, 120);
  assert.equal(purchase.items[1].total, 120);
  assert.equal(purchase.items[0].product.name, 'Soap');
  assert.equal(purchase.items[1].product.name, 'Lotion');
});

test('fetchPurchase throws 404 for an unknown purchase', async () => {
  answerWith(404, { ok: false, error: { message: 'Purchase not found' } });

  await assert.rejects(() => fetchPurchase(999), (err) => {
    assert.equal(err.response.status, 404);
    return true;
  });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, '/purchases/999');
});

test('fetchPurchase throws on a server failure', async () => {
  answerWith(500, { ok: false, error: { message: 'Internal server error' } });

  await assert.rejects(() => fetchPurchase(7), (err) => {
    assert.equal(err.response.status, 500);
    return true;
  });
});

test('fetchPurchase throws on a malformed 2xx answer instead of reporting "not found"', async () => {
  answerWith(200, { ok: true });

  await assert.rejects(() => fetchPurchase(7), /Invalid purchase detail response/);
});

test('fetchPurchase refuses to call the backend without an id', async () => {
  await assert.rejects(() => fetchPurchase(null), /Purchase id is required/);
  await assert.rejects(() => fetchPurchase(undefined), /Purchase id is required/);
  assert.equal(requests.length, 0);
});
