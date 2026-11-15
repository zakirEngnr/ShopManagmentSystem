// Unit tests for the expense edit API helper.
//
// Uses a fake Axios adapter, so no network and no mocking library is involved.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import client from '../src/api/client.js';
import { updateExpense } from '../src/api/expenses.js';

const EXPENSE = {
  id: 5,
  date: '2026-01-15',
  category: 'RENT',
  expenseName: 'Office Rent',
  description: 'Monthly rent',
  amount: 1200,
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
    requests.push({ url: config.url, method: config.method, data: config.data });
    if (status >= 400) {
      const err = new Error(`Request failed with status code ${status}`);
      err.response = { status, data: body };
      throw err;
    }
    return { data: body, status, statusText: 'OK', headers: {}, config, request: {} };
  };
}

test('updateExpense PATCHes the expense and returns the updated record', async () => {
  answerWith(200, { ok: true, expense: { ...EXPENSE, amount: 1300 } });

  const updated = await updateExpense(5, { amount: 1300 });

  assert.equal(requests.length, 1);
  assert.equal(requests[0].method, 'patch');
  assert.equal(requests[0].url, '/expenses/5');
  assert.deepEqual(JSON.parse(requests[0].data), { amount: 1300 });
  assert.deepEqual(updated, { ...EXPENSE, amount: 1300 });
});

test('updateExpense sends only the fields that changed', async () => {
  answerWith(200, { ok: true, expense: { ...EXPENSE, description: 'Updated rent' } });

  await updateExpense(5, { description: 'Updated rent' });

  assert.equal(requests.length, 1);
  assert.deepEqual(JSON.parse(requests[0].data), { description: 'Updated rent' });
});

test('updateExpense throws 404 for an unknown expense', async () => {
  answerWith(404, { ok: false, error: { message: 'Expense not found' } });

  await assert.rejects(() => updateExpense(999, { amount: 100 }), (err) => {
    assert.equal(err.response.status, 404);
    return true;
  });
});

test('updateExpense throws 400 for a validation failure', async () => {
  answerWith(400, { ok: false, error: { message: 'Amount must be greater than zero' } });

  await assert.rejects(() => updateExpense(5, { amount: -10 }), (err) => {
    assert.equal(err.response.status, 400);
    return true;
  });
});

test('updateExpense throws on a server failure', async () => {
  answerWith(500, { ok: false, error: { message: 'Internal server error' } });

  await assert.rejects(() => updateExpense(5, { amount: 100 }), (err) => {
    assert.equal(err.response.status, 500);
    return true;
  });
});

test('updateExpense refuses to call the backend without an id', async () => {
  await assert.rejects(() => updateExpense(null, { amount: 100 }), /Expense id is required/);
  assert.equal(requests.length, 0);
});
