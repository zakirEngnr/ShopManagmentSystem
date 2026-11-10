import client from './client';

function normalizeExpenseListResponse(data) {
  if (!data || data.ok !== true || !Array.isArray(data.items)) {
    throw new Error('Malformed expense list response');
  }

  if (!Number.isInteger(data.total) || !Number.isInteger(data.page) || !Number.isInteger(data.limit)) {
    throw new Error('Expense list response is missing pagination metadata');
  }

  const totalPages = Number.isInteger(data.totalPages)
    ? data.totalPages
    : Math.ceil(data.total / Math.max(data.limit, 1));

  return {
    items: data.items,
    total: data.total,
    page: data.page,
    limit: data.limit,
    totalPages: Math.max(1, totalPages),
  };
}

export async function fetchExpenses(page = 1, limit = 20, filters = {}) {
  const safePage = Number.isInteger(page) ? page : Number(page) || 1;
  const safeLimit = Number.isInteger(limit) ? limit : Number(limit) || 20;

  const params = { page: safePage, limit: safeLimit, ...filters };

  const res = await client.get('/expenses', { params });
  const data = normalizeExpenseListResponse(res.data);

  if (data.page < 1 || data.limit < 1 || data.page > data.totalPages) {
    throw new Error('Expense pagination response is invalid');
  }

  return data;
}

export async function createExpense(data) {
  const payload = {
    date: data.date,
    category: data.category,
    expenseName: data.expenseName?.trim() || null,
    description: String(data.description ?? '').trim(),
    amount: Number(data.amount),
  };

  const res = await client.post('/expenses', payload);
  const body = res.data;

  if (!body || body.ok !== true || !body.expense || typeof body.expense !== 'object') {
    throw new Error('Malformed create expense response');
  }

  return body.expense;
}

export async function deleteExpense(id) {
  const res = await client.delete(`/expenses/${id}`);
  const body = res.data;

  if (!body || body.ok !== true) {
    throw new Error('Malformed delete expense response');
  }

  return true;
}
