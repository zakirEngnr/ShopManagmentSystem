import { prisma } from '../db/prisma.js';
import { httpError } from '../utils/prismaErrors.js';
import { toPaisa, fromPaisa } from '../utils/money.js';

const MAX_PAYMENT_AMOUNT = 1e9;

function normalizeOptionalText(value) {
  if (value === undefined || value === null || value === '') return null;
  return String(value).trim();
}

function resolvePurchaseStatus(totalAmount, paidAmount) {
  const total = Number(totalAmount || 0);
  const paid = Number(paidAmount || 0);
  if (paid <= 0) return 'UNPAID';
  if (paid >= total) return 'PAID';
  return 'PARTIAL';
}

export async function listSuppliers(query = {}) {
  const page = Number(query.page ?? 1);
  const limit = Number(query.limit ?? 20);
  if (!Number.isInteger(page) || page < 1) throw httpError(400, 'Invalid page');
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw httpError(400, 'Invalid limit');

  const where = {};
  const search = typeof query.search === 'string' ? query.search.trim() : '';
  if (search) {
    where.name = { contains: search };
  }

  const [total, suppliers, outstandingTotal] = await prisma.$transaction([
    prisma.supplier.count({ where }),
    prisma.supplier.findMany({
      where,
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.supplier.aggregate({
      _sum: { balance: true },
      where,
    }),
  ]);

  return {
    suppliers,
    total,
    page,
    limit,
    outstandingTotal: outstandingTotal._sum.balance ?? 0,
  };
}

export async function createSupplier(data) {
  const supplierData = {
    name: String(data.name).trim(),
    phone: normalizeOptionalText(data.phone),
    email: normalizeOptionalText(data.email),
    address: normalizeOptionalText(data.address),
    notes: normalizeOptionalText(data.notes),
    balance: 0,
  };

  return prisma.supplier.create({ data: supplierData });
}

export async function recordPayment(supplierId, data, idempotencyKey) {
  const amount = Number(data?.amount);
  const paisa = toPaisa(amount);
  if (!Number.isFinite(amount) || paisa <= 0) {
    throw httpError(400, 'Amount must be a positive number');
  }
  if (amount > MAX_PAYMENT_AMOUNT) {
    throw httpError(400, 'Amount must not exceed 1000000000');
  }

  return prisma.$transaction(async (tx) => {
    // Idempotency: if a key was supplied, return the original payment when one
    // already exists, skipping stock/payable/allocation side effects.
    if (idempotencyKey) {
      const existing = await tx.supplierPayment.findUnique({ where: { idempotencyKey } });
      if (existing) {
        const allocations = await tx.supplierPaymentAllocation.findMany({
          where: { supplierPaymentId: existing.id },
          orderBy: { id: 'asc' },
        });
        const supplier = await tx.supplier.findUnique({ where: { id: supplierId } });
        return { payment: existing, allocations, supplier };
      }
    }

    const supplier = await tx.supplier.findUnique({ where: { id: supplierId } });
    if (!supplier) throw httpError(404, 'Supplier not found');

    const balancePaisa = toPaisa(Number(supplier.balance || 0));
    if (balancePaisa <= 0) {
      throw httpError(400, 'No outstanding balance to pay');
    }
    if (paisa > balancePaisa) {
      throw httpError(400, "Payment cannot exceed the supplier's outstanding balance.");
    }

    let payment;
    try {
      payment = await tx.supplierPayment.create({
        data: {
          supplierId,
          amount,
          ...(idempotencyKey ? { idempotencyKey } : {}),
          description: data.description === undefined || data.description === null ? null : String(data.description).trim() || null,
        },
      });
    } catch (err) {
      if (err.code === 'P2002' && idempotencyKey) {
        const existing = await tx.supplierPayment.findUnique({ where: { idempotencyKey } });
        if (existing) {
          const allocations = await tx.supplierPaymentAllocation.findMany({
            where: { supplierPaymentId: existing.id },
            orderBy: { id: 'asc' },
          });
          const supplier2 = await tx.supplier.findUnique({ where: { id: supplierId } });
          return { payment: existing, allocations, supplier: supplier2 };
        }
      }
      throw err;
    }

    let remainingPaisa = paisa;
    const purchases = await tx.purchase.findMany({
      where: { supplierId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });

    for (const purchase of purchases) {
      if (remainingPaisa <= 0) break;
      const totalPaisa = toPaisa(Number(purchase.totalAmount || 0));
      const paidPaisa = toPaisa(Number(purchase.paidAmount || 0));
      const duePaisa = totalPaisa - paidPaisa;
      if (duePaisa <= 0) continue;

      const allocatePaisa = Math.min(remainingPaisa, duePaisa);
      if (allocatePaisa <= 0) continue;

      const nextPaidPaisa = paidPaisa + allocatePaisa;
      // Compare-and-swap on the previously observed paidAmount. If a concurrent
      // payment changed this purchase in the meantime, updateMany matches zero
      // rows and the whole transaction rolls back instead of overwriting it.
      const updatedPurchase = await tx.purchase.updateMany({
        where: { id: purchase.id, paidAmount: purchase.paidAmount },
        data: {
          paidAmount: fromPaisa(nextPaidPaisa),
          status: resolvePurchaseStatus(fromPaisa(totalPaisa), fromPaisa(nextPaidPaisa)),
        },
      });
      if (updatedPurchase.count !== 1) {
        throw httpError(409, 'Purchase changed, please retry');
      }
      await tx.supplierPaymentAllocation.create({
        data: {
          supplierPaymentId: payment.id,
          purchaseId: purchase.id,
          amount: fromPaisa(allocatePaisa),
        },
      });
      remainingPaisa -= allocatePaisa;
    }

    if (remainingPaisa > 0) {
      throw httpError(400, "Payment cannot exceed the supplier's outstanding balance.");
    }

    // Atomic decrement with a guarded WHERE clause. The pre-read balance is
    // only used for validation; the database re-checks it at write time so a
    // concurrent payment or purchase cannot be silently overwritten.
    const decremented = await tx.supplier.updateMany({
      where: { id: supplierId, balance: { gte: amount } },
      data: { balance: { decrement: amount } },
    });
    if (decremented.count !== 1) {
      throw httpError(409, 'Balance changed, please retry');
    }

    // Normalize to 2 decimal places after a successful decrement.
    await tx.$executeRaw`
      UPDATE "Supplier"
      SET "balance" = ROUND("balance", 2)
      WHERE "id" = ${supplierId}
    `;

    const updatedSupplier = await tx.supplier.findUnique({ where: { id: supplierId } });

    const allocations = await tx.supplierPaymentAllocation.findMany({
      where: { supplierPaymentId: payment.id },
      orderBy: { id: 'asc' },
    });

    return { payment, allocations, supplier: updatedSupplier };
  });
}

export default { listSuppliers, createSupplier, recordPayment };
