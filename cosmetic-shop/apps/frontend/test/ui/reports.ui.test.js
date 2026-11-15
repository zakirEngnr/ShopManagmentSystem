// SSR render tests for the Reports page P&L statement.
//
// Renders the real page component through Vite (same transform as the production
// build) with react-dom/server and asserts on the markup.
//
// This is NOT a browser test: there is no click, layout, or event dispatch.
// Assertions are made on the rendered HTML: which labels appear in the
// P&L statement.
//
// PHASE 4D: The Discounts KPI measures bill-level discounts only
// (Sale.discount). Negotiated item prices (SaleItem.unitPrice < Product.sellPrice)
// are NOT discounts and are not counted. The P&L label must reflect this.
//
// Test E (frontend label): P&L displays "Bill Discounts", not "Discounts".

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

test('P&L statement displays "Bill Discounts" label (not "Discounts")', async () => {
  const mod = await load('/src/pages/Reports.jsx');

  const html = renderToStaticMarkup(
    React.createElement(mod.default)
  );

  // The label must say "Bill Discounts" to accurately reflect that only
  // bill-level discounts (Sale.discount) are counted.
  assert.ok(html.includes('Bill Discounts'), 'P&L must show "Bill Discounts" label');
  // The old misleading label must not appear.
  assert.ok(!html.includes('>Discounts<'), 'P&L must not show the misleading "Discounts" label');
});