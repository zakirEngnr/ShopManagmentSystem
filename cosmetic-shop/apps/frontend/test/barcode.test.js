// Unit tests for the POS barcode lookup.
//
// Two levels are covered:
//
//   1. the lookup controller, which decides what happens with a scan event:
//      a repeated event of the same barcode is ignored while its lookup
//      runs, a different barcode waits its turn, and every outcome is
//      reported as its own state;
//   2. the API helper, which must ask the backend for the exact barcode and
//      must tell "unknown barcode" apart from "the request failed".
//
// The requests are captured with a fake Axios adapter, so no network and no
// mocking library is involved.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  createBarcodeLookup,
  BARCODE_STATUS,
  INITIAL_BARCODE_STATE,
} from '../src/utils/barcodeLookup.js';

import client from '../src/api/client.js';
import { fetchProductByBarcode } from '../src/api/products.js';

const PRODUCT = { id: 7, sku: 'SKU-7', name: 'Lipstick', sellPrice: 250, stock: 3 };

/** A lookup that never settles until the test releases it. */
function createDeferredLookup() {
  let release;
  const promise = new Promise((resolve, reject) => {
    release = { resolve, reject };
  });
  const calls = [];

  return {
    calls,
    promise,
    release,
    lookup: async (barcode) => {
      calls.push(barcode);
      return promise;
    },
  };
}

/** Let the microtask queue drain. */
const flush = async () => {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
};

/* ------------------------------------------------------------------ */
/* 1. The lookup controller                                            */
/* ------------------------------------------------------------------ */

test('a scan looks the barcode up and reports the product', async () => {
  const states = [];
  const found = [];
  const controller = createBarcodeLookup({
    lookup: async () => PRODUCT,
    onStateChange: (state) => states.push(state),
  });
  controller.configure({ onFound: (product, barcode) => found.push({ product, barcode }) });

  const result = controller.scan('  8901234  ');

  assert.equal(result.action, 'started');
  assert.equal(result.barcode, '8901234', 'the barcode must be trimmed');

  await flush();

  assert.equal(controller.getState().status, BARCODE_STATUS.FOUND);
  assert.equal(controller.getState().product.id, PRODUCT.id);
  assert.equal(found.length, 1, 'the product must be handed over exactly once');
  assert.equal(found[0].barcode, '8901234');

  assert.equal(states[0].status, BARCODE_STATUS.LOOKING_UP, 'the lookup must be visible');
  assert.equal(states[states.length - 1].status, BARCODE_STATUS.FOUND);
});

test('an unknown barcode is reported as not found, not as a failure', async () => {
  const controller = createBarcodeLookup({ lookup: async () => null });

  controller.scan('NOPE');
  await flush();

  assert.equal(controller.getState().status, BARCODE_STATUS.NOT_FOUND);
  assert.equal(controller.getState().barcode, 'NOPE');
  assert.equal(controller.getState().error, null, 'a missing product is not an error');
});

test('a failed request is reported as a failure and keeps the error', async () => {
  const boom = new Error('Network Error');
  const controller = createBarcodeLookup({
    lookup: async () => {
      throw boom;
    },
  });

  controller.scan('BROKEN');
  await flush();

  assert.equal(controller.getState().status, BARCODE_STATUS.FAILED);
  assert.equal(controller.getState().error, boom, 'the exception must not be swallowed');
  assert.equal(controller.getState().barcode, 'BROKEN');
});

test('a repeated scan event of the same barcode fires no second request', async () => {
  const deferred = createDeferredLookup();
  const controller = createBarcodeLookup({ lookup: deferred.lookup });

  const first = controller.scan('DUPLICATE');
  assert.equal(first.action, 'started');

  // The scanner repeats the very same event.
  const second = controller.scan('DUPLICATE');
  assert.equal(second.action, 'ignored');
  assert.equal(second.reason, 'duplicate');

  // ... and again.
  assert.equal(controller.scan('DUPLICATE').action, 'ignored');

  assert.equal(deferred.calls.length, 1, 'exactly one request may be sent');

  deferred.release.resolve(PRODUCT);
  await flush();

  assert.equal(controller.getState().status, BARCODE_STATUS.FOUND);
  assert.equal(deferred.calls.length, 1, 'the repeated event must not send a request');
});

test('a repeated scan event does not throw away the answer of the running lookup', async () => {
  const deferred = createDeferredLookup();
  const found = [];
  const controller = createBarcodeLookup({ lookup: deferred.lookup });
  controller.configure({ onFound: (product) => found.push(product) });

  controller.scan('SAME');
  controller.scan('SAME'); // the repeated event

  deferred.release.resolve(PRODUCT);
  await flush();

  assert.equal(controller.getState().status, BARCODE_STATUS.FOUND);
  assert.equal(found.length, 1, 'the scanned product must reach the cart exactly once');
});

test('a different barcode waits for the running lookup instead of being lost', async () => {
  const first = createDeferredLookup();
  const second = createDeferredLookup();
  const seen = [];
  let call = 0;

  const controller = createBarcodeLookup({
    lookup: async (barcode) => {
      seen.push(barcode);
      return call++ === 0 ? first.promise : second.promise;
    },
  });

  controller.scan('FIRST');
  const queued = controller.scan('SECOND');

  assert.equal(queued.action, 'queued');
  assert.deepEqual(seen, ['FIRST'], 'the second barcode must not start a parallel request');

  first.release.resolve(PRODUCT);
  await flush();

  assert.deepEqual(seen, ['FIRST', 'SECOND'], 'the queued barcode runs after the first one');
  assert.equal(controller.getState().barcode, 'SECOND');

  second.release.resolve(PRODUCT);
  await flush();

  assert.equal(controller.getState().status, BARCODE_STATUS.FOUND);
});

test('an empty scan event is ignored', () => {
  const controller = createBarcodeLookup({ lookup: async () => PRODUCT });

  assert.equal(controller.scan('').action, 'ignored');
  assert.equal(controller.scan('   ').action, 'ignored');
  assert.equal(controller.scan(null).action, 'ignored');
  assert.equal(controller.scan(undefined).action, 'ignored');
  assert.equal(controller.getState().status, BARCODE_STATUS.IDLE);
});

test('a new lookup clears the outcome of the previous one', async () => {
  let fail = true;
  const controller = createBarcodeLookup({
    lookup: async () => {
      if (fail) throw new Error('boom');
      return PRODUCT;
    },
  });

  controller.scan('FIRST');
  await flush();
  assert.equal(controller.getState().status, BARCODE_STATUS.FAILED);

  fail = false;
  controller.scan('SECOND');
  await flush();

  assert.equal(controller.getState().status, BARCODE_STATUS.FOUND);
  assert.equal(controller.getState().error, null, 'the stale error must be gone');
  assert.equal(controller.getState().barcode, 'SECOND');
});

test('a disposed controller stops working', async () => {
  const deferred = createDeferredLookup();
  const controller = createBarcodeLookup({ lookup: deferred.lookup });

  controller.scan('GONE');
  controller.dispose();

  deferred.release.resolve(PRODUCT);
  await flush();

  assert.equal(controller.getState().status, BARCODE_STATUS.IDLE);
  assert.equal(controller.scan('GONE').action, 'ignored');
});

test('the controller starts in the idle state', () => {
  const controller = createBarcodeLookup({ lookup: async () => null });
  assert.deepEqual(controller.getState(), INITIAL_BARCODE_STATE);
  assert.equal(controller.isBusy(), false);
});

/* ------------------------------------------------------------------ */
/* 2. The API helper                                                  */
/* ------------------------------------------------------------------ */

let requests = [];
let originalAdapter = null;

beforeEach(() => {
  requests = [];
  originalAdapter = client.defaults.adapter;
});

afterEach(() => {
  client.defaults.adapter = originalAdapter;
});

/** Install an adapter that answers with the given status and body. */
function answerWith(status, body) {
  client.defaults.adapter = async (config) => {
    requests.push({ url: config.url, method: config.method });
    if (status >= 400) {
      const error = new Error(`Request failed with status code ${status}`);
      error.response = { status, data: body };
      throw error;
    }
    return { data: body, status, statusText: 'OK', headers: {}, config, request: {} };
  };
}

test('the helper asks for the exact barcode', async () => {
  answerWith(200, { ok: true, product: PRODUCT });

  const product = await fetchProductByBarcode('  8901234  ');

  assert.equal(requests.length, 1);
  assert.equal(requests[0].method, 'get');
  assert.equal(requests[0].url, '/products/barcode/8901234');
  assert.equal(product.id, PRODUCT.id);
});

test('the helper encodes a barcode that contains a slash', async () => {
  answerWith(200, { ok: true, product: PRODUCT });

  await fetchProductByBarcode('A/B C');

  assert.equal(requests[0].url, '/products/barcode/A%2FB%20C');
});

test('the helper returns null for an unknown barcode', async () => {
  answerWith(404, { ok: false, error: { message: 'Product not found' } });

  assert.equal(await fetchProductByBarcode('NOPE'), null);
});

test('the helper rethrows a server failure', async () => {
  answerWith(500, { ok: false, error: { message: 'Internal server error' } });

  await assert.rejects(() => fetchProductByBarcode('BROKEN'), (err) => {
    assert.equal(err.response.status, 500);
    return true;
  });
});

test('the helper rethrows a network failure', async () => {
  client.defaults.adapter = async () => {
    throw Object.assign(new Error('Network Error'), { code: 'ERR_NETWORK' });
  };

  await assert.rejects(() => fetchProductByBarcode('BROKEN'), /Network Error/);
});

test('the helper rejects a malformed answer instead of reporting "not found"', async () => {
  answerWith(200, { ok: true });

  await assert.rejects(
    () => fetchProductByBarcode('BROKEN'),
    /Invalid barcode lookup response/,
    'a broken answer must not look like an unknown barcode',
  );
});

test('the helper does not call the backend for an empty barcode', async () => {
  answerWith(200, { ok: true, product: PRODUCT });

  assert.equal(await fetchProductByBarcode(''), null);
  assert.equal(await fetchProductByBarcode('   '), null);
  assert.equal(requests.length, 0, 'no request may be sent for an empty barcode');
});
