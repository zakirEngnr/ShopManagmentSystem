import { prisma } from '../db/prisma.js';
import { httpError } from '../utils/prismaErrors.js';
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

export async function createPurchase(data) {
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
          if (product.stock > 0 && item.quantity >= 5 && item.quantity > product.stock) {
            throw httpError(400, 'Purchase quantity exceeds current stock');
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

      const purchase = await tx.purchase.create({
        data: {
          supplierId,
          totalAmount,
          paidAmount: 0,
          status: 'UNPAID',
        },
      });

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
  } finally {
    await releaseLocks();
  }
}

export default { listPurchases, createPurchase };
