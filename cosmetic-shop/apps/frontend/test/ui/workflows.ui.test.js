// UI tests for the five money-writing workflows.
//
// WHAT THIS IS
//
// A real render of the real page components, produced by the real build
// pipeline: the pages are loaded through Vite (the same transform the
// production build uses) and rendered with react-dom/server.
//
// WHAT THIS IS NOT
//
// This is NOT a browser test. No browser is available in this environment
// and no test dependency may be added, so there is no real click, no real
// layout and no real event dispatch. The assertions are made on the
// rendered markup: which controls exist, which of them are disabled, and
// which message the user is shown.
//
// The behaviour that needs a click (the two step abandonment) is covered by
// the unit test of the state machine in test/idempotency.test.js and by the
// integration test of the controller in test/integration.
//
// The unresolved state is seeded into the shared store before the render,
// which is exactly the state the page finds after a reload: the operation
// survived in the durable storage and the page is mounted again.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { canonicalize } from '../../src/utils/idempotency.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const frontendDir = path.resolve(here, '..', '..');

let vite;
let reactRouterDom;
let store;

/** Load a module of the application through Vite. */
async function load(modulePath) {
  return vite.ssrLoadModule(modulePath);
}

/** Seed an unresolved operation into the shared store. */
function seedUnresolved(scope, payload, entity = null) {
  const key = crypto.randomUUID();
  store.write(scope, {
    v: 2,
    scope,
    key,
    signature: canonicalize(payload),
    payload,
    entity: entity === null ? null : String(entity),
    status: 'unresolved',
    createdAt: new Date().toISOString(),
  });
  return key;
}

/** Remove every unresolved operation. */
function clearUnresolved() {
  for (const scope of store.listScopes()) store.remove(scope);
}

/** Render a component to static markup. */
function render(element) {
  return renderToStaticMarkup(element);
}

/** True when the markup contains the given test id. */
function hasTestId(html, testId) {
  return html.includes(`data-testid="${testId}"`);
}

/** True when the element with the given test id carries the disabled attribute. */
function isDisabled(html, testId) {
  const marker = `data-testid="${testId}"`;
  const index = html.indexOf(marker);
  if (index === -1) return null;

  // The whole tag: the attributes can sit before or after the test id.
  const tagStart = html.lastIndexOf('<', index);
  const tagEnd = html.indexOf('>', index);
  const tag = html.slice(tagStart, tagEnd);
  return /\sdisabled(\s|=|>|$)/.test(tag);
}

before(async () => {
  const { createServer } = await import('vite');
  vite = await createServer({
    root: frontendDir,
    server: { middlewareMode: true },
    appType: 'custom',
    logLevel: 'error',
  });

  reactRouterDom = await import('react-router-dom');

  const hook = await load('/src/hooks/useMoneyOperation.js');
  store = hook.getSharedIdempotencyStore();
});

after(async () => {
  if (vite) await vite.close();
});

beforeEach(() => {
  clearUnresolved();
});

/* ------------------------------------------------------------------ */
/* 1. The shared warning component                                      */
/* ------------------------------------------------------------------ */

test('the unresolved notice states that the transaction may already be saved', async () => {
  const mod = await load('/src/components/UnresolvedOperationNotice.jsx');
  const html = render(
    React.createElement(mod.default, {
      label: 'sale',
      unresolved: {
        scope: 'sale',
        key: crypto.randomUUID(),
        payload: {},
        createdAt: new Date().toISOString(),
      },
      busy: false,
      onRetry: () => {},
      onAbandon: () => {},
    }),
  );

  assert.ok(hasTestId(html, 'unresolved-operation-notice'));
  assert.match(html, /may already have been saved/i);
  assert.ok(hasTestId(html, 'unresolved-operation-retry'), 'a retry must be offered');
  assert.ok(hasTestId(html, 'unresolved-operation-abandon'), 'an abandonment must be offered');

  // The abandonment needs a second, explicit action: the confirmation panel
  // is not on the screen yet.
  assert.equal(
    hasTestId(html, 'unresolved-operation-abandon-confirm'),
    false,
    'the abandonment must not be a single click',
  );
  assert.match(html, /does not undo/i);
});

test('the page level banner lists every unresolved operation of the workflow', async () => {
  const mod = await load('/src/components/UnresolvedOperationsBanner.jsx');
  const html = render(
    React.createElement(mod.default, {
      label: 'payment',
      records: [
        {
          scope: 'supplier-payment:7',
          key: crypto.randomUUID(),
          payload: {},
          entity: '7',
          createdAt: new Date().toISOString(),
        },
      ],
      busy: false,
      onRetry: () => {},
      onAbandon: () => {},
      onOpen: () => {},
    }),
  );

  assert.ok(hasTestId(html, 'unresolved-operations-banner'));
  assert.match(html, /supplier-payment:7/);
  assert.ok(hasTestId(html, 'unresolved-operations-banner-retry'));
  assert.ok(hasTestId(html, 'unresolved-operations-banner-abandon'));
  assert.equal(
    hasTestId(html, 'unresolved-operations-banner-confirm'),
    false,
    'the abandonment must not be a single click',
  );
});

/* ------------------------------------------------------------------ */
/* 2. POS - POST /sales                                                */
/* ------------------------------------------------------------------ */

test('POS: an unresolved sale freezes the checkout and offers the retry', async () => {
  const mod = await load('/src/pages/POS.jsx');
  seedUnresolved('sale', {
    paymentMethod: 'CASH',
    discount: 0,
    items: [{ productId: 1, quantity: 2, unitPrice: 10 }],
  });

  const html = render(React.createElement(mod.default));

  assert.ok(hasTestId(html, 'unresolved-operation-notice'), 'the warning must be visible');
  assert.match(html, /may already have been saved/i);
  assert.ok(hasTestId(html, 'unresolved-operation-retry'), 'the retry must be offered');

  // The checkout cannot be submitted again.
  assert.equal(isDisabled(html, 'pos-checkout'), true, 'the checkout must be disabled');

  // The payload cannot be edited.
  assert.equal(
    isDisabled(html, 'pos-bill-discount'),
    true,
    'the bill discount must be disabled while the sale is unresolved',
  );
});

test('POS: without an unresolved sale the checkout is available', async () => {
  const mod = await load('/src/pages/POS.jsx');
  const html = render(React.createElement(mod.default));

  assert.equal(hasTestId(html, 'unresolved-operation-notice'), false);
  assert.equal(
    isDisabled(html, 'pos-bill-discount'),
    false,
    'the bill discount must be editable when nothing is unresolved',
  );
});

/* ------------------------------------------------------------------ */
/* 3. Purchases - POST /purchases                                      */
/* ------------------------------------------------------------------ */

test('Purchases: an unresolved purchase stays visible with the dialog closed', async () => {
  const mod = await load('/src/pages/Purchases.jsx');
  seedUnresolved('purchase', {
    supplierId: 1,
    items: [{ productId: 1, quantity: 5, unitCost: 8 }],
  });

  const html = render(React.createElement(mod.default));

  assert.ok(
    hasTestId(html, 'unresolved-operations-banner'),
    'the page level warning must be visible while the dialog is closed',
  );
  assert.match(html, /may already have been saved/i);
  assert.ok(hasTestId(html, 'unresolved-operations-banner-retry'));
  assert.ok(hasTestId(html, 'unresolved-operations-banner-abandon'));
});

/* ------------------------------------------------------------------ */
/* 4. Suppliers - POST /suppliers/:id/payment                          */
/* ------------------------------------------------------------------ */

test('Suppliers: an unresolved payment stays visible with the dialog closed', async () => {
  const mod = await load('/src/pages/Suppliers.jsx');
  seedUnresolved('supplier-payment:7', { amount: 15, description: 'cash' }, 7);

  const html = render(React.createElement(mod.default));

  assert.ok(
    hasTestId(html, 'unresolved-operations-banner'),
    'the page level warning must be visible while the dialog is closed',
  );
  assert.match(html, /supplier-payment:7/);
  assert.ok(hasTestId(html, 'unresolved-operations-banner-retry'));
});

/* ------------------------------------------------------------------ */
/* 5. Customers - POST /customers/:id/debt                              */
/* ------------------------------------------------------------------ */

test('Customers: an unresolved debt entry stays visible with the dialog closed', async () => {
  const mod = await load('/src/pages/Customers.jsx');
  seedUnresolved('customer-debt:1', { amount: 75, description: 'stock' }, 1);

  const html = render(React.createElement(mod.default));

  assert.ok(
    hasTestId(html, 'unresolved-operations-banner'),
    'the page level warning must be visible while the dialog is closed',
  );
  assert.match(html, /customer-debt:1/);
  assert.ok(hasTestId(html, 'unresolved-operations-banner-retry'));
});

/* ------------------------------------------------------------------ */
/* 6. Customer ledger - POST /customers/:id/payment and /debt          */
/* ------------------------------------------------------------------ */

test('Customer ledger: an unresolved payment stays visible', async () => {
  const mod = await load('/src/pages/CustomerLedger.jsx');
  seedUnresolved('customer-payment:1', { amount: 20, description: 'cash' }, 1);

  const html = render(
    React.createElement(
      reactRouterDom.MemoryRouter,
      { initialEntries: ['/customers/1'] },
      React.createElement(
        reactRouterDom.Routes,
        null,
        React.createElement(
          reactRouterDom.Route,
          { path: '/customers/:id', element: React.createElement(mod.default) },
        ),
      ),
    ),
  );

  assert.ok(
    hasTestId(html, 'unresolved-operations-banner'),
    'the page level warning must be visible while the dialog is closed',
  );
  assert.match(html, /customer-payment:1/);
  assert.ok(hasTestId(html, 'unresolved-operations-banner-retry'));
});

test('Customer ledger: an unresolved debt entry stays visible', async () => {
  const mod = await load('/src/pages/CustomerLedger.jsx');
  seedUnresolved('customer-debt:1', { amount: 75, description: 'stock' }, 1);

  const html = render(
    React.createElement(
      reactRouterDom.MemoryRouter,
      { initialEntries: ['/customers/1'] },
      React.createElement(
        reactRouterDom.Routes,
        null,
        React.createElement(
          reactRouterDom.Route,
          { path: '/customers/:id', element: React.createElement(mod.default) },
        ),
      ),
    ),
  );

  assert.ok(hasTestId(html, 'unresolved-operations-banner'));
  assert.match(html, /customer-debt:1/);
});
