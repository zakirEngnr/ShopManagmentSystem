// Unit tests for the frontend idempotency subsystem.
//
// Three levels are covered:
//
//   1. the key holder, which decides WHEN a key is created, pinned, released
//      or abandoned, and WHICH payload goes with it;
//   2. the money-operation controller, which is the code path every one of
//      the five money-writing workflows uses;
//   3. the API helpers, which must put the key AND the unchanged body on the
//      wire for every money-writing operation.
//
// The requests are captured with a fake Axios adapter, so no network and no
// mocking library is involved.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  createIdempotencyKey,
  requireIdempotencyKey,
  classifyOutcome,
  normalizePayload,
  canonicalize,
  createIdempotencyKeyHolder,
  definitiveStatusesFor,
  DEFINITIVE_STATUSES_BY_OPERATION,
} from '../src/utils/idempotency.js';
import { createIdempotencyStore } from '../src/utils/idempotencyStore.js';
import {
  MONEY_OUTCOME,
  createMoneyOperation,
  abandonConfirmationReducer,
  isAbandonConfirming,
  ABANDON_IDLE,
  ABANDON_CONFIRMING,
} from '../src/utils/moneyOperation.js';

import client from '../src/api/client.js';
import { createSale } from '../src/api/sales.js';
import { createPurchase, buildPurchasePayload } from '../src/api/purchases.js';
import {
  recordSupplierPayment,
  buildSupplierPaymentPayload,
} from '../src/api/suppliers.js';
import {
  recordCustomerPayment,
  recordCustomerDebt,
  buildCustomerPaymentPayload,
  buildCustomerDebtPayload,
} from '../src/api/customers.js';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** The five money-writing workflows. */
const WORKFLOWS = [
  { operation: 'POST /sales', label: 'sale' },
  { operation: 'POST /purchases', label: 'purchase' },
  { operation: 'POST /suppliers/:id/payment', label: 'payment' },
  { operation: 'POST /customers/:id/payment', label: 'payment' },
  { operation: 'POST /customers/:id/debt', label: 'debt entry' },
];

/** A minimal sessionStorage stand-in. */
function createMemoryStorage() {
  const map = new Map();
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => { map.set(key, String(value)); },
    removeItem: (key) => { map.delete(key); },
    entries: () => [...map.entries()],
  };
}

function createHolder(storage = createMemoryStorage()) {
  return {
    storage,
    holder: createIdempotencyKeyHolder({ store: createIdempotencyStore({ storage }) }),
  };
}

/** A controller with a memory store, so every case starts clean. */
function createController({ scope = 'sale', operation = 'POST /sales', label = 'sale', send } = {}) {
  const storage = createMemoryStorage();
  const store = createIdempotencyStore({ storage });
  const sent = [];

  const controller = createMoneyOperation({
    scope,
    operation,
    label,
    store,
    send:
      send ??
      (async (body, key) => {
        sent.push({ body, key });
        return { ok: true };
      }),
  });

  return { controller, store, storage, sent };
}

/* ------------------------------------------------------------------ */
/* 1. UUID generation                                                  */
/* ------------------------------------------------------------------ */

test('a generated key is a v4 UUID', () => {
  const key = createIdempotencyKey();
  assert.match(key, UUID_V4);
  assert.notEqual(createIdempotencyKey(), createIdempotencyKey());
});

test('without secure randomness the key generation fails closed', () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  Object.defineProperty(globalThis, 'crypto', { value: undefined, configurable: true });
  try {
    assert.throws(() => createIdempotencyKey(), /secure random/i);
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'crypto', descriptor);
  }
});

test('without secure randomness the request is not sent', () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  Object.defineProperty(globalThis, 'crypto', { value: undefined, configurable: true });
  try {
    const { holder } = createHolder();
    // The holder must throw instead of handing out a weak key.
    assert.throws(() => holder.begin('sale', { a: 1 }), /secure random/i);
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'crypto', descriptor);
  }
});

test('without secure randomness the controller does not send the request', async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  Object.defineProperty(globalThis, 'crypto', { value: undefined, configurable: true });
  try {
    const { controller, sent } = createController();
    const outcome = await controller.submit({ amount: 100 });
    assert.equal(outcome.outcome, MONEY_OUTCOME.UNSAFE);
    assert.equal(sent.length, 0, 'no request may be sent without a secure key');
    assert.equal(controller.getUnresolved(), null, 'nothing is unresolved when nothing was sent');
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'crypto', descriptor);
  }
});

test('the key never comes from Math.random', () => {
  const source = createIdempotencyKey.toString();
  assert.equal(source.includes('Math.random'), false, 'the key must not be derived from Math.random');
});

test('requireIdempotencyKey rejects a missing key and accepts a real one', () => {
  assert.throws(() => requireIdempotencyKey(undefined, 'POST /sales'), /Idempotency-Key/);
  assert.throws(() => requireIdempotencyKey('', 'POST /sales'), /Idempotency-Key/);
  assert.throws(() => requireIdempotencyKey('   ', 'POST /sales'), /Idempotency-Key/);
  assert.equal(requireIdempotencyKey(' abc ', 'POST /sales'), 'abc');
});

/* ------------------------------------------------------------------ */
/* 2. Outcome classification                                           */
/* ------------------------------------------------------------------ */

test('classifyOutcome: a request without a response is ambiguous', () => {
  const outcome = classifyOutcome(
    Object.assign(new Error('timeout of 15000ms exceeded'), { code: 'ECONNABORTED' }),
    'POST /sales',
  );
  assert.equal(outcome.ambiguous, true);
  assert.equal(outcome.reason, 'no-response');
});

test('classifyOutcome: a network failure is ambiguous', () => {
  const outcome = classifyOutcome(
    Object.assign(new Error('Network Error'), { code: 'ERR_NETWORK' }),
    'POST /sales',
  );
  assert.equal(outcome.ambiguous, true);
});

test('classifyOutcome: a 5xx is ambiguous', () => {
  const outcome = classifyOutcome({ response: { status: 500 } }, 'POST /sales');
  assert.equal(outcome.ambiguous, true);
  assert.equal(outcome.reason, 'server-error');
});

test('classifyOutcome: a 502/504 from a proxy is ambiguous', () => {
  assert.equal(classifyOutcome({ response: { status: 502 } }, 'POST /sales').ambiguous, true);
  assert.equal(classifyOutcome({ response: { status: 504 } }, 'POST /sales').ambiguous, true);
});

test('classifyOutcome: a verified 4xx is definitive', () => {
  for (const status of [400, 404, 409, 422]) {
    const outcome = classifyOutcome({ response: { status } }, 'POST /sales');
    assert.equal(outcome.ambiguous, false, `status ${status} must be definitive`);
    assert.equal(outcome.reason, 'client-error');
  }
});

test('classifyOutcome: an unknown status is treated as ambiguous', () => {
  assert.equal(classifyOutcome({ response: { status: 302 } }, 'POST /sales').ambiguous, true);
  assert.equal(classifyOutcome({ response: { status: 418 } }, 'POST /sales').ambiguous, true);
});

test('every money-writing workflow has its own verified set of definitive statuses', () => {
  for (const { operation } of WORKFLOWS) {
    assert.ok(
      DEFINITIVE_STATUSES_BY_OPERATION[operation],
      `${operation} must have its own list of definitive statuses`,
    );

    const statuses = definitiveStatusesFor(operation);
    assert.ok(Array.isArray(statuses), `${operation} must have a list of definitive statuses`);

    // The verified backend contract: every validation of every workflow runs
    // before the first write or inside the transaction that is rolled back,
    // so a 4xx proves that nothing was committed.
    for (const definitive of [400, 401, 403, 404, 409, 422]) {
      assert.equal(statuses.includes(definitive), true, `${operation}: ${definitive} must be definitive`);
    }

    // A 5xx is never proof that nothing was committed.
    for (const serverError of [500, 502, 503, 504]) {
      assert.equal(statuses.includes(serverError), false, `${operation}: ${serverError} must stay ambiguous`);
    }

    // An unknown status is never proof that nothing was committed.
    assert.equal(statuses.includes(418), false);
  }
});

test('an unknown operation falls back to the default definitive statuses', () => {
  assert.deepEqual(
    [...definitiveStatusesFor('POST /not-a-money-endpoint')],
    [...definitiveStatusesFor(undefined)],
  );
});

/* ------------------------------------------------------------------ */
/* 3. The key holder                                                   */
/* ------------------------------------------------------------------ */

test('a new operation gets a key and keeps its payload', () => {
  const { holder } = createHolder();
  const payload = { amount: 100, description: 'cash' };
  const result = holder.begin('customer-payment:1', payload);

  assert.ok(result);
  assert.equal(result.blocked, false);
  assert.equal(result.replay, false);
  assert.match(result.key, UUID_V4);
  assert.deepEqual(result.payload, payload);
});

test('an ambiguous failure pins the key AND the original payload', () => {
  const { holder } = createHolder();
  const payload = { amount: 100, description: 'cash' };

  const first = holder.begin('customer-payment:1', payload);
  holder.fail('customer-payment:1', { ambiguous: true });

  const unresolved = holder.peek('customer-payment:1');
  assert.ok(unresolved, 'the operation must still be known');
  assert.equal(unresolved.key, first.key, 'the key must be pinned');
  assert.deepEqual(unresolved.payload, payload, 'the original payload must be pinned');
  assert.equal(unresolved.signature, canonicalize(payload));
});

test('a retry reuses the original key and the original payload', () => {
  const { holder } = createHolder();
  const payload = { amount: 100, description: 'cash' };

  const first = holder.begin('customer-payment:1', payload);
  holder.fail('customer-payment:1', { ambiguous: true });

  const retry = holder.begin('customer-payment:1', payload);
  assert.equal(retry.blocked, false);
  assert.equal(retry.replay, true);
  assert.equal(retry.key, first.key, 'the retry must reuse the key');
  assert.deepEqual(retry.payload, payload, 'the retry must reuse the payload');
});

test('changed form data cannot alter the retry payload', () => {
  const { holder } = createHolder();
  const original = { amount: 100, description: 'cash' };

  const first = holder.begin('customer-payment:1', original);
  holder.fail('customer-payment:1', { ambiguous: true });

  // The user changes the amount and tries to submit again.
  const changed = { amount: 999, description: 'cash' };
  const result = holder.begin('customer-payment:1', changed);

  assert.equal(result.blocked, true, 'a different payload must be blocked');
  assert.equal(result.reason, 'unresolved-operation');

  // The stored request is untouched and is what a retry sends.
  const replay = holder.replay('customer-payment:1');
  assert.equal(replay.key, first.key);
  assert.deepEqual(replay.payload, original, 'the retry must use the ORIGINAL payload');
});

test('the signature is computed from the payload, not supplied by the caller', () => {
  const { holder } = createHolder();
  const payload = { amount: 100, description: 'cash' };

  const first = holder.begin('sale', payload);
  holder.fail('sale', { ambiguous: true });

  // The same payload with a different key order is the same request.
  const reordered = { description: 'cash', amount: 100 };
  const same = holder.begin('sale', reordered);
  assert.equal(same.blocked, false, 'the same request must not be blocked');
  assert.equal(same.replay, true);
  assert.equal(same.key, first.key);

  // The replay is in flight; it also ends up with an unknown outcome.
  holder.fail('sale', { ambiguous: true });

  // A different payload IS blocked, even if only the description changed.
  const different = { amount: 100, description: 'other' };
  assert.equal(holder.begin('sale', different).blocked, true);
});

test('the explicit retry action sends the stored request', () => {
  const { holder } = createHolder();
  const original = { amount: 100 };

  holder.begin('sale', original);
  holder.fail('sale', { ambiguous: true });

  const replay = holder.replay('sale');
  assert.deepEqual(replay.payload, original);
  assert.match(replay.key, UUID_V4);
});

test('a definitive failure releases the key, so the next submission is a new one', () => {
  const { holder } = createHolder();
  const payload = { amount: 100 };

  const first = holder.begin('sale', payload);
  holder.fail('sale', { ambiguous: false });

  assert.equal(holder.peek('sale'), null, 'a definitive failure leaves nothing unresolved');

  const second = holder.begin('sale', payload);
  assert.notEqual(second.key, first.key, 'a new operation needs a new key');
});

test('a success clears the operation', () => {
  const { holder } = createHolder();
  holder.begin('sale', { amount: 1 });
  holder.succeed('sale');
  assert.equal(holder.peek('sale'), null);
});

test('a second submit while the first is pending is refused', () => {
  const { holder } = createHolder();
  const first = holder.begin('sale', { amount: 1 });
  assert.ok(first);
  assert.equal(holder.begin('sale', { amount: 1 }), null);
  assert.equal(holder.isPending('sale'), true);
});

test('abandoning an unresolved operation is an explicit action', () => {
  const { holder } = createHolder();
  holder.begin('sale', { amount: 1 });
  holder.fail('sale', { ambiguous: true });

  // Nothing else releases it: the state survives until abandon() is called.
  assert.ok(holder.peek('sale'));
  holder.abandon('sale');
  assert.equal(holder.peek('sale'), null);
});

test('separate scopes never share a key', () => {
  const { holder } = createHolder();
  const a = holder.begin('customer-payment:1', { amount: 1 });
  const b = holder.begin('customer-payment:2', { amount: 1 });
  const c = holder.begin('sale', { amount: 1 });
  assert.equal(new Set([a.key, b.key, c.key]).size, 3);
});

test('an unmount and a remount restore the unresolved operation', () => {
  const storage = createMemoryStorage();
  const payload = { amount: 100, description: 'cash' };

  // The mounted component.
  const first = createIdempotencyKeyHolder({ store: createIdempotencyStore({ storage }) });
  const started = first.begin('customer-payment:1', payload, 1);
  first.fail('customer-payment:1', { ambiguous: true });

  // The component unmounts (its holder is dropped) and a new one mounts.
  const second = createIdempotencyKeyHolder({ store: createIdempotencyStore({ storage }) });
  const restored = second.peek('customer-payment:1');

  assert.ok(restored, 'the unresolved operation must be restored');
  assert.equal(restored.key, started.key, 'the SAME key must be restored');
  assert.deepEqual(restored.payload, payload, 'the SAME payload must be restored');
  assert.equal(restored.entity, '1', 'the target of the request must be restored');

  // The retry after the remount reuses the restored request.
  const retry = second.replay('customer-payment:1');
  assert.equal(retry.key, started.key);
  assert.deepEqual(retry.payload, payload);
  assert.equal(retry.entity, '1');
});

test('the persisted record holds the key, the payload and the scope - and nothing else', () => {
  const storage = createMemoryStorage();
  const holder = createIdempotencyKeyHolder({ store: createIdempotencyStore({ storage }) });
  const payload = { amount: 100, description: 'cash' };

  holder.begin('customer-payment:7', payload, 7);
  holder.fail('customer-payment:7', { ambiguous: true });

  assert.equal(storage.entries().length, 1);
  const [storageKey, raw] = storage.entries()[0];
  const record = JSON.parse(raw);

  assert.match(storageKey, /customer-payment:7$/);
  assert.equal(record.scope, 'customer-payment:7');
  assert.match(record.key, UUID_V4);
  assert.deepEqual(record.payload, payload);
  assert.equal(record.signature, canonicalize(payload));
  assert.equal(record.entity, '7');
  assert.equal(record.status, 'unresolved');
  assert.equal(typeof record.createdAt, 'string');

  // No credentials, no tokens.
  const serialised = JSON.stringify(record).toLowerCase();
  for (const forbidden of ['token', 'password', 'authorization', 'bearer', 'jwt', 'secret']) {
    assert.equal(serialised.includes(forbidden), false, `the record must not contain "${forbidden}"`);
  }
});

test('a corrupted persisted record is discarded', () => {
  const storage = createMemoryStorage();
  const store = createIdempotencyStore({ storage });
  const holder = createIdempotencyKeyHolder({ store });

  storage.setItem('cosmetic-shop.idem.v2:sale', '{not json');
  assert.equal(holder.peek('sale'), null);

  storage.setItem(
    'cosmetic-shop.idem.v2:sale',
    JSON.stringify({ v: 99, scope: 'sale', key: 'x', signature: 's', payload: {}, status: 'unresolved' }),
  );
  assert.equal(holder.peek('sale'), null, 'a record of another version must be discarded');

  storage.setItem(
    'cosmetic-shop.idem.v2:sale',
    JSON.stringify({ v: 2, scope: 'other', key: 'x', signature: 's', payload: {}, status: 'unresolved' }),
  );
  assert.equal(holder.peek('sale'), null, 'a record of another scope must be discarded');

  storage.setItem(
    'cosmetic-shop.idem.v2:sale',
    JSON.stringify({
      v: 2,
      scope: 'sale',
      key: 'not-a-uuid',
      signature: 's',
      payload: {},
      status: 'unresolved',
      createdAt: new Date().toISOString(),
    }),
  );
  assert.equal(holder.peek('sale'), null, 'a record with an invalid key must be discarded');
});

test('normalizePayload drops undefined members, exactly like the wire format', () => {
  assert.deepEqual(normalizePayload({ a: 1, b: undefined }), { a: 1 });
  assert.deepEqual(normalizePayload({ a: { b: [1, 2] } }), { a: { b: [1, 2] } });
});

test('canonicalize is stable under a different key order', () => {
  assert.equal(canonicalize({ a: 1, b: 2 }), canonicalize({ b: 2, a: 1 }));
  assert.notEqual(canonicalize({ a: 1 }), canonicalize({ a: 2 }));
});

/* ------------------------------------------------------------------ */
/* 4. The money-operation controller (the code path of every workflow) */
/* ------------------------------------------------------------------ */

test('the controller sends the body it was given, unchanged', async () => {
  const { controller, sent } = createController();
  const body = { paymentMethod: 'CASH', discount: 0, items: [{ productId: 1, quantity: 2 }] };

  const outcome = await controller.submit(body);

  assert.equal(outcome.outcome, MONEY_OUTCOME.SENT);
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].body, body);
  assert.match(sent[0].key, UUID_V4);
});

test('the controller pins the key AND the payload after an ambiguous outcome', async () => {
  const { controller, storage } = createController({
    send: async () => {
      throw Object.assign(new Error('timeout of 15000ms exceeded'), { code: 'ECONNABORTED' });
    },
  });

  const body = { amount: 100 };
  const outcome = await controller.submit(body);

  assert.equal(outcome.outcome, MONEY_OUTCOME.AMBIGUOUS);
  assert.match(outcome.message, /may already have been saved/i);

  const unresolved = controller.getUnresolved();
  assert.ok(unresolved, 'the operation must stay unresolved');
  assert.match(unresolved.key, UUID_V4);
  assert.deepEqual(unresolved.payload, body, 'the original payload must be pinned');

  // The state survives in the durable store.
  const stored = [...storage.entries()].map(([, raw]) => JSON.parse(raw));
  assert.equal(stored.length, 1);
  assert.deepEqual(stored[0].payload, body);
  assert.equal(stored[0].status, 'unresolved');
});

test('the controller blocks a different payload while an operation is unresolved', async () => {
  let calls = 0;
  const { controller } = createController({
    send: async () => {
      calls += 1;
      throw Object.assign(new Error('timeout'), { code: 'ECONNABORTED' });
    },
  });

  await controller.submit({ amount: 100 });
  assert.equal(calls, 1);

  const second = await controller.submit({ amount: 999 });
  assert.equal(second.outcome, MONEY_OUTCOME.BLOCKED);
  assert.match(second.message, /unresolved/i);
  assert.equal(calls, 1, 'the blocked submission must not reach the server');
});

test('the controller retry replays the original body and the original key', async () => {
  const sent = [];
  let fail = true;
  const { controller } = createController({
    send: async (body, key) => {
      sent.push({ body, key });
      if (fail) throw Object.assign(new Error('timeout'), { code: 'ECONNABORTED' });
      return { ok: true };
    },
  });

  const original = { amount: 100 };
  await controller.submit(original);
  assert.equal(sent.length, 1);

  // The user edits the form and submits again: the request is refused.
  await controller.submit({ amount: 999 });
  assert.equal(sent.length, 1, 'the edited request must not be sent');

  // The explicit retry replays the original request.
  fail = false;
  const retry = await controller.retry();
  assert.equal(retry.outcome, MONEY_OUTCOME.SENT);
  assert.equal(sent.length, 2);
  assert.equal(sent[1].key, sent[0].key, 'the retry must reuse the key');
  assert.deepEqual(sent[1].body, original, 'the retry must reuse the original body');
});

test('the controller clears the operation on a confirmed success', async () => {
  const { controller, storage } = createController();

  const outcome = await controller.submit({ amount: 100 });

  assert.equal(outcome.outcome, MONEY_OUTCOME.SENT);
  assert.equal(controller.getUnresolved(), null);
  assert.equal(storage.entries().length, 0, 'the persisted state must be cleared');
});

test('the controller releases the key after a verified definitive failure', async () => {
  let calls = 0;
  const { controller, storage } = createController({
    send: async () => {
      calls += 1;
      const error = new Error('Product not found');
      error.response = { status: 404, data: { ok: false, error: { message: 'Product not found' } } };
      throw error;
    },
  });

  const outcome = await controller.submit({ amount: 100 });

  assert.equal(outcome.outcome, MONEY_OUTCOME.FAILED);
  assert.equal(outcome.message, 'Product not found');
  assert.equal(controller.getUnresolved(), null, 'a verified failure leaves nothing unresolved');
  assert.equal(storage.entries().length, 0);
  assert.equal(calls, 1);
});

test('the controller keeps the operation unresolved after a 5xx', async () => {
  const { controller } = createController({
    send: async () => {
      const error = new Error('Internal server error');
      error.response = { status: 500, data: { ok: false } };
      throw error;
    },
  });

  const outcome = await controller.submit({ amount: 100 });

  assert.equal(outcome.outcome, MONEY_OUTCOME.AMBIGUOUS);
  assert.ok(controller.getUnresolved(), 'a 5xx does not prove that nothing was committed');
});

test('the controller only releases the unresolved state on an explicit abandonment', async () => {
  const { controller } = createController({
    send: async () => {
      throw Object.assign(new Error('timeout'), { code: 'ECONNABORTED' });
    },
  });

  await controller.submit({ amount: 100 });
  assert.ok(controller.getUnresolved());

  // A refused second submission does not release it.
  await controller.submit({ amount: 999 });
  assert.ok(controller.getUnresolved(), 'a blocked submission must not release the state');

  // Only the explicit abandonment does.
  controller.abandon();
  assert.equal(controller.getUnresolved(), null);
});

test('a scope change while a request is in flight never clears another scope', async () => {
  let release;
  const pending = new Promise((resolve) => {
    release = resolve;
  });

  const storage = createMemoryStorage();
  const store = createIdempotencyStore({ storage });

  // The payment of customer 1 has an unknown outcome and stays unresolved.
  const customerOne = createMoneyOperation({
    scope: 'customer-payment:1',
    operation: 'POST /customers/:id/payment',
    label: 'payment',
    send: async () => {
      throw Object.assign(new Error('timeout'), { code: 'ECONNABORTED' });
    },
    store,
  });
  await customerOne.submit({ amount: 100 }, 1);
  assert.ok(customerOne.getUnresolved(), 'the payment of customer 1 is unresolved');

  // The user picks customer 2 and submits a payment for them.
  const controller = createMoneyOperation({
    scope: 'customer-payment:2',
    operation: 'POST /customers/:id/payment',
    label: 'payment',
    send: async () => pending,
    store,
  });
  const inFlight = controller.submit({ amount: 200 }, 2);

  // While the request of customer 2 is in flight the user switches back to
  // customer 1. The success of customer 2 must not touch the unresolved
  // operation of customer 1.
  controller.configure({ scope: 'customer-payment:1' });
  release({ ok: true });
  const outcome = await inFlight;

  assert.equal(outcome.outcome, MONEY_OUTCOME.SENT);
  assert.ok(
    customerOne.getUnresolved(),
    'the unresolved operation of customer 1 must NOT be cleared by the success of customer 2',
  );
  assert.equal(
    store.read('customer-payment:2'),
    null,
    'the operation of customer 2 is settled',
  );
});

test('the abandonment needs a second, explicit action', () => {
  let state = { status: ABANDON_IDLE, key: null };

  state = abandonConfirmationReducer(state, { type: 'request', key: 'key-1' });
  assert.equal(state.status, ABANDON_CONFIRMING);
  assert.equal(isAbandonConfirming(state, 'key-1'), true);

  // Cancelling goes back to idle.
  state = abandonConfirmationReducer(state, { type: 'cancel' });
  assert.equal(state.status, ABANDON_IDLE);
  assert.equal(isAbandonConfirming(state, 'key-1'), false);

  // The confirmation applies to one operation only.
  state = abandonConfirmationReducer(state, { type: 'request', key: 'key-1' });
  assert.equal(isAbandonConfirming(state, 'key-2'), false);
});

/* ------------------------------------------------------------------ */
/* 5. The API helpers put the key AND the body on the wire            */
/* ------------------------------------------------------------------ */

let requests = [];
let originalAdapter = null;

beforeEach(() => {
  requests = [];
  originalAdapter = client.defaults.adapter;
  client.defaults.adapter = async (config) => {
    requests.push({
      method: config.method,
      url: config.url,
      headers: config.headers,
      data: config.data,
    });
    return {
      data: {
        ok: true,
        sale: { id: 1, invoiceNo: 'INV-1', total: 10 },
        purchase: { id: 1, totalAmount: 40 },
        payment: { id: 1, amount: 15 },
        allocations: [],
        transaction: { id: 1, amount: 20 },
        customer: { id: 1, name: 'Audit Customer' },
        supplier: { id: 1, name: 'Audit Supplier' },
      },
      status: 200,
      statusText: 'OK',
      headers: {},
      config,
      request: {},
    };
  };
});

afterEach(() => {
  client.defaults.adapter = originalAdapter;
});

function headerOf(request) {
  const headers = request.headers ?? {};
  const found = Object.keys(headers).find((h) => h.toLowerCase() === 'idempotency-key');
  return found ? headers[found] : undefined;
}

test('POST /sales sends the Idempotency-Key header', async () => {
  const key = createIdempotencyKey();
  await createSale({ paymentMethod: 'CASH', items: [] }, key);

  assert.equal(requests.length, 1);
  assert.equal(requests[0].method, 'post');
  assert.equal(requests[0].url, '/sales');
  assert.equal(headerOf(requests[0]), key);
});

test('POST /purchases sends the Idempotency-Key header', async () => {
  const key = createIdempotencyKey();
  await createPurchase({ supplierId: 1, items: [{ productId: 1, quantity: 1, unitCost: 5 }] }, key);

  assert.equal(requests.length, 1);
  assert.equal(requests[0].method, 'post');
  assert.equal(requests[0].url, '/purchases');
  assert.equal(headerOf(requests[0]), key);
});

test('POST /suppliers/:id/payment sends the Idempotency-Key header', async () => {
  const key = createIdempotencyKey();
  await recordSupplierPayment(7, { amount: 100, description: 'cash' }, key);

  assert.equal(requests.length, 1);
  assert.equal(requests[0].method, 'post');
  assert.equal(requests[0].url, '/suppliers/7/payment');
  assert.equal(headerOf(requests[0]), key);
});

test('POST /customers/:id/payment sends the Idempotency-Key header', async () => {
  const key = createIdempotencyKey();
  await recordCustomerPayment(3, { amount: 50, description: 'cash' }, key);

  assert.equal(requests.length, 1);
  assert.equal(requests[0].method, 'post');
  assert.equal(requests[0].url, '/customers/3/payment');
  assert.equal(headerOf(requests[0]), key);
});

test('POST /customers/:id/debt sends the Idempotency-Key header', async () => {
  const key = createIdempotencyKey();
  await recordCustomerDebt(3, { amount: 50, description: 'rent' }, key);

  assert.equal(requests.length, 1);
  assert.equal(requests[0].method, 'post');
  assert.equal(requests[0].url, '/customers/3/debt');
  assert.equal(headerOf(requests[0]), key);
});

test('every money-writing helper refuses to send a request without a key', async () => {
  await assert.rejects(() => createSale({ paymentMethod: 'CASH', items: [] }), /Idempotency-Key/);
  await assert.rejects(() => createPurchase({ supplierId: 1, items: [] }), /Idempotency-Key/);
  await assert.rejects(() => recordSupplierPayment(1, { amount: 1 }), /Idempotency-Key/);
  await assert.rejects(() => recordCustomerPayment(1, { amount: 1 }), /Idempotency-Key/);
  await assert.rejects(() => recordCustomerDebt(1, { amount: 1 }), /Idempotency-Key/);
  assert.equal(requests.length, 0, 'no request may be sent without a key');
});

test('the body on the wire is the body that was stored, byte for byte', async () => {
  const key = createIdempotencyKey();
  const body = { amount: 100, description: 'cash' };

  await recordCustomerPayment(3, body, key);

  assert.deepEqual(JSON.parse(requests[0].data), body);
  assert.equal(Object.keys(JSON.parse(requests[0].data)).length, 2, 'no field may be added');
});

test('a retry puts the SAME key and the SAME body on the wire again', async () => {
  const { holder } = createHolder();
  const payload = { paymentMethod: 'CASH', items: [{ productId: 1, quantity: 1, unitPrice: 10 }] };

  const first = holder.begin('sale', payload);
  await createSale(first.payload, first.key);
  holder.fail('sale', { ambiguous: true });

  // The user changes the form, then the retry action sends the ORIGINAL request.
  const changed = { paymentMethod: 'CASH', items: [{ productId: 1, quantity: 9, unitPrice: 10 }] };
  const blocked = holder.begin('sale', changed);
  assert.equal(blocked.blocked, true);

  const replay = holder.replay('sale');
  await createSale(replay.payload, replay.key);

  assert.equal(requests.length, 2);
  assert.equal(headerOf(requests[0]), headerOf(requests[1]), 'the same key must be sent');
  assert.deepEqual(
    JSON.parse(requests[0].data),
    JSON.parse(requests[1].data),
    'the same body must be sent',
  );
});

test('a new transaction puts a DIFFERENT key on the wire', async () => {
  const { holder } = createHolder();
  const payload = { paymentMethod: 'CASH', items: [] };

  const first = holder.begin('sale', payload);
  await createSale(first.payload, first.key);
  holder.succeed('sale');

  const second = holder.begin('sale', payload);
  await createSale(second.payload, second.key);

  assert.notEqual(second.key, first.key);
  assert.equal(headerOf(requests[0]), first.key);
  assert.equal(headerOf(requests[1]), second.key);
});

test('the key is not generated by an interceptor, so a retry cannot get a new one', async () => {
  const { holder } = createHolder();
  const { key } = holder.begin('sale', { a: 1 });

  await createSale({ a: 1 }, key);
  await createSale({ a: 1 }, key);

  assert.equal(headerOf(requests[0]), key);
  assert.equal(headerOf(requests[1]), key);
});

test('the payload of a request is not changed by the key integration', async () => {
  const key = createIdempotencyKey();
  await createSale(
    { paymentMethod: 'CASH', discount: 0, items: [{ productId: 1, quantity: 2, unitPrice: 10 }] },
    key,
  );

  const sent = JSON.parse(requests[0].data);
  assert.deepEqual(sent, {
    paymentMethod: 'CASH',
    discount: 0,
    items: [{ productId: 1, quantity: 2, unitPrice: 10 }],
  });
});

/* ------------------------------------------------------------------ */
/* 6. The payload builders                                             */
/* ------------------------------------------------------------------ */

test('the purchase builder produces the body the backend accepts', () => {
  const payload = buildPurchasePayload({
    supplierId: '3',
    items: [{ productId: '7', quantity: '2', unitCost: '8.5' }],
  });

  assert.deepEqual(payload, { supplierId: 3, items: [{ productId: 7, quantity: 2, unitCost: 8.5 }] });
});

test('the payment builders produce the body the backend accepts', () => {
  // The backend schemas are strict: the customer/supplier id belongs to the
  // URL, not to the body.
  assert.deepEqual(buildSupplierPaymentPayload({ amount: '15', description: ' cash ' }), {
    amount: 15,
    description: 'cash',
  });
  assert.deepEqual(buildCustomerPaymentPayload({ amount: '20', description: '' }), {
    amount: 20,
    description: null,
  });
  assert.deepEqual(buildCustomerDebtPayload({ amount: '75', description: ' stock ' }), {
    amount: 75,
    description: 'stock',
  });
});
