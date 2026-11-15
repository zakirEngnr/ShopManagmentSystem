// Behaviour tests for the active / archived expense views and for the
// restoration workflow.
//
// WHAT THIS IS
//
// The REAL page component (src/pages/Expenses.jsx) is rendered and driven
// through the small React test renderer in test/support/reactHarness.js. The
// REAL API helpers (src/api/expenses.js) build the REAL requests; only the
// transport is replaced by the stub in test/support/expenseApiStub.js, which
// answers exactly like the backend does.
//
// The page is loaded through Vite (the same transform the production build
// uses), so the component under test is the component that ships.
//
// WHAT THIS IS NOT
//
// There is no browser and no DOM in this environment, so there is no layout
// and no real event delegation: a "click" is the direct call of the onClick
// prop of the rendered element. The assertions are therefore about WHAT the
// page does - which request it sends, which rows it shows and which message
// the user is given - and not about how it looks.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createHarness } from '../support/reactHarness.js';
import { installExpenseApiStub, makeExpense, buildListBody } from '../support/expenseApiStub.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const frontendDir = path.resolve(here, '..', '..');

let vite;
let ExpensesPage;
let client;
let stub;

/** The page under test, with a fresh stub. */
function mountPage(rows) {
  stub = installExpenseApiStub(client, { rows });
  const harness = createHarness(ExpensesPage);
  return harness;
}

/** The requests the page made, as "METHOD url" strings. */
function requestLines() {
  return stub.requests.map((request) => `${request.method.toUpperCase()} ${request.url}`);
}

/** The query parameters of the last list request. */
function lastListParams() {
  const lists = stub.requests.filter((request) => request.method === 'get');
  return lists[lists.length - 1]?.params ?? null;
}

/** A button of the rendered tree, found by its exact text. */
function button(harness, text, index = 0) {
  const found = harness.findByText((value) => value.trim() === text, 'button');
  assert.ok(found.length > index, `no button labelled "${text}" (index ${index})`);
  return found[index];
}

/** Click a button and let the resulting promises settle. */
async function click(harness, element) {
  assert.equal(typeof element.props.onClick, 'function', 'the button must have an onClick handler');
  element.props.onClick();
  harness.flush();
  await harness.settle();
}

before(async () => {
  const { createServer } = await import('vite');
  vite = await createServer({
    root: frontendDir,
    server: { middlewareMode: true },
    appType: 'custom',
    logLevel: 'error',
  });

  const pageModule = await vite.ssrLoadModule('/src/pages/Expenses.jsx');
  ExpensesPage = pageModule.default;

  // The same client instance the page uses, so the stub really replaces the
  // transport of the real API helpers.
  const clientModule = await vite.ssrLoadModule('/src/api/client.js');
  client = clientModule.default;
});

after(async () => {
  if (vite) await vite.close();
});

beforeEach(() => {
  if (stub) stub.restore();
});

/* ------------------------------------------------------------------ */
/* 1. the active view is the default                                   */
/* ------------------------------------------------------------------ */

test('the page loads the active expenses and does not ask for the archived ones', async () => {
  const harness = mountPage([
    makeExpense({ id: 1, expenseName: 'ActiveHead', description: 'Active rent', amount: 100 }),
    makeExpense({ id: 2, expenseName: 'ArchivedHead', description: 'Archived rent', amount: 250, deletedAt: '2026-11-03T00:00:00.000Z' }),
  ]);
  await harness.settle();

  assert.deepEqual(requestLines(), ['GET /expenses']);
  assert.equal(lastListParams().includeDeleted, undefined, 'the active view must not send includeDeleted');

  const text = harness.text();
  assert.match(text, /Active rent/, 'the active expense must be shown');
  assert.doesNotMatch(text, /Archived rent/, 'an archived expense must not be shown in the active view');
});

test('the active view offers Edit and Delete and never offers Restore', async () => {
  const harness = mountPage([makeExpense({ id: 1, description: 'Active rent' })]);
  await harness.settle();

  assert.equal(button(harness, 'Edit').props.disabled, undefined);
  assert.ok(button(harness, 'Delete'));
  assert.equal(harness.findByText((value) => value.trim() === 'Restore', 'button').length, 0);
});

/* ------------------------------------------------------------------ */
/* 1b. the filters                                                     */
/* ------------------------------------------------------------------ */

test('the search box sends the name filter with the list request', async () => {
  const harness = mountPage([makeExpense({ id: 1, description: 'Active rent' })]);
  await harness.settle();

  const search = harness.collect().find((element) => element.type === 'input' && element.props.type === 'text');
  assert.ok(search, 'the search box must exist');
  search.props.onChange({ target: { value: 'Rent' } });
  harness.flush();
  await harness.settle();

  assert.equal(lastListParams().expenseName, 'Rent', 'the search term must be sent');
});

test('the date filters are sent with the list request', async () => {
  const harness = mountPage([makeExpense({ id: 1, description: 'Active rent' })]);
  await harness.settle();

  const dates = harness.collect().filter((element) => element.type === 'input' && element.props.type === 'date');
  assert.equal(dates.length, 2, 'the page must offer a from date and a to date');

  dates[0].props.onChange({ target: { value: '2026-11-01' } });
  harness.flush();
  await harness.settle();
  dates[1].props.onChange({ target: { value: '2026-11-30' } });
  harness.flush();
  await harness.settle();

  assert.equal(lastListParams().from, '2026-11-01');
  assert.equal(lastListParams().to, '2026-11-30');
});

test('the Clear button removes the filters from the request', async () => {
  const harness = mountPage([makeExpense({ id: 1, description: 'Active rent' })]);
  await harness.settle();

  const search = harness.collect().find((element) => element.type === 'input' && element.props.type === 'text');
  search.props.onChange({ target: { value: 'Rent' } });
  harness.flush();
  await harness.settle();

  await click(harness, button(harness, 'Clear'));

  assert.equal(lastListParams().expenseName, undefined, 'the search term must be removed');
});

/* ------------------------------------------------------------------ */
/* 1c. the totals                                                      */
/* ------------------------------------------------------------------ */

test('the summary of the active view does not contain the archived expenses', async () => {
  const today = new Date().toISOString().slice(0, 10);
  const harness = mountPage([
    makeExpense({ id: 1, expenseName: 'ActiveHead', description: 'Active rent', amount: 100, date: `${today}T09:00:00.000Z` }),
    makeExpense({ id: 2, expenseName: 'ArchivedHead', description: 'Archived rent', amount: 250, date: `${today}T09:00:00.000Z`, deletedAt: `${today}T10:00:00.000Z` }),
  ]);
  await harness.settle();

  const text = harness.text();
  assert.match(text, /Rs\. 100/, 'the active expense must be in the summary');
  assert.doesNotMatch(text, /Rs\. 250/, 'the archived expense must not be in the summary of the active view');
});

test('F02: the cumulative totals of the archived view contain the archived expenses only', async () => {
  const today = new Date().toISOString().slice(0, 10);
  const harness = mountPage([
    makeExpense({ id: 1, expenseName: 'ActiveHead', description: 'Active rent', amount: 100, date: `${today}T09:00:00.000Z` }),
    makeExpense({ id: 2, expenseName: 'ArchivedHead', description: 'Archived rent', amount: 250, date: `${today}T09:00:00.000Z`, deletedAt: `${today}T10:00:00.000Z` }),
  ]);
  await harness.settle();
  await click(harness, button(harness, 'Archived'));

  // The backend groups the cumulative totals over the rows of the SAME query,
  // and the query with includeDeleted=only contains the archived rows only.
  const text = harness.text();
  assert.match(text, /ArchivedHead/, 'the head of the archived expense is in the cumulative totals');
  assert.match(text, /Rs\. 250/, 'the amount of the archived expense is in the cumulative totals');
  assert.doesNotMatch(text, /ActiveHead/, 'the head of an active expense must not be in the cumulative totals');
  assert.doesNotMatch(text, /Rs\. 100/, 'the amount of an active expense must not be in the cumulative totals');
  assert.doesNotMatch(text, /Active rent/, 'the active expense is not in the list of the archived view');
});

/* ------------------------------------------------------------------ */
/* 2. switching between the views                                      */
/* ------------------------------------------------------------------ */
test('switching to the archived view asks for the deleted expenses and shows only them', async () => {
  const harness = mountPage([
    makeExpense({ id: 1, expenseName: 'ActiveHead', description: 'Active rent', amount: 100 }),
    makeExpense({ id: 2, expenseName: 'ArchivedHead', description: 'Archived rent', amount: 250, deletedAt: '2026-11-03T00:00:00.000Z' }),
  ]);
  await harness.settle();

  await click(harness, button(harness, 'Archived'));

  assert.deepEqual(requestLines(), ['GET /expenses', 'GET /expenses']);
  assert.equal(lastListParams().includeDeleted, 'only', 'the archived view must ask for the archived expenses only');

  const text = harness.text();
  assert.match(text, /Archived rent/, 'the archived expense must be shown');
  assert.doesNotMatch(text, /Active rent/, 'an active expense must not be shown in the archived view');
});

test('switching back to the active view asks for the active expenses again', async () => {
  const harness = mountPage([
    makeExpense({ id: 1, expenseName: 'ActiveHead', description: 'Active rent', amount: 100 }),
    makeExpense({ id: 2, expenseName: 'ArchivedHead', description: 'Archived rent', amount: 250, deletedAt: '2026-11-03T00:00:00.000Z' }),
  ]);
  await harness.settle();

  await click(harness, button(harness, 'Archived'));
  await click(harness, button(harness, 'Active'));

  assert.equal(requestLines().length, 3);
  assert.equal(lastListParams().includeDeleted, undefined, 'the active view must not send includeDeleted');

  const text = harness.text();
  assert.match(text, /Active rent/);
  assert.doesNotMatch(text, /Archived rent/);
});

test('the archived view offers Restore and never offers Edit or Delete', async () => {
  const harness = mountPage([
    makeExpense({ id: 2, description: 'Archived rent', deletedAt: '2026-11-03T00:00:00.000Z' }),
  ]);
  await harness.settle();
  await click(harness, button(harness, 'Archived'));

  assert.ok(button(harness, 'Restore'), 'the archived view must offer Restore');
  assert.equal(harness.findByText((value) => value.trim() === 'Edit', 'button').length, 0);
  assert.equal(harness.findByText((value) => value.trim() === 'Delete', 'button').length, 0);
});

/* ------------------------------------------------------------------ */
/* 3. the restoration workflow                                         */
/* ------------------------------------------------------------------ */

test('opening the confirmation sends no request', async () => {
  const harness = mountPage([
    makeExpense({ id: 2, description: 'Archived rent', deletedAt: '2026-11-03T00:00:00.000Z' }),
  ]);
  await harness.settle();
  await click(harness, button(harness, 'Archived'));

  await click(harness, button(harness, 'Restore'));

  assert.deepEqual(requestLines(), ['GET /expenses', 'GET /expenses'], 'opening the confirmation must not send a request');
  assert.match(harness.text(), /Restore Expense\?/, 'the confirmation must be shown');
  assert.match(harness.text(), /Archived rent/, 'the confirmation must name the expense');
});

test('cancelling the confirmation sends no request at all', async () => {
  const harness = mountPage([
    makeExpense({ id: 2, description: 'Archived rent', deletedAt: '2026-11-03T00:00:00.000Z' }),
  ]);
  await harness.settle();
  await click(harness, button(harness, 'Archived'));
  await click(harness, button(harness, 'Restore'));

  await click(harness, button(harness, 'Cancel'));

  assert.deepEqual(requestLines(), ['GET /expenses', 'GET /expenses'], 'cancelling must not send a request');
  assert.doesNotMatch(harness.text(), /Restore Expense\?/, 'the confirmation must be closed');
});

test('confirming the restoration sends exactly one restore request', async () => {
  const harness = mountPage([
    makeExpense({ id: 2, description: 'Archived rent', deletedAt: '2026-11-03T00:00:00.000Z' }),
  ]);
  await harness.settle();
  await click(harness, button(harness, 'Archived'));
  await click(harness, button(harness, 'Restore'));

  await click(harness, button(harness, 'Restore', 1));

  const restores = stub.requests.filter((request) => request.url.endsWith('/restore'));
  assert.equal(restores.length, 1, 'exactly one restore request must be sent');
  assert.equal(restores[0].method, 'post');
  assert.equal(restores[0].url, '/expenses/2/restore');
});

test('the restore cannot be submitted twice while it is in flight', async () => {
  let releaseRestore;
  stub = installExpenseApiStub(client, {
    rows: [makeExpense({ id: 2, description: 'Archived rent', deletedAt: '2026-11-03T00:00:00.000Z' })],
    onRestore: (request, respond) => new Promise((resolve) => {
      releaseRestore = () => resolve(respond(200, { ok: true, expense: { id: 2, description: 'Archived rent', deletedAt: null } }));
    }),
  });
  const page = createHarness(ExpensesPage);
  await page.settle();
  await click(page, button(page, 'Archived'));
  await click(page, button(page, 'Restore'));

  const confirm = button(page, 'Restore', 1);
  confirm.props.onClick();
  page.flush();
  // The request is dispatched by Axios in a microtask: let it reach the
  // transport, but do not let it settle (the answer is held back).
  await page.settle();

  const busy = button(page, 'Restoring...');
  assert.ok(busy.props.disabled, 'the confirm button must be disabled while the restore is in flight');
  assert.ok(button(page, 'Cancel').props.disabled, 'the cancel button must be disabled while the restore is in flight');

  const restoresWhileBusy = stub.requests.filter((request) => request.url.endsWith('/restore'));
  assert.equal(restoresWhileBusy.length, 1, 'exactly one restore request must be sent');

  releaseRestore();
  await page.settle();

  const restores = stub.requests.filter((request) => request.url.endsWith('/restore'));
  assert.equal(restores.length, 1, 'exactly one restore request must be sent');
});

test('a successful restoration reports the success and refreshes the list', async () => {
  const harness = mountPage([
    makeExpense({ id: 2, description: 'Archived rent', deletedAt: '2026-11-03T00:00:00.000Z' }),
  ]);
  await harness.settle();
  await click(harness, button(harness, 'Archived'));
  await click(harness, button(harness, 'Restore'));

  await click(harness, button(harness, 'Restore', 1));

  assert.match(harness.text(), /Expense restored successfully\./);
  assert.doesNotMatch(harness.text(), /Restore Expense\?/, 'the confirmation must be closed');

  const lists = stub.requests.filter((request) => request.method === 'get');
  assert.equal(lists.length, 3, 'the list must be refreshed after a restoration');
  assert.equal(lists[2].params.includeDeleted, 'only', 'the refreshed list must be the archived list');
});

test('a restored expense is shown in the active view', async () => {
  const rows = [makeExpense({ id: 2, description: 'Archived rent', deletedAt: '2026-11-03T00:00:00.000Z' })];
  const harness = mountPage(rows);
  await harness.settle();
  await click(harness, button(harness, 'Archived'));
  await click(harness, button(harness, 'Restore'));
  await click(harness, button(harness, 'Restore', 1));

  await click(harness, button(harness, 'Active'));

  assert.match(harness.text(), /Archived rent/, 'the restored expense must be shown in the active view');
});

test('a failed restoration reports the error and keeps the confirmation open', async () => {
  const harness = mountPage([
    makeExpense({ id: 2, description: 'Archived rent', deletedAt: '2026-11-03T00:00:00.000Z' }),
  ]);
  stub.onRestore = (request, respond) => respond(404, { ok: false, error: { message: 'Expense not found' } });

  await harness.settle();
  await click(harness, button(harness, 'Archived'));
  await click(harness, button(harness, 'Restore'));

  await click(harness, button(harness, 'Restore', 1));

  const text = harness.text();
  assert.match(text, /Restore Expense\?/, 'the confirmation must stay open after a failure');
  assert.doesNotMatch(text, /Expense restored successfully\./, 'no success must be reported');

  // F01: the message of the server reaches the user.
  assert.match(text, /Expense not found/);
  assert.doesNotMatch(text, /Request failed with status code/);
});

/* ------------------------------------------------------------------ */
/* 3c. the messages of the server (F01)                                 */
/* ------------------------------------------------------------------ */

/** The error an Axios request rejects with for a status outside 2xx. */
function axiosError(status, body) {
  const error = new Error(`Request failed with status code ${status}`);
  error.response = { status, data: body };
  return error;
}

/** Open the confirmation of the archived expense of a fresh page. */
async function openRestoreConfirmation() {
  const harness = mountPage([
    makeExpense({ id: 2, description: 'Archived rent', deletedAt: '2026-11-03T00:00:00.000Z' }),
  ]);
  await harness.settle();
  await click(harness, button(harness, 'Archived'));
  await click(harness, button(harness, 'Restore'));
  return harness;
}

test('F01: a validation error of the server reaches the user', async () => {
  const harness = await openRestoreConfirmation();
  stub.onRestore = () => { throw axiosError(400, { ok: false, error: { message: 'Amount must be greater than 0' } }); };

  await click(harness, button(harness, 'Restore', 1));

  assert.match(harness.text(), /Amount must be greater than 0/);
  assert.doesNotMatch(harness.text(), /Request failed with status code/);
});

test('F01: an authentication error of the server reaches the user', async () => {
  const harness = await openRestoreConfirmation();
  stub.onRestore = () => { throw axiosError(401, { ok: false, error: { message: 'Missing or invalid Authorization header' } }); };

  await click(harness, button(harness, 'Restore', 1));

  assert.match(harness.text(), /Missing or invalid Authorization header/);
  assert.doesNotMatch(harness.text(), /Request failed with status code/);
});

test('F01: a server error reaches the user without any internal detail', async () => {
  const harness = await openRestoreConfirmation();
  // The backend answers a 500 with a generic message; no stack and no
  // internal detail may reach the user.
  stub.onRestore = () => { throw axiosError(500, { ok: false, error: { message: 'Internal server error' } }); };

  await click(harness, button(harness, 'Restore', 1));

  assert.match(harness.text(), /Internal server error/);
  assert.doesNotMatch(harness.text(), /at .*\.js:\d+/);
  assert.doesNotMatch(harness.text(), /stack/i);
});

test('F01: a failure without an answer is reported', async () => {
  const harness = await openRestoreConfirmation();
  const networkError = new Error('Network Error');
  stub.onRestore = () => { throw networkError; };

  await click(harness, button(harness, 'Restore', 1));

  assert.match(harness.text(), /Network Error/);
  assert.doesNotMatch(harness.text(), /Unable to restore the expense\./, 'the reason of the failure must be shown');
});

test('F01: an answer without any message falls back to the wording of the page', async () => {
  const harness = await openRestoreConfirmation();
  const empty = new Error('');
  empty.response = { status: 400, data: { ok: false, error: {} } };
  stub.onRestore = () => { throw empty; };

  await click(harness, button(harness, 'Restore', 1));

  assert.match(harness.text(), /Unable to restore this expense\./);
});

test('F01: the message of the server reaches the user when the list cannot be loaded', async () => {
  const harness = mountPage([]);
  stub.onList = () => { throw axiosError(500, { ok: false, error: { message: 'Internal server error' } }); };

  await harness.settle();

  assert.match(harness.text(), /Unable to load expenses/);
  assert.match(harness.text(), /Internal server error/);
});

/* ------------------------------------------------------------------ */
/* 3d. the wording of the delete confirmation (F04)                     */
/* ------------------------------------------------------------------ */

test('F04: the delete confirmation says that the expense is archived, not destroyed', async () => {
  const harness = mountPage([makeExpense({ id: 1, description: 'Active rent' })]);
  await harness.settle();

  await click(harness, button(harness, 'Delete'));

  const text = harness.text();
  assert.match(text, /to the archived expenses/, 'the confirmation must say that the expense is archived');
  assert.match(text, /You can restore it later/, 'the confirmation must say that the expense can be restored');
  assert.match(text, /Active rent/, 'the confirmation must name the expense');
  assert.doesNotMatch(text, /permanently remove/, 'the confirmation must not claim that the record is destroyed');
  assert.doesNotMatch(text, /from the record/);
});

test('F04: the delete confirmation still offers a cancel and a delete', async () => {
  const harness = mountPage([makeExpense({ id: 1, description: 'Active rent' })]);
  await harness.settle();

  await click(harness, button(harness, 'Delete'));

  assert.ok(button(harness, 'Cancel'), 'the confirmation must still offer a cancel');
  assert.ok(button(harness, 'Delete'), 'the confirmation must still offer the delete');
  assert.match(harness.text(), /Delete Expense\?/, 'the heading must not change');

  // Cancelling sends no request.
  const before = stub.requests.length;
  await click(harness, button(harness, 'Cancel'));
  assert.equal(stub.requests.length, before, 'cancelling must not send a request');
});

/* ------------------------------------------------------------------ */
/* 3b. the refresh race (F03)                                          */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/* 3b. the refresh race (F03)                                          */
/* ------------------------------------------------------------------ */

test('F03: a restoration that finishes while a list request is running still refreshes the list', async () => {
  const rows = [makeExpense({ id: 2, description: 'Archived rent', deletedAt: '2026-11-03T00:00:00.000Z' })];
  const pending = { list: [], restore: [] };

  stub = installExpenseApiStub(client, {
    rows,
    // The answer of the server is fixed when the request arrives, exactly
    // like a real server answers it.
    onList: (request, respond) => new Promise((resolve) => {
      const body = buildListBody(request, rows);
      pending.list.push(() => resolve(respond(200, body)));
    }),
    onRestore: (request, respond) => new Promise((resolve) => {
      pending.restore.push(() => {
        // The backend restored the row.
        rows[0].deletedAt = null;
        resolve(respond(200, { ok: true, expense: rows[0] }));
      });
    }),
  });

  const page = createHarness(ExpensesPage);
  const listRequests = () => stub.requests.filter((request) => request.method === 'get').length;

  // 1. the first list request of the page.
  await page.settle();
  pending.list.shift()();
  await page.settle();

  // 2. the archived view.
  await click(page, button(page, 'Archived'));
  await page.settle();
  pending.list.shift()();
  await page.settle();
  assert.match(page.text(), /Archived rent/, 'the archived expense must be in the archived view');

  // 3. the restoration starts.
  await click(page, button(page, 'Restore'));
  button(page, 'Restore', 1).props.onClick();
  await page.settle();
  assert.equal(pending.restore.length, 1, 'the restoration must be in flight');

  // 4. the filter changes while the list request of step 2 is still running.
  const search = page.collect().find((element) => element.type === 'input' && element.props.type === 'text');
  search.props.onChange({ target: { value: 'Rent' } });
  page.flush();
  await page.settle();
  const loadsWhileTheRestoreRuns = listRequests();
  assert.equal(pending.list.length, 1, 'the filter change must start a list request');

  // 5. the restoration finishes. The refresh is deferred, not lost.
  pending.restore.shift()();
  await page.settle();
  assert.equal(
    listRequests(),
    loadsWhileTheRestoreRuns,
    'no second request may be started while a request is running',
  );

  // 6. the running request finishes: the deferred refresh runs now.
  pending.list.shift()();
  await page.settle();
  assert.equal(
    listRequests(),
    loadsWhileTheRestoreRuns + 1,
    'the list must be refreshed after the restoration',
  );

  // 7. the answer of the refresh arrives.
  pending.list.shift()();
  await page.settle();

  assert.doesNotMatch(
    page.text(),
    /Archived rent/,
    'the restored expense must not be in the archived view any more',
  );

  // 8. the restored expense is in the active view.
  await click(page, button(page, 'Active'));
  await page.settle();
  pending.list.shift()();
  await page.settle();
  assert.match(page.text(), /Archived rent/, 'the restored expense must be in the active view');
});

test('F03: an ordinary restoration refreshes the list exactly once', async () => {
  const harness = mountPage([
    makeExpense({ id: 2, description: 'Archived rent', deletedAt: '2026-11-03T00:00:00.000Z' }),
  ]);
  await harness.settle();
  await click(harness, button(harness, 'Archived'));
  await click(harness, button(harness, 'Restore'));

  await click(harness, button(harness, 'Restore', 1));

  const lists = stub.requests.filter((request) => request.method === 'get');
  assert.equal(lists.length, 3, 'the list must be refreshed exactly once after the restoration');
  assert.match(harness.text(), /Expense restored successfully\./);
});

test('F03: several reloads during a running request are merged into one', async () => {
  const rows = [makeExpense({ id: 2, description: 'Archived rent', deletedAt: '2026-11-03T00:00:00.000Z' })];
  const pending = { list: [], restore: [] };

  stub = installExpenseApiStub(client, {
    rows,
    onList: (request, respond) => new Promise((resolve) => {
      const body = buildListBody(request, rows);
      pending.list.push(() => resolve(respond(200, body)));
    }),
    onRestore: (request, respond) => new Promise((resolve) => {
      pending.restore.push(() => {
        rows[0].deletedAt = null;
        resolve(respond(200, { ok: true, expense: rows[0] }));
      });
    }),
  });

  const page = createHarness(ExpensesPage);
  const listRequests = () => stub.requests.filter((request) => request.method === 'get').length;

  // The page and the archived view.
  await page.settle();
  pending.list.shift()();
  await page.settle();
  await click(page, button(page, 'Archived'));
  await page.settle();
  pending.list.shift()();
  await page.settle();

  // A refresh is running: the list stays on the screen, so the rows can
  // still be used.
  button(page, 'Refresh').props.onClick();
  page.flush();
  await page.settle();
  const requestsWhileRunning = listRequests();

  // Two restorations finish while that refresh is running: both ask for a
  // reload of the list.
  await click(page, button(page, 'Restore'));
  button(page, 'Restore', 1).props.onClick();
  await page.settle();
  pending.restore.shift()();
  await page.settle();

  await click(page, button(page, 'Restore'));
  button(page, 'Restore', 1).props.onClick();
  await page.settle();
  pending.restore.shift()();
  await page.settle();

  assert.equal(
    listRequests(),
    requestsWhileRunning,
    'no request may be started while a request is running',
  );

  // The running request ends: the merged reload runs once.
  pending.list.shift()();
  await page.settle();
  assert.equal(
    listRequests(),
    requestsWhileRunning + 1,
    'the two reloads must be merged into exactly one request',
  );

  pending.list.shift()();
  await page.settle();
});
/* ------------------------------------------------------------------ */
/* 4. loading, empty and failure states                                */
/* ------------------------------------------------------------------ */

test('the page shows a loading state before the first answer arrives', () => {
  const harness = mountPage([makeExpense({ id: 1 })]);
  assert.match(harness.text(), /Loading expenses\.\.\./);
});

test('an empty answer produces an empty state and no table', async () => {
  const harness = mountPage([]);
  await harness.settle();

  assert.match(harness.text(), /No expenses recorded yet\./);
  assert.equal(harness.findByText((value) => value.trim() === 'Restore', 'button').length, 0);
});

test('a failed list is reported and can be retried', async () => {
  const harness = mountPage([]);
  stub.onList = (request, respond) => respond(500, { ok: false, error: { message: 'Internal server error' } });

  await harness.settle();

  assert.match(harness.text(), /Unable to load expenses/);
  assert.ok(button(harness, 'Retry'), 'a retry must be offered');
});
