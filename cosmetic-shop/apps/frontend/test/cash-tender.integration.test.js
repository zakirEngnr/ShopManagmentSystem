// INTEGRATION test of the cash tender against the REAL backend and a
// DISPOSABLE database.
//
// Everything here runs against a throw-away database and the real backend:
//   * the disposable database is built by replaying the migration SQL with
//     node:sqlite (no Prisma CLI command, no development database);
//   * the real backend is started as a child process against that database;
//   * the real frontend API helper is used, with a real HTTP round trip.
//
// The level under test is the WIRE: which body is sent and what the backend
// does with it.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { startDisposableBackend, installLosingAdapter } from './support/disposableBackend.js';

import client from '../src/api/client.js';
import { createSale } from '../src/api/sales.js';

let backend;
let losing;

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

test('a CASH request carries the tender and the backend stores it', async () => {
  losing.lose = false;
  const key = crypto.randomUUID();
  const body = {
    paymentMethod: 'CASH',
    cashReceived: 20,
    discount: 0,
    items: [{ productId: 1, quantity: 2, unitPrice: 10 }],
  };

  const sale = await createSale(body, key);

  assert.equal(sale.total, 20, 'the total is the sale amount');
  assert.equal(sale.cashReceived, 20, 'the tender must be stored');

  const row = backend.row('SELECT "cashReceived", "total" FROM "Sale" ORDER BY id DESC LIMIT 1');
  assert.equal(Number(row.cashReceived), 20, 'the Sale row must store the tender');
  assert.equal(Number(row.total), 20, 'the tender must not change the total');
});

test('a non-CASH request omits the tender and the backend stores NULL', async () => {
  losing.lose = false;
  const key = crypto.randomUUID();
  const body = {
    paymentMethod: 'CARD',
    discount: 0,
    items: [{ productId: 1, quantity: 1, unitPrice: 10 }],
  };

  const sale = await createSale(body, key);

  assert.equal(sale.cashReceived, null, 'a card sale stores no tender');
  const row = backend.row('SELECT "cashReceived" FROM "Sale" ORDER BY id DESC LIMIT 1');
  assert.equal(row.cashReceived, null, 'the Sale row must store NULL');
});

test('an insufficient tender is rejected and creates no sale', async () => {
  losing.lose = false;
  const key = crypto.randomUUID();
  const salesBefore = backend.row('SELECT COUNT(*) c FROM "Sale"').c;

  await assert.rejects(
    () =>
      createSale(
        {
          paymentMethod: 'CASH',
          cashReceived: 5,
          discount: 0,
          items: [{ productId: 1, quantity: 1, unitPrice: 10 }],
        },
        key,
      ),
    (err) => {
      assert.equal(err.response?.status, 400, 'the backend must reject an insufficient tender');
      return true;
    },
  );

  assert.equal(backend.row('SELECT COUNT(*) c FROM "Sale"').c, salesBefore, 'no sale may be created');
});

test('a retry replays the original body and the original tender', async () => {
  losing.lose = false;
  const key = crypto.randomUUID();
  const body = {
    paymentMethod: 'CASH',
    cashReceived: 20,
    discount: 0,
    items: [{ productId: 1, quantity: 1, unitPrice: 10 }],
  };

  const first = await createSale(body, key);
  assert.equal(first.cashReceived, 20);

  // The very same body and the very same key are sent again.
  const replay = await createSale(body, key);

  assert.equal(replay.id, first.id, 'the retry must return the original sale');
  assert.equal(replay.cashReceived, 20, 'the retry must return the original tender');
  assert.equal(backend.row('SELECT COUNT(*) c FROM "Sale" WHERE "idempotencyKey" = ?', key).c, 1, 'exactly one sale');
});

test('a lost response leaves one sale and the retry returns the original tender', async () => {
  losing.lose = false;
  const key = crypto.randomUUID();
  const body = {
    paymentMethod: 'CASH',
    cashReceived: 50,
    discount: 0,
    items: [{ productId: 1, quantity: 1, unitPrice: 10 }],
  };
  const salesBefore = backend.row('SELECT COUNT(*) c FROM "Sale"').c;

  // The server commits the sale but the response never reaches the browser.
  losing.lose = true;
  await assert.rejects(() => createSale(body, key));

  // The retry sends the ORIGINAL body with the ORIGINAL key.
  losing.lose = false;
  const replay = await createSale(body, key);

  assert.equal(replay.cashReceived, 50, 'the retry must return the original tender');
  assert.equal(backend.row('SELECT COUNT(*) c FROM "Sale"').c, salesBefore + 1, 'exactly one sale may exist');
});
