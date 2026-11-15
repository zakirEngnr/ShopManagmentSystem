import { prisma } from '../db/prisma.js';
import { EXPENSE_CATEGORIES } from '../config/constants.js';
import { httpError, mapPrismaError } from '../utils/prismaErrors.js';
import { add, toPaisa, fromPaisa } from '../utils/money.js';

function toMoney(value) {
  return fromPaisa(toPaisa(value || 0));
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
  const amount = Number(data.amount);
  const paisa = toPaisa(amount);
  if (!Number.isFinite(amount) || paisa <= 0) {
    throw httpError(400, 'Amount must be a positive number');
  }

  const payload = {
    category: data.category,
    expenseName: data.expenseName?.trim() || null,
    description: data.description.trim(),
    amount,
    date: parseDateValue(data.date) ?? new Date(),
  };

  return prisma.expense.create({ data: payload });
}

export async function listExpenses(query = {}) {
  const page = normalizePage(query.page, 'page');
  const limit = normalizeLimit(query.limit, 'limit');

  const where = {};

  // The archive of an expense can be asked for in three ways:
  //
  //   includeDeleted is absent (or any value other than the two below)
  //       -> only the ACTIVE expenses (deletedAt IS NULL)
  //   includeDeleted === 'true'
  //       -> the active AND the archived expenses
  //   includeDeleted === 'only'
  //       -> only the ARCHIVED expenses (deletedAt IS NOT NULL)
  //
  // The cumulative totals are always computed over the rows of the SAME
  // query, so the totals of the archived view contain the archived expenses
  // only and the totals of the active view contain the active expenses only.
  const includeDeleted = String(query.includeDeleted ?? '').trim().toLowerCase();
  if (includeDeleted === 'only') {
    where.deletedAt = { not: null };
  } else if (includeDeleted !== 'true') {
    where.deletedAt = null;
  }

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
      // Case-insensitive search
      where.expenseName = { contains: expenseName };
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
      fromBoundary.setUTCHours(0, 0, 0, 0);
      where.date.gte = fromBoundary;
    }
    if (toValue) {
      const toBoundary = new Date(toValue);
      toBoundary.setUTCHours(23, 59, 59, 999);
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

  // The cumulative totals are computed over ALL the rows of the query - the
  // pagination is ignored - so a row is counted exactly once and never once
  // per page. The name filter is not applied here, exactly like in the active
  // view: the panel shows the total of every head of the period.
  const groupWhere = { ...where };
  delete groupWhere.expenseName;
  
  const allFilteredExpenses = await prisma.expense.findMany({
    where: groupWhere,
    select: { expenseName: true, amount: true }
  });

  const totalsMap = new Map();
  for (const exp of allFilteredExpenses) {
    const nameKey = exp.expenseName ? exp.expenseName.toLowerCase() : 'uncategorized';
    const current = totalsMap.get(nameKey) || { displayName: exp.expenseName || 'Uncategorized', total: 0 };
    current.total = add(current.total, Number(exp.amount || 0));
    totalsMap.set(nameKey, current);
  }

  const cumulativeTotals = Array.from(totalsMap.values())
    .map((row) => ({ expenseName: row.displayName, total: toMoney(row.total) }))
    .sort((a, b) => b.total - a.total);

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
  if (data.amount !== undefined) {
    const amount = Number(data.amount);
    const paisa = toPaisa(amount);
    if (!Number.isFinite(amount) || paisa <= 0) {
      throw httpError(400, 'Amount must be a positive number');
    }
    payload.amount = amount;
  }

  try {
    // Preserve the previous expense state before applying the update.
    await prisma.expenseHistory.create({
      data: {
        expenseId: id,
        action: 'UPDATE',
        snapshot: JSON.stringify(existing),
      },
    });
    return await prisma.expense.update({ where: { id }, data: payload });
  } catch (err) {
    mapPrismaError(err, { entity: 'Expense' });
  }
}

export async function deleteExpense(id) {
  const existing = await prisma.expense.findUnique({ where: { id } });
  if (!existing) throw httpError(404, 'Expense not found');
  if (existing.deletedAt) throw httpError(404, 'Expense not found');

  try {
    await prisma.$transaction(async (tx) => {
      await tx.expenseHistory.create({
        data: {
          expenseId: id,
          action: 'DELETE',
          snapshot: JSON.stringify(existing),
        },
      });
      await tx.expense.update({
        where: { id },
        data: { deletedAt: new Date() },
      });
    });
    return true;
  } catch (err) {
    mapPrismaError(err, { entity: 'Expense' });
  }
}

export async function restoreExpense(id) {
  const existing = await prisma.expense.findUnique({ where: { id } });
  if (!existing) throw httpError(404, 'Expense not found');
  if (!existing.deletedAt) return existing;

  try {
    await prisma.$transaction(async (tx) => {
      await tx.expenseHistory.create({
        data: {
          expenseId: id,
          action: 'RESTORE',
          snapshot: JSON.stringify(existing),
        },
      });
      await tx.expense.update({
        where: { id },
        data: { deletedAt: null },
      });
    });
    return prisma.expense.findUnique({ where: { id } });
  } catch (err) {
    mapPrismaError(err, { entity: 'Expense' });
  }
}

export default { createExpense, listExpenses, getExpense, updateExpense, deleteExpense, restoreExpense };