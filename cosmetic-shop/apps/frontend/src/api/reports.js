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

/**
 * Fetch the profit & loss report for a UTC date range.
 *
 * Backend contract (GET /api/reports/pnl?from=YYYY-MM-DD&to=YYYY-MM-DD):
 *   Response: { ok: true, report: { from, to, revenue, discount, netSales,
 *     cogs, grossProfit, expenses, netProfit } }
 *
 * @param {string} from - start date (YYYY-MM-DD, inclusive)
 * @param {string} to - end date (YYYY-MM-DD, inclusive)
 */
export async function fetchPnlReport(from, to) {
  const res = await client.get('/reports/pnl', { params: { from, to } });
  const data = res.data;

  if (!data || data.ok !== true || !data.report || typeof data.report !== 'object') {
    throw new Error('Malformed P&L report response');
  }

  const report = data.report;
  const required = ['from', 'to', 'revenue', 'discount', 'netSales', 'cogs', 'grossProfit', 'expenses', 'netProfit'];
  for (const key of required) {
    if (report[key] === undefined || report[key] === null) {
      throw new Error(`P&L report missing field: ${key}`);
    }
    if (typeof report[key] !== 'number' && key !== 'from' && key !== 'to') {
      throw new Error(`P&L report field ${key} is not a number`);
    }
  }

  return report;
}

/**
 * Fetch top-selling products for a UTC date range.
 *
 * Backend contract (GET /api/reports/top-products?from=YYYY-MM-DD&to=YYYY-MM-DD&limit=N):
 *   Response: { ok: true, products: [{ productId, productName, quantitySold, revenue }] }
 *
 * @param {string} from - start date (YYYY-MM-DD, inclusive)
 * @param {string} to - end date (YYYY-MM-DD, inclusive)
 * @param {number} limit - maximum products to return (default 10, max 50)
 */
export async function fetchTopProducts(from, to, limit = 10) {
  const res = await client.get('/reports/top-products', { params: { from, to, limit } });
  const data = res.data;

  if (!data || data.ok !== true || !Array.isArray(data.products)) {
    throw new Error('Malformed top products response');
  }

  return data.products;
}
