import { prisma } from '../db/prisma.js';
import { createSaleSchema } from '../schemas/sale.schema.js';
import { httpError, mapPrismaError } from '../utils/prismaErrors.js';
import { formatInvoiceNo } from '../utils/invoiceNo.js';
import { recordSale } from '../services/khata.service.js';
import { PAYMENT_METHODS, INVOICE_PREFIX } from '../config/constants.js';

const productLocks = new Map();
let invoiceLock = Promise.resolve();

function sortedUniqueIds(ids) {
  return [...new Set(ids.filter((id) => Number.isInteger(id) && id > 0))].sort((a, b) => a - b);
}

async function acquireProductLocks(productIds) {
  const uniqueSorted = sortedUniqueIds(productIds);
  let previous = Promise.resolve();
  for (const id of uniqueSorted) {
    const lock = productLocks.get(id) || Promise.resolve();
    previous = previous.then(() => lock).then(() => undefined);
    productLocks.set(id, previous);
  }

  return async () => {
    for (const id of uniqueSorted) {
      const current = productLocks.get(id);
      if (current) {
        try {
          await current;
        } catch {
          // Ignore errors during cleanup.
        }
        productLocks.delete(id);
      }
    }
  };
}

async function acquireInvoiceLock() {
  const previous = invoiceLock;
  const next = previous.then(() => undefined);
  invoiceLock = next;

  return async () => {
    try {
      await next;
    } catch {
      // Ignore errors during cleanup.
    }
  };
}

export async function createSale(userId, data) {
  const parsed = createSaleSchema.parse(data);
  const { paymentMethod, discount, items, customerId } = parsed;

  const productIds = items
    .filter((item) => item.productId !== undefined && item.productId !== null)
    .map((item) => item.productId);

  const releaseProductLocks = await acquireProductLocks(productIds);
  const releaseInvoiceLock = await acquireInvoiceLock();

  try {
    const result = await prisma.$transaction(async (tx) => {
      const inventoryItems = [];
      const manualItems = [];

      for (const item of items) {
        if (item.productId !== undefined && item.productId !== null) {
          inventoryItems.push(item);
        } else {
          manualItems.push(item);
        }
      }

      const quantityByProductId = new Map();
      for (const item of inventoryItems) {
        const pid = item.productId;
        quantityByProductId.set(pid, (quantityByProductId.get(pid) || 0) + item.quantity);
      }

      const products = await tx.product.findMany({
        where: { id: { in: [...quantityByProductId.keys()] } },
      });

      const productMap = new Map();
      for (const product of products) {
        productMap.set(product.id, product);
      }

      for (const [productId, aggregatedQuantity] of quantityByProductId) {
        const product = productMap.get(productId);
        if (!product) {
          throw httpError(404, 'Product not found');
        }
        if (product.stock < aggregatedQuantity) {
          throw httpError(400, `Insufficient stock for ${product.name}`);
        }
      }

      let subtotal = 0;
      const saleItemsData = [];

      for (const item of inventoryItems) {
        const product = productMap.get(item.productId);
        const lineTotal = Number((item.unitPrice * item.quantity).toFixed(2));
        subtotal = Number((subtotal + lineTotal).toFixed(2));
        saleItemsData.push({
          saleId: -1,
          productId: item.productId,
          manualName: null,
          quantity: item.quantity,
          unitPrice: item.unitPrice,
          unitCost: product ? product.costPrice : null,
          total: lineTotal,
        });
      }

      for (const item of manualItems) {
        const lineTotal = Number((item.unitPrice * item.quantity).toFixed(2));
        subtotal = Number((subtotal + lineTotal).toFixed(2));
        saleItemsData.push({
          saleId: -1,
          productId: null,
          manualName: item.manualName,
          quantity: item.quantity,
          unitPrice: item.unitPrice,
          unitCost: null,
          total: lineTotal,
        });
      }

      const discountValue = Number(Math.max(0, Number(discount) || 0).toFixed(2));
      const totalValue = Math.max(0, Number((subtotal - discountValue).toFixed(2)));

      const now = new Date();
      const year = now.getFullYear();
      const existingCount = await tx.sale.count({
        where: { invoiceNo: { startsWith: `${INVOICE_PREFIX}-${year}-` } },
      });
      const invoiceNo = formatInvoiceNo(year, existingCount + 1);

      // KHATA sales require an existing customer. Validate BEFORE inserting the
      // Sale so a missing customer yields 404 rather than a foreign-key
      // violation (409) from the database.
      if (paymentMethod === 'KHATA') {
        const khataCustomer = await tx.customer.findUnique({ where: { id: customerId } });
        if (!khataCustomer) throw httpError(404, 'Customer not found');
      }

      const sale = await tx.sale.create({
        data: {
          invoiceNo,
          subtotal: Number(subtotal.toFixed(2)),
          discount: discountValue,
          total: totalValue,
          paymentMethod,
          customerId: paymentMethod === 'KHATA' ? customerId : undefined,
          createdAt: new Date(),
        },
      });

      // KHATA sales create a ledger entry and increase the customer balance
      // inside the SAME transaction as the sale. If anything fails, the whole
      // transaction (sale + items + stock + ledger + balance) rolls back, so
      // no orphan ledger entry or balance change can be left behind.
      if (paymentMethod === 'KHATA') {
        await recordSale(customerId, sale.id, sale.total, `Credit sale ${sale.invoiceNo}`, tx);
      }

      const finalizedItems = saleItemsData.map((item) => ({ ...item, saleId: sale.id }));
      await tx.saleItem.createMany({ data: finalizedItems });

      for (const [productId, aggregatedQuantity] of quantityByProductId) {
        const product = productMap.get(productId);
        if (!product) continue;
        const result = await tx.product.updateMany({
          where: { id: productId, stock: { gte: aggregatedQuantity } },
          data: { stock: { decrement: aggregatedQuantity } },
        });

        if (result.count !== 1) {
          throw httpError(400, `Insufficient stock for ${product.name}`);
        }
      }

      return { ...sale, items: finalizedItems };
    });

    return result;
  } catch (err) {
    if (err && err.expose) {
      throw err;
    }
    try {
      mapPrismaError(err, { entity: 'Sale' });
    } catch (mapped) {
      throw mapped;
    }
    throw httpError(500, 'Internal server error');
  } finally {
    await releaseProductLocks();
    await releaseInvoiceLock();
  }
}

export default { createSale };
