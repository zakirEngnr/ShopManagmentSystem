import client from './client';

/**
 * Fetch all product brands.
 *
 * Backend contract (GET /api/brands):
 *   Response: { ok: true, brands: [{ id, name, createdAt }, ...] }
 *
 * Returns the brands array. Throws on HTTP failure or on a malformed
 * response structure — it never silently converts an invalid response into
 * an empty result.
 */
export async function fetchBrands() {
  const res = await client.get('/brands');

  if (!res.data || typeof res.data !== 'object' || !Array.isArray(res.data.brands)) {
    throw new Error('Invalid brands response from server.');
  }

  return res.data.brands;
}

export async function createBrand(data) {
  const res = await client.post('/brands', data);

  if (!res.data || typeof res.data !== 'object' || !res.data.brand || typeof res.data.brand !== 'object') {
    throw new Error('Invalid brand create response from server.');
  }

  return res.data.brand;
}
