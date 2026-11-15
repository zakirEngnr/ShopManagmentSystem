// A DISPOSABLE backend for the frontend integration tests.
//
// Everything here is throw-away:
//   * the database is built by replaying the migration SQL into a temporary
//     SQLite file with node:sqlite - the development database (shop.db) is
//     never opened, read, written or queried;
//   * the real backend is started as a child process against that database;
//   * the temporary directory is removed when the test file ends.
//
// The real frontend API helpers and the real money-operation controller are
// used, with a real HTTP round trip.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

import axios from 'axios';

const here = path.dirname(fileURLToPath(import.meta.url));
export const frontendDir = path.resolve(here, '..', '..');
export const backendDir = path.resolve(frontendDir, '..', 'backend');

// bcrypt hash of "AuditIntegration!2026", for the throwaway admin of the
// disposable database only.
export const ADMIN_EMAIL = 'audit-integration@shop.local';
export const ADMIN_PASSWORD = 'AuditIntegration!2026';
const ADMIN_HASH = '$2a$10$EtA4OCx0MFTIqLC9F3pH3O4Y7G3qDZtcIm5Gg2daZzOuTI4QT3GAK';

/** Build the disposable database by replaying the migration SQL. */
function buildDisposableDatabase(target) {
  const migrationsDir = path.join(backendDir, 'prisma', 'migrations');
  const names = fs
    .readdirSync(migrationsDir)
    .filter((n) => fs.existsSync(path.join(migrationsDir, n, 'migration.sql')))
    .sort();

  const db = new DatabaseSync(target);
  for (const name of names) {
    db.exec(fs.readFileSync(path.join(migrationsDir, name, 'migration.sql'), 'utf8'));
  }
  return db;
}

/** The reference data every scenario needs. */
function seedReferenceData(db) {
  const now = new Date().toISOString();
  db.exec(
    `INSERT INTO "User" ("name","email","password","role","isActive","failedAttempts","tokenVersion","createdAt","updatedAt")
     VALUES ('Audit Admin','${ADMIN_EMAIL}','${ADMIN_HASH}','ADMIN',1,0,0,'${now}','${now}')`,
  );
  db.exec(`INSERT INTO "Category" ("name","type","createdAt") VALUES ('Cosmetics','COSMETIC','${now}')`);
  db.exec(`INSERT INTO "Brand" ("name","createdAt") VALUES ('Generic','${now}')`);
  db.exec(
    `INSERT INTO "Product" ("sku","barcode","name","type","costPrice","sellPrice","stock","lowStockAt","categoryId","brandId","createdAt","updatedAt")
     VALUES ('AUD-001','1111000000001','Audit Product','COSMETIC',5,10,100,5,1,1,'${now}','${now}')`,
  );
  db.exec(
    `INSERT INTO "Customer" ("name","phone","balance","type","createdAt","updatedAt")
     VALUES ('Audit Customer','03001239999',0,'RETAIL','${now}','${now}')`,
  );
  db.exec(
    `INSERT INTO "Customer" ("name","phone","balance","type","createdAt","updatedAt")
     VALUES ('Audit Business','03001238888',0,'BUSINESS','${now}','${now}')`,
  );
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port: p } = srv.address();
      srv.close(() => resolve(p));
    });
    srv.on('error', reject);
  });
}

async function waitForBackend(url, attempts = 80) {
  for (let i = 0; i < attempts; i += 1) {
    try {
      const res = await fetch(`${url}/api/health`);
      if (res.ok) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

/**
 * Start the disposable backend.
 *
 * @returns {Promise<object>} The handle the tests use.
 */
export async function startDisposableBackend() {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cosmetic-shop-idem-integration-'));
  const dbPath = path.join(workDir, 'audit.db');

  const db = buildDisposableDatabase(dbPath);
  seedReferenceData(db);
  db.close();

  const port = await freePort();
  const backend = spawn('node', [path.join(backendDir, 'src', 'index.js')], {
    cwd: backendDir,
    env: {
      ...process.env,
      DATABASE_URL: `file:${dbPath}`,
      BACKUP_DIR: path.join(workDir, 'backups'),
      UPLOAD_DIR: path.join(workDir, 'uploads'),
      PORT: String(port),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  backend.stdout.resume();
  backend.stderr.resume();

  const base = `http://127.0.0.1:${port}`;
  const healthy = await waitForBackend(base);
  if (!healthy) {
    backend.kill();
    fs.rmSync(workDir, { recursive: true, force: true });
    throw new Error('the disposable backend did not start');
  }

  const login = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
  });
  if (login.status !== 200) {
    backend.kill();
    fs.rmSync(workDir, { recursive: true, force: true });
    throw new Error(`the disposable admin could not log in (${login.status})`);
  }
  const token = (await login.json()).token;

  const row = (sql, ...params) => {
    const reader = new DatabaseSync(dbPath, { readOnly: true });
    try {
      return reader.prepare(sql).get(...params);
    } finally {
      reader.close();
    }
  };

  const rows = (sql, ...params) => {
    const reader = new DatabaseSync(dbPath, { readOnly: true });
    try {
      return reader.prepare(sql).all(...params);
    } finally {
      reader.close();
    }
  };

  /** A plain API call with the Bearer token of the disposable admin. */
  const api = async (method, url, body) => {
    const res = await fetch(`${base}/api${url}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };

  const stop = () => {
    backend.kill();
    fs.rmSync(workDir, { recursive: true, force: true });
  };

  return { base, dbPath, token, row, rows, api, stop };
}

/**
 * Replace the Axios adapter with one that performs the REAL request and then
 * throws a timeout error. The server commits the transaction, the browser
 * never receives the answer - exactly the ambiguous outcome under test.
 */
export function installLosingAdapter(client) {
  const realAdapter = axios.getAdapter(client.defaults.adapter);
  const state = { lose: false };

  client.defaults.adapter = async (config) => {
    const response = await realAdapter(config);
    if (state.lose) {
      const err = new Error('timeout of 15000ms exceeded');
      err.code = 'ECONNABORTED';
      err.config = config;
      throw err;
    }
    return response;
  };

  return state;
}

export default { startDisposableBackend, installLosingAdapter };
