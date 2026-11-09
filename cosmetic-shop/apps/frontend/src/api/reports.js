import client from './client';

export async function fetchDailyReport() {
  const res = await client.get('/reports/daily');
  return res.data;
}

export async function fetchLowStockProducts() {
  const res = await client.get('/reports/low-stock');
  return res.data;
}

export async function fetchExpiringSoonProducts(days = 30) {
  const res = await client.get('/reports/expiring-soon', { params: { days } });
  return res.data;
}
