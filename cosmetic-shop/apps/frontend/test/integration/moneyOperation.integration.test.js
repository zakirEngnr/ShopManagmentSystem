// INTEGRATION regression test of the money-operation controller against the
// REAL backend and a DISPOSABLE database.
//
// The controller is the code path every one of the five money-writing
// workflows uses (POS sale, purchase, supplier payment, customer payment,
// customer debt). The scenario that is proven for every workflow:
//
//   1. submit a financial operation;
//   2. the backend COMMITS it;
//   3. the response is lost (the Axios adapter throws a timeout AFTER the
//      request really reached the server);
//   4. the user edits the payload and tries to submit again  -> BLOCKED;
//   5. the explicit retry sends the ORIGINAL payload and key;
//   6. exactly ONE transaction exists, and no stock, invoice counter,
//      balance, ledger entry or allocation was duplicated.
//
// The database is a throw-away file built from the migration SQL; the
// development database is never touched.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { startDisposableBackend, installLosingAdapter } from '../support/disposableBackend.js';

import { createMoneyOperation, MONEY_OUTCOME } from '../../src/utils/moneyOperation.js';
import { createIdempotencyStore } from '../../src/utils/idempotencyStore.js';
import client from '../../src/api/client.js';
import { createSale } from '../../src/api/sales.js';
import { createPurchase, buildPurchasePayload } from '../../src/api/purchases.js';
import {
  recordSupplierPayment,
  buildSupplierPaymentPayload,
} from '../../src/api/suppliers.js';
import {
  recordCustomerPayment,
  recordCustomerDebt,
  buildCustomerPaymentPayload,
  buildCustomerDebtPayload,
} from '../../src/api/customers.js';

let backend;
let losing;

/** A sessionStorage stand-in that survives a remount. */
function createMemoryStorage() {
  const map = new Map();
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => { map.set(key, String(value)); },
    removeItem: (key) => { map.delete(key); },
    entries: () => [...map.entries()],
  };
}

before(async () => {
  backend = await startDisposableBackend();
  client.defaults.baseURL = `${backend.base}/api`;

  // The shared client reads the Bearer token from localStorage.
  globalThis.localStorage = {
    getItem: (key) => (key === 'cosmetic-shop-token' ? backend.token : null),
    setItem: () => {},
    removeItem: () => {},
  };

  losing = installLosingAdapter(client);
});

after(() => {
  if (backend) backend.stop();
});

/**
 * The core scenario for one workflow.
 *
 * @param {object} options
 * @param {string} options.scope - The idempotency scope.
 * @param {string} options.operation - The endpoint.
 * @param {string} options.label - The human name of the transaction.
 * @param {Function} options.send - `(body, key, entity) => Promise`.
 * @param {object} options.body - The original request body.
 * @param {string|number|null} [options.entity] - The customer/supplier.
 * @param {Function} options.count - () => number, how many records exist.
 * @param {Function} options.verify - () => void, the side effect assertions.
 */
async function runAmbiguousScenario({
  scope,
  operation,
  label,
  send,
  body,
  entity = null,
  count,
  verify,
}) {
  const storage = createMemoryStorage();
  const store = createIdempotencyStore({ storage });
  const controller = createMoneyOperation({ scope, operation, label, send, store });

  // 1 + 2: the request is sent and the backend COMMITS it.
  losing.lose = true;
  const first = await controller.submit(body, entity);
  assert.equal(first.outcome, MONEY_OUTCOME.AMBIGUOUS, 'the client must see an unknown outcome');
  assert.match(first.message, /may already have been saved/i);
  assert.equal(count(), 1, 'exactly one transaction must exist after the lost response');

  // 3: the ambiguous outcome pins the key AND the body.
  const unresolved = controller.getUnresolved();
  assert.ok(unresolved, 'the operation must be unresolved');
  assert.deepEqual(unresolved.payload, body, 'the original body must be pinned');
  assert.match(unresolved.key, /^[0-9a-f-]{36}$/i);

  // 4: the user edits the body and tries to submit again -> BLOCKED.
  const edited = { ...body, amount: 999 };
  const blocked = await controller.submit(edited, entity);
  assert.equal(blocked.outcome, MONEY_OUTCOME.BLOCKED, 'a different body must be blocked');
  assert.equal(count(), 1, 'the blocked submission must not create a transaction');

  // 5: the explicit retry sends the ORIGINAL body and the ORIGINAL key.
  losing.lose = false;
  const retried = await controller.retry();
  assert.equal(retried.outcome, MONEY_OUTCOME.SENT, 'the retry must return the original transaction');

  // 6: exactly ONE transaction, no duplicated side effect.
  assert.equal(count(), 1, 'the retry must not create a second transaction');
  verify({ key: unresolved.key, entity: unresolved.entity });
  assert.equal(controller.getUnresolved(), null, 'the confirmed retry clears the state');

  return { key: unresolved.key, entity: unresolved.entity };
}

/* ------------------------------------------------------------------ */
/* the five money-writing workflows                                     */
/* ------------------------------------------------------------------ */

test('POST /sales: a lost response cannot become a second sale', async () => {
  const before = backend.row('SELECT stock FROM "Product" WHERE sku = ?', 'AUD-001').stock;

  await runAmbiguousScenario({
    scope: 'sale',
    operation: 'POST /sales',
    label: 'sale',
    send: (body, k) => createSale(body, k),
    body: {
      paymentMethod: 'CASH',
      cashReceived: 20,
      discount: 0,
      items: [{ productId: 1, quantity: 2, unitPrice: 10 }],
    },
    count: () => backend.row('SELECT COUNT(*) c FROM "Sale"').c,
    verify: ({ key }) => {
      assert.equal(backend.row('SELECT COUNT(*) c FROM "Sale"').c, 1, 'exactly one sale');
      assert.equal(
        backend.row('SELECT COUNT(*) c FROM "SaleItem" WHERE "saleId" = ?', 1).c,
        1,
        'exactly one sale item',
      );
      assert.equal(
        backend.row('SELECT stock FROM "Product" WHERE sku = ?', 'AUD-001').stock,
        before - 2,
        'the stock must be decremented exactly once',
      );
      assert.equal(
        backend.row('SELECT value FROM "Counter" WHERE key = ?', 'invoice-2026').value,
        1,
        'the invoice counter must advance exactly once',
      );
      assert.equal(
        backend.row('SELECT COUNT(*) c FROM "Sale" WHERE "idempotencyKey" IS NOT NULL').c,
        1,
        'exactly one sale carries the key',
      );
      assert.equal(
        backend.row('SELECT COUNT(*) c FROM "Sale" WHERE "idempotencyKey" = ?', key).c,
        1,
        'the retry must carry the original key',
      );
    },
  });
});

test('POST /purchases: a lost response cannot increment the stock twice', async () => {
  const before = backend.row('SELECT stock FROM "Product" WHERE sku = ?', 'AUD-001').stock;
  const created = await backend.api('POST', '/suppliers', {
    name: 'Audit Supplier',
    phone: '03001237777',
  });
  assert.equal(created.status, 201);
  const supplierId = created.body.supplier.id;

  await runAmbiguousScenario({
    scope: 'purchase',
    operation: 'POST /purchases',
    label: 'purchase',
    send: (body, k) => createPurchase(body, k),
    body: buildPurchasePayload({
      supplierId,
      items: [{ productId: 1, quantity: 5, unitCost: 8 }],
    }),
    count: () => backend.row('SELECT COUNT(*) c FROM "Purchase"').c,
    verify: () => {
      assert.equal(backend.row('SELECT COUNT(*) c FROM "Purchase"').c, 1, 'exactly one purchase');
      assert.equal(
        backend.row('SELECT COUNT(*) c FROM "PurchaseItem"').c,
        1,
        'exactly one purchase item',
      );
      assert.equal(
        backend.row('SELECT stock FROM "Product" WHERE sku = ?', 'AUD-001').stock,
        before + 5,
        'the stock must be incremented exactly once',
      );
      assert.equal(
        backend.row('SELECT balance FROM "Supplier" WHERE id = ?', supplierId).balance,
        40,
        'the supplier payable must be increased exactly once',
      );
    },
  });
});

test('POST /suppliers/:id/payment: a lost response cannot pay twice', async () => {
  const created = await backend.api('POST', '/suppliers', {
    name: 'Audit Payable Supplier',
    phone: '03001236666',
  });
  const supplierId = created.body.supplier.id;

  // Give the supplier a payable.
  await backend.api('POST', '/purchases', {
    supplierId,
    items: [{ productId: 1, quantity: 4, unitCost: 10 }],
  });
  const payable = backend.row('SELECT balance FROM "Supplier" WHERE id = ?', supplierId).balance;
  assert.equal(payable, 40);

  await runAmbiguousScenario({
    scope: `supplier-payment:${supplierId}`,
    operation: 'POST /suppliers/:id/payment',
    label: 'payment',
    send: (body, k, entity) => recordSupplierPayment(Number(entity), body, k),
    body: buildSupplierPaymentPayload({ amount: 15, description: 'audit payment' }),
    entity: supplierId,
    count: () => backend.row('SELECT COUNT(*) c FROM "SupplierPayment"').c,
    verify: () => {
      assert.equal(backend.row('SELECT COUNT(*) c FROM "SupplierPayment"').c, 1, 'exactly one payment');
      assert.equal(
        backend.row('SELECT COUNT(*) c FROM "SupplierPaymentAllocation"').c,
        1,
        'exactly one allocation',
      );
      assert.equal(
        backend.row('SELECT balance FROM "Supplier" WHERE id = ?', supplierId).balance,
        payable - 15,
        'the payable must be reduced exactly once',
      );
      assert.equal(
        backend.row('SELECT paidAmount FROM "Purchase" WHERE "supplierId" = ?', supplierId).paidAmount,
        15,
        'the purchase must be settled exactly once',
      );
    },
  });
});

test('POST /customers/:id/payment: a lost response cannot collect twice', async () => {
  const customer = backend.row('SELECT id FROM "Customer" WHERE type = ?', 'RETAIL');

  // Create a KHATA sale so the customer has an outstanding balance.
  await backend.api('POST', '/sales', {
    paymentMethod: 'KHATA',
    customerId: customer.id,
    discount: 0,
    items: [{ productId: 1, quantity: 1, unitPrice: 20 }],
  });
  assert.equal(backend.row('SELECT balance FROM "Customer" WHERE id = ?', customer.id).balance, 20);

  await runAmbiguousScenario({
    scope: `customer-payment:${customer.id}`,
    operation: 'POST /customers/:id/payment',
    label: 'payment',
    send: (body, k, entity) => recordCustomerPayment(Number(entity), body, k),
    body: buildCustomerPaymentPayload({ amount: 20, description: 'audit collection' }),
    entity: customer.id,
    count: () =>
      backend.row('SELECT COUNT(*) c FROM "KhataTransaction" WHERE type = ?', 'PAYMENT').c,
    verify: () => {
      assert.equal(
        backend.row('SELECT COUNT(*) c FROM "KhataTransaction" WHERE type = ?', 'PAYMENT').c,
        1,
        'exactly one payment',
      );
      assert.equal(
        backend.row('SELECT balance FROM "Customer" WHERE id = ?', customer.id).balance,
        0,
        'the balance must be reduced exactly once',
      );
      assert.equal(
        backend.row('SELECT COUNT(*) c FROM "PaymentAllocation"').c,
        1,
        'exactly one allocation',
      );
      assert.equal(
        backend.row('SELECT COUNT(*) c FROM "KhataTransaction" WHERE type = ?', 'SALE').c,
        1,
        'exactly one KHATA sale ledger entry',
      );
    },
  });
});

test('POST /customers/:id/debt: a lost response cannot raise the debt twice', async () => {
  const customer = backend.row('SELECT id FROM "Customer" WHERE type = ?', 'BUSINESS');

  await runAmbiguousScenario({
    scope: `customer-debt:${customer.id}`,
    operation: 'POST /customers/:id/debt',
    label: 'debt entry',
    send: (body, k, entity) => recordCustomerDebt(Number(entity), body, k),
    body: buildCustomerDebtPayload({ amount: 75, description: 'audit debt' }),
    entity: customer.id,
    count: () => backend.row('SELECT COUNT(*) c FROM "KhataTransaction" WHERE type = ?', 'DEBT').c,
    verify: () => {
      assert.equal(
        backend.row('SELECT COUNT(*) c FROM "KhataTransaction" WHERE type = ?', 'DEBT').c,
        1,
        'exactly one debt entry',
      );
      assert.equal(
        backend.row('SELECT balance FROM "Customer" WHERE id = ?', customer.id).balance,
        75,
        'the balance must be increased exactly once',
      );
    },
  });
});

/* ------------------------------------------------------------------ */
/* remount / navigation recovery                                        */
/* ------------------------------------------------------------------ */

test('a remount restores the unresolved operation and the retry still replays it', async () => {
  const storage = createMemoryStorage();
  const store = createIdempotencyStore({ storage });

  const body = {
    paymentMethod: 'CASH',
    cashReceived: 10,
    discount: 0,
    items: [{ productId: 1, quantity: 1, unitPrice: 10 }],
  };

  // The mounted component.
  const mounted = createMoneyOperation({
    scope: 'sale',
    operation: 'POST /sales',
    label: 'sale',
    send: (b, k) => createSale(b, k),
    store,
  });

  losing.lose = true;
  await mounted.submit(body);
  const salesAfterLostResponse = backend.row('SELECT COUNT(*) c FROM "Sale"').c;
  assert.ok(salesAfterLostResponse >= 1);

  // The component unmounts; a new one mounts with the same persisted state.
  const remounted = createMoneyOperation({
    scope: 'sale',
    operation: 'POST /sales',
    label: 'sale',
    send: (b, k) => createSale(b, k),
    store: createIdempotencyStore({ storage }),
  });

  const restored = remounted.getUnresolved();
  assert.ok(restored, 'the unresolved operation must be restored after the remount');
  assert.deepEqual(restored.payload, body, 'the same body must be restored');
  assert.match(restored.key, /^[0-9a-f-]{36}$/i);

  // The edited form is blocked, and nothing new is created.
  const edited = { ...body, items: [{ productId: 1, quantity: 7, unitPrice: 10 }] };
  const blocked = await remounted.submit(edited);
  assert.equal(blocked.outcome, MONEY_OUTCOME.BLOCKED);
  assert.equal(
    backend.row('SELECT COUNT(*) c FROM "Sale"').c,
    salesAfterLostResponse,
    'the blocked submission must not create a sale',
  );

  // The retry replays the original request.
  losing.lose = false;
  const retried = await remounted.retry();
  assert.equal(retried.outcome, MONEY_OUTCOME.SENT);
  assert.equal(
    backend.row('SELECT COUNT(*) c FROM "Sale"').c,
    salesAfterLostResponse,
    'the retry must not create a second sale',
  );
  assert.equal(
    backend.row('SELECT COUNT(*) c FROM "Sale" WHERE "idempotencyKey" = ?', restored.key).c,
    1,
    'exactly one sale carries the key',
  );
});

test('an unresolved operation survives a navigation to another scope', async () => {
  const storage = createMemoryStorage();
  const store = createIdempotencyStore({ storage });

  const customer = backend.row('SELECT id FROM "Customer" WHERE type = ?', 'BUSINESS');

  const debt = createMoneyOperation({
    scope: `customer-debt:${customer.id}`,
    operation: 'POST /customers/:id/debt',
    label: 'debt entry',
    send: (b, k, entity) => recordCustomerDebt(Number(entity), b, k),
    store,
  });

  losing.lose = true;
  const outcome = await debt.submit(
    buildCustomerDebtPayload({ amount: 60, description: 'navigation debt' }),
    customer.id,
  );
  assert.equal(outcome.outcome, MONEY_OUTCOME.AMBIGUOUS);
  const debtCount = backend.row('SELECT COUNT(*) c FROM "KhataTransaction" WHERE type = ?', 'DEBT').c;

  // The user navigates to another scope: the operation is still there.
  const elsewhere = createMoneyOperation({
    scope: 'sale',
    operation: 'POST /sales',
    label: 'sale',
    send: (b, k) => createSale(b, k),
    store: createIdempotencyStore({ storage }),
  });
  assert.equal(elsewhere.getUnresolved(), null, 'another scope is not affected');

  const restored = debt.getUnresolved();
  assert.ok(restored, 'the debt entry is still unresolved after the navigation');
  assert.equal(restored.entity, String(customer.id));

  // And the retry replays it.
  losing.lose = false;
  const retried = await debt.retry();
  assert.equal(retried.outcome, MONEY_OUTCOME.SENT);
  assert.equal(
    backend.row('SELECT COUNT(*) c FROM "KhataTransaction" WHERE type = ?', 'DEBT').c,
    debtCount,
    'the retry must not create a second debt entry',
  );
});

/* ------------------------------------------------------------------ */
/* the definitive failure                                               */
/* ------------------------------------------------------------------ */

test('a definitive 4xx creates nothing and leaves no unresolved operation', async () => {
  const storage = createMemoryStorage();
  const controller = createMoneyOperation({
    scope: 'sale',
    operation: 'POST /sales',
    label: 'sale',
    send: (b, k) => createSale(b, k),
    store: createIdempotencyStore({ storage }),
  });

  const salesBefore = backend.row('SELECT COUNT(*) c FROM "Sale"').c;
  const counterBefore = backend.row('SELECT value FROM "Counter" WHERE key = ?', 'invoice-2026').value;

  losing.lose = false;
  const outcome = await controller.submit({
    paymentMethod: 'CASH',
    cashReceived: 10,
    discount: 0,
    items: [{ productId: 99999, quantity: 1, unitPrice: 10 }],
  });

  assert.equal(outcome.outcome, MONEY_OUTCOME.FAILED);
  assert.equal(outcome.error.response.status, 404, 'the backend must answer 404 for a missing product');
  assert.equal(controller.getUnresolved(), null, 'a verified failure must not leave an unresolved operation');
  assert.equal(backend.row('SELECT COUNT(*) c FROM "Sale"').c, salesBefore, 'no sale may be created');
  assert.equal(
    backend.row('SELECT value FROM "Counter" WHERE key = ?', 'invoice-2026').value,
    counterBefore,
    'a failed sale must not consume an invoice number',
  );
});

test('an explicit abandonment releases the operation, and the next one is a new operation', async () => {
  const storage = createMemoryStorage();
  const controller = createMoneyOperation({
    scope: 'sale',
    operation: 'POST /sales',
    label: 'sale',
    send: (b, k) => createSale(b, k),
    store: createIdempotencyStore({ storage }),
  });

  losing.lose = true;
  await controller.submit({
    paymentMethod: 'CASH',
    cashReceived: 10,
    discount: 0,
    items: [{ productId: 1, quantity: 1, unitPrice: 10 }],
  });
  assert.ok(controller.getUnresolved());

  controller.abandon();
  assert.equal(controller.getUnresolved(), null);

  // The next submission is a NEW operation with a new key.
  losing.lose = false;
  const next = await controller.submit({
    paymentMethod: 'CASH',
    cashReceived: 10,
    discount: 0,
    items: [{ productId: 1, quantity: 1, unitPrice: 10 }],
  });
  assert.equal(next.outcome, MONEY_OUTCOME.SENT);
  assert.equal(controller.getUnresolved(), null);
});
