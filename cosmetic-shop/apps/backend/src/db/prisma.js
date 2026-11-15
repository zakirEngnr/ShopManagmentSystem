import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { PrismaLibSql } from '@prisma/adapter-libsql';

const isProd = process.env.NODE_ENV === 'production';
const globalForPrisma = globalThis;

function buildClient(url) {
  const adapter = new PrismaLibSql({ url });
  return new PrismaClient({
    adapter,
    log: isProd ? ['error'] : ['error', 'warn'],
  });
}

let currentUrl = null;
let currentClient = null;

/**
 * Resolve the PrismaClient bound to the current `DATABASE_URL`.
 *
 * The client is rebuilt whenever `DATABASE_URL` changes. This is what makes
 * throwaway per-test databases work: each test suite points `DATABASE_URL` at
 * its own temp SQLite file (via test-support/tempDb.js) before any query runs,
 * and the client follows it. It also prevents cross-test contamination when
 * many test files run in a single `node --test` process, because a stale client
 * bound to a previous suite's (already deleted) temp DB can never be reused.
 *
 * In production `DATABASE_URL` is stable, so this resolves to a single cached
 * client -- identical to the previous behaviour.
 */
function resolveClient() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error('DATABASE_URL is not set. Check apps/backend/.env');
  }
  if (currentClient === null || currentUrl !== url) {
    currentClient = buildClient(url);
    currentUrl = url;
    if (!isProd) {
      globalForPrisma.prisma = currentClient;
    }
  }
  return currentClient;
}

// Live binding: property access resolves the client for the current DATABASE_URL,
// so modules that imported `prisma` before DATABASE_URL was set still end up
// talking to the right (temp) database once it is configured.
export const prisma = new Proxy({}, {
  get(_target, prop) {
    return resolveClient()[prop];
  },
});

export default prisma;
