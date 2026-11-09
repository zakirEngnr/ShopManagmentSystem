import client from './client';

export async function createSale(saleData) {
  const res = await client.post('/sales', saleData);
  return res.data;
}
