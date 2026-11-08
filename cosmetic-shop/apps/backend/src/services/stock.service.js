import { prisma } from '../db/prisma.js';
import { httpError } from '../utils/prismaErrors.js';

export async function adjustStock(userId, data) {
  const { productId, delta, reason, unitCost } = data;

  const product = await prisma.product.findUnique({ where: { id: productId } });
  if (!product) throw httpError(404, 'Product not found');

  if (delta < 0 && product.stock < Math.abs(delta)) {
    throw httpError(400, `Insufficient stock to remove ${Math.abs(delta)} units`);
  }

  return await prisma.$transaction(async (tx) => {
    const storedUnitCost = delta > 0 ? (unitCost ?? null) : null;

    const adjustment = await tx.stockAdjust.create({
      data: { productId, delta, reason, unitCost: storedUnitCost },
    });

    if (delta > 0) {
      await tx.product.update({
        where: { id: productId },
        data: { stock: { increment: delta } },
      });
    } else {
      const result = await tx.product.updateMany({
        where: { id: productId, stock: { gte: Math.abs(delta) } },
        data: { stock: { decrement: Math.abs(delta) } },
      });
      if (result.count !== 1) {
        throw httpError(400, 'Insufficient stock: concurrent modification');
      }
    }

    const updatedProduct = await tx.product.findUnique({ where: { id: productId } });
    return { adjustment, product: updatedProduct };
  });
}

export async function listAdjustments(query) {
  const page = Math.max(1, Number(query.page) || 1);
  const limit = Math.min(Math.max(1, Number(query.limit) || 20), 100);
  const where = {};
  if (query.productId) where.productId = Number(query.productId);

  const [total, adjustments] = await Promise.all([
    prisma.stockAdjust.count({ where }),
    prisma.stockAdjust.findMany({
      where, orderBy: { createdAt: 'desc' }, take: limit, skip: (page - 1) * limit,
    }),
  ]);

  return { adjustments, total, page, limit, totalPages: Math.ceil(total / limit) };
}

export async function getAdjustmentsForProduct(productId) {
  const product = await prisma.product.findUnique({ where: { id: productId } });
  if (!product) throw httpError(404, 'Product not found');

  const adjustments = await prisma.stockAdjust.findMany({
    where: { productId }, orderBy: { createdAt: 'desc' },
  });
  return { adjustments };
}
