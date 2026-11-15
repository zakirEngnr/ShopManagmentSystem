import { prisma } from '../db/prisma.js';
import { httpError, mapPrismaError } from '../utils/prismaErrors.js';
import { toPaisa, fromPaisa } from '../utils/money.js';

const MAX_PAYMENT_AMOUNT = 1e9;

/**
 * Run `fn` inside a transaction when no transaction is supplied.
 *
 * When a transaction (`tx`) is supplied by the caller (e.g. the POS sale
 * flow) it is reused directly — no nested transaction is started — so the
 * caller's financial operation stays atomic. When no transaction is supplied,
 * a fresh Prisma transaction is opened with a bounded timeout.
 */
async function withTx(tx, fn) {
  return tx ? fn(tx) : prisma.$transaction(fn, { timeout: 15000 });
}

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
export async function recordSale(customerId, saleId, amount, description, tx) {
  const paisa = toPaisa(amount);
  if (!Number.isFinite(amount) || paisa <= 0) {
    throw httpError(400, 'Amount must be a positive number');
  }
  const run = async (txClient) => {
    const customer = await txClient.customer.findUnique({ where: { id: customerId } });
    if (!customer) throw httpError(404, 'Customer not found');
    const transaction = await txClient.khataTransaction.create({
      data: { customerId, type: 'SALE', amount, description, saleId },
    });
    // Atomic increment: never read-modify-write the balance in application code.
    const updated = await txClient.customer.update({
      where: { id: customerId },
      data: { balance: { increment: amount } },
    });
    // Normalize the balance to 2 decimal places inside the same transaction so
    // repeated atomic Float increments cannot leave floating-point residue.
    await txClient.$executeRaw`
      UPDATE "Customer"
      SET "balance" = ROUND("balance", 2)
      WHERE "id" = ${customerId}
    `;
    const customerRow = await txClient.customer.findUnique({ where: { id: customerId } });
    return { transaction, customer: customerRow };
  };
  return withTx(tx, run);
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
 *
 * The balance is decremented with a guarded atomic `updateMany` whose WHERE
 * clause re-checks the balance at write time. If a concurrent request changed
 * the balance in the meantime, the decrement matches zero rows and we throw
 * 409 so the caller can retry. The customer is read only for existence/type
 * and optimistic pre-validation — the atomic decrement is the authority.
 */
export async function recordPayment(customerId, amount, description, tx, idempotencyKey) {
  const paisa = toPaisa(amount);
  if (!Number.isFinite(amount) || paisa <= 0) {
    throw httpError(400, 'Amount must be a positive number');
  }
  if (amount > MAX_PAYMENT_AMOUNT) {
    throw httpError(400, 'Amount must not exceed 1000000000');
  }
  const run = async (txClient) => {
    // Idempotency: if a key was supplied, return the original payment record
    // when one already exists. The unique constraint is the final authority
    // for concurrent duplicates (P2002 handled below).
    if (idempotencyKey) {
      const existing = await txClient.khataTransaction.findUnique({ where: { idempotencyKey } });
      if (existing) {
        const customer = await txClient.customer.findUnique({ where: { id: customerId } });
        return { transaction: existing, customer };
      }
    }
    const customer = await txClient.customer.findUnique({ where: { id: customerId } });
    if (!customer) throw httpError(404, 'Customer not found');
    const balancePaisa = toPaisa(Number(customer.balance || 0));
    if (balancePaisa <= 0) {
      throw httpError(400, 'No outstanding balance to pay');
    }
    if (paisa > balancePaisa) {
      throw httpError(400, "Payment cannot exceed the customer's outstanding balance.");
    }
    let transaction;
    try {
      transaction = await txClient.khataTransaction.create({
        data: {
          customerId,
          type: 'PAYMENT',
          amount,
          description,
          ...(idempotencyKey ? { idempotencyKey } : {}),
        },
      });
    } catch (err) {
      if (err.code === 'P2002' && idempotencyKey) {
        // A concurrent request won the unique-constraint race. Return the
        // committed record it created so no side effect is duplicated.
        const existing = await txClient.khataTransaction.findUnique({ where: { idempotencyKey } });
        if (existing) {
          const customer2 = await txClient.customer.findUnique({ where: { id: customerId } });
          return { transaction: existing, customer: customer2 };
        }
      }
      throw err;
    }
    const decremented = await txClient.customer.updateMany({
      where: { id: customerId, balance: { gte: amount } },
      data: { balance: { decrement: amount } },
    });
    if (decremented.count !== 1) {
      throw httpError(409, 'Balance changed, please retry');
    }

    // Normalize the balance to 2 decimal places inside the same transaction so
    // repeated atomic Float decrements cannot leave floating-point residue.
    // Only runs after the guarded decrement succeeded, so a failed/overpayment
    // is never normalized.
    await txClient.$executeRaw`
      UPDATE "Customer"
      SET "balance" = ROUND("balance", 2)
      WHERE "id" = ${customerId}
    `;

    // Allocate the payment to unpaid KHATA sales using FIFO for every customer
    // type. Sale.recognizedAmount must track collected cash for all KHATA sales
    // so report outstanding is correct; manual debt entries do not create Sales
    // and therefore do not participate in this allocation.
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
      // Retain the previously read recognizedAmount and only apply the new
      // value if it still matches, so a concurrent allocation cannot be
      // silently overwritten.
      const previousRecognized = sale.recognizedAmount;
      const newRecognizedPaisa = toPaisa(Number(previousRecognized || 0)) + allocatePaisa;
      const updatedSale = await txClient.sale.updateMany({
        where: { id: sale.id, recognizedAmount: previousRecognized },
        data: { recognizedAmount: fromPaisa(newRecognizedPaisa) },
      });
      if (updatedSale.count !== 1) {
        throw httpError(409, 'Balance changed, please retry');
      }
      await txClient.paymentAllocation.create({
        data: {
          paymentId: transaction.id,
          saleId: sale.id,
          amount: fromPaisa(allocatePaisa),
        },
      });
      remainingPaisa -= allocatePaisa;
    }

    const updated = await txClient.customer.findUnique({ where: { id: customerId } });
    return { transaction, customer: updated };
  };
  return withTx(tx, run);
}

/**
 * Record a manual debt entry for a BUSINESS or PERSONAL customer.
 * Increases the customer's outstanding balance without creating a Sale.
 */
export async function recordDebt(customerId, amount, description, tx, idempotencyKey) {
  const paisa = toPaisa(amount);
  if (!Number.isFinite(amount) || paisa <= 0) {
    throw httpError(400, 'Amount must be a positive number');
  }
  if (amount > MAX_PAYMENT_AMOUNT) {
    throw httpError(400, 'Amount must not exceed 1000000000');
  }
  const run = async (txClient) => {
    if (idempotencyKey) {
      const existing = await txClient.khataTransaction.findUnique({ where: { idempotencyKey } });
      if (existing) {
        const customer = await txClient.customer.findUnique({ where: { id: customerId } });
        return { transaction: existing, customer };
      }
    }
    const customer = await txClient.customer.findUnique({ where: { id: customerId } });
    if (!customer) throw httpError(404, 'Customer not found');
    if (customer.type !== 'BUSINESS' && customer.type !== 'PERSONAL') {
      throw httpError(400, 'Manual debt entries are only allowed for Business or Personal customers');
    }
    let transaction;
    try {
      transaction = await txClient.khataTransaction.create({
        data: {
          customerId,
          type: 'DEBT',
          amount,
          description,
          ...(idempotencyKey ? { idempotencyKey } : {}),
        },
      });
    } catch (err) {
      if (err.code === 'P2002' && idempotencyKey) {
        const existing = await txClient.khataTransaction.findUnique({ where: { idempotencyKey } });
        if (existing) {
          const customer2 = await txClient.customer.findUnique({ where: { id: customerId } });
          return { transaction: existing, customer: customer2 };
        }
      }
      throw err;
    }
    // Atomic increment: never read-modify-write the balance in application code.
    const updated = await txClient.customer.update({
      where: { id: customerId },
      data: { balance: { increment: amount } },
    });
    // Normalize the balance to 2 decimal places inside the same transaction so
    // repeated atomic Float increments cannot leave floating-point residue.
    await txClient.$executeRaw`
      UPDATE "Customer"
      SET "balance" = ROUND("balance", 2)
      WHERE "id" = ${customerId}
    `;
    const customerRow = await txClient.customer.findUnique({ where: { id: customerId } });
    return { transaction, customer: customerRow };
  };
  return withTx(tx, run);
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
