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
  ctx = await createTempDb({ prefix: 'exp-audit-', backendDir });
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

test('expense auditability: soft delete preserves record and history', async () => {
  const expense = await prisma.expense.create({
    data: { date: new Date('2026-01-15T10:00:00.000Z'), category: 'RENT', description: 'Rent', amount: 100 },
  });
  await expenseService.deleteExpense(expense.id);
  const stored = await prisma.expense.findUnique({ where: { id: expense.id } });
  assert.ok(stored);
  assert.ok(stored.deletedAt);
  const history = await prisma.expenseHistory.findMany({ where: { expenseId: expense.id } });
  assert.equal(history.length, 1);
  assert.equal(history[0].action, 'DELETE');
});

test('expense auditability: deleted expense excluded from active totals and reports', async () => {
  const expense = await prisma.expense.create({
    data: { date: new Date('2026-01-15T10:00:00.000Z'), category: 'RENT', description: 'Rent2', amount: 50 },
  });
  await expenseService.deleteExpense(expense.id);
  const list = await expenseService.listExpenses({ from: '2026-01-15', to: '2026-01-15' });
  assert.equal(list.total, 0);
  const report = await reportService.getDailyReport('2026-01-15');
  assert.equal(report.expenses, 0);
});

test('expense auditability: restore makes expense active again', async () => {
  const expense = await prisma.expense.create({
    data: { date: new Date('2026-01-15T10:00:00.000Z'), category: 'RENT', description: 'Rent3', amount: 25 },
  });
  await expenseService.deleteExpense(expense.id);
  const restored = await expenseService.restoreExpense(expense.id);
  assert.ok(restored);
  assert.equal(restored.deletedAt, null);
  const list = await expenseService.listExpenses({ from: '2026-01-15', to: '2026-01-15' });
  assert.equal(list.total, 1);
});

test('expense auditability: update preserves previous snapshot', async () => {
  const expense = await prisma.expense.create({
    data: { date: new Date('2026-01-15T10:00:00.000Z'), category: 'RENT', description: 'Rent4', amount: 10 },
  });
  await expenseService.updateExpense(expense.id, { amount: 20 });
  const history = await prisma.expenseHistory.findMany({ where: { expenseId: expense.id, action: 'UPDATE' } });
  assert.equal(history.length, 1);
  const snapshot = JSON.parse(history[0].snapshot);
  assert.equal(snapshot.amount, 10);
});