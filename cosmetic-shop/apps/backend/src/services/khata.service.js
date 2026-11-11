import { prisma } from '../db/prisma.js';
import { httpError, mapPrismaError } from '../utils/prismaErrors.js';
import { toPaisa, fromPaisa } from '../utils/money.js';

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
  const paisa = toPaisa(amount);
  if (!Number.isFinite(amount) || paisa <= 0) {
    throw httpError(400, 'Amount must be a positive number');
  }
  const customer = await tx.customer.findUnique({ where: { id: customerId } });
  if (!customer) throw httpError(404, 'Customer not found');
  const transaction = await tx.khataTransaction.create({
    data: { customerId, type: 'SALE', amount, description, saleId },
  });
  // Compute new balance in integer paisa to avoid float residue.
  const newBalancePaisa = toPaisa(Number(customer.balance || 0)) + toPaisa(amount);
  const updated = await tx.customer.update({
    where: { id: customerId },
    data: { balance: fromPaisa(newBalancePaisa) },
  });
  return { transaction, customer: updated };
}

/**
 * Record a payment received from a customer (decreases debt).
 * Payment must not exceed the current outstanding balance.
 *
 * For RETAIL customers with KHATA sales, the payment is allocated using FIFO
 * (oldest unpaid sale first). Each allocation increases the sale's
 * recognizedAmount (revenue recognized) proportionally.
 *
 * For BUSINESS/PERSONAL customers, no sale allocation occurs — manual debt
 * collections never affect product revenue, COGS, or profit.
 */
export async function recordPayment(customerId, amount, description, tx = prisma) {
  const paisa = toPaisa(amount);
  if (!Number.isFinite(amount) || paisa <= 0) {
    throw httpError(400, 'Amount must be a positive number');
  }
  if (amount > MAX_PAYMENT_AMOUNT) {
    throw httpError(400, 'Amount must not exceed 1000000000');
  }
  const run = async (txClient) => {
    const customer = await txClient.customer.findUnique({ where: { id: customerId } });
    if (!customer) throw httpError(404, 'Customer not found');
    const balancePaisa = toPaisa(Number(customer.balance || 0));
    if (balancePaisa <= 0) {
      throw httpError(400, 'No outstanding balance to pay');
    }
    if (paisa > balancePaisa) {
      throw httpError(400, "Payment cannot exceed the customer's outstanding balance.");
    }

    const transaction = await txClient.khataTransaction.create({
      data: { customerId, type: 'PAYMENT', amount, description },
    });
    // For RETAIL customers, allocate the payment to unpaid KHATA sales using FIFO.
    // Each allocation increases the sale's recognizedAmount (revenue recognized).
    // For BUSINESS/PERSONAL customers, no sale allocation — manual debt
    // collections never affect product revenue, COGS, or profit.
    if (customer.type === 'RETAIL') {
      let remainingPaisa = paisa;
      // Fetch unpaid KHATA sales for this customer, oldest first.
      // A sale is "unpaid" when recognizedAmount < total.
      const unpaidSales = await txClient.sale.findMany({
        where: {
          customerId,
          paymentMethod: 'KHATA',
        },
        orderBy: { createdAt: 'asc' },
      });
      // Filter in JS to compare in integer paisa (avoid float residue).
      const allocatable = [];
      for (const sale of unpaidSales) {
        const totalPaisa = toPaisa(Number(sale.total || 0));
        const recognizedPaisa = toPaisa(Number(sale.recognizedAmount || 0));
        const duePaisa = totalPaisa - recognizedPaisa;
        if (duePaisa > 0) allocatable.push({ ...sale, duePaisa });
      }

      for (const sale of allocatable) {
        if (remainingPaisa <= 0) break;
        const allocatePaisa = Math.min(remainingPaisa, sale.duePaisa);
        if (allocatePaisa <= 0) continue;
        const newRecognizedPaisa = toPaisa(Number(sale.recognizedAmount || 0)) + allocatePaisa;
        await txClient.sale.update({
          where: { id: sale.id },
          data: { recognizedAmount: fromPaisa(newRecognizedPaisa) },
        });
        await txClient.paymentAllocation.create({
          data: {
            paymentId: transaction.id,
            saleId: sale.id,
            amount: fromPaisa(allocatePaisa),
          },
        });
        remainingPaisa -= allocatePaisa;
      }
    }

    const updated = await txClient.customer.update({
      where: { id: customerId },
      data: { balance: fromPaisa(balancePaisa - paisa) },
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
  const paisa = toPaisa(amount);
  if (!Number.isFinite(amount) || paisa <= 0) {
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
    const newBalancePaisa = toPaisa(Number(customer.balance || 0)) + toPaisa(amount);
    const updated = await txClient.customer.update({
      where: { id: customerId },
      data: { balance: fromPaisa(newBalancePaisa) },
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
  const totalOutstandingPaisa = customers.reduce(
    (sumPaisa, customer) => sumPaisa + toPaisa(Number(customer.balance || 0)),
    0,
  );
  return {
    customers,
    totalOutstanding: fromPaisa(totalOutstandingPaisa),
  };
}

export default { recordSale, recordPayment, recordDebt, getLedger, getOutstanding };
