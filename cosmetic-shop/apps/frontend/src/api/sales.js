import client from './client.js';
import { requireIdempotencyKey } from '../utils/idempotency.js';

/**
 * Create a sale.
 *
 * The body is put on the wire UNCHANGED. The caller stores the body with the
 * idempotency key before sending it, so a replay of an ambiguous request
 * sends byte for byte the request that may already have been committed.
 *
 * @param {object} saleData - The sale payload. It is sent unchanged.
 * @param {string} idempotencyKey - Key of this logical submission. A retry of
 *   the same submission must reuse the same key so the backend returns the
 *   original sale instead of creating a second one.
 */
export async function createSale(saleData, idempotencyKey) {
  const key = requireIdempotencyKey(idempotencyKey, 'POST /sales');
  const res = await client.post('/sales', saleData, { headers: { 'Idempotency-Key': key } });
  const body = res.data;

  if (!body || body.ok !== true || !body.sale || typeof body.sale !== 'object') {
    // The server answered 2xx, so the sale was committed. The frontend must
    // treat this as an unknown outcome, not as a failure.
    throw new Error('Invalid sale response from server.');
  }

  return body.sale;
}
