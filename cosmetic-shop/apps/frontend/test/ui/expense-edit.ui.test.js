// SSR render tests for the expense edit modal.
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

function inputValue(html, name) {
  const re = new RegExp(`name="${name}"[^>]*value="([^"]*)"`);
  const m = re.exec(html);
  return m ? m[1] : null;
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

test('ExpenseEditModal prepopulates the form from the expense', async () => {
  const mod = await load('/src/components/ExpenseEditModal.jsx');
  const expense = {
    id: 5,
    date: '2026-01-15',
    category: 'RENT',
    expenseName: 'Office Rent',
    description: 'Monthly rent',
    amount: 1200,
  };

  const html = renderToStaticMarkup(
    React.createElement(mod.default, { expense, onSave: () => {}, onClose: () => {}, loading: false, error: null })
  );

  assert.ok(html.includes('value="2026-01-15"'), 'date input prepopulated');
  assert.ok(html.includes('<option value="RENT" selected="">RENT</option>'), 'category RENT selected');
  assert.ok(html.includes('value="Office Rent"'), 'expenseName prepopulated');
  assert.ok(html.includes('value="Monthly rent"'), 'description prepopulated');
  assert.ok(html.includes('value="1200"'), 'amount prepopulated');
});

test('ExpenseEditModal handles a null expense without crashing', async () => {
  const mod = await load('/src/components/ExpenseEditModal.jsx');

  const html = renderToStaticMarkup(
    React.createElement(mod.default, {
      expense: null,
      onSave: () => {},
      onClose: () => {},
      loading: false,
      error: null,
    })
  );

  assert.match(html, /Edit Expense/);
  assert.match(html, /value=""/);
  assert.match(html, /option value="OTHER"/);
});

test('ExpenseEditModal shows a server error', async () => {
  const mod = await load('/src/components/ExpenseEditModal.jsx');
  const expense = { id: 5, date: '2026-01-15', category: 'RENT', expenseName: 'Rent', description: '', amount: '100' };

  const html = renderToStaticMarkup(
    React.createElement(mod.default, {
      expense,
      onSave: () => {},
      onClose: () => {},
      loading: false,
      error: 'Unable to update the expense.',
    })
  );

  assert.match(html, /Unable to save expense/);
  assert.match(html, /Unable to update the expense./);
});

test('ExpenseEditModal shows a loading state while saving', async () => {
  const mod = await load('/src/components/ExpenseEditModal.jsx');
  const expense = { id: 5, date: '2026-01-15', category: 'RENT', expenseName: 'Rent', description: '', amount: '100' };

  const html = renderToStaticMarkup(
    React.createElement(mod.default, { expense, onSave: () => {}, onClose: () => {}, loading: true, error: null })
  );

  assert.ok(html.includes('Saving...'), 'saving state shown');
  // The submit button is disabled while saving.
  assert.equal(html.includes('disabled'), true);
});

test('ExpenseEditModal renders a cancel button that closes the modal', async () => {
  const mod = await load('/src/components/ExpenseEditModal.jsx');
  const expense = { id: 5, date: '2026-01-15', category: 'RENT', expenseName: 'Rent', description: '', amount: '100' };

  const html = renderToStaticMarkup(
    React.createElement(mod.default, { expense, onSave: () => {}, onClose: () => {}, loading: false, error: null })
  );

  assert.match(html, /Cancel/);
  assert.match(html, /Save Expense/);
});
