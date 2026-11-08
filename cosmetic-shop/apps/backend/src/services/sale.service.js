import { prisma } from '../db/prisma.js';
import { createSaleSchema } from '../schemas/sale.schema.js';
import { httpError, mapPrismaError } from '../utils/prismaErrors.js';
import { formatInvoiceNo } from '../utils/invoiceNo.js';
import { PAYMENT_METHODS, INVOICE_PREFIX } from '../config/constants.js';

// --- In-memory locks ---
// Per-product lock map: productId -> promise chain
const productLocks = new Map();

// Global invoice generation lock
const invoiceLock = Promise.resolve();

/**
 * Acquires per-product locks in deterministic order (sorted by productId).
 * Returns a cleanup function that releases all acquired locks.
 */
async function acquireProductLocks(productIds) {
  const uniqueSorted = [...new Set(productIds)].sort((a, b) => a - b);

  let previous = Promise.resolve();
  for (const id of uniqueSorted) {
    let lock = productLocks.get(id);
    if (!lock) lock = Promise.resolve();
    previous = previous.then(() => {
      const next = lock.then(() => {});
      return next;
    });
    productLocks.set(id, previous);
  }

  return async () => {
    for (const id of uniqueSorted) {
      const current = productLocks.get(id);
      if (current) {
        try {
          await current;
        } catch {
          // Ignore errors during cleanup
        }
        productLocks.delete(id);
      }
    }
  };
}

/**
 * Acquires the global invoice generation lock.
 * Returns a cleanup function that releases the lock.
 */
async function acquireInvoiceLock() {
  const previous = invoiceLock;
  const next = previous.then(() => {});
  invoiceLock = next;

  return async () => {
    try {
      await next;
    } catch {
      // Ignore errors during cleanup
    }
  };
}

/**
 * Create a sale (POS transaction) with atomic stock decrement and invoice generation.
 *
 * @param {number} userId - The user ID creating the sale
 * @param {object} data - The sale data validated by createSaleSchema
 * @returns {Promise<object>} The created sale with associated sale items
 */
export async function createSale(userId, data) {
  // Validate inputs using the schema
  const parsed = createSaleSchema.parse(data);

  const { paymentMethod, discount, items } = parsed;

  // Identify all unique product IDs for locking
  const productIds = items
    .filter((item) => item.productId !== undefined && item.productId !== null)
    .map((item) => item.productId!);

  // Acquire product locks in deterministic order
  const releaseProductLocks = await acquireProductLocks(productIds);

  // Acquire invoice generation lock
  const releaseInvoiceLock = await acquireInvoiceLock();

  try {
    // Use a single Prisma transaction for ALL database writes
    const result = await prisma.$transaction(async (tx) => {
      // --- Product lookup and stock validation ---
      // Group items by productId to aggregate quantities
      const inventoryItems = items.filter(
        (item) => item.productId !== undefined && item.productId !== null
      );
      const manualItems = items.filter(
        (item) => item.manualName !== undefined && item.manualName !== null
      );

      // Build a map of productId -> aggregated quantity from this sale
      const quantityByProductId = new Map();
      for (const item of inventoryItems) {
        const pid = item.productId!;
        quantityByProductId.set(
          pid,
          (quantityByProductId.get(pid) || 0) + item.quantity
        );
      }

      // Fetch all products involved in the sale
      const products = await tx.product.findMany({
        where: {
          id: {
            in: quantityByProductId.keys(),
          },
        },
      });

      // Build a product lookup map
      const productMap = new Map();
      for (const product of products) {
        productMap.set(product.id, product);
      }

      // Validate each inventory product exists and has sufficient stock
      for (const [productId, aggregatedQuantity] of quantityByProductId) {
        const product = productMap.get(productId);
        if (!product) {
          throw httpError(404, 'Product not found');
        }
        if (product.stock < aggregatedQuantity) {
          throw httpError(400, `Insufficient stock for ${product.name}`);
        }
      }

      // Snapshot unitCost from the database (never use client-supplied unitCost)
      const unitCostByProductId = new Map();
      for (const [productId, _] of quantityByProductId) {
        const product = productMap.get(productId);
        if (product) {
          unitCostByProductId.set(productId, product.costPrice);
        }
      }

      // --- Calculate line totals and subtotal ---
      let subtotal = 0;
      const saleItemsData = [];

      // Process inventory items
      for (const item of inventoryItems) {
        const product = productMap.get(item.productId!);
        const aggregatedQty = quantityByProductId.get(item.productId!);
        const dbUnitCost = unitCostByProductId.get(item.productId!) || product.costPrice;

        const lineTotal = item.unitPrice * aggregatedQty;
        subtotal += lineTotal;

        saleItemsData.push({
          saleId: -1, // placeholder, will be set after sale creation
          productId: item.productId,
          manualName: null,
          quantity: aggregatedQty,
          unitPrice: item.unitPrice,
          unitCost: dbUnitCost,
          total: lineTotal,
        });
      }

      // Process manual items
      for (const item of manualItems) {
        const aggregatedQty = item.quantity; // manual items have single line
        const lineTotal = item.unitPrice * aggregatedQty;
        subtotal += lineTotal;

        saleItemsData.push({
          saleId: -1, // placeholder
          productId: null,
          manualName: item.manualName,
          quantity: aggregatedQty,
          unitPrice: item.unitPrice,
          unitCost: null, // manual items always have null unitCost
          total: lineTotal,
        });
      }

      // --- Invoice generation ---
      // Get current year (using local timezone consistently)
      const now = new Date();
      const year = now.getFullYear();

      // Count existing sales for this year (protected by invoice lock)
      const existingCount = await tx.sale.count({
        where: {
          invoiceNo: {
            startsWith: `${INVOICE_PREFIX}-${year}-`,
          },
        },
      });

      const invoiceNo = formatInvoiceNo(year, existingCount + 1);

      // --- Create the Sale record ---
      const sale = await tx.sale.create({
        data: {
          invoiceNo,
          subtotal: Number(subtotal.toFixed(2)),
          discount: Number(Number(discount) || 0),
          total: Math.max(0, Number(subtotal.toFixed(2)) - Number(Number(discount) || 0)),
          paymentMethod,
          createdAt: new Date(),
        },
      });

      // Associate saleId with all sale items
      for (const si of saleItemsData) {
        si.saleId = sale.id;
      }

      // --- Create SaleItem records ---
      await tx.saleItem.createMany({
        data: saleItemsData,
      });

      // --- Decrement stock for inventory products ---
      // Use conditional atomic updates inside the transaction
      for (const [productId, aggregatedQuantity] of quantityByProductId) {
        const product = productMap.get(productId);
        if (product) {
          const result = await tx.product.updateMany({
            where: {
              id: productId,
              stock: { gte: aggregatedQuantity },
            },
            data: {
              stock: { decrement: aggregatedQuantity },
            },
          });

          if (result.count !== 1) {
            throw httpError(400, 'Insufficient stock');
          }
        }
      }

      // Return the created sale including its items
      return {
        ...sale,
        items: saleItemsData,
      };
    });

    return result;
  } catch (err) {
    // Map Prisma errors to HTTP errors
    mapPrismaError(err);

    // Re-throw httpError instances (they already have .status and .expose)
    if (err instanceof Error && err.expose) {
      throw err;
    }

    // Wrap unexpected errors
    throw httpError(500, 'Internal server error');
  } finally {
    // Always release locks in finally blocks
    releaseProductLocks();
    releaseInvoiceLock();
  }
}