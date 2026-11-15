// Test bootstrap - runs in every test file BEFORE any other module.
//
// It is loaded through `node --test --import ./test-support/guard-bootstrap.mjs`
// and guarantees that no test process can end up talking to the development
// database:
//
//   * DATABASE_URL is validated before anything else is imported
//   * an unsafe DATABASE_URL (shop.db, a backup, a WAL file, anything outside
//     the designated test directory) aborts the process immediately
//   * a MISSING DATABASE_URL is replaced by an isolated, empty database inside
//     the designated directory - never by the development database
//
// Every resolved URL is appended to an audit log so a test can prove that no
// test process ever pointed at the development database.
import fs from 'node:fs';
import path from 'node:path';
import {
  TEST_DB_ROOT,
  assertIsolatedDatabaseUrl,
  ensureTestDbRoot,
  makeIsolatedDbPath,
} from './dbGuard.js';

function audit(line) {
  try {
    fs.appendFileSync(path.join(TEST_DB_ROOT, 'db-url-audit.log'), `${line}\n`);
  } catch {
    /* auditing must never break a test run */
  }
}

function abort(message) {
  process.stderr.write(`\n[db-guard] ${message}\n\n`);
  audit(`REJECTED ${process.env.DATABASE_URL ?? '(unset)'} :: ${String(message).split('\n')[0]}`);
  process.exit(1);
}

ensureTestDbRoot();

const raw = process.env.DATABASE_URL;

if (raw === undefined || raw === null || String(raw).trim() === '') {
  // No database was selected yet: install an isolated, empty one so that a
  // module that reads DATABASE_URL at import time (env.js does) can never
  // pick up the development database from apps/backend/.env.
  const fallback = makeIsolatedDbPath('fallback-');
  process.env.DATABASE_URL = `file:${fallback}`;
  process.stderr.write(
    `[db-guard] DATABASE_URL was not set - using an isolated database at ${fallback}\n`,
  );
  audit(`FALLBACK ${fallback}`);
} else {
  try {
    assertIsolatedDatabaseUrl(raw);
  } catch (err) {
    abort(err.message);
  }
  audit(`ACCEPTED ${assertIsolatedDatabaseUrl(raw)}`);
}
