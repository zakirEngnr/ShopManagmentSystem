// Standalone restore script.
//
//   node scripts/restore-backup.mjs <backup-file> [--allow-older-schema] [--keep N] [--dry-run]
//
// The script is a thin wrapper around src/services/restore.service.js. The
// restore itself is:
//
//   1. the backup is validated on a COPY (integrity, foreign keys, schema) -
//      the live database is never touched by a bad backup;
//   2. the application must not be using the database;
//   3. the live database is closed, checkpointed and copied to a recovery copy
//      next to it, which is verified before anything is replaced;
//   4. the backup is copied to a temporary file next to the live database and
//      verified there;
//   5. the sidecar files (-wal, -shm, -journal) of the OLD database are
//      removed, so they can never be applied to the new one;
//   6. the temporary file is renamed over the live database (atomic);
//   7. the restored database is verified.
//
// Migrations are never applied by this script. A backup that does not have
// every table and column of the current application is refused unless
// --allow-older-schema is given.
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const BACKEND_ROOT = path.resolve(SCRIPT_DIR, '..');

const { resolveDatabaseFilePath, describeDatabaseUrl } = await import(
  path.join(BACKEND_ROOT, 'src', 'utils', 'databasePath.js')
);
const {
  performRestore,
  validateBackupFile,
  RESTORE_OUTCOME,
} = await import(path.join(BACKEND_ROOT, 'src', 'services', 'restore.service.js'));

/** Read the .env file of the backend without logging any value. */
function loadEnv() {
  const vars = {};
  const envPath = path.join(BACKEND_ROOT, '.env');
  if (!fs.existsSync(envPath)) return vars;
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
  return vars;
}

/** True when something is listening on the port of the application. */
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

function parseArgs(argv) {
  const options = {
    backupPath: null,
    allowOlderSchema: false,
    keep: Number(process.env.RESTORE_KEEP ?? 5) || 5,
    dryRun: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--allow-older-schema') options.allowOlderSchema = true;
    else if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--keep') {
      index += 1;
      const value = Number(argv[index]);
      if (Number.isInteger(value) && value >= 1) options.keep = value;
    } else if (!options.backupPath) options.backupPath = arg;
  }
  return options;
}

function printUsage() {
  console.log('Usage: node scripts/restore-backup.mjs <backup-file> [--allow-older-schema] [--keep N] [--dry-run]');
  console.log('');
  console.log('  --allow-older-schema  restore a backup that does not have every table and');
  console.log('                       column of the current application (use with care)');
  console.log('  --keep N              how many recovery copies to keep (default: RESTORE_KEEP or 5)');
  console.log('  --dry-run             only check the backup, change nothing');
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!options.backupPath) {
    printUsage();
    process.exit(1);
  }

  const env = loadEnv();
  // The process environment takes precedence; the .env file is the fallback.
  const port = Number(process.env.PORT || env.PORT || 4000);
  const databaseUrl = process.env.DATABASE_URL || env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('DATABASE_URL is not set in .env or in the environment.');
    process.exit(1);
  }

  let databasePath;
  try {
    databasePath = resolveDatabaseFilePath(databaseUrl);
  } catch (err) {
    console.error(`The DATABASE_URL cannot be used: ${err.message}`);
    process.exit(1);
  }

  const backupPath = path.resolve(options.backupPath);

  console.log(`Database: ${databasePath}`);
  console.log(`Backup:   ${backupPath}`);

  if (options.dryRun) {
    const validation = await validateBackupFile(backupPath, {
      allowOlderSchema: options.allowOlderSchema,
    });
    console.log('');
    console.log(validation.ok ? 'The backup is valid.' : `The backup was REJECTED: ${validation.message}`);
    if (validation.ok && validation.details) {
      console.log(`  tables: ${validation.details.tables}, indexes: ${validation.details.indexes},`);
      console.log(`  recorded migrations: ${validation.details.migrations}`);
      if (validation.details.unrecordedMigrations?.length) {
        console.log(`  not recorded in the migration history: ${validation.details.unrecordedMigrations.join(', ')}`);
      }
    }
    process.exit(validation.ok ? 0 : 1);
  }

  const result = await performRestore({
    backupPath,
    databasePath,
    allowOlderSchema: options.allowOlderSchema,
    keep: options.keep,
    isApplicationRunning: () => isAppRunning(port),
  });

  console.log('');
  for (const step of result.steps) {
    console.log(`  [${step.ok ? 'ok' : 'FAILED'}] ${step.step}: ${step.message}`);
  }
  console.log('');

  if (result.outcome === RESTORE_OUTCOME.RESTORED) {
    console.log('The database was restored and verified.');
    if (result.recoveryCopy) {
      console.log(`The previous database is preserved at: ${result.recoveryCopy}`);
    }
    console.log('');
    console.log('Start the application again. If the application reports a missing migration,');
    console.log('run "prisma migrate deploy" and check the result before using the shop.');
    process.exit(0);
  }

  if (result.outcome === RESTORE_OUTCOME.FAILED) {
    console.error('The restore did not pass its verification.');
    console.error(result.message);
    if (result.recoveryCopy) {
      console.error(`The previous database is preserved at: ${result.recoveryCopy}`);
    }
    process.exit(1);
  }

  console.error('The restore was refused. The live database was NOT changed.');
  console.error(result.message);
  if (result.recoveryCopy) {
    console.error(`A recovery copy of the live database is at: ${result.recoveryCopy}`);
  }
  process.exit(1);
}

main().catch((err) => {
  console.error(`Restore failed: ${err && err.message ? err.message : 'unknown error'}`);
  process.exit(1);
});
