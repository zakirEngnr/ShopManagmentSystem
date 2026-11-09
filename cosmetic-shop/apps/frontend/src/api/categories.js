import client from './client';

/**
 * Fetch all product categories.
 *
 * Backend contract (GET /api/categories):
 *   Response: { ok: true, categories: [{ id, name, type, createdAt }, ...] }
 *
 * Returns the categories array. Throws on HTTP failure or on a malformed
 * response structure — it never silently converts an invalid response into
 * an empty result.
 */
export async function fetchCategories() {
  const res = await client.get('/categories');

  if (!res.data || typeof res.data !== 'object' || !Array.isArray(res.data.categories)) {
    throw new Error('Invalid categories response from server.');
  }

  return res.data.categories;
}
