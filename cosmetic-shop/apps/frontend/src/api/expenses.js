import client from './client.js';

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
    // FIX: Pass the cumulativeTotals array through to the UI
    cumulativeTotals: Array.isArray(data.cumulativeTotals) ? data.cumulativeTotals : [],
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

export async function restoreExpense(id) {
  if (id == null) throw new Error('Expense id is required.');

  const res = await client.post(`/expenses/${id}/restore`);
  const body = res.data;

  if (!body || body.ok !== true || !body.expense || typeof body.expense !== 'object') {
    throw new Error('Malformed restore expense response');
  }

  return body.expense;
}

/**
 * Update an existing expense via PATCH.
 *
 * Only the fields that changed are sent, so unrelated values are preserved.
 *
 * @param {number|string} id - The expense id.
 * @param {object} data - Partial expense fields (date, category, expenseName, description, amount).
 * @returns {object} The updated expense.
 * @throws When the expense is not found (404), validation fails (400) or the
 *   response is malformed.
 */
export async function updateExpense(id, data) {
  if (id == null) throw new Error('Expense id is required.');

  const payload = {};
  if (data.date !== undefined) payload.date = data.date;
  if (data.category !== undefined) payload.category = data.category;
  if (data.expenseName !== undefined)
    payload.expenseName = data.expenseName === null ? null : String(data.expenseName).trim() || null;
  if (data.description !== undefined)
    payload.description = data.description === null ? null : String(data.description).trim();
  if (data.amount !== undefined) payload.amount = Number(data.amount);

  const res = await client.patch(`/expenses/${id}`, payload);
  const body = res.data;

  if (!body || body.ok !== true || !body.expense || typeof body.expense !== 'object') {
    throw new Error('Malformed update expense response');
  }

  return body.expense;
}