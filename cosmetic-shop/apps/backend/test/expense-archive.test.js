// The archive contract of the expense list.
//
// The list of expenses can be asked for in three ways:
//
//   includeDeleted is absent      -> the ACTIVE expenses only
//   includeDeleted === 'true'     -> the active AND the archived expenses
//   includeDeleted === 'only'     -> the ARCHIVED expenses only
//
// The cumulative totals are always computed over the rows of the SAME query,
// so the totals of a view never contain the rows of another view.
//
// The database of these tests is a throw-away SQLite file in os.tmpdir(); the
// development database is never opened.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { createTempDb, assertTmpDbUrl } from '../test-support/tempDb.js';
import { createUser, signToken } from '../test-support/auth.js';

const backendDir = path.resolve(import.meta.dirname, '..');
const backendUrl = pathToFileURL(backendDir + path.sep).href;
let prisma, app, adminToken, ctx;

before(async () => {
  ctx = await createTempDb({ prefix: 'expense-archive-', backendDir });
  assertTmpDbUrl(ctx.dbUrl, ctx.realTmp);
  const db = await import(backendUrl + 'src/db/prisma.js');
  prisma = db.prisma;
  app = (await import(backendUrl + 'src/app.js')).createApp();
  const admin = await createUser(prisma, { role: 'ADMIN', tag: 'admin-expense-archive' });
  adminToken = signToken(admin);
});

after(async () => {
  if (prisma) await prisma.$disconnect();
  if (ctx) ctx.cleanup();
});

function req(method, urlPath, opts = {}) {
  let full = urlPath;
  if (opts.query) full += '?' + new URLSearchParams(opts.query).toString();
  const payload = opts.body ? JSON.stringify(opts.body) : null;
  return new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const headers = {};
      if (payload) {
        headers['Content-Type'] = 'application/json';
        headers['Content-Length'] = Buffer.byteLength(payload);
      }
      if (opts.token) headers.Authorization = 'Bearer ' + opts.token;
      const r = http.request({
        host: '127.0.0.1',
        port: server.address().port,
        path: full,
        method,
        headers,
      }, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          server.close();
          let body = {};
          try { body = data ? JSON.parse(data) : {}; } catch { body = { _raw: data }; }
          resolve({ status: res.statusCode, body });
        });
      });
      r.on('error', (err) => {
        server.close();
        reject(err);
      });
      if (payload) r.write(payload);
      r.end();
    });
  });
}

/** Create an expense and archive it when archived is true. */
async function seed(overrides = {}) {
  const { archived = false, ...data } = overrides;
  const row = await prisma.expense.create({
    data: {
      date: new Date('2026-01-15T10:00:00.000Z'),
      category: 'RENT',
      expenseName: 'Head',
      description: 'An expense',
      amount: 100,
      ...data,
    },
  });
  if (archived) {
    await prisma.expense.update({ where: { id: row.id }, data: { deletedAt: new Date('2026-01-16T10:00:00.000Z') } });
  }
  return row;
}

/** The total of one head of the cumulative totals of an answer. */
function totalOf(body, expenseName) {
  const head = body.cumulativeTotals.find((row) => row.expenseName === expenseName);
  return head ? head.total : undefined;
}

test('A1 the active list contains the active expenses only', async () => {
  await seed({ description: 'A1 active', expenseName: 'A1Head', amount: 100 });
  await seed({ description: 'A1 archived', expenseName: 'A1Head', amount: 250, archived: true });

  const res = await req('GET', '/api/expenses', { token: adminToken, query: { limit: '100' } });

  assert.equal(res.status, 200);
  assert.equal(res.body.items.filter((item) => item.description === 'A1 archived').length, 0);
  assert.equal(res.body.items.filter((item) => item.description === 'A1 active').length, 1);
});

test('A2 the active totals contain the active expenses only', async () => {
  await seed({ description: 'A2 active', expenseName: 'A2Head', amount: 100 });
  await seed({ description: 'A2 archived', expenseName: 'A2Head', amount: 250, archived: true });

  const res = await req('GET', '/api/expenses', { token: adminToken, query: { limit: '100' } });

  assert.equal(totalOf(res.body, 'A2Head'), 100, 'the total of the active head must not contain the archived amount');
});

test('A3 includeDeleted=only returns the archived expenses only', async () => {
  await seed({ description: 'A3 active', expenseName: 'A3Head', amount: 100 });
  await seed({ description: 'A3 archived', expenseName: 'A3Head', amount: 250, archived: true });

  const res = await req('GET', '/api/expenses', {
    token: adminToken,
    query: { limit: '100', includeDeleted: 'only' },
  });

  assert.equal(res.status, 200);
  assert.equal(res.body.items.filter((item) => item.description === 'A3 active').length, 0);
  assert.equal(res.body.items.filter((item) => item.description === 'A3 archived').length, 1);
  assert.ok(res.body.items.every((item) => item.deletedAt), 'every row of the archived list must be archived');
});

test('A4 the archived totals contain the archived expenses only', async () => {
  await seed({ description: 'A4 active', expenseName: 'A4Head', amount: 100 });
  await seed({ description: 'A4 archived', expenseName: 'A4Head', amount: 250, archived: true });

  const res = await req('GET', '/api/expenses', {
    token: adminToken,
    query: { limit: '100', includeDeleted: 'only' },
  });

  assert.equal(totalOf(res.body, 'A4Head'), 250, 'the total of the archived head must contain the archived amount only');
});

test('A5 the heads of the two views do not mix', async () => {
  await seed({ description: 'A5 active head', expenseName: 'A5Active', amount: 100 });
  await seed({ description: 'A5 archived head', expenseName: 'A5Archived', amount: 250, archived: true });

  const active = await req('GET', '/api/expenses', { token: adminToken, query: { limit: '100' } });
  const archived = await req('GET', '/api/expenses', {
    token: adminToken,
    query: { limit: '100', includeDeleted: 'only' },
  });

  assert.equal(totalOf(active.body, 'A5Active'), 100);
  assert.equal(totalOf(active.body, 'A5Archived'), undefined, 'the archived head must not be in the active totals');
  assert.equal(totalOf(archived.body, 'A5Archived'), 250);
  assert.equal(totalOf(archived.body, 'A5Active'), undefined, 'the active head must not be in the archived totals');
});

test('A6 includeDeleted=true keeps its old contract', async () => {
  await seed({ description: 'A6 active', expenseName: 'A6Head', amount: 100 });
  await seed({ description: 'A6 archived', expenseName: 'A6Head', amount: 250, archived: true });

  const res = await req('GET', '/api/expenses', {
    token: adminToken,
    query: { limit: '100', includeDeleted: 'true' },
  });

  assert.equal(res.status, 200);
  assert.equal(res.body.items.filter((item) => item.description === 'A6 active').length, 1);
  assert.equal(res.body.items.filter((item) => item.description === 'A6 archived').length, 1);
  assert.equal(totalOf(res.body, 'A6Head'), 350, 'the totals of includeDeleted=true contain both views');
});

test('A7 an unknown value of includeDeleted keeps the active view', async () => {
  await seed({ description: 'A7 active', expenseName: 'A7Head', amount: 100 });
  await seed({ description: 'A7 archived', expenseName: 'A7Head', amount: 250, archived: true });

  const res = await req('GET', '/api/expenses', {
    token: adminToken,
    query: { limit: '100', includeDeleted: 'bogus' },
  });

  assert.equal(res.status, 200);
  assert.equal(res.body.items.filter((item) => item.description === 'A7 archived').length, 0);
  assert.equal(totalOf(res.body, 'A7Head'), 100);
});

test('A8 the value of includeDeleted is not case sensitive', async () => {
  await seed({ description: 'A8 archived', expenseName: 'A8Head', amount: 250, archived: true });

  const res = await req('GET', '/api/expenses', {
    token: adminToken,
    query: { limit: '100', includeDeleted: 'ONLY', expenseName: 'A8Head' },
  });

  assert.equal(res.status, 200);
  assert.equal(res.body.items.length, 1);
  assert.equal(totalOf(res.body, 'A8Head'), 250);
});

test('A9 the name filter is applied to the archived rows', async () => {
  await seed({ description: 'A9 wanted', expenseName: 'A9Wanted', amount: 100, archived: true });
  await seed({ description: 'A9 other', expenseName: 'A9Other', amount: 250, archived: true });

  const res = await req('GET', '/api/expenses', {
    token: adminToken,
    query: { limit: '100', includeDeleted: 'only', expenseName: 'A9Wanted' },
  });

  assert.equal(res.status, 200);
  assert.equal(res.body.items.length, 1);
  assert.equal(res.body.items[0].description, 'A9 wanted');
});

test('A10 the date filter is applied to the archived rows and to the archived totals', async () => {
  await seed({ description: 'A10 inside', expenseName: 'A10Head', amount: 100, date: new Date('2026-03-10T00:00:00.000Z'), archived: true });
  await seed({ description: 'A10 outside', expenseName: 'A10Head', amount: 250, date: new Date('2026-04-10T00:00:00.000Z'), archived: true });

  const res = await req('GET', '/api/expenses', {
    token: adminToken,
    query: { limit: '100', includeDeleted: 'only', from: '2026-03-01', to: '2026-03-31' },
  });

  assert.equal(res.status, 200);
  assert.equal(res.body.items.length, 1);
  assert.equal(res.body.items[0].description, 'A10 inside');
  assert.equal(totalOf(res.body, 'A10Head'), 100, 'the archived total must respect the date filter');
});

test('A11 an empty archived result answers with no rows and no totals', async () => {
  await seed({ description: 'A11 active', expenseName: 'A11Head', amount: 100 });

  // A period in which no expense exists at all.
  const res = await req('GET', '/api/expenses', {
    token: adminToken,
    query: { limit: '100', includeDeleted: 'only', from: '2030-01-01', to: '2030-01-31' },
  });

  assert.equal(res.status, 200);
  assert.equal(res.body.total, 0);
  assert.deepEqual(res.body.items, []);
  assert.deepEqual(res.body.cumulativeTotals, []);
});

test('A12 the pagination never counts a row twice', async () => {
  await seed({ description: 'A12 one', expenseName: 'A12Head', amount: 100, archived: true });
  await seed({ description: 'A12 two', expenseName: 'A12Head', amount: 200, archived: true });
  await seed({ description: 'A12 three', expenseName: 'A12Head', amount: 300, archived: true });

  const query = { limit: '1', includeDeleted: 'only', expenseName: 'A12Head' };
  const first = await req('GET', '/api/expenses', { token: adminToken, query });

  assert.equal(first.status, 200);
  assert.equal(first.body.items.length, 1);
  assert.equal(first.body.total, 3);
  assert.equal(first.body.totalPages, 3);
  assert.equal(totalOf(first.body, 'A12Head'), 600, 'the totals cover every row, not only the rows of the page');

  const seen = [];
  let page = 1;
  while (page <= first.body.totalPages) {
    const res = await req('GET', '/api/expenses', {
      token: adminToken,
      query: { ...query, page: String(page) },
    });
    assert.equal(res.status, 200);
    seen.push(...res.body.items.map((item) => item.id));
    assert.equal(totalOf(res.body, 'A12Head'), 600, 'every page must carry the same total');
    page += 1;
  }

  assert.equal(seen.length, 3);
  assert.equal(new Set(seen).size, 3, 'no row may be returned twice');
});

test('A13 the archived rows of the database are the rows of the archived list', async () => {
  const active = await seed({ description: 'A13 active', expenseName: 'A13Head', amount: 100 });
  const archived = await seed({ description: 'A13 archived', expenseName: 'A13Head', amount: 250, archived: true });

  const res = await req('GET', '/api/expenses', {
    token: adminToken,
    query: { limit: '100', includeDeleted: 'only' },
  });

  const inList = res.body.items.map((item) => item.id);
  const inDatabase = await prisma.expense.findMany({
    where: { deletedAt: { not: null } },
    select: { id: true },
  });

  assert.deepEqual(inList.sort(), inDatabase.map((row) => row.id).sort());
  assert.equal(inList.includes(active.id), false);
  assert.ok(inList.includes(archived.id));
});

test('A14 the archived list needs a credential', async () => {
  const res = await req('GET', '/api/expenses', { query: { limit: '100', includeDeleted: 'only' } });

  assert.equal(res.status, 401);
});
