import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createTempDb, assertTmpDbUrl } from '../test-support/tempDb.js';

const backendDir = path.resolve(import.meta.dirname, '..');
const backendUrl = pathToFileURL(backendDir + path.sep).href;

let prisma;
let khata;
let ctx;

before(async () => {
  ctx = await createTempDb({ prefix: 'khata-reg-', backendDir });
  const { dbUrl, realTmp } = ctx;
  assertTmpDbUrl(dbUrl, realTmp);
  prisma = (await import(backendUrl + 'src/db/prisma.js')).prisma;
  khata = (await import(backendUrl + 'src/services/khata.service.js')).default;
});

after(async () => {
  if (prisma) {
    try { await prisma.$disconnect(); } catch {}
  }
  if (ctx) ctx.cleanup();
});

async function setupCustomerWithSale(type, amount) {
  const customer = await prisma.customer.create({
    data: { name: `${type} Customer`, phone: `${type}-${Date.now()}-${Math.random()}`, type },
  });
  const sale = await prisma.sale.create({
    data: {
      invoiceNo: `INV-${type}-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`,
      subtotal: amount,
      discount: 0,
      total: amount,
      recognizedAmount: 0,
      paymentMethod: 'KHATA',
      customerId: customer.id,
      createdAt: new Date(),
    },
  });
  await prisma.khataTransaction.create({
    data: { customerId: customer.id, type: 'SALE', amount, description: 'credit', saleId: sale.id },
  });
  await prisma.customer.update({ where: { id: customer.id }, data: { balance: amount } });
  return { customer, sale };
}

for (const type of ['RETAIL', 'BUSINESS', 'PERSONAL']) {
  test(`khata allocation: ${type} customer full payment cycle`, async () => {
    const { customer, sale } = await setupCustomerWithSale(type, 10000);
    await khata.recordPayment(customer.id, 3000, 'p1', undefined, undefined);
    let s = await prisma.sale.findUnique({ where: { id: sale.id } });
    let c = await prisma.customer.findUnique({ where: { id: customer.id } });
    assert.equal(Number(s.recognizedAmount), 3000);
    assert.equal(Number(c.balance), 7000);

    await khata.recordPayment(customer.id, 7000, 'p2', undefined, undefined);
    s = await prisma.sale.findUnique({ where: { id: sale.id } });
    c = await prisma.customer.findUnique({ where: { id: customer.id } });
    assert.equal(Number(s.recognizedAmount), 10000);
    assert.equal(Number(c.balance), 0);
  });
}

test('khata allocation: FIFO across two sales', async () => {
  const customer = await prisma.customer.create({
    data: { name: 'FIFO Cust', phone: `FIFO-${Date.now()}`, type: 'BUSINESS' },
  });
  const sale1 = await prisma.sale.create({
    data: { invoiceNo: `F1-${Date.now()}`, subtotal: 6000, discount: 0, total: 6000, recognizedAmount: 0, paymentMethod: 'KHATA', customerId: customer.id, createdAt: new Date('2026-01-01T00:00:00Z') },
  });
  const sale2 = await prisma.sale.create({
    data: { invoiceNo: `F2-${Date.now()}`, subtotal: 4000, discount: 0, total: 4000, recognizedAmount: 0, paymentMethod: 'KHATA', customerId: customer.id, createdAt: new Date('2026-01-02T00:00:00Z') },
  });
  await prisma.khataTransaction.create({ data: { customerId: customer.id, type: 'SALE', amount: 6000, description: 's1', saleId: sale1.id, createdAt: new Date('2026-01-01T00:00:00Z') } });
  await prisma.khataTransaction.create({ data: { customerId: customer.id, type: 'SALE', amount: 4000, description: 's2', saleId: sale2.id, createdAt: new Date('2026-01-02T00:00:00Z') } });
  await prisma.customer.update({ where: { id: customer.id }, data: { balance: 10000 } });

  await khata.recordPayment(customer.id, 7000, 'pay', undefined, undefined);

  const s1 = await prisma.sale.findUnique({ where: { id: sale1.id } });
  const s2 = await prisma.sale.findUnique({ where: { id: sale2.id } });
  assert.equal(Number(s1.recognizedAmount), 6000);
  assert.equal(Number(s2.recognizedAmount), 1000);
});

test('khata allocation: duplicate idempotency key', async () => {
  const { customer, sale } = await setupCustomerWithSale('RETAIL', 10000);
  const key = crypto.randomUUID();
  const first = await khata.recordPayment(customer.id, 3000, 'p1', undefined, key);
  const second = await khata.recordPayment(customer.id, 3000, 'p2', undefined, key);
  assert.equal(first.transaction.id, second.transaction.id);
  const payments = await prisma.khataTransaction.findMany({ where: { customerId: customer.id, type: 'PAYMENT' } });
  assert.equal(payments.length, 1);
  const allocs = await prisma.paymentAllocation.findMany({ where: { saleId: sale.id } });
  assert.equal(allocs.length, 1);
});