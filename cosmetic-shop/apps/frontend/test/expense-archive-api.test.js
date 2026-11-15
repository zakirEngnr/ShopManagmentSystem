// Contract tests for the expense API helpers.
//
// Uses a fake Axios adapter, so no network and no mocking library is involved.
// The same convention as test/expense-edit-api.test.js.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import client from '../src/api/client.js';
import { deleteExpense, fetchExpenses, restoreExpense } from '../src/api/expenses.js';

let requests = [];
let originalAdapter = null;
let originalLocalStorage = null;

beforeEach(() => {
  requests = [];
  originalAdapter = client.defaults.adapter;
});

afterEach(() => {
  client.defaults.adapter = originalAdapter;
  if (originalLocalStorage === undefined) delete globalThis.localStorage;
  else globalThis.localStorage = originalLocalStorage;
});

/** Install an adapter that answers with the given status and body. */
function answerWith(status, body) {
  client.defaults.adapter = async (config) => {
    requests.push({
      url: config.url,
      method: config.method,
      params: config.params,
      data: config.data,
      headers: config.headers,
    });
    if (status >= 400) {
      const err = new Error(`Request failed with status code ${status}`);
      err.response = { status, data: body };
      throw err;
    }
    return { data: body, status, statusText: 'OK', headers: {}, config, request: {} };
  };
}

/** A well formed list answer. */
function listBody(overrides = {}) {
  return {
    ok: true,
    items: [],
    total: 0,
    page: 1,
    limit: 100,
    totalPages: 0,
    cumulativeTotals: [],
    ...overrides,
  };
}

/* ------------------------------------------------------------------ */
/* the list request                                                    */
/* ------------------------------------------------------------------ */

test('fetchExpenses asks for the active expenses and sends no includeDeleted', async () => {
  answerWith(200, listBody());

  await fetchExpenses(1, 100, { expenseName: undefined, from: undefined, to: undefined });

  assert.equal(requests.length, 1);
  assert.equal(requests[0].method, 'get');
  assert.equal(requests[0].url, '/expenses');
  assert.equal(requests[0].params.page, 1);
  assert.equal(requests[0].params.limit, 100);
  assert.equal(requests[0].params.includeDeleted, undefined, 'the active view must not ask for the deleted expenses');

  // The URL that really goes on the wire: an empty filter is not sent.
  assert.equal(client.getUri({ url: '/expenses', params: requests[0].params }), '/api/expenses?page=1&limit=100');
});

test('fetchExpenses sends the search and the date filters', async () => {
  answerWith(200, listBody());

  await fetchExpenses(1, 100, { expenseName: 'Rent', from: '2026-01-01', to: '2026-01-31' });

  assert.deepEqual(requests[0].params, {
    page: 1,
    limit: 100,
    expenseName: 'Rent',
    from: '2026-01-01',
    to: '2026-01-31',
  });
});

test('fetchExpenses asks for the deleted expenses with includeDeleted=true', async () => {
  answerWith(200, listBody());

  await fetchExpenses(1, 100, { includeDeleted: 'true' });

  assert.equal(requests[0].params.includeDeleted, 'true');
});

test('fetchExpenses asks for the archived expenses only with includeDeleted=only', async () => {
  answerWith(200, listBody());

  await fetchExpenses(1, 100, { includeDeleted: 'only' });

  assert.equal(requests[0].params.includeDeleted, 'only');
  assert.equal(
    client.getUri({ url: '/expenses', params: requests[0].params }),
    '/api/expenses?page=1&limit=100&includeDeleted=only',
  );
});

test('fetchExpenses returns the items and the cumulative totals', async () => {
  const item = { id: 1, description: 'Rent', amount: 100, deletedAt: null };
  answerWith(200, listBody({
    items: [item],
    total: 1,
    totalPages: 1,
    cumulativeTotals: [{ expenseName: 'Rent', total: 100 }],
  }));

  const result = await fetchExpenses(1, 100);

  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].description, 'Rent');
  assert.deepEqual(result.cumulativeTotals, [{ expenseName: 'Rent', total: 100 }]);
  assert.equal(result.totalPages, 1);
});

test('fetchExpenses refuses a malformed answer', async () => {
  answerWith(200, { ok: false, items: [] });

  await assert.rejects(() => fetchExpenses(1, 100), /Malformed expense list response/);
});

test('fetchExpenses refuses an answer without pagination metadata', async () => {
  answerWith(200, { ok: true, items: [], total: 0 });

  await assert.rejects(() => fetchExpenses(1, 100), /missing pagination metadata/);
});

test('fetchExpenses passes a server failure on', async () => {
  answerWith(500, { ok: false, error: { message: 'Internal server error' } });

  await assert.rejects(() => fetchExpenses(1, 100), (err) => {
    assert.equal(err.response.status, 500);
    return true;
  });
});

/* ------------------------------------------------------------------ */
/* the restore request                                                 */
/* ------------------------------------------------------------------ */

test('restoreExpense POSTs to the restore endpoint of the expense', async () => {
  const expense = { id: 5, description: 'Rent', amount: 100, deletedAt: null };
  answerWith(200, { ok: true, expense });

  const restored = await restoreExpense(5);

  assert.equal(requests.length, 1);
  assert.equal(requests[0].method, 'post');
  assert.equal(requests[0].url, '/expenses/5/restore');
  assert.equal(requests[0].data, undefined, 'the restore request must not carry a body');
  assert.deepEqual(restored, expense);
});

test('restoreExpense refuses to call the backend without an id', async () => {
  await assert.rejects(() => restoreExpense(null), /Expense id is required/);
  assert.equal(requests.length, 0);
});

test('restoreExpense refuses a malformed answer', async () => {
  answerWith(200, { ok: true });

  await assert.rejects(() => restoreExpense(5), /Malformed restore expense response/);
});

test('restoreExpense keeps the answer of the server on the rejection', async () => {
  answerWith(404, { ok: false, error: { message: 'Expense not found' } });

  await assert.rejects(() => restoreExpense(999), (err) => {
    assert.equal(err.response.status, 404);
    assert.equal(err.response.data.error.message, 'Expense not found');
    return true;
  });
});

/* ------------------------------------------------------------------ */
/* the delete request and the authentication                            */
/* ------------------------------------------------------------------ */

test('deleteExpense DELETEs the expense', async () => {
  answerWith(200, { ok: true });

  await deleteExpense(5);

  assert.equal(requests.length, 1);
  assert.equal(requests[0].method, 'delete');
  assert.equal(requests[0].url, '/expenses/5');
});

test('the client sends the stored token as a Bearer credential', async () => {
  originalLocalStorage = globalThis.localStorage;
  globalThis.localStorage = {
    getItem: (key) => (key === 'cosmetic-shop-token' ? 'test-token' : null),
  };
  answerWith(200, { ok: true, expense: { id: 5 } });

  await restoreExpense(5);

  assert.equal(requests[0].headers.Authorization, 'Bearer test-token');
});

test('the client sends no credential when no token is stored', async () => {
  originalLocalStorage = globalThis.localStorage;
  globalThis.localStorage = { getItem: () => null };
  answerWith(200, { ok: true, expense: { id: 5 } });

  await restoreExpense(5);

  assert.equal(requests[0].headers.Authorization, undefined);
});
