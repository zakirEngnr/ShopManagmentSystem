// SSR render tests for the purchase detail modal.
//
// Renders the real component through Vite (same transform as the production
// build) with react-dom/server and asserts on the markup.
//
// This is NOT a browser test: there is no click, layout, or event dispatch.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const here = path.dirname(fileURLToPath(import.meta.url));
const frontendDir = path.resolve(here, '..', '..');

let vite;

async function load(modulePath) {
  return vite.ssrLoadModule(modulePath);
}

function hasTestId(html, testId) {
  return html.includes(`data-testid="${testId}"`);
}

before(async () => {
  const { createServer } = await import('vite');
  vite = await createServer({
    root: frontendDir,
    server: { middlewareMode: true },
    appType: 'custom',
    logLevel: 'error',
  });
});

after(async () => {
  if (vite) await vite.close();
});

test('PurchaseDetailModal renders the purchase with supplier and line items', async () => {
  const mod = await load('/src/components/PurchaseDetailModal.jsx');
  const purchase = {
    id: 7,
    supplierId: 3,
    totalAmount: 200,
    paidAmount: 50,
    status: 'PARTIAL',
    idempotencyKey: 'key-123',
    createdAt: '2026-01-15T10:00:00Z',
    supplier: { id: 3, name: 'Audit Supplier', phone: '03001239999' },
    items: [
      { id: 1, purchaseId: 7, productId: 10, quantity: 2, unitCost: 40, total: 80, product: { id: 10, name: 'Soap', sku: 'S-10', barcode: '123' } },
      { id: 2, purchaseId: 7, productId: 11, quantity: 1, unitCost: 120, total: 120, product: { id: 11, name: 'Lotion', sku: 'S-11', barcode: null } },
    ],
  };

  const html = renderToStaticMarkup(
    React.createElement(mod.default, { purchase, loading: false, error: null, onClose: () => {} })
  );

  assert.match(html, /Audit Supplier/);
  assert.match(html, /Soap/);
  assert.match(html, /Lotion/);
  assert.equal(html.includes('S-10'), true);
  assert.equal(html.includes('S-11'), true);
  assert.match(html, /Rs\. 200/);
  assert.match(html, /Rs\. 50/);
  assert.match(html, /Rs\. 150/);
  // Line totals use the historical unitCost / total, not current product prices.
  assert.equal(html.includes('Rs\. 80'), true);
  assert.equal(html.includes('Rs\. 120'), true);
});

test('PurchaseDetailModal shows a loader while loading', async () => {
  const mod = await load('/src/components/PurchaseDetailModal.jsx');
  const html = renderToStaticMarkup(
    React.createElement(mod.default, { purchase: null, loading: true, error: null, onClose: () => {} })
  );
  assert.match(html, /Loading purchase…/);
});

test('PurchaseDetailModal shows an error on failure', async () => {
  const mod = await load('/src/components/PurchaseDetailModal.jsx');
  const html = renderToStaticMarkup(
    React.createElement(mod.default, { purchase: null, loading: false, error: 'Purchase not found', onClose: () => {} })
  );
  assert.match(html, /Unable to load purchase/);
  assert.match(html, /Purchase not found/);
});

test('PurchaseDetailModal renders nothing when there is no purchase', async () => {
  const mod = await load('/src/components/PurchaseDetailModal.jsx');
  const html = renderToStaticMarkup(
    React.createElement(mod.default, { purchase: null, loading: false, error: null, onClose: () => {} })
  );
  assert.equal(html.trim(), '');
});
