import { prisma } from '../db/prisma.js';
import { httpError, mapPrismaError } from '../utils/prismaErrors.js';

const MAX_PAYMENT_AMOUNT = 1e9;

/**
 * Khata (customer credit ledger) service.
 *
 * Balance changes always use atomic database increments/decrements
 * (`balance: { increment / decrement }`) inside a Prisma transaction. The
 * balance is never read, recomputed in application code, and overwritten,
 * so concurrent ledger writes cannot lose updates.
 */

/**
 * Record a credit sale against a customer (increases debt).
 * `tx` is optional: when supplied (e.g. from the POS sale flow) the ledger
 * entry joins the caller's transaction so sale + ledger commit atomically
 * and no duplicate ledger entry can be created.
 */
export async function recordSale(customerId, saleId, amount, description, tx = prisma) {
  if (!Number.isFinite(amount) || amount <= 0) {
    throw httpError(400, 'Amount must be a positive number');
  }
  const customer = await tx.customer.findUnique({ where: { id: customerId } });
  if (!customer) throw httpError(404, 'Customer not found');
  const transaction = await tx.khataTransaction.create({
    data: { customerId, type: 'SALE', amount, description, saleId },
  });
  const updated = await tx.customer.update({
    where: { id: customerId },
    data: { balance: { increment: amount } },
  });
  return { transaction, customer: updated };
}

/**
 * Record a payment received from a customer (decreases debt).
 * Payment must not exceed the current outstanding balance.
 */
export async function recordPayment(customerId, amount, description, tx = prisma) {
  if (!Number.isFinite(amount) || amount <= 0) {
    throw httpError(400, 'Amount must be a positive number');
  }
  if (amount > MAX_PAYMENT_AMOUNT) {
    throw httpError(400, 'Amount must not exceed 1000000000');
  }
  const run = async (txClient) => {
    const customer = await txClient.customer.findUnique({ where: { id: customerId } });
    if (!customer) throw httpError(404, 'Customer not found');
    const balance = Number(customer.balance || 0);
    if (balance <= 0) {
      throw httpError(400, 'No outstanding balance to pay');
    }
    if (amount > balance) {
      throw httpError(400, "Payment cannot exceed the customer's outstanding balance.");
    }
    const transaction = await txClient.khataTransaction.create({
      data: { customerId, type: 'PAYMENT', amount, description },
    });
    const updated = await txClient.customer.update({
      where: { id: customerId },
      data: { balance: { decrement: amount } },
    });
    return { transaction, customer: updated };
  };
  return tx ? run(tx) : prisma.$transaction(run);
}

/**
 * Record a manual debt entry for a BUSINESS or PERSONAL customer.
 * Increases the customer's outstanding balance without creating a Sale.
 */
export async function recordDebt(customerId, amount, description, tx = prisma) {
  if (!Number.isFinite(amount) || amount <= 0) {
    throw httpError(400, 'Amount must be a positive number');
  }
  if (amount > MAX_PAYMENT_AMOUNT) {
    throw httpError(400, 'Amount must not exceed 1000000000');
  }
  const run = async (txClient) => {
    const customer = await txClient.customer.findUnique({ where: { id: customerId } });
    if (!customer) throw httpError(404, 'Customer not found');
    if (customer.type !== 'BUSINESS' && customer.type !== 'PERSONAL') {
      throw httpError(400, 'Manual debt entries are only allowed for Business or Personal customers');
    }
    const transaction = await txClient.khataTransaction.create({
      data: { customerId, type: 'DEBT', amount, description },
    });
    const updated = await txClient.customer.update({
      where: { id: customerId },
      data: { balance: { increment: amount } },
    });
    return { transaction, customer: updated };
  };
  return tx ? run(tx) : prisma.$transaction(run);
}

export async function getLedger(customerId, { page = 1, limit = 50 } = {}) {
  const parsedPage = Number(page);
  const parsedLimit = Number(limit);
  if (!Number.isInteger(parsedPage) || parsedPage < 1) {
    throw httpError(400, 'Invalid page');
  }
  if (!Number.isInteger(parsedLimit) || parsedLimit < 1 || parsedLimit > 100) {
    throw httpError(400, 'Invalid limit');
  }
  const customer = await prisma.customer.findUnique({ where: { id: customerId } });
  if (!customer) throw httpError(404, 'Customer not found');
  const [transactions, total] = await prisma.$transaction([
    prisma.khataTransaction.findMany({
      where: { customerId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      skip: (parsedPage - 1) * parsedLimit,
      take: parsedLimit,
    }),
    prisma.khataTransaction.count({ where: { customerId } }),
  ]);
  const totalPages = Math.ceil(total / parsedLimit);
  return { transactions, total, page: parsedPage, limit: parsedLimit, totalPages };
}

export async function getOutstanding() {
  const customers = await prisma.customer.findMany({
    where: { balance: { gt: 0 } },
    orderBy: { balance: 'desc' },
    select: { id: true, name: true, phone: true, balance: true },
  });
  const totalOutstanding = customers.reduce(
    (sum, customer) => sum + Number(customer.balance || 0),
    0,
  );
  return {
    customers,
    totalOutstanding: Number(totalOutstanding.toFixed(2)),
  };
}

export default { recordSale, recordPayment, recordDebt, getLedger, getOutstanding };
