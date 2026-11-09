import client from './client';

/**
 * Fetch the daily report for today (UTC).
 *
 * Backend contract (GET /api/reports/daily):
 *   Response: { ok: true, report: { date, salesCount, revenue, discount,
 *     netSales, cogs, grossProfit, expenses, netProfit } }
 *
 * The helper returns the full `res.data` envelope so the caller can validate
 * the response structure instead of assuming `res.data.report`.
 */
export async function fetchDailyReport() {
  const res = await client.get('/reports/daily');
  return res.data;
}

/**
 * Fetch low-stock products (stock at or below their lowStockAt threshold).
 *
 * Backend contract (GET /api/reports/low-stock):
 *   Response: { ok: true, products: [{ id, sku, name, stock, lowStockAt }] }
 */
export async function fetchLowStockProducts() {
  const res = await client.get('/reports/low-stock');
  return res.data;
}

/**
 * Fetch products expiring within the next `days` days (UTC window).
 * The backend excludes already-expired products and treats the window as
 * inclusive.
 *
 * Backend contract (GET /api/reports/expiring-soon?days=30):
 *   Response: { ok: true, products: [{ id, sku, name, expiryDate, stock }] }
 *
 * @param {number} days - look-ahead window in days (default 30)
 */
export async function fetchExpiringSoonProducts(days = 30) {
  const res = await client.get('/reports/expiring-soon', { params: { days } });
  return res.data;
}
