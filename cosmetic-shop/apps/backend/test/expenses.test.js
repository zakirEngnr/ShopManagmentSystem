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
  ctx = await createTempDb({ prefix: 'expenses-', backendDir });
  assertTmpDbUrl(ctx.dbUrl, ctx.realTmp);
  const db = await import(backendUrl + 'src/db/prisma.js');
  prisma = db.prisma;
  app = (await import(backendUrl + 'src/app.js')).createApp();
  const admin = await createUser(prisma, { role: 'ADMIN', tag: 'admin-expense' });
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

async function createExpense(overrides = {}) {
  const payload = {
    date: '2024-01-15T12:00:00.000Z',
    category: 'RENT',
    description: 'Office rent',
    amount: 1250,
    ...overrides,
  };
  return prisma.expense.create({ data: payload });
}

test('T1 valid create', async () => {
  const before = await prisma.expense.count();
  const res = await req('POST', '/api/expenses', {
    token: adminToken,
    body: { category: 'RENT', description: 'Office rent', amount: 1250 },
  });
  assert.equal(res.status, 201);
  assert.equal(await prisma.expense.count(), before + 1);

  const record = await prisma.expense.findFirst({ orderBy: { createdAt: 'desc' } });
  assert.equal(record.category, 'RENT');
  assert.equal(record.description, 'Office rent');
  assert.equal(Number(record.amount), 1250);
  assert.ok(record.date instanceof Date);

  const explicit = await req('POST', '/api/expenses', {
    token: adminToken,
    body: { date: '2024-03-10T00:00:00.000Z', category: 'UTILITY', description: 'Power bill', amount: 99.5 },
  });
  assert.equal(explicit.status, 400);
  assert.equal((await prisma.expense.count()), before + 1);
});

test('T2 invalid payloads', async () => {
  const invalidCases = [
    { category: 'RENT', description: 'A', amount: 0 },
    { category: 'RENT', description: 'A', amount: -5 },
    { category: 'RENT', description: 'A', amount: 1_000_000_001 },
    { category: 'RENT', amount: 10 },
    { category: 'RENT', description: '', amount: 10 },
    { category: 'RENT', description: 'x'.repeat(256), amount: 10 },
    { category: 'INVALID', description: 'A', amount: 10 },
    { date: 'not-a-date', category: 'RENT', description: 'A', amount: 10 },
    { category: 'RENT', description: 'A' },
  ];

  for (const body of invalidCases) {
    const res = await req('POST', '/api/expenses', { token: adminToken, body });
    assert.equal(res.status, 400, `expected 400 for ${JSON.stringify(body)}`);
  }

  const emptyPatch = await req('PATCH', '/api/expenses/1', { token: adminToken, body: {} });
  assert.equal(emptyPatch.status, 400);
});

test('T3 unauthenticated requests', async () => {
  const before = await prisma.expense.count();
  const requests = [
    ['POST', '/api/expenses', { category: 'RENT', description: 'No auth', amount: 10 }],
    ['GET', '/api/expenses', null],
    ['GET', '/api/expenses/1', null],
    ['PATCH', '/api/expenses/1', { description: 'No auth patch' }],
    ['DELETE', '/api/expenses/1', null],
  ];

  for (const [method, pathValue, body] of requests) {
    const res = await req(method, pathValue, body ? { body } : {});
    assert.equal(res.status, 401, `${method} ${pathValue} should require auth`);
  }
  assert.equal(await prisma.expense.count(), before);
});

test('T4 list and filter', async () => {
  await createExpense({ date: '2024-01-10T08:00:00.000Z', category: 'RENT', description: 'Rent Jan', amount: 100 });
  await createExpense({ date: '2024-01-12T08:00:00.000Z', category: 'SALARIES', description: 'Staff pay', amount: 200 });
  await createExpense({ date: '2024-01-15T08:00:00.000Z', category: 'RENT', description: 'Rent Feb', amount: 300 });

  const all = await req('GET', '/api/expenses', { token: adminToken });
  assert.equal(all.status, 200);
  assert.ok(Array.isArray(all.body.items));
  assert.ok(all.body.items.length >= 3);

  const byCategory = await req('GET', '/api/expenses', { token: adminToken, query: { category: 'RENT' } });
  assert.equal(byCategory.status, 200);
  assert.ok(byCategory.body.items.every((item) => item.category === 'RENT'));

  const fromOnly = await req('GET', '/api/expenses', { token: adminToken, query: { from: '2024-01-11' } });
  assert.equal(fromOnly.status, 200);
  assert.ok(fromOnly.body.items.every((item) => new Date(item.date) >= new Date('2024-01-11T00:00:00.000Z')));

  const toOnly = await req('GET', '/api/expenses', { token: adminToken, query: { to: '2024-01-13' } });
  assert.equal(toOnly.status, 200);
  assert.ok(toOnly.body.items.every((item) => new Date(item.date) <= new Date('2024-01-13T23:59:59.999Z')));

  const range = await req('GET', '/api/expenses', {
    token: adminToken,
    query: { from: '2024-01-10', to: '2024-01-12' },
  });
  assert.equal(range.status, 200);
  assert.ok(range.body.items.every((item) => {
    const value = new Date(item.date).getTime();
    return value >= new Date('2024-01-10T00:00:00.000Z').getTime() && value <= new Date('2024-01-12T23:59:59.999Z').getTime();
  }));

  const sorted = [...all.body.items].sort((a, b) => new Date(b.date) - new Date(a.date) || b.id - a.id);
  assert.deepEqual(all.body.items.map((item) => item.id), sorted.map((item) => item.id));

  const invalidRange = await req('GET', '/api/expenses', { token: adminToken, query: { from: '2024-01-15', to: '2024-01-10' } });
  assert.equal(invalidRange.status, 400);
});

test('T5 update', async () => {
  const created = await createExpense({ category: 'PACKAGING', description: 'Boxes', amount: 30, date: '2024-02-05T00:00:00.000Z' });

  const res = await req('PATCH', `/api/expenses/${created.id}`, {
    token: adminToken,
    body: { amount: 500 },
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.expense.amount, 500);
  assert.equal(res.body.expense.category, 'PACKAGING');
  assert.equal(res.body.expense.description, 'Boxes');

  const missing = await req('PATCH', '/api/expenses/999999', { token: adminToken, body: { amount: 10 } });
  assert.equal(missing.status, 404);

  const bad = await req('PATCH', `/api/expenses/${created.id}`, {
    token: adminToken,
    body: { amount: -1 },
  });
  assert.equal(bad.status, 400);

  const empty = await req('PATCH', `/api/expenses/${created.id}`, { token: adminToken, body: {} });
  assert.equal(empty.status, 400);
});

test('T6 delete', async () => {
  const record = await createExpense({ category: 'MARKETING', description: 'Campaign', amount: 75, date: '2024-05-06T00:00:00.000Z' });
  const res = await req('DELETE', `/api/expenses/${record.id}`, { token: adminToken });
  assert.equal(res.status, 200);
  assert.equal((await prisma.expense.findUnique({ where: { id: record.id } })), null);

  const again = await req('DELETE', `/api/expenses/${record.id}`, { token: adminToken });
  assert.equal(again.status, 404);

  const missing = await req('DELETE', '/api/expenses/999999', { token: adminToken });
  assert.equal(missing.status, 404);
});

test('T7 pagination', async () => {
  const startingTotal = await prisma.expense.count();

  for (let i = 0; i < 25; i += 1) {
    await prisma.expense.create({
      data: {
        category: 'OTHER',
        description: `Expense ${i + 1}`,
        amount: i + 1,
        date: new Date(Date.UTC(2024, 0, 1 + (i % 10), 12, 0, 0)),
      },
    });
  }

  const total = startingTotal + 25;

  const defaultPage = await req('GET', '/api/expenses', { token: adminToken });
  assert.equal(defaultPage.status, 200);
  assert.equal(defaultPage.body.items.length, Math.min(20, total));
  assert.equal(defaultPage.body.total, total);
  assert.equal(defaultPage.body.page, 1);
  assert.equal(defaultPage.body.limit, 20);
  assert.equal(defaultPage.body.totalPages, Math.ceil(total / 20));

  const page2 = await req('GET', '/api/expenses', { token: adminToken, query: { page: '2', limit: '10' } });
  assert.equal(page2.status, 200);
  assert.equal(page2.body.items.length, Math.min(10, Math.max(total - 10, 0)));
  assert.equal(page2.body.total, total);
  assert.equal(page2.body.page, 2);
  assert.equal(page2.body.limit, 10);
  assert.equal(page2.body.totalPages, Math.ceil(total / 10));

  const page3 = await req('GET', '/api/expenses', { token: adminToken, query: { page: '3', limit: '10' } });
  assert.equal(page3.status, 200);
  assert.equal(page3.body.total, total);
  assert.equal(page3.body.totalPages, Math.ceil(total / 10));

  const invalidPage = await req('GET', '/api/expenses', { token: adminToken, query: { page: '0' } });
  assert.equal(invalidPage.status, 400);

  const invalidLimit = await req('GET', '/api/expenses', { token: adminToken, query: { limit: '0' } });
  assert.equal(invalidLimit.status, 400);

  const tooBigLimit = await req('GET', '/api/expenses', { token: adminToken, query: { limit: '101' } });
  assert.equal(tooBigLimit.status, 400);
});
