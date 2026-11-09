import client from './client';

/**
 * Customer (Khata) API helpers.
 *
 * Backend contract (all endpoints require the Bearer token attached by the
 * shared `client` instance):
 *
 *   GET    /api/customers              -> { ok: true, customers: Customer[] }
 *   GET    /api/customers/outstanding  -> { ok: true, customers: Customer[], totalOutstanding: number }
 *   GET    /api/customers/:id          -> { ok: true, customer: Customer }
 *   POST   /api/customers              (201) -> { ok: true, customer }
 *   PATCH  /api/customers/:id          -> { ok: true, customer }
 *   DELETE /api/customers/:id          -> { ok: true }  (409 if ledger history exists)
 *   GET    /api/customers/:id/ledger   -> { ok: true, transactions: KhataTransaction[], total, page, limit, totalPages }
 *   POST   /api/customers/:id/payment  -> { ok: true, transaction, customer }
 *
 * Customer: { id, name, phone, email, address, notes, balance, createdAt, updatedAt }
 * KhataTransaction: { id, customerId, type, amount, description, saleId, createdAt }
 */

/**
 * Fetch all customers ordered by name ascending.
 * Returns the customers array.
 */
export async function fetchCustomers() {
  const res = await client.get('/customers');

  if (!res.data || typeof res.data !== 'object' || !Array.isArray(res.data.customers)) {
    throw new Error('Invalid customers response from server.');
  }

  return res.data.customers;
}

/**
 * Fetch outstanding customers (balance > 0), ordered by balance descending.
 * Returns { customers, totalOutstanding }.
 */
export async function fetchOutstandingCustomers() {
  const res = await client.get('/customers/outstanding');

  if (
    !res.data ||
    typeof res.data !== 'object' ||
    !Array.isArray(res.data.customers) ||
    typeof res.data.totalOutstanding !== 'number'
  ) {
    throw new Error('Invalid outstanding customers response from server.');
  }

  return {
    customers: res.data.customers,
    totalOutstanding: res.data.totalOutstanding,
  };
}

/**
 * Fetch a single customer by id.
 * Returns the customer object.
 */
export async function fetchCustomer(id) {
  if (id == null) throw new Error('Customer id is required to fetch a customer.');

  const res = await client.get(`/customers/${id}`);

  if (!res.data || typeof res.data !== 'object' || !res.data.customer) {
    throw new Error('Invalid customer response from server.');
  }

  return res.data.customer;
}

/**
 * Create a new customer.
 * Returns the created customer object.
 */
export async function createCustomer(data) {
  const res = await client.post('/customers', data);

  if (!res.data || typeof res.data !== 'object' || !res.data.customer) {
    throw new Error('Invalid customer creation response from server.');
  }

  return res.data.customer;
}

/**
 * Update a customer's profile fields only.
 * Returns the updated customer object.
 */
export async function updateCustomer(id, data) {
  if (id == null) throw new Error('Customer id is required to update a customer.');

  const res = await client.patch(`/customers/${id}`, data);

  if (!res.data || typeof res.data !== 'object' || !res.data.customer) {
    throw new Error('Invalid customer update response from server.');
  }

  return res.data.customer;
}

/**
 * Delete a customer by id.
 * May throw with a 409 error message when the customer has ledger history.
 */
export async function deleteCustomer(id) {
  if (id == null) throw new Error('Customer id is required to delete a customer.');

  const res = await client.delete(`/customers/${id}`);

  if (!res.data || typeof res.data !== 'object') {
    throw new Error('Invalid customer deletion response from server.');
  }

  return res.data;
}

/**
 * Fetch a customer's paginated ledger.
 * @param {number|string} id - customer id
 * @param {object} params - { page?, limit? }
 * @returns {transactions, total, page, limit, totalPages}
 */
export async function fetchCustomerLedger(id, { page = 1, limit = 50 } = {}) {
  if (id == null) throw new Error('Customer id is required to fetch the ledger.');

  const params = new URLSearchParams();
  params.append('page', String(page));
  params.append('limit', String(limit));

  const res = await client.get(`/customers/${id}/ledger?${params.toString()}`);

  if (
    !res.data ||
    typeof res.data !== 'object' ||
    !Array.isArray(res.data.transactions) ||
    typeof res.data.total !== 'number' ||
    typeof res.data.page !== 'number' ||
    typeof res.data.limit !== 'number' ||
    typeof res.data.totalPages !== 'number'
  ) {
    throw new Error('Invalid customer ledger response from server.');
  }

  return {
    transactions: res.data.transactions,
    total: res.data.total,
    page: res.data.page,
    limit: res.data.limit,
    totalPages: res.data.totalPages,
  };
}

/**
 * Record a payment received from a customer.
 * @param {number|string} id - customer id
 * @param {object} data - { amount, description? }
 * @returns { transaction, customer }
 */
export async function recordCustomerPayment(id, data) {
  if (id == null) throw new Error('Customer id is required to record a payment.');

  const res = await client.post(`/customers/${id}/payment`, {
    amount: Number(data.amount),
    description: data.description,
  });

  if (
    !res.data ||
    typeof res.data !== 'object' ||
    !res.data.transaction ||
    !res.data.customer
  ) {
    throw new Error('Invalid payment response from server.');
  }

  return res.data;
}
