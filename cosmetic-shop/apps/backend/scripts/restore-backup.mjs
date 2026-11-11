// Standalone restore script: node scripts/restore-backup.mjs <backup-file>
// Replaces the live shop.db with a verified backup. Refuses to run if the app
// is currently listening (checked via a TCP connect to the configured PORT).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import { PrismaClient } from '@prisma/client';
import { PrismaLibSql } from '@prisma/adapter-libsql';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const BACKEND_ROOT = path.resolve(SCRIPT_DIR, '..');

function loadEnv() {
  const vars = {};
  const envPath = path.join(BACKEND_ROOT, '.env');
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      let val = trimmed.slice(eq + 1).trim();
      if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
      vars[key] = val;
    }
  }
  return vars;
}

const pad = (n) => String(n).padStart(2, '0');
function nowTimestamp() {
  const d = new Date();
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function resolveDbFilePath(databaseUrl) {
  if (!databaseUrl || !databaseUrl.startsWith('file:')) {
    throw new Error('Restore only supports a local file DATABASE_URL');
  }
  return path.resolve(BACKEND_ROOT, databaseUrl.replace(/^file:/, ''));
}

// Returns a promise that resolves true if a TCP connect succeeds (app running),
// false if it is refused / times out.
function isAppRunning(port, timeoutMs = 500) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    let settled = false;
    const onConnect = () => { settled = true; socket.destroy(); resolve(true); };
    const onFail = () => { if (!settled) { settled = true; resolve(false); } };
    const onTimeout = () => { if (!settled) { settled = true; socket.destroy(); resolve(false); } };
    socket.once('connect', onConnect);
    socket.once('error', onFail);
    socket.setTimeout(timeoutMs, onTimeout);
  });
}

async function main() {
  const backupFile = process.argv[2];
  if (!backupFile) {
    console.error('Usage: node scripts/restore-backup.mjs <backup-file>');
    process.exit(1);
  }
  const backupPath = path.resolve(backupFile);
  if (!fs.existsSync(backupPath)) {
    console.error(`Backup file not found: ${backupPath}`);
    process.exit(1);
  }

  const env = loadEnv();
  // Process environment takes precedence (useful in tests); .env is fallback.
  const port = Number(process.env.PORT || env.PORT || 4000);
  const databaseUrl = process.env.DATABASE_URL || env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('DATABASE_URL not set in .env or environment');
    process.exit(1);
  }
  const dbFile = resolveDbFilePath(databaseUrl);

  // Refuse to restore while the app is running.
  if (await isAppRunning(port)) {
    console.error(`Refusing to restore: the app appears to be running on 127.0.0.1:${port}.`);
    console.error('Stop the app first, then re-run this script.');
    process.exit(1);
  }

  // Back up the current database before overwriting it.
  const preRestore = path.join(
    BACKEND_ROOT,
    `shop.db.pre-restore-${nowTimestamp()}`,
  );
  try {
    fs.copyFileSync(dbFile, preRestore);
    console.log(`Current database backed up to: ${preRestore}`);
  } catch (err) {
    console.error(`Failed to back up current database: ${err.message}`);
    process.exit(1);
  }

  // Restore: overwrite shop.db with the verified backup.
  fs.copyFileSync(backupPath, dbFile);
  console.log(`Restored database from: ${backupPath}`);

  // Verify the restored database with PRAGMA integrity_check.
  const adapter = new PrismaLibSql({ url: `file:${dbFile}` });
  const prisma = new PrismaClient({ adapter });
  try {
    const rows = await prisma.$queryRawUnsafe('PRAGMA integrity_check');
    const first = rows[0];
    const result = String(first && (first.integrity_check !== undefined ? first.integrity_check : Object.values(first)[0]));
    console.log(`PRAGMA integrity_check: ${result}`);
    if (result !== 'ok') {
      console.error('Restored database failed integrity check!');
      process.exit(1);
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(`Restore failed: ${err.message}`);
  process.exit(1);
});
