// Task 1: backend binds to the local machine only (127.0.0.1 by default).
// Imports startServer from src/index.js, listens on port 0, asserts the bound
// address is 127.0.0.1, then closes. No database is touched.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';

// Env must be set BEFORE importing src/modules (env.js requires DATABASE_URL).
// The database lives inside the designated test database directory and is
// validated with the shared guard.
import { TEST_DB_ROOT, assertIsolatedDatabaseUrl, ensureTestDbRoot } from '../test-support/dbGuard.js';

ensureTestDbRoot();
const tmpDir = fs.mkdtempSync(path.join(TEST_DB_ROOT, 'host-bind-'));
process.env.DATABASE_URL = `file:${path.join(tmpDir, 'test.db')}`;
assertIsolatedDatabaseUrl(process.env.DATABASE_URL);
process.env.JWT_SECRET = 'test-jwt-secret-that-is-long-enough-0123456789';
process.env.NODE_ENV = 'test';
process.env.HOST = '127.0.0.1';

const backendDir = path.resolve(import.meta.dirname, '..');
let server;
after(async () => {
  if (server) server.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('startServer binds to 127.0.0.1 (localhost only)', async () => {
  const { startServer } = await import('../src/index.js');
  server = startServer({ port: 0, host: '127.0.0.1' });
  await new Promise((resolve) => server.once('listening', resolve));
  const addr = server.address();
  assert.equal(addr.address, '127.0.0.1');
  assert.ok(Number.isInteger(addr.port) && addr.port > 0);
});
