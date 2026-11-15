import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createTempDb, assertTmpDbUrl } from '../test-support/tempDb.js';

const backendDir = path.resolve(import.meta.dirname, '..');
const backendUrl = pathToFileURL(backendDir + path.sep).href;

let prisma;
let expenseService;
let reportService;
let ctx;

before(async () => {
  ctx = await createTempDb({ prefix: 'exp-date-', backendDir });
  const { dbUrl, realTmp } = ctx;
  assertTmpDbUrl(dbUrl, realTmp);
  prisma = (await import(backendUrl + 'src/db/prisma.js')).prisma;
  expenseService = (await import(backendUrl + 'src/services/expense.service.js')).default;
  reportService = (await import(backendUrl + 'src/services/report.service.js')).default;
});

after(async () => {
  if (prisma) {
    try { await prisma.$disconnect(); } catch {}
  }
  if (ctx) ctx.cleanup();
});

test('expense date: UTC late-night expense belongs to the UTC day', async () => {
  await prisma.expense.create({
    data: { date: new Date('2026-01-15T23:30:00.000Z'), category: 'RENT', description: 'late', amount: 10 },
  });
  const list = await expenseService.listExpenses({ from: '2026-01-15', to: '2026-01-15' });
  assert.equal(list.total, 1);
  const report = await reportService.getDailyReport('2026-01-15');
  assert.equal(report.expenses, 10);
});

test('expense date: just after midnight belongs to the next UTC day', async () => {
  await prisma.expense.create({
    data: { date: new Date('2026-01-16T00:30:00.000Z'), category: 'RENT', description: 'early', amount: 20 },
  });
  const list = await expenseService.listExpenses({ from: '2026-01-15', to: '2026-01-15' });
  assert.equal(list.total, 1); // only the late expense from previous test
  const report = await reportService.getDailyReport('2026-01-16');
  assert.equal(report.expenses, 20);
});