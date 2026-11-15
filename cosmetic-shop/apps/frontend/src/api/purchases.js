import client from './client.js';
import { requireIdempotencyKey } from '../utils/idempotency.js';

export async function fetchPurchases({ page = 1, limit = 20, supplierId, from, to, search } = {}) {
  const params = new URLSearchParams();

  params.append('page', String(page));
  params.append('limit', String(limit));

  if (supplierId != null && supplierId !== '') {
    params.append('supplierId', String(supplierId));
  }

  if (from) params.append('from', String(from));
  if (to) params.append('to', String(to));
  if (search != null && search.trim() !== '') params.append('search', String(search));

  const res = await client.get(`/purchases?${params.toString()}`);
  const body = res.data;

  if (
    !body ||
    body.ok !== true ||
    !Array.isArray(body.purchases) ||
    !Number.isInteger(body.total) ||
    !Number.isInteger(body.page) ||
    !Number.isInteger(body.limit)
  ) {
    throw new Error('Invalid purchases response from server.');
  }

  return {
    purchases: body.purchases,
    total: body.total,
    page: body.page,
    limit: body.limit,
  };
}

/**
 * Build the request body of a purchase from the form state.
 *
 * The result is the EXACT body that is sent. The caller stores it with the
 * idempotency key, so a replay sends the very same body and not a body that
 * was rebuilt from the (possibly edited) form.
 *
 * @param {object} data - { supplierId, items }
 * @returns {object} The request body.
 */
export function buildPurchasePayload(data) {
  return {
    supplierId: Number(data?.supplierId),
    items: (Array.isArray(data?.items) ? data.items : []).map((item) => {
      const quantity = Number(item?.quantity);
      const unitCost = Number(item?.unitCost);

      if (item && (item.type === 'new' || item.newProduct)) {
        const newProduct = item.newProduct || {};
        const cleaned = {
          name: String(newProduct.name ?? '').trim(),
          sku: String(newProduct.sku ?? '').trim(),
          barcode: newProduct.barcode ? String(newProduct.barcode).trim() : null,
          type: newProduct.type || 'COSMETIC',
          categoryId: Number(newProduct.categoryId),
          brandId: newProduct.brandId ? Number(newProduct.brandId) : null,
          costPrice: Number(newProduct.costPrice),
          sellPrice: Number(newProduct.sellPrice),
        };

        return {
          newProduct: cleaned,
          quantity,
          unitCost,
        };
      }

      return {
        productId: Number(item?.productId),
        quantity,
        unitCost,
      };
    }),
  };
}

/**
 * Create a purchase.
 *
 * The body is put on the wire UNCHANGED, so a replay of an ambiguous request
 * sends byte for byte the request that may already have been committed.
 *
 * @param {object} payload - The request body. It is sent unchanged.
 * @param {string} idempotencyKey - Key of this logical submission.
 */
/**
 * Fetch a single purchase by its primary key.
 *
 * @param {number|string} id - The purchase id.
 * @returns {object} The purchase, with supplier and items (with product).
 * @throws When the purchase is not found (404) or the response is malformed.
 */
export async function fetchPurchase(id) {
  if (id == null) throw new Error('Purchase id is required.');
  const res = await client.get(`/purchases/${id}`);
  const body = res.data;

  if (!body || body.ok !== true || !body.purchase || typeof body.purchase !== 'object') {
    throw new Error('Invalid purchase detail response from server.');
  }

  return body.purchase;
}

export async function createPurchase(payload, idempotencyKey) {
  const key = requireIdempotencyKey(idempotencyKey, 'POST /purchases');

  const res = await client.post('/purchases', payload, { headers: { 'Idempotency-Key': key } });
  const body = res.data;

  if (!body || body.ok !== true || !body.purchase || typeof body.purchase !== 'object') {
    // The server answered 2xx, so the purchase was committed. The frontend
    // must treat this as an unknown outcome, not as a failure.
    throw new Error('Invalid purchase creation response from server.');
  }

  return body.purchase;
}
