import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createTempDb, assertTmpDbUrl } from '../test-support/tempDb.js';

const backendDir = path.resolve(import.meta.dirname, '..');
const backendUrl = pathToFileURL(backendDir + path.sep).href;

let prisma;
let supplierService;
let purchaseService;
let ctx;

before(async () => {
  ctx = await createTempDb({ prefix: 'sup-alloc-', backendDir });
  const { dbUrl, realTmp } = ctx;
  assertTmpDbUrl(dbUrl, realTmp);
  const db = await import(backendUrl + 'src/db/prisma.js');
  prisma = db.prisma;
  supplierService = (await import(backendUrl + 'src/services/supplier.service.js')).default;
  purchaseService = (await import(backendUrl + 'src/services/purchase.service.js')).default;
});

after(async () => {
  if (prisma) {
    try { await prisma.$disconnect(); } catch {}
  }
  if (ctx) ctx.cleanup();
});

async function makeSupplierWithPurchases(amounts) {
  const supplier = await prisma.supplier.create({ data: { name: `S-${Date.now()}`, balance: 0 } });
  const cat = await prisma.category.create({ data: { name: `C-${Date.now()}`, type: 'COSMETIC' } });
  const products = [];
  for (let i = 0; i < amounts.length; i += 1) {
    const product = await prisma.product.create({
      data: {
        sku: `P-${Date.now()}-${i}-${Math.random().toString(16).slice(2, 6)}`,
        name: `Product ${i}`,
        type: 'COSMETIC',
        costPrice: 10,
        sellPrice: 20,
        stock: 0,
        categoryId: cat.id,
      },
    });
    products.push(product);
    const qty = Math.max(1, Math.round(amounts[i] / 10));
    const unitCost = amounts[i] / qty;
    await purchaseService.createPurchase(
      { supplierId: supplier.id, items: [{ productId: product.id, quantity: qty, unitCost }] },
      undefined,
    );
  }
  // Adjust totalAmount to exact requested amounts by updating the single item purchase.
  // Simpler: recreate purchases with exact totals using one unit at the exact amount.
  // The above may create rounding; instead do direct purchase via service with quantity 1.
  return supplier;
}

async function createExactPurchase(supplierId, amount) {
  const cat = await prisma.category.create({ data: { name: `C-${Date.now()}-${Math.random()}`, type: 'COSMETIC' } });
  const product = await prisma.product.create({
    data: {
      sku: `PE-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`,
      name: 'Exact Product',
      type: 'COSMETIC',
      costPrice: amount,
      sellPrice: amount * 2,
      stock: 0,
      categoryId: cat.id,
    },
  });
  await purchaseService.createPurchase(
    { supplierId, items: [{ productId: product.id, quantity: 1, unitCost: amount }] },
    undefined,
  );
}

async function reconstruct(supplierId) {
  const purchases = await prisma.purchase.findMany({ where: { supplierId } });
  const payments = await prisma.supplierPayment.findMany({ where: { supplierId } });
  const supplier = await prisma.supplier.findUnique({ where: { id: supplierId } });
  const totalPurchases = purchases.reduce((s, p) => s + Number(p.totalAmount || 0), 0);
  const totalPayments = payments.reduce((s, p) => s + Number(p.amount || 0), 0);
  return { purchases, payments, supplier, totalPurchases, totalPayments, reconstructed: totalPurchases - totalPayments };
}

test('supplier allocation: FIFO sequential across two purchases', async () => {
  const supplier = await prisma.supplier.create({ data: { name: 'FIFO', balance: 0 } });
  await createExactPurchase(supplier.id, 60);
  await createExactPurchase(supplier.id, 40);

  await supplierService.recordPayment(supplier.id, { amount: 50 }, undefined);
  await supplierService.recordPayment(supplier.id, { amount: 50 }, undefined);

  const { purchases, supplier: sup, totalPayments } = await reconstruct(supplier.id);
  const paid = purchases.map((p) => Number(p.paidAmount || 0)).sort((a, b) => a - b);
  assert.equal(totalPayments, 100);
  assert.deepEqual(paid, [40, 60]);
  assert.equal(sup.balance, 0);
  assert.ok(purchases.every((p) => p.status === 'PAID'));
  const allocs = await prisma.supplierPaymentAllocation.findMany({ where: { supplierPaymentId: { in: (await prisma.supplierPayment.findMany({ where: { supplierId: supplier.id } })).map((p) => p.id) } } });
  assert.equal(allocs.reduce((s, a) => s + Number(a.amount || 0), 0), 100);
});

test('supplier allocation: competing payments against one purchase', async () => {
  const supplier = await prisma.supplier.create({ data: { name: 'COMP', balance: 0 } });
  await createExactPurchase(supplier.id, 100);

  const results = await Promise.allSettled([
    supplierService.recordPayment(supplier.id, { amount: 80 }, undefined),
    supplierService.recordPayment(supplier.id, { amount: 80 }, undefined),
  ]);

  const { purchases, supplier: sup, totalPayments } = await reconstruct(supplier.id);
  const purchase = purchases[0];
  assert.ok(Number(purchase.paidAmount) <= 100, 'paidAmount must not exceed total');
  assert.ok(Number(sup.balance) >= 0, 'balance must not be negative');
  assert.ok(totalPayments <= 100, 'total payments must not exceed outstanding');
  const allocTotal = (await prisma.supplierPaymentAllocation.findMany({ where: { purchaseId: { in: purchases.map((p) => p.id) } } })).reduce((s, a) => s + Number(a.amount || 0), 0);
  assert.ok(allocTotal <= 100, 'allocations must not exceed outstanding');
  assert.equal(sup.balance, reconstructSync(purchases, totalPayments));
  assert.ok(results.some((r) => r.status === 'fulfilled'));
});

function reconstructSync(purchases, totalPayments) {
  const totalPurchases = purchases.reduce((s, p) => s + Number(p.totalAmount || 0), 0);
  return totalPurchases - totalPayments;
}

test('supplier allocation: payment concurrent with purchase creation', async () => {
  const supplier = await prisma.supplier.create({ data: { name: 'CONC', balance: 0 } });
  await createExactPurchase(supplier.id, 100);

  const [payRes, purchRes] = await Promise.allSettled([
    supplierService.recordPayment(supplier.id, { amount: 60 }, undefined),
    createExactPurchase(supplier.id, 40).then(() => ({ ok: true })),
  ]);

  const { purchases, supplier: sup } = await reconstruct(supplier.id);
  const totalPurchases = purchases.reduce((s, p) => s + Number(p.totalAmount || 0), 0);
  const totalPayments = (await prisma.supplierPayment.findMany({ where: { supplierId: supplier.id } })).reduce((s, p) => s + Number(p.amount || 0), 0);
  assert.equal(Number(sup.balance), totalPurchases - totalPayments);
  assert.ok(Number(sup.balance) >= 0);
});

test('supplier allocation: multiple payments and purchases', async () => {
  const supplier = await prisma.supplier.create({ data: { name: 'MULTI', balance: 0 } });
  await createExactPurchase(supplier.id, 30);
  await createExactPurchase(supplier.id, 50);
  await createExactPurchase(supplier.id, 20);

  await supplierService.recordPayment(supplier.id, { amount: 40 }, undefined);
  await supplierService.recordPayment(supplier.id, { amount: 60 }, undefined);

  const { purchases, supplier: sup } = await reconstruct(supplier.id);
  const paidSorted = purchases.map((p) => Number(p.paidAmount || 0)).sort((a, b) => a - b);
  assert.deepEqual(paidSorted, [20, 30, 50]);
  assert.equal(sup.balance, 0);
  assert.ok(purchases.every((p) => p.status === 'PAID'));
});

test('supplier allocation: same idempotency key is not duplicated', async () => {
  const supplier = await prisma.supplier.create({ data: { name: 'IDEM', balance: 0 } });
  await createExactPurchase(supplier.id, 100);
  const key = crypto.randomUUID();

  const first = await supplierService.recordPayment(supplier.id, { amount: 40 }, key);
  const second = await supplierService.recordPayment(supplier.id, { amount: 40 }, key);

  assert.equal(first.payment.id, second.payment.id);
  const payments = await prisma.supplierPayment.findMany({ where: { supplierId: supplier.id } });
  assert.equal(payments.length, 1);
  const allocs = await prisma.supplierPaymentAllocation.findMany({ where: { supplierPaymentId: first.payment.id } });
  assert.equal(allocs.length, 1);
  const sup = await prisma.supplier.findUnique({ where: { id: supplier.id } });
  assert.equal(Number(sup.balance), 60);
});

test('supplier allocation: different idempotency keys are distinct', async () => {
  const supplier = await prisma.supplier.create({ data: { name: 'DISTINCT', balance: 0 } });
  await createExactPurchase(supplier.id, 100);

  const first = await supplierService.recordPayment(supplier.id, { amount: 30 }, crypto.randomUUID());
  const second = await supplierService.recordPayment(supplier.id, { amount: 30 }, crypto.randomUUID());

  assert.notEqual(first.payment.id, second.payment.id);
  const payments = await prisma.supplierPayment.findMany({ where: { supplierId: supplier.id } });
  assert.equal(payments.length, 2);
});

test('supplier allocation: fractional paisa amounts reconcile', async () => {
  const supplier = await prisma.supplier.create({ data: { name: 'FRAC', balance: 0 } });
  await createExactPurchase(supplier.id, 10.01);

  await supplierService.recordPayment(supplier.id, { amount: 4.01 }, undefined);
  await supplierService.recordPayment(supplier.id, { amount: 6.00 }, undefined);

  const { purchases, supplier: sup } = await reconstruct(supplier.id);
  assert.equal(Number(purchases[0].paidAmount), 10.01);
  assert.equal(purchases[0].status, 'PAID');
  assert.equal(Number(sup.balance), 0);
});