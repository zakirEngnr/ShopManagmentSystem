// SSR render test for the change that is shown after a cash sale.
//
// The component is rendered through Vite (the same transform as the
// production build) with react-dom/server, and the assertions are made on the
// rendered HTML.
//
// The change is derived from the sale the SERVER confirmed, so the rendered
// output is the change the cashier actually has to hand back.
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

function textOf(html, testId) {
  const re = new RegExp('<[^>]*data-testid="' + testId + '"[^>]*>(.*?)</[^>]*>', 's');
  const m = re.exec(html);
  return m ? m[1].trim() : null;
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

test('an exact cash payment shows Rs. 0.00 of change', async () => {
  const mod = await load('/src/components/SaleChangeAmount.jsx');

  const html = renderToStaticMarkup(
    React.createElement(mod.default, { sale: { cashReceived: 10, total: 10 } })
  );

  assert.equal(textOf(html, 'sale-success-change'), 'Rs. 0.00', 'an exact payment must show Rs. 0.00');
});

test('an overpayment shows the correct change', async () => {
  const mod = await load('/src/components/SaleChangeAmount.jsx');

  const html = renderToStaticMarkup(
    React.createElement(mod.default, { sale: { cashReceived: 50, total: 30 } })
  );

  assert.equal(textOf(html, 'sale-success-change'), 'Rs. 20.00');
});

test('a change of one paisa is shown exactly', async () => {
  const mod = await load('/src/components/SaleChangeAmount.jsx');

  const html = renderToStaticMarkup(
    React.createElement(mod.default, { sale: { cashReceived: 10.01, total: 10 } })
  );

  assert.equal(textOf(html, 'sale-success-change'), 'Rs. 0.01');
});

test('a sale that was not paid in cash shows no change at all', async () => {
  const mod = await load('/src/components/SaleChangeAmount.jsx');

  const html = renderToStaticMarkup(
    React.createElement(mod.default, { sale: { cashReceived: null, total: 30 } })
  );

  assert.equal(textOf(html, 'sale-success-change'), null, 'a card sale has no change to show');
  assert.ok(!html.includes('Change'), 'no change row may be rendered');
});
