// INTEGRATION test of the archived / restored expenses against the REAL
// backend and a DISPOSABLE database.
//
// Everything here runs against a throw-away database and the real backend:
//   * the disposable database is built by replaying the migration SQL with
//     node:sqlite (no Prisma CLI command, no development database);
//   * the real backend is started as a child process against that database;
//   * the real frontend API helpers are used, with a real HTTP round trip.
//
// The level under test here is the DATA: which rows the backend returns,
// which rows it keeps in the database and what the cumulative totals contain.
// A successful HTTP answer is not proof of that, so the rows of the
// disposable database are read directly.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';

import { startDisposableBackend } from '../support/disposableBackend.js';

import client from '../../src/api/client.js';
import { createExpense, deleteExpense, fetchExpenses, restoreExpense } from '../../src/api/expenses.js';

let backend;

before(async () => {
  backend = await startDisposableBackend();
  client.defaults.baseURL = `${backend.base}/api`;

  // The shared client reads the Bearer token from localStorage.
  globalThis.localStorage = {
    getItem: (key) => (key === 'cosmetic-shop-token' ? backend.token : null),
    setItem: () => {},
    removeItem: () => {},
  };
});

after(() => {
  if (backend) backend.stop();
});

/** Create an expense through the real API. */
async function newExpense(overrides = {}) {
  const created = await createExpense({
    date: '2026-11-01T00:00:00.000Z',
    category: 'RENT',
    expenseName: 'Integration Head',
    description: 'Integration rent',
    amount: 100,
    ...overrides,
  });
  return created;
}

/** The row of the expense in the disposable database. */
function rowOf(id) {
  return backend.row('SELECT id, description, amount, expenseName, deletedAt FROM Expense WHERE id = ?', id);
}

/** The history rows of the expense in the disposable database. */
function historyOf(id) {
  return backend.rows('SELECT id, action FROM ExpenseHistory WHERE expenseId = ? ORDER BY id', id);
}

/** The total of one head of the cumulative totals of an answer. */
function totalOf(list, expenseName) {
  const head = list.cumulativeTotals.find((row) => row.expenseName === expenseName);
  return head ? Number(head.total) : undefined;
}

/** Every row of the expense table of the disposable database. */
function everyExpenseRow() {
  return backend.rows('SELECT id, description, amount, expenseName, deletedAt FROM Expense ORDER BY id');
}

test('the test runs against a disposable database and never against the shop database', () => {
  assert.ok(
    backend.dbPath.startsWith(os.tmpdir()),
    `the database must live in the temporary directory, not in the project: ${backend.dbPath}`,
  );
  assert.ok(!backend.dbPath.endsWith('shop.db'), 'the development database must never be used');
});

test('an archived expense leaves the active list and stays in the database', async () => {
  const expense = await newExpense({ description: 'To be archived', amount: 300 });

  const before = await fetchExpenses(1, 100);
  assert.ok(
    before.items.some((item) => item.id === expense.id),
    'the expense must be in the active list before it is archived',
  );

  await deleteExpense(expense.id);

  const row = rowOf(expense.id);
  assert.ok(row, 'the row of an archived expense must still exist');
  assert.ok(row.deletedAt, 'the row must carry the archive marker');

  const after = await fetchExpenses(1, 100);
  assert.equal(
    after.items.some((item) => item.id === expense.id),
    false,
    'an archived expense must not be in the active list',
  );
});

test('the active totals do not contain the archived expense', async () => {
  const expense = await newExpense({ description: 'Totals head', expenseName: 'Totals Head', amount: 700 });

  await deleteExpense(expense.id);

  const list = await fetchExpenses(1, 100);
  const head = list.cumulativeTotals.find((row) => row.expenseName === 'Totals Head');

  assert.equal(head, undefined, 'the head of an archived expense must not be in the active totals');
});

test('the archived request returns the archived expense and keeps its amount', async () => {
  const expense = await newExpense({ description: 'Archived row', expenseName: 'Archived Head', amount: 250 });
  await deleteExpense(expense.id);

  const list = await fetchExpenses(1, 100, { includeDeleted: 'true' });
  const archived = list.items.find((item) => item.id === expense.id);

  assert.ok(archived, 'the archived expense must be in the archived list');
  assert.ok(archived.deletedAt, 'the archived expense must carry the archive marker');
  assert.equal(Number(archived.amount), 250, 'the amount of an archived expense must not change');
});

test('a restoration makes the expense active again', async () => {
  const expense = await newExpense({ description: 'To be restored', amount: 400 });
  await deleteExpense(expense.id);

  const restored = await restoreExpense(expense.id);

  assert.ok(restored, 'the restore must answer with the expense');
  assert.equal(restored.deletedAt, null, 'the restored expense must not be archived any more');

  const row = rowOf(expense.id);
  assert.equal(row.deletedAt, null, 'the row of the database must not be archived any more');

  const active = await fetchExpenses(1, 100);
  assert.ok(
    active.items.some((item) => item.id === expense.id),
    'the restored expense must be in the active list',
  );

  const archived = await fetchExpenses(1, 100, { includeDeleted: 'true' });
  const stillArchived = archived.items.find((item) => item.id === expense.id);
  assert.equal(
    stillArchived?.deletedAt ?? null,
    null,
    'the restored expense must not be in the archived list any more',
  );
});

test('a restoration and an archive are written to the history of the expense', async () => {
  const expense = await newExpense({ description: 'Audited expense', amount: 120 });

  await deleteExpense(expense.id);
  await restoreExpense(expense.id);

  const history = historyOf(expense.id);
  const actions = history.map((entry) => entry.action);

  assert.ok(actions.includes('DELETE'), 'the archive must be written to the history');
  assert.ok(actions.includes('RESTORE'), 'the restoration must be written to the history');
});

test('restoring an expense that is not archived changes nothing', async () => {
  const expense = await newExpense({ description: 'Never archived', amount: 60 });
  const historyBefore = historyOf(expense.id).length;

  const restored = await restoreExpense(expense.id);

  assert.ok(restored, 'the restore must answer with the expense');
  assert.equal(restored.deletedAt, null);
  assert.equal(rowOf(expense.id).deletedAt, null);
  assert.equal(historyOf(expense.id).length, historyBefore, 'no history row may be written');
});

test('restoring an expense that does not exist answers 404', async () => {
  await assert.rejects(
    () => restoreExpense(999999),
    (error) => {
      assert.equal(error.response.status, 404);
      assert.equal(error.response.data.error.message, 'Expense not found');
      return true;
    },
  );
});

test('restoring without a credential answers 401', async () => {
  const response = await fetch(`${backend.base}/api/expenses/1/restore`, { method: 'POST' });

  assert.equal(response.status, 401);
  const body = await response.json();
  assert.equal(body.ok, false);
  assert.ok(body.error.message, 'the answer must carry a message');
});

test('a repeated restoration behaves the same way', async () => {
  const expense = await newExpense({ description: 'Twice restored', amount: 90 });
  await deleteExpense(expense.id);

  const first = await restoreExpense(expense.id);
  const second = await restoreExpense(expense.id);

  assert.equal(first.deletedAt, null);
  assert.equal(second.deletedAt, null);
  assert.equal(Number(second.amount), 90, 'the amount must not change');
  assert.equal(rowOf(expense.id).deletedAt, null);
});

/* ------------------------------------------------------------------ */
/* the archived totals, against the rows of the database                */
/* ------------------------------------------------------------------ */

test('the archived list and the archived totals contain the archived expenses only', async () => {
  const head = `Totals Head ${Date.now()}`;
  const active = await newExpense({ description: 'Totals active', expenseName: head, amount: 100 });
  const archived = await newExpense({ description: 'Totals archived', expenseName: head, amount: 250 });

  await deleteExpense(archived.id);

  // The database is the authority.
  const rows = everyExpenseRow();
  const archivedRows = rows.filter((row) => row.deletedAt);
  const activeRows = rows.filter((row) => !row.deletedAt);
  assert.ok(archivedRows.some((row) => row.id === archived.id), 'the archived row must be in the database');
  assert.ok(activeRows.some((row) => row.id === active.id), 'the active row must be in the database');

  const archivedList = await fetchExpenses(1, 100, { includeDeleted: 'only' });

  assert.ok(
    archivedList.items.every((item) => item.deletedAt),
    'every row of the archived list must be archived',
  );
  assert.equal(
    archivedList.items.some((item) => item.id === active.id),
    false,
    'the active expense must not be in the archived list',
  );
  assert.equal(
    totalOf(archivedList, head),
    250,
    'the archived total must be the amount of the archived expense only',
  );

  const activeList = await fetchExpenses(1, 100);
  assert.equal(
    totalOf(activeList, head),
    100,
    'the active total must be the amount of the active expense only',
  );
});

test('the archived totals follow the archive state of the database', async () => {
  const head = `Follow Head ${Date.now()}`;
  const expense = await newExpense({ description: 'Followed expense', expenseName: head, amount: 320 });

  await deleteExpense(expense.id);
  assert.equal(totalOf(await fetchExpenses(1, 100, { includeDeleted: 'only' }), head), 320);
  assert.equal(totalOf(await fetchExpenses(1, 100), head), undefined);

  await restoreExpense(expense.id);
  assert.equal(totalOf(await fetchExpenses(1, 100, { includeDeleted: 'only' }), head), undefined);
  assert.equal(totalOf(await fetchExpenses(1, 100), head), 320);
  assert.equal(rowOf(expense.id).deletedAt, null, 'the row of the database must be active again');
});

test('the archived totals of several heads are the sums of the archived rows only', async () => {
  const stamp = Date.now();
  const first = `Multi Head A ${stamp}`;
  const second = `Multi Head B ${stamp}`;

  await newExpense({ description: 'Multi A active', expenseName: first, amount: 10 });
  const firstArchived = await newExpense({ description: 'Multi A archived', expenseName: first, amount: 20 });
  await newExpense({ description: 'Multi B active', expenseName: second, amount: 30 });
  const secondArchived = await newExpense({ description: 'Multi B archived', expenseName: second, amount: 40 });

  await deleteExpense(firstArchived.id);
  await deleteExpense(secondArchived.id);

  // The database is the authority.
  const rows = everyExpenseRow();
  const archivedRows = rows.filter((row) => row.deletedAt);

  const list = await fetchExpenses(1, 100, { includeDeleted: 'only' });
  const expectedFirst = archivedRows
    .filter((row) => row.expenseName === first)
    .reduce((sum, row) => sum + Number(row.amount), 0);
  const expectedSecond = archivedRows
    .filter((row) => row.expenseName === second)
    .reduce((sum, row) => sum + Number(row.amount), 0);

  assert.equal(expectedFirst, 20, 'the archived row of the first head must be in the database');
  assert.equal(expectedSecond, 40, 'the archived row of the second head must be in the database');
  assert.equal(totalOf(list, first), expectedFirst);
  assert.equal(totalOf(list, second), expectedSecond);
  assert.equal(
    list.items.length,
    archivedRows.length,
    'the archived list must contain every archived row of the database and nothing else',
  );

  const activeList = await fetchExpenses(1, 100);
  assert.equal(totalOf(activeList, first), 10, 'the active total must not contain the archived amount');
  assert.equal(totalOf(activeList, second), 30, 'the active total must not contain the archived amount');
});

test('the archived list of the database is not affected by the pagination', async () => {
  const stamp = Date.now();
  for (let index = 0; index < 3; index += 1) {
    const expense = await newExpense({ description: `Paged ${index}`, expenseName: `Paged Head ${stamp}`, amount: 10 * (index + 1) });
    await deleteExpense(expense.id);
  }

  const rows = everyExpenseRow();
  const archivedOfHead = rows.filter(
    (row) => row.expenseName === `Paged Head ${stamp}` && row.deletedAt,
  );
  const expectedTotal = archivedOfHead.reduce((sum, row) => sum + Number(row.amount), 0);

  const page = await fetchExpenses(1, 1, { includeDeleted: 'only', expenseName: `Paged Head ${stamp}` });

  assert.equal(page.items.length, 1, 'the page must contain a single row');
  assert.equal(page.total, archivedOfHead.length, 'the total must count every archived row of the head');
  assert.equal(page.totalPages, archivedOfHead.length);
  assert.equal(totalOf(page, `Paged Head ${stamp}`), expectedTotal, 'every row must be counted exactly once');
});

test('the archived list of the database and of the answer are the same rows', async () => {
  const stamp = Date.now();
  const expense = await newExpense({ description: `Rows ${stamp}`, expenseName: `Rows Head ${stamp}`, amount: 55 });
  await deleteExpense(expense.id);

  const rows = everyExpenseRow();
  const archivedRows = rows.filter((row) => row.deletedAt).map((row) => row.id).sort((a, b) => a - b);

  const list = await fetchExpenses(1, 100, { includeDeleted: 'only' });
  const answered = list.items.map((item) => item.id).sort((a, b) => a - b);

  assert.deepEqual(answered, archivedRows, 'the answer and the database must contain the same rows');
  assert.ok(answered.includes(expense.id));
});
