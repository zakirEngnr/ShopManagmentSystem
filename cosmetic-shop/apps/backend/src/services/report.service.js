import { prisma } from '../db/prisma.js';
import { httpError } from '../utils/prismaErrors.js';

/** Round monetary values to cents, avoiding float dust. */
function toMoney(value) {
  return Number(Number(value || 0).toFixed(2));
}

function startOfDayUtc(date) {
  const d = new Date(date);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

function endOfDayUtc(date) {
  const d = new Date(date);
  d.setUTCHours(23, 59, 59, 999);
  return d;
}

/**
 * Validate a YYYY-MM-DD date string strictly (real calendar dates only).
 * Returns the normalized string, or undefined when no value was supplied
 * (caller is responsible for the today fallback).
 */
function parseDateArgument(value, label = 'date') {
  if (value === undefined || value === null) return undefined;
  const text = String(value).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    throw httpError(400, `Invalid ${label}`);
  }
  const [year, month, day] = text.split('-').map(Number);
  const check = new Date(Date.UTC(year, month - 1, day));
  if (
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() !== month - 1 ||
    check.getUTCDate() !== day
  ) {
    throw httpError(400, `Invalid ${label}`);
  }
  return text;
}

function utcDateString() {
  const now = new Date();
  return (
    now.getUTCFullYear() +
    '-' +
    String(now.getUTCMonth() + 1).padStart(2, '0') +
    '-' +
    String(now.getUTCDate()).padStart(2, '0')
  );
}

/**
 * Aggregate sale totals within inclusive UTC boundaries [gte, lte].
 *
 * Accounting semantics (per the sale service):
 * - Sale.subtotal is the pre-discount sales amount  -> revenue
 * - Sale.discount is the discount actually applied   -> discount
 * - Sale.total is subtotal minus discount            -> net sales
 * Net sales is therefore revenue minus discount; the discount is never
 * applied a second time.
 */
async function aggregateSales(gte, lte) {
  const agg = await prisma.sale.aggregate({
    where: { createdAt: { gte, lte } },
    _sum: { subtotal: true, discount: true },
    _count: true,
  });
  return {
    salesCount: Number(agg._count ?? 0),
    revenue: toMoney(agg._sum.subtotal ?? 0),
    discount: toMoney(agg._sum.discount ?? 0),
  };
}

/**
 * Historical COGS: SaleItem.unitCost (the product cost preserved at sale
 * time) multiplied by quantity, for sale items of sales in [gte, lte].
 * Rows with a null unitCost (e.g. manual sale items) contribute nothing.
 * Aggregated server-side so the sales history is never loaded into memory.
 */
async function aggregateCogs(gte, lte) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT COALESCE(SUM("unitCost" * "quantity"), 0) AS cogs
     FROM "SaleItem"
     WHERE "saleId" IN (
       SELECT id FROM "Sale" WHERE "createdAt" >= ? AND "createdAt" <= ?
     )`,
    gte,
    lte,
  );
  return toMoney(rows[0]?.cogs ?? 0);
}

async function aggregateExpenses(gte, lte) {
  const agg = await prisma.expense.aggregate({
    where: { date: { gte, lte } },
    _sum: { amount: true },
  });
  return toMoney(agg._sum.amount ?? 0);
}


/**
 * A. Daily report for one UTC date (defaults to today's UTC date).
 */
export async function getDailyReport(dateString) {
  const date = parseDateArgument(dateString, 'date') ?? utcDateString();
  const gte = startOfDayUtc(date);
  const lte = endOfDayUtc(date);

  const { salesCount, revenue, discount } = await aggregateSales(gte, lte);
  const netSales = toMoney(revenue - discount);
  const cogs = await aggregateCogs(gte, lte);
  const expenses = await aggregateExpenses(gte, lte);
  const grossProfit = toMoney(netSales - cogs);
  const netProfit = toMoney(grossProfit - expenses);

  return {
    date,
    salesCount,
    revenue,
    discount,
    netSales,
    cogs,
    grossProfit,
    expenses,
    netProfit,
  };
}

/**
 * B. P&L report across inclusive UTC date boundaries [from, to].
 */
export async function getPnlReport(fromDate, toDate) {
  const from = parseDateArgument(fromDate, 'from');
  const to = parseDateArgument(toDate, 'to');
  if (from === undefined || to === undefined) {
    throw httpError(400, 'Invalid date');
  }
  if (from > to) {
    throw httpError(400, 'from must be before or equal to to');
  }

  const gte = startOfDayUtc(from);
  const lte = endOfDayUtc(to);

  const { revenue, discount } = await aggregateSales(gte, lte);
  const netSales = toMoney(revenue - discount);
  const cogs = await aggregateCogs(gte, lte);
  const expenses = await aggregateExpenses(gte, lte);
  const grossProfit = toMoney(netSales - cogs);
  const netProfit = toMoney(grossProfit - expenses);

  return {
    from,
    to,
    revenue,
    discount,
    netSales,
    cogs,
    grossProfit,
    expenses,
    netProfit,
  };
}

/**
 * C. Top products by quantity sold within the sale date range.
 * Manual sale items (productId null) are excluded from rankings.
 */
export async function getTopProducts(fromDate, toDate, limit = 5) {
  const from = parseDateArgument(fromDate, 'from');
  const to = parseDateArgument(toDate, 'to');
  if (from === undefined || to === undefined) {
    throw httpError(400, 'Invalid date');
  }
  const parsedLimit = Number(limit);
  if (!Number.isInteger(parsedLimit) || parsedLimit < 1 || parsedLimit > 50) {
    throw httpError(400, 'Invalid limit');
  }

  const gte = startOfDayUtc(from);
  const lte = endOfDayUtc(to);

  const groups = await prisma.saleItem.groupBy({
    by: ['productId'],
    where: {
      productId: { not: null },
      sale: { createdAt: { gte, lte } },
    },
    _sum: { quantity: true, total: true },
    orderBy: { _sum: { quantity: 'desc' } },
    take: parsedLimit,
  });

  groups.sort(
    (a, b) =>
      Number(b._sum.quantity) - Number(a._sum.quantity) ||
      Number(a.productId) - Number(b.productId),
  );

  const ids = groups.map((g) => Number(g.productId));
  let nameById = new Map();
  if (ids.length > 0) {
    const products = await prisma.product.findMany({
      where: { id: { in: ids } },
      select: { id: true, name: true },
    });
    nameById = new Map(products.map((p) => [p.id, p.name]));
  }

  return groups.map((g) => ({
    productId: Number(g.productId),
    productName: nameById.get(Number(g.productId)) ?? 'Unknown',
    quantitySold: Number(g._sum.quantity ?? 0),
    revenue: toMoney(g._sum.total ?? 0),
  }));
}

/**
 * D. Products whose stock is at or below their low-stock threshold.
 * lowStockAt is a real schema field (Int, default 5); no fallback is invented.
 */
export async function getLowStockProducts() {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT id, sku, name, stock, lowStockAt
     FROM "Product"
     WHERE "stock" <= "lowStockAt"
     ORDER BY id`,
  );
  return rows;
}

/**
 * E. Products expiring within the next `days` days (UTC window),
 * excluding already expired products and products beyond the window.
 */
export async function getExpiringSoonProducts(days = 30) {
  const parsedDays = Number(days ?? 30);
  if (!Number.isInteger(parsedDays) || parsedDays < 1 || parsedDays > 365) {
    throw httpError(400, 'Invalid days');
  }

  const today = startOfDayUtc(new Date());
  const windowEnd = endOfDayUtc(new Date(today));
  windowEnd.setUTCDate(today.getUTCDate() + parsedDays);

  const products = await prisma.product.findMany({
    where: {
      expiryDate: { not: null, gte: today, lte: windowEnd },
    },
    orderBy: { expiryDate: 'asc' },
    select: { id: true, sku: true, name: true, expiryDate: true, stock: true },
  });
  return products;
}

export default {
  getDailyReport,
  getPnlReport,
  getTopProducts,
  getLowStockProducts,
  getExpiringSoonProducts,
};
