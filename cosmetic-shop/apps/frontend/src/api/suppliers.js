import client from './client.js';
import { requireIdempotencyKey } from '../utils/idempotency.js';

export async function fetchSuppliers({ page = 1, limit = 20, search = '' } = {}) {
  const params = new URLSearchParams();

  params.append('page', String(page));
  params.append('limit', String(limit));

  const trimmedSearch = typeof search === 'string' ? search.trim() : '';
  if (trimmedSearch) {
    params.append('search', trimmedSearch);
  }

  const res = await client.get(`/suppliers?${params.toString()}`);
  const body = res.data;

  if (
    !body ||
    body.ok !== true ||
    !Array.isArray(body.suppliers) ||
    !Number.isInteger(body.total) ||
    !Number.isInteger(body.page) ||
    !Number.isInteger(body.limit)
  ) {
    throw new Error('Invalid suppliers response from server.');
  }

  return {
    suppliers: body.suppliers,
    total: body.total,
    page: body.page,
    limit: body.limit,
    outstandingTotal: body.outstandingTotal ?? 0,
  };
}

export async function createSupplier(data) {
  const payload = {
    name: String(data?.name ?? '').trim(),
    phone: data?.phone ? String(data.phone).trim() : null,
    email: data?.email ? String(data.email).trim() : null,
    address: data?.address ? String(data.address).trim() : null,
    notes: data?.notes ? String(data.notes).trim() : null,
  };

  const res = await client.post('/suppliers', payload);
  const body = res.data;

  if (!body || body.ok !== true || !body.supplier || typeof body.supplier !== 'object') {
    throw new Error('Invalid supplier creation response from server.');
  }

  return body.supplier;
}

/**
 * Build the request body of a supplier payment from the form state.
 *
 * The result is the EXACT body that is sent. The caller stores it with the
 * idempotency key, so a replay sends the very same body and not a body that
 * was rebuilt from the (possibly edited) form.
 *
 * The supplier id is NOT part of the body: the backend schema of
 * `POST /suppliers/:id/payment` is strict and rejects unknown fields. It is
 * carried by the URL and stored with the operation instead.
 *
 * @param {object} form - { amount, description }
 * @returns {object} The request body.
 */
export function buildSupplierPaymentPayload(form) {
  return {
    amount: Number(form?.amount),
    description: form?.description ? String(form.description).trim() : null,
  };
}

/**
 * Record a payment to a supplier.
 *
 * The body is put on the wire UNCHANGED, so a replay of an ambiguous request
 * sends byte for byte the request that may already have been committed.
 *
 * @param {number|string} id - The supplier id.
 * @param {object} payload - The request body. It is sent unchanged.
 * @param {string} idempotencyKey - Key of this logical submission.
 */
export async function recordSupplierPayment(id, payload, idempotencyKey) {
  if (id == null) throw new Error('Supplier id is required.');
  const key = requireIdempotencyKey(idempotencyKey, 'POST /suppliers/:id/payment');

  const res = await client.post(`/suppliers/${id}/payment`, payload, {
    headers: { 'Idempotency-Key': key },
  });
  const body = res.data;

  if (
    !body ||
    body.ok !== true ||
    !body.payment ||
    typeof body.payment !== 'object' ||
    !body.supplier ||
    typeof body.supplier !== 'object'
  ) {
    // The server answered 2xx, so the payment was committed. The frontend
    // must treat this as an unknown outcome, not as a failure.
    throw new Error('Invalid supplier payment response from server.');
  }

  return body;
}
