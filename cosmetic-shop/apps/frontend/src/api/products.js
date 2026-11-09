import client from './client';

export async function fetchProducts({ search, type, limit = 50 } = {}) {
  const params = new URLSearchParams();

  if (search?.trim()) {
    params.append('search', search.trim());
  }

  if (type) {
    params.append('type', type);
  }

  params.append('limit', String(limit));

  const res = await client.get(`/products?${params.toString()}`);
  return res.data;
}

export async function fetchProductByBarcode(barcode) {
  const normalizedBarcode = String(barcode ?? '').trim();

  if (!normalizedBarcode) return null;

  try {
    const res = await client.get(
      `/products/barcode/${encodeURIComponent(normalizedBarcode)}`
    );

    return res.data.product;
  } catch (err) {
    if (err.response?.status === 404) {
      return null;
    }

    throw err;
  }
}

/**
 * Create a new product.
 *
 * Backend contract (POST /api/products):
 *   Body: { sku, barcode?, name, type, costPrice, sellPrice, stock?,
 *     lowStockAt?, expiryDate?, categoryId, brandId? }
 *   Response (201): { ok: true, product }
 *
 * Returns the full `res.data` envelope so the caller can inspect the result.
 * Throws on HTTP failure or malformed responses.
 */
export async function createProduct(data) {
  const res = await client.post('/products', data);

  if (!res.data || typeof res.data !== 'object' || !res.data.product) {
    throw new Error('Invalid product creation response from server.');
  }

  return res.data;
}

/**
 * Update an existing product.
 *
 * Backend contract (PATCH /api/products/:id):
 *   Body: partial product fields (stock is NOT accepted here — stock
 *   changes go exclusively through POST /api/stock)
 *   Response: { ok: true, product }
 *
 * @param {number|string} id - product id
 * @param {object} data - fields to update (must not include stock)
 */
export async function updateProduct(id, data) {
  if (id == null) throw new Error('Product id is required to update a product.');

  const res = await client.patch(`/products/${id}`, data);

  if (!res.data || typeof res.data !== 'object' || !res.data.product) {
    throw new Error('Invalid product update response from server.');
  }

  return res.data;
}

/**
 * Delete a product.
 *
 * Backend contract (DELETE /api/products/:id):
 *   Response: { ok: true }
 *   May return 409 if the product is referenced by sales or stock records.
 *
 * @param {number|string} id - product id
 */
export async function deleteProduct(id) {
  if (id == null) throw new Error('Product id is required to delete a product.');

  const res = await client.delete(`/products/${id}`);

  if (!res.data || typeof res.data !== 'object') {
    throw new Error('Invalid product deletion response from server.');
  }

  return res.data;
}

/**
 * Upload an image for an existing product.
 *
 * Backend contract (POST /api/products/:id/image):
 *   Multipart body with a single file field named `image`.
 *   Accepted: JPEG, PNG, WebP, max 2 MB.
 *   Response: { ok: true, product }
 *
 * The Axios client already sends FormData with the browser-generated
 * multipart boundary, so the Content-Type header must NOT be set manually.
 *
 * @param {number|string} id - product id
 * @param {File} file - image file
 */
export async function uploadProductImage(id, file) {
  if (id == null) throw new Error('Product id is required to upload an image.');
  if (!(file instanceof File)) throw new Error('A valid image file is required.');

  const formData = new FormData();
  formData.append('image', file);

  const res = await client.post(`/products/${id}/image`, formData);

  if (!res.data || typeof res.data !== 'object' || !res.data.product) {
    throw new Error('Invalid image upload response from server.');
  }

  return res.data;
}

/**
 * Adjust the stock of a product.
 *
 * Backend contract (POST /api/stock):
 *   Body: { productId, delta, reason, unitCost? }
 *     - delta: non-zero integer (positive increases, negative decreases)
 *     - reason: PURCHASE | DAMAGE | LOSS | RETURN | CORRECTION | OTHER
 *     - unitCost: finite non-negative number (stored only when delta > 0)
 *   Response (201): { ok: true, adjustment, product }
 *
 * @param {number|string} productId
 * @param {number} delta
 * @param {'PURCHASE'|'DAMAGE'|'LOSS'|'RETURN'|'CORRECTION'|'OTHER'} reason
 * @param {number|null} unitCost
 */
export async function adjustStock(productId, delta, reason, unitCost = null) {
  if (productId == null) throw new Error('Product id is required to adjust stock.');
  if (!Number.isInteger(delta) || delta === 0) {
    throw new Error('Delta must be a non-zero integer.');
  }

  const validReasons = [
    'PURCHASE',
    'DAMAGE',
    'LOSS',
    'RETURN',
    'CORRECTION',
    'OTHER',
  ];
  if (!validReasons.includes(reason)) {
    throw new Error('Invalid stock adjustment reason.');
  }

  const body = { productId: Number(productId), delta, reason };
  if (unitCost !== null && unitCost !== undefined) {
    body.unitCost = unitCost;
  }

  const res = await client.post('/stock', body);

  if (!res.data || typeof res.data !== 'object') {
    throw new Error('Invalid stock adjustment response from server.');
  }

  return res.data;
}
