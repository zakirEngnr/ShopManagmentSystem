import client from './client.js';
import { requireIdempotencyKey } from '../utils/idempotency.js';

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
 *   POST   /api/customers/:id/debt     -> { ok: true, transaction, customer }
 *
 * Customer: { id, name, phone, email, address, notes, balance, type, createdAt, updatedAt }
 * KhataTransaction: { id, customerId, type, amount, description, saleId, createdAt }
 */

/**
 * Fetch customers ordered by name ascending.
 * @param {object} params - Optional query parameters { type? }
 * @param {string} params.type - Optional customer type filter: 'RETAIL', 'BUSINESS', or 'PERSONAL'
 * Returns the customers array.
 */
export async function fetchCustomers({ type } = {}) {
  const params = new URLSearchParams();
  if (type) params.append('type', type);

  const res = await client.get(`/customers${params.toString() ? '?' + params.toString() : ''}`);

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
 * Build the request body of a customer payment from the form state.
 *
 * The result is the EXACT body that is sent. The caller stores it with the
 * idempotency key, so a replay sends the very same body and not a body that
 * was rebuilt from the (possibly edited) form.
 *
 * The customer id is NOT part of the body: the backend schema of
 * `POST /customers/:id/payment` is strict and rejects unknown fields. It is
 * carried by the URL and stored with the operation instead.
 *
 * @param {object} form - { amount, description }
 * @returns {object} The request body.
 */
export function buildCustomerPaymentPayload(form) {
  return {
    amount: Number(form?.amount),
    description: form?.description ? String(form.description).trim() : null,
  };
}

/**
 * Build the request body of a manual debt entry from the form state.
 *
 * @param {object} form - { amount, description }
 * @returns {object} The request body.
 */
export function buildCustomerDebtPayload(form) {
  return {
    amount: Number(form?.amount),
    description: String(form?.description ?? '').trim(),
  };
}

/**
 * Record a payment received from a customer.
 *
 * The body is put on the wire UNCHANGED, so a replay of an ambiguous request
 * sends byte for byte the request that may already have been committed.
 *
 * @param {number|string} id - customer id
 * @param {object} payload - The request body. It is sent unchanged.
 * @param {string} idempotencyKey - Key of this logical submission.
 * @returns { transaction, customer }
 */
export async function recordCustomerPayment(id, payload, idempotencyKey) {
  if (id == null) throw new Error('Customer id is required to record a payment.');
  const key = requireIdempotencyKey(idempotencyKey, 'POST /customers/:id/payment');

  const res = await client.post(`/customers/${id}/payment`, payload, {
    headers: { 'Idempotency-Key': key },
  });

  if (
    !res.data ||
    typeof res.data !== 'object' ||
    !res.data.transaction ||
    !res.data.customer
  ) {
    // The server answered 2xx, so the payment was committed. The frontend
    // must treat this as an unknown outcome, not as a failure.
    throw new Error('Invalid payment response from server.');
  }

  return res.data;
}

/**
 * Record a manual debt entry for a BUSINESS or PERSONAL customer.
 *
 * The body is put on the wire UNCHANGED, so a replay of an ambiguous request
 * sends byte for byte the request that may already have been committed.
 *
 * @param {number|string} id - customer id
 * @param {object} payload - The request body. It is sent unchanged.
 * @param {string} idempotencyKey - Key of this logical submission.
 * @returns { transaction, customer }
 */
export async function recordCustomerDebt(id, payload, idempotencyKey) {
  if (id == null) throw new Error('Customer id is required to record a debt entry.');
  const key = requireIdempotencyKey(idempotencyKey, 'POST /customers/:id/debt');

  const res = await client.post(`/customers/${id}/debt`, payload, {
    headers: { 'Idempotency-Key': key },
  });

  if (
    !res.data ||
    typeof res.data !== 'object' ||
    !res.data.transaction ||
    !res.data.customer
  ) {
    // The server answered 2xx, so the debt entry was committed. The frontend
    // must treat this as an unknown outcome, not as a failure.
    throw new Error('Invalid debt entry response from server.');
  }

  return res.data;
}
