import { prisma } from '../db/prisma.js';
import { EXPENSE_CATEGORIES } from '../config/constants.js';
import { httpError, mapPrismaError } from '../utils/prismaErrors.js';

function toMoney(value) {
  return Number(Number(value || 0).toFixed(2));
}

function parseDateValue(rawValue, label = 'date') {
  if (rawValue === undefined || rawValue === null || rawValue === '') return null;
  const value = String(rawValue).trim();
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw httpError(400, `Invalid ${label}`);
  }
  return date;
}

function normalizePage(value, fieldName) {
  const parsed = Number(value ?? 1);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw httpError(400, `Invalid ${fieldName}`);
  }
  return parsed;
}

function normalizeLimit(value, fieldName) {
  const parsed = Number(value ?? 20);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100) {
    throw httpError(400, `Invalid ${fieldName}`);
  }
  return parsed;
}

export async function createExpense(data) {
  const payload = {
    category: data.category,
    expenseName: data.expenseName?.trim() || null,
    description: data.description.trim(),
    amount: Number(data.amount),
    date: parseDateValue(data.date) ?? new Date(),
  };

  return prisma.expense.create({ data: payload });
}

export async function listExpenses(query = {}) {
  const page = normalizePage(query.page, 'page');
  const limit = normalizeLimit(query.limit, 'limit');

  const where = {};

  if (query.category) {
    const category = String(query.category).trim();
    if (!EXPENSE_CATEGORIES.includes(category)) {
      throw httpError(400, 'Invalid category');
    }
    where.category = category;
  }

  if (query.expenseName) {
    const expenseName = String(query.expenseName).trim();
    if (expenseName) {
      where.expenseName = expenseName;
    }
  }

  const fromValue = query.from !== undefined ? parseDateValue(query.from, 'from') : null;
  const toValue = query.to !== undefined ? parseDateValue(query.to, 'to') : null;

  if (fromValue && toValue && fromValue.getTime() > toValue.getTime()) {
    throw httpError(400, 'from date must be before or equal to to date');
  }

  if (fromValue || toValue) {
    where.date = {};
    if (fromValue) {
      const fromBoundary = new Date(fromValue);
      fromBoundary.setHours(0, 0, 0, 0);
      where.date.gte = fromBoundary;
    }
    if (toValue) {
      const toBoundary = new Date(toValue);
      toBoundary.setHours(23, 59, 59, 999);
      where.date.lte = toBoundary;
    }
  }

  const [total, items] = await Promise.all([
    prisma.expense.count({ where }),
    prisma.expense.findMany({
      where,
      orderBy: [{ date: 'desc' }, { id: 'desc' }],
      skip: (page - 1) * limit,
      take: limit,
    }),
  ]);

  // Calculate cumulative totals grouped by expenseName for the filtered date range
  const expenseNameAgg = await prisma.expense.groupBy({
    by: ['expenseName'],
    where,
    _sum: { amount: true },
    orderBy: {
      _sum: { amount: 'desc' },
    },
  });

  const cumulativeTotals = expenseNameAgg.map((row) => ({
    expenseName: row.expenseName || 'Uncategorized',
    total: toMoney(row._sum.amount ?? 0),
  }));

  return {
    items,
    total,
    page,
    limit,
    totalPages: Math.ceil(total / limit),
    cumulativeTotals,
  };
}

export async function getExpense(id) {
  const expense = await prisma.expense.findUnique({ where: { id } });
  if (!expense) throw httpError(404, 'Expense not found');
  return expense;
}

export async function updateExpense(id, data) {
  const existing = await prisma.expense.findUnique({ where: { id } });
  if (!existing) throw httpError(404, 'Expense not found');

  const payload = {};

  if (data.date !== undefined) payload.date = parseDateValue(data.date, 'date') ?? new Date();
  if (data.category !== undefined) payload.category = data.category;
  if (data.description !== undefined) payload.description = data.description.trim();
  if (data.amount !== undefined) payload.amount = Number(data.amount);

  try {
    return await prisma.expense.update({ where: { id }, data: payload });
  } catch (err) {
    mapPrismaError(err, { entity: 'Expense' });
  }
}

export async function deleteExpense(id) {
  const existing = await prisma.expense.findUnique({ where: { id } });
  if (!existing) throw httpError(404, 'Expense not found');

  try {
    await prisma.expense.delete({ where: { id } });
    return true;
  } catch (err) {
    mapPrismaError(err, { entity: 'Expense' });
  }
}

export default { createExpense, listExpenses, getExpense, updateExpense, deleteExpense };
