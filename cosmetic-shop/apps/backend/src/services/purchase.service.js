import { prisma } from '../db/prisma.js';
import { httpError, mapPrismaError } from '../utils/prismaErrors.js';
import { createPurchaseSchema, purchaseListQuerySchema } from '../schemas/purchase.schema.js';
import { createProduct } from './product.service.js';
import { add, multiply } from '../utils/money.js';

const MAX_AMOUNT = 1e9;
const productLocks = new Map();

function resolvePurchaseStatus(totalAmount, paidAmount) {
  const total = Number(totalAmount || 0);
  const paid = Number(paidAmount || 0);
  if (paid <= 0) return 'UNPAID';
  if (paid >= total) return 'PAID';
  return 'PARTIAL';
}

function parseDateIfPresent(value, label) {
  if (value === undefined || value === null || value === '') return undefined;
  const dateValue = new Date(String(value));
  if (Number.isNaN(dateValue.getTime())) {
    throw httpError(400, `Invalid ${label}`);
  }
  return dateValue;
}

async function acquireProductLocks(productIds) {
  const uniqueSorted = [...new Set(productIds.filter((id) => Number.isInteger(id) && id > 0))].sort((a, b) => a - b);
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
          // Ignore release-time failures.
        }
        productLocks.delete(id);
      }
    }
  };
}

export async function listPurchases(query = {}) {
  const parsed = purchaseListQuerySchema.parse(query);
  const page = Number(parsed.page);
  const limit = Number(parsed.limit);
  const where = {};

  if (parsed.supplierId !== undefined) {
    where.supplierId = parsed.supplierId;
  }
  if (parsed.from || parsed.to) {
    where.createdAt = {};
    if (parsed.from) {
      where.createdAt.gte = parseDateIfPresent(parsed.from, 'from');
    }
    if (parsed.to) {
      const end = new Date(String(parsed.to));
      end.setHours(23, 59, 59, 999);
      where.createdAt.lte = end;
    }
  }

  // Search: purchase ID (exact numeric) OR supplier name (partial contains).
  // Empty or whitespace-only search behaves exactly like no search.
  if (parsed.search && parsed.search.trim() !== '') {
    const searchTerm = parsed.search.trim();
    const orConditions = [];

    // Purchase ID match: only when the search term is a valid positive safe integer.
    // Invalid numeric conversions must not create unintended matches.
    // We verify String(idAsNumber) === searchTerm to reject inputs like "00123"
    // that would silently become ID 123.
    const idAsNumber = Number(searchTerm);
    if (
      Number.isFinite(idAsNumber) &&
      idAsNumber > 0 &&
      Number.isSafeInteger(idAsNumber) &&
      String(idAsNumber) === searchTerm
    ) {
      orConditions.push({ id: idAsNumber });
    }

    // Supplier name match: partial contains on SQLite.
    // SQLite's LIKE operator is case-insensitive for ASCII characters (a-z, A-Z)
    // by default. Prisma generates "Supplier"."name" LIKE '%searchTerm%' for the
    // contains filter. This is ASCII-only case-insensitive; Unicode characters may
    // not be case-insensitive depending on SQLite's case_sensitive_like pragma.
    orConditions.push({
      supplier: {
        name: {
          contains: searchTerm,
        },
      },
    });

    where.OR = orConditions;
  }

  const [total, purchases] = await prisma.$transaction([
    prisma.purchase.count({ where }),
    prisma.purchase.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      skip: (page - 1) * limit,
      take: limit,
      include: {
        supplier: true,
        items: { include: { product: true } },
      },
    }),
  ]);

  return { purchases, total, page, limit };
}

/**
 * A duplicate purchase was detected inside the transaction.
 *
 * Throwing it rolls the transaction back, so every side effect allocated by
 * the losing request (items, stock increments, supplier balance) is released
 * again. The original purchase is then read outside the transaction, where
 * the winner has committed it.
 */
class DuplicatePurchaseError extends Error {
  constructor(idempotencyKey) {
    super('A purchase with this idempotency key already exists');
    this.name = 'DuplicatePurchaseError';
    this.idempotencyKey = idempotencyKey;
  }
}

/**
 * Read a purchase together with its supplier and items, for an idempotent
 * replay or a detail response.
 *
 * @param {object} client - a Prisma transaction client (or the root client).
 * @param {number} id - the primary key of the purchase.
 * @returns {Promise<object>} the purchase with relations.
 * @throws {P2025} when no purchase matches the id.
 */
async function readPurchaseWithItems(client, id) {
  return client.purchase.findUnique({
    where: { id },
    include: {
      supplier: true,
      items: { include: { product: true }, orderBy: { id: 'asc' } },
    },
  });
}

export async function createPurchase(data, idempotencyKey) {
  const parsed = createPurchaseSchema.parse(data);
  const { supplierId, items } = parsed;
  const productIds = items
    .filter((item) => 'productId' in item)
    .map((item) => item.productId);
  if (new Set(productIds).size !== productIds.length) {
    throw httpError(400, 'Duplicate product IDs are not allowed');
  }

  const releaseLocks = await acquireProductLocks(productIds);
  try {
    return await prisma.$transaction(async (tx) => {
      // Idempotency: when a key was supplied, a purchase that already carries
      // that key is returned unchanged. No second purchase, no second stock
      // increment, no second supplier balance change and no second item row.
      if (idempotencyKey) {
        const existing = await tx.purchase.findUnique({ where: { idempotencyKey } });
        if (existing) {
          return readPurchaseWithItems(tx, existing.id);
        }
      }

      const supplier = await tx.supplier.findUnique({ where: { id: supplierId } });
      if (!supplier) {
        throw httpError(404, 'Supplier not found');
      }

      const resolvedItems = [];

      for (const item of items) {
        if ('productId' in item) {
          const product = await tx.product.findUnique({ where: { id: item.productId } });
          if (!product) {
            throw httpError(404, 'Product not found');
          }
          if (!Number.isFinite(item.unitCost) || item.unitCost <= 0 || item.unitCost > MAX_AMOUNT) {
            throw httpError(400, 'Invalid unitCost');
          }
          if (!Number.isInteger(item.quantity) || item.quantity <= 0) {
            throw httpError(400, 'Invalid quantity');
          }

          resolvedItems.push({
            productId: item.productId,
            quantity: item.quantity,
            unitCost: Number(item.unitCost),
            isNewProduct: false,
          });
          continue;
        }

        if (!('newProduct' in item)) {
          throw httpError(400, 'One of productId or newProduct is required');
        }
        if (!Number.isFinite(item.unitCost) || item.unitCost <= 0 || item.unitCost > MAX_AMOUNT) {
          throw httpError(400, 'Invalid unitCost');
        }
        if (!Number.isInteger(item.quantity) || item.quantity <= 0) {
          throw httpError(400, 'Invalid quantity');
        }

        const createdProduct = await createProduct({
          ...item.newProduct,
          stock: item.quantity,
        }, tx);

        resolvedItems.push({
          productId: createdProduct.id,
          quantity: item.quantity,
          unitCost: Number(item.unitCost),
          isNewProduct: true,
        });
      }

      const totalAmount = resolvedItems.reduce(
        (sum, item) => add(sum, multiply(item.unitCost, item.quantity)),
        0,
      );
      if (!Number.isFinite(totalAmount) || totalAmount <= 0 || totalAmount > MAX_AMOUNT * 10_000) {
        throw httpError(400, 'Purchase total is invalid');
      }

      let purchase;
      try {
        purchase = await tx.purchase.create({
          data: {
            supplierId,
            totalAmount,
            paidAmount: 0,
            status: 'UNPAID',
            ...(idempotencyKey ? { idempotencyKey } : {}),
          },
        });
      } catch (err) {
        if (err.code === 'P2002' && idempotencyKey) {
          // A concurrent request with the same key won the unique-constraint
          // race. Throwing rolls this transaction back (releasing its stock
          // increments and supplier balance change) so we can return the
          // committed purchase instead of creating a duplicate.
          const existing = await tx.purchase.findUnique({ where: { idempotencyKey } });
          if (existing) throw new DuplicatePurchaseError(idempotencyKey);
        }
        throw err;
      }

      const purchaseItems = resolvedItems.map((item) => ({
        purchaseId: purchase.id,
        productId: item.productId,
        quantity: item.quantity,
        unitCost: Number(item.unitCost),
        total: multiply(item.unitCost, item.quantity),
      }));

      await tx.purchaseItem.createMany({ data: purchaseItems });

      for (const item of resolvedItems) {
        if (item.isNewProduct) continue;
        await tx.product.update({
          where: { id: item.productId },
          data: {
            stock: { increment: item.quantity },
            costPrice: item.unitCost,
          },
        });
      }

      await tx.supplier.update({
        where: { id: supplierId },
        data: { balance: { increment: totalAmount } },
      });

      const current = await tx.purchase.findUnique({
        where: { id: purchase.id },
        include: {
          supplier: true,
          items: { include: { product: true } },
        },
      });

      return current;
    });
  } catch (err) {
    if (err instanceof DuplicatePurchaseError) {
      // The winning request has committed the purchase. Return it unchanged.
      const existing = await prisma.purchase.findUnique({
        where: { idempotencyKey: err.idempotencyKey },
        include: {
          supplier: true,
          items: { include: { product: true }, orderBy: { id: 'asc' } },
        },
      });
      if (existing) return existing;
      throw err;
    }
    if (err && err.expose) {
      throw err;
    }
    try {
      mapPrismaError(err, { entity: 'Purchase' });
    } catch (mapped) {
      throw mapped;
    }
    throw httpError(500, 'Internal server error');
  } finally {
    await releaseLocks();
  }
}

/**
 * Fetch a single purchase by its primary key, with supplier and items.
 * Throws P2025 (mapped to 404 "Purchase not found") when missing.
 *
 * @param {number} id - the primary key of the purchase.
 * @returns {Promise<object>} the purchase with supplier and items.
 */
export async function getPurchaseById(id) {
  try {
    const purchase = await readPurchaseWithItems(prisma, id);
    if (!purchase) throw httpError(404, 'Purchase not found');
    return purchase;
  } catch (err) {
    if (err?.code === 'P2025') {
      throw httpError(404, 'Purchase not found');
    }
    throw err;
  }
}

export default { listPurchases, createPurchase, getPurchaseById };
