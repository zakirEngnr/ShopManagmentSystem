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
