#!/usr/bin/env node
// Application level checks against a reconciled disposable database.
//
//   node scripts/db-reconcile/app-check.mjs <db-path> [--json]
//
// Verifies that the REAL application (Prisma client + Express API) works
// against the reconciled database:
//   * all 18 schema.prisma models are queryable
//   * the four idempotency columns are selectable
//   * relational reads resolve
//   * the HTTP API answers, including authenticated reads
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { BACKEND_ROOT } from './lib/paths.mjs';

export const MODELS = [
  'user', 'setting', 'counter', 'category', 'brand', 'product', 'supplier',
  'purchase', 'purchaseItem', 'supplierPayment', 'supplierPaymentAllocation',
  'sale', 'saleItem', 'stockAdjust', 'expense', 'customer', 'khataTransaction',
  'paymentAllocation',
];

export const IDEMPOTENCY_COLUMNS = [
  ['sale', 'idempotencyKey'],
  ['purchase', 'idempotencyKey'],
  ['khataTransaction', 'idempotencyKey'],
  ['supplierPayment', 'idempotencyKey'],
];

const AUTHENTICATED_READS = [
  ['GET', '/api/auth/me'],
  ['GET', '/api/products'],
  ['GET', '/api/categories'],
  ['GET', '/api/brands'],
  ['GET', '/api/customers'],
  ['GET', '/api/customers/outstanding'],
  ['GET', '/api/customers/1/ledger'],
  ['GET', '/api/suppliers'],
  ['GET', '/api/purchases'],
  ['GET', '/api/reports/daily'],
  ['GET', '/api/reports/pnl?from=2026-01-01&to=2026-12-31'],
  ['GET', '/api/reports/top-products?from=2026-01-01&to=2026-12-31'],
  ['GET', '/api/reports/low-stock'],
  ['GET', '/api/expenses'],
  ['GET', '/api/stock'],
];

/**
 * Run the application level checks.
 * The caller must set process.env.DATABASE_URL before calling this.
 */
export async function runAppChecks({ uploadDir }) {
  const results = [];
  const check = (name, ok, detail = '') => {
    results.push({ name, ok, detail });
    return ok;
  };

  // Defence in depth: the application modules load .env (which points at the
  // live shop.db). The DATABASE_URL must already point at a disposable file,
  // otherwise this harness could connect to the real database.
  const url = process.env.DATABASE_URL ?? '';
  if (!url.startsWith('file:')) {
    throw new Error(`refusing to run: DATABASE_URL must be a local file (got "${url}")`);
  }
  const resolved = path.resolve(url.replace(/^file:/, ''));
  const tmp = fs.realpathSync(os.tmpdir());
  if (!resolved.startsWith(tmp + path.sep)) {
    throw new Error(`refusing to run: DATABASE_URL (${resolved}) is not inside the temp directory`);
  }
  if (/(^|[\\/])shop\.db([.-].*)?$/i.test(resolved)) {
    throw new Error(`refusing to run: DATABASE_URL (${resolved}) is the development database`);
  }

  const { prisma } = await import(
    pathToFileURL(path.join(BACKEND_ROOT, 'src/db/prisma.js')).href
  );

  // 1. every model is queryable
  let queried = 0;
  for (const model of MODELS) {
    try {
      const rows = await prisma[model].findMany({ take: 1 });
      queried += 1;
      check(`model ${model} queryable`, true, `rows>=${rows.length}`);
    } catch (err) {
      check(`model ${model} queryable`, false, err.message.split('\n')[0]);
    }
  }
  check(`all ${MODELS.length} models queried`, queried === MODELS.length, `${queried}/${MODELS.length}`);

  // 2. the four idempotency columns are usable
  for (const [model, field] of IDEMPOTENCY_COLUMNS) {
    try {
      const rows = await prisma[model].findMany({ take: 3, select: { id: true, [field]: true } });
      check(`${model}.${field} selectable`, true, `${rows.length} rows`);
    } catch (err) {
      check(`${model}.${field} selectable`, false, err.message.split('\n')[0]);
    }
  }

  // 3. representative relational reads
  try {
    const customers = await prisma.customer.findMany({
      include: { transactions: { orderBy: { createdAt: 'asc' } } },
      orderBy: { id: 'asc' },
    });
    const sales = await prisma.sale.findMany({
      include: { items: true, customer: true },
      orderBy: { id: 'asc' },
    });
    const purchases = await prisma.purchase.findMany({
      include: { items: true, supplier: true },
      orderBy: { id: 'asc' },
    });
    const suppliers = await prisma.supplier.findMany({ orderBy: { id: 'asc' } });
    const counters = await prisma.counter.findMany();
    check(
      'relational reads execute (customer->transactions, sale->items/customer, purchase->items/supplier)',
      true,
      `customers=${customers.length} sales=${sales.length} purchases=${purchases.length} suppliers=${suppliers.length} counters=${counters.length}`,
    );
  } catch (err) {
    check('relational reads', false, err.message.split('\n')[0]);
  }

  // 4. HTTP API
  const { createApp } = await import(pathToFileURL(path.join(BACKEND_ROOT, 'src/app.js')).href);
  const app = createApp();
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const port = server.address().port;

  const request = (method, p, token, body) =>
    new Promise((resolve, reject) => {
      const headers = { Accept: 'application/json' };
      if (token) headers.Authorization = `Bearer ${token}`;
      if (body !== undefined) {
        headers['Content-Type'] = 'application/json';
        headers['Content-Length'] = Buffer.byteLength(JSON.stringify(body));
      }
      const req = http.request({ host: '127.0.0.1', port, path: p, method, headers }, (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          let json = null;
          try {
            json = data ? JSON.parse(data) : null;
          } catch {
            json = { _raw: data };
          }
          resolve({ status: res.statusCode, body: json });
        });
      });
      req.on('error', reject);
      if (body !== undefined) req.write(JSON.stringify(body));
      req.end();
    });

  try {
    const health = await request('GET', '/api/health');
    check('GET /api/health', health.status === 200 && health.body?.ok === true, `status=${health.status}`);

    const unauth = await request('GET', '/api/products');
    check(
      'GET /api/products without token is rejected',
      unauth.status === 401,
      `status=${unauth.status}`,
    );

    const login = await request('POST', '/api/auth/login', null, {
      email: 'admin@shop.local',
      password: 'ReconcileTest123!',
    });
    const token = login.body?.data?.token ?? login.body?.token ?? login.body?.data?.accessToken;
    check('POST /api/auth/login', login.status === 200 && Boolean(token), `status=${login.status}`);

    if (token) {
      for (const [method, p] of AUTHENTICATED_READS) {
        const res = await request(method, p, token);
        check(`${method} ${p}`, res.status === 200, `status=${res.status}`);
      }
    }
  } finally {
    server.close();
  }

  return results;
}

// CLI entry point
if (import.meta.url === `file://${process.argv[1]}`) {
  const dbPath = process.argv[2];
  if (!dbPath) {
    console.error('usage: node app-check.mjs <db-path> [--json]');
    process.exit(1);
  }
  process.env.DATABASE_URL = `file:${dbPath}`;
  process.env.UPLOAD_DIR = process.env.UPLOAD_DIR ?? '/tmp/db-reconcile-uploads';
  process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'db-reconcile-app-check-secret-0123456789';
  process.env.NODE_ENV = 'test';
  const results = await runAppChecks({ uploadDir: process.env.UPLOAD_DIR });
  for (const r of results) {
    console.log(`   [${r.ok ? 'PASS' : 'FAIL'}] ${r.name}${r.detail ? ` :: ${r.detail}` : ''}`);
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`   => ${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length === 0 ? 0 : 1);
}
