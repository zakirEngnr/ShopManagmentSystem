import { prisma } from '../db/prisma.js';
import { createSaleSchema } from '../schemas/sale.schema.js';
import { httpError, mapPrismaError } from '../utils/prismaErrors.js';
import { add, multiply, subtract, toPaisa, fromPaisa } from '../utils/money.js';
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

/**
 * The invoice sequences live in the Counter table, so they are allocated by
 * the database and are safe when several requests race for the same number.
 *
 * A year that has no counter yet is seeded with the highest sequence that
 * already exists in the invoice numbers of that year, so a database that was
 * written before the counter existed continues after its highest invoice
 * number instead of restarting at 1.
 *
 * MUST be called inside the transaction that creates the sale: the counter is
 * rolled back with the sale, so a failed sale consumes no invoice number.
 *
 * @param {object} client - a Prisma transaction client (or the root client).
 * @param {number} year - the year of the invoice number.
 * @returns {Promise<number>} the allocated sequence (1-based).
 */
export async function allocateInvoiceSequence(client, year) {
  const key = `invoice-${year}`;
  const prefix = `${INVOICE_PREFIX}-${year}-`;

  const existing = await client.counter.findUnique({ where: { key } });
  if (!existing) {
    // Seed the counter with the highest sequence that already exists for this
    // year, so the numbering continues after the highest invoice number.
    const rows = await client.sale.findMany({
      where: { invoiceNo: { startsWith: prefix } },
      select: { invoiceNo: true },
    });
    let highest = 0;
    for (const row of rows) {
      const sequence = Number.parseInt(String(row.invoiceNo).slice(prefix.length), 10);
      if (Number.isFinite(sequence) && sequence > highest) highest = sequence;
    }
    try {
      await client.counter.create({ data: { key, value: highest } });
    } catch (err) {
      // Another request created the counter first; its value is the truth.
      if (err.code !== 'P2002') throw err;
    }
  }

  // Atomic increment: the database performs the read-modify-write, so two
  // concurrent allocations can never receive the same sequence.
  const updated = await client.counter.update({
    where: { key },
    data: { value: { increment: 1 } },
  });
  return updated.value;
}

/**
 * A duplicate sale was detected inside the transaction.
 *
 * Throwing it rolls the transaction back, so the invoice sequence that was
 * allocated for the losing request is released again. The original sale is
 * then read outside the transaction, where the winner has committed it.
 */
class DuplicateSaleError extends Error {
  constructor(idempotencyKey) {
    super('A sale with this idempotency key already exists');
    this.name = 'DuplicateSaleError';
    this.idempotencyKey = idempotencyKey;
  }
}

/**
 * Resolve the cash tender of a sale.
 *
 * CASH   - the tender is mandatory, must be a finite non-negative amount and
 *          must cover the sale total. The tender itself is what is stored;
 *          the sale total is never replaced by the tender and the recognized
 *          amount stays the sale amount.
 * Others - the tender does not apply. It may be omitted or explicitly null
 *          (both are stored as NULL) but any other value is rejected.
 *
 * The tender and the total are compared as INTEGER PAISA. Comparing the
 * floating point rupees directly would make a one-paisa difference
 * unpredictable.
 *
 * @param {string} paymentMethod - the payment method of the sale.
 * @param {number|null|undefined} cashReceived - the tender from the payload.
 * @param {number} totalPaisa - the final sale total in integer paisa.
 * @returns {number|null} the tender to store (NULL when it does not apply).
 */
function determineCashReceived(paymentMethod, cashReceived, totalPaisa) {
  if (paymentMethod === 'CASH') {
    if (cashReceived === null || cashReceived === undefined) {
      throw httpError(400, 'cashReceived is required for CASH payments');
    }
    if (typeof cashReceived !== 'number' || !Number.isFinite(cashReceived)) {
      throw httpError(400, 'cashReceived must be a finite number');
    }
    const tenderPaisa = toPaisa(cashReceived);
    if (tenderPaisa < 0) {
      throw httpError(400, 'cashReceived must not be negative');
    }
    if (tenderPaisa < totalPaisa) {
      throw httpError(400, 'Cash received is less than the total of the sale');
    }
    return fromPaisa(tenderPaisa);
  }

  // CARD, JAZZCASH, MOBILE and KHATA: the tender does not apply.
  if (cashReceived !== null && cashReceived !== undefined) {
    throw httpError(400, 'cashReceived is not applicable for this payment method');
  }
  return null;
}

/** Read a sale together with its items, for an idempotent replay. */
async function readSaleWithItems(client, sale) {
  const items = await client.saleItem.findMany({
    where: { saleId: sale.id },
    orderBy: { id: 'asc' },
  });
  return { ...sale, items };
}

export async function createSale(userId, data, idempotencyKey) {
  const parsed = createSaleSchema.parse(data);
  const { paymentMethod, discount, items, customerId, cashReceived } = parsed;

  const productIds = items
    .filter((item) => item.productId !== undefined && item.productId !== null)
    .map((item) => item.productId);

  const releaseProductLocks = await acquireProductLocks(productIds);
  const releaseInvoiceLock = await acquireInvoiceLock();

  try {
    let result;
    try {
      result = await prisma.$transaction(async (tx) => {
        // Idempotency: when a key was supplied, a sale that already carries
        // that key is returned unchanged. No second sale, no second stock
        // decrement, no second ledger entry and no second invoice number.
        if (idempotencyKey) {
          const existing = await tx.sale.findUnique({ where: { idempotencyKey } });
          if (existing) {
            return readSaleWithItems(tx, existing);
          }
        }

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
          const lineTotal = multiply(item.unitPrice, item.quantity);
          subtotal = add(subtotal, lineTotal);
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
          const lineTotal = multiply(item.unitPrice, item.quantity);
          subtotal = add(subtotal, lineTotal);
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

        // Cap the applied discount at the subtotal (defense-in-depth). The
        // frontend also clamps the bill discount to the subtotal, but the
        // backend must enforce it regardless of what the client sends.
        const appliedDiscount = Math.min(Math.max(0, discount || 0), subtotal);
        const totalValue = Math.max(0, subtract(subtotal, appliedDiscount));

        // A KHATA sale with a total of 0 means the customer owes nothing; that
        // is not a valid credit sale. Reject with a clear 400 instead of a 500.
        if (paymentMethod === 'KHATA' && totalValue <= 0) {
          throw httpError(400, 'KHATA sale total cannot be zero: discount cannot exceed the subtotal.');
        }

        // KHATA sales require an existing customer. Validate BEFORE inserting the
        // Sale so a missing customer yields 404 rather than a foreign-key
        // violation (409) from the database.
        if (paymentMethod === 'KHATA') {
          const khataCustomer = await tx.customer.findUnique({ where: { id: customerId } });
          if (!khataCustomer) throw httpError(404, 'Customer not found');
        }

        // The cash tender is resolved BEFORE the sale row is written, so a
        // rejected tender never creates a sale. The comparison against the
        // final total happens in integer paisa.
        const totalPaisa = toPaisa(totalValue);
        const resolvedCashReceived = determineCashReceived(paymentMethod, cashReceived, totalPaisa);

        const now = new Date();
        const year = now.getFullYear();
        const sequence = await allocateInvoiceSequence(tx, year);
        const invoiceNo = formatInvoiceNo(year, sequence);

        let sale;
        try {
          sale = await tx.sale.create({
            data: {
              invoiceNo,
              subtotal: Number(subtotal.toFixed(2)),
              discount: appliedDiscount,
              total: totalValue,
              // Recognized revenue: immediate for non-KHATA (paid at sale time),
              // deferred for KHATA (recognized as payments are collected).
              recognizedAmount: paymentMethod === 'KHATA' ? 0 : totalValue,
              paymentMethod,
              customerId: paymentMethod === 'KHATA' ? customerId : undefined,
              cashReceived: resolvedCashReceived,
              ...(idempotencyKey ? { idempotencyKey } : {}),
              createdAt: now,
            },
          });
        } catch (err) {
          if (err.code === 'P2002' && idempotencyKey) {
            // A concurrent request with the same key won the unique-constraint
            // race. Roll the transaction back (so the invoice sequence that was
            // allocated here is released again) and return the committed sale.
            const existing = await tx.sale.findUnique({ where: { idempotencyKey } });
            if (existing) throw new DuplicateSaleError(idempotencyKey);
          }
          throw err;
        }

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
    } catch (err) {
      if (err instanceof DuplicateSaleError) {
        // The winning request has committed the sale. Return it unchanged.
        const existing = await prisma.sale.findUnique({ where: { idempotencyKey: err.idempotencyKey } });
        if (existing) {
          return readSaleWithItems(prisma, existing);
        }
        throw err;
      }
      if (err && err.expose) {
        throw err;
      }
      try {
        mapPrismaError(err, { entity: 'Sale' });
      } catch (mapped) {
        throw mapped;
      }
      throw httpError(500, 'Internal server error');
    }

    return result;
  } finally {
    await releaseProductLocks();
    await releaseInvoiceLock();
  }
}

export { determineCashReceived };
export default { createSale, allocateInvoiceSequence };
