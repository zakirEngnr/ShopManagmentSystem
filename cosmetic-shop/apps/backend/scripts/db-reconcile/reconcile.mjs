#!/usr/bin/env node
// Read-only-first SQLite schema reconciliation tool for cosmetic-shop.
//
//   node scripts/db-reconcile/reconcile.mjs --db <file> [--audit|--plan|--apply] ...
//
// SAFETY MODEL
//   * --db is mandatory. The tool never picks a database and never reads
//     DATABASE_URL to choose a target.
//   * The default mode is --audit: the database is opened read-only and
//     nothing is written.
//   * --apply additionally requires that the target lives inside a disposable
//     root (the OS temp dir by default) AND that --yes-disposable is passed.
//   * The live shop.db and every shop.db backup are refused in every mode.
//   * Migration history is reported, never modified.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  BACKEND_ROOT,
  assertNotProtected,
  defaultDisposableRoots,
  describeFile,
  isDisposable,
  isProtectedPath,
  resolveTargetPath,
} from './lib/paths.mjs';
import { reconcile } from './lib/engine.mjs';
import { renderSummary, writeJsonReport, writeSqlPlan } from './lib/report.mjs';

const USAGE = `
Usage:
  node scripts/db-reconcile/reconcile.mjs --db <sqlite-file> [options]

Modes (mutually exclusive, default: --audit):
  --audit                 read-only inspection; writes the report and the plan only
  --plan                  same as --audit, but states that the plan is executable
  --apply                 EXECUTES the plan (disposable databases only)

Required:
  --db <path>             absolute or relative path of the SQLite file to audit.
                          Never defaults to DATABASE_URL and is never guessed.

Options:
  --out <dir>             directory for the JSON report and the SQL plan
                          (default: <tmp>/db-reconcile-<timestamp>)
  --schema <path>         schema.prisma (default: apps/backend/prisma/schema.prisma)
  --migrations <dir>      migrations directory (default: apps/backend/prisma/migrations)
  --expected-ddl <file>   use a previously generated "prisma migrate diff" DDL file
                          instead of invoking the Prisma CLI
  --disposable-root <dir> additional directory that counts as disposable
                          (default: the OS temp dir)
  --yes-disposable        required with --apply: confirms the target is a throw-away copy
  --json                  print the JSON report to stdout instead of the summary
  --help                  show this help

Exit codes:
  0  success, nothing needs attention
  1  usage / environment error
  2  schema differences found (audit or plan)
  3  the plan was blocked (pre-check failed) or data loss was detected
`;

function parseArgs(argv) {
  const opts = {
    mode: 'audit',
    out: null,
    db: null,
    schema: path.join(BACKEND_ROOT, 'prisma/schema.prisma'),
    migrations: path.join(BACKEND_ROOT, 'prisma/migrations'),
    expectedDdl: null,
    disposableRoots: defaultDisposableRoots(),
    yesDisposable: false,
    json: false,
    help: false,
  };
  const modes = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`missing value for ${arg}`);
      return v;
    };
    switch (arg) {
      case '--db':
        opts.db = next();
        break;
      case '--out':
        opts.out = next();
        break;
      case '--schema':
        opts.schema = next();
        break;
      case '--migrations':
        opts.migrations = next();
        break;
      case '--expected-ddl':
        opts.expectedDdl = next();
        break;
      case '--disposable-root':
        opts.disposableRoots.push(next());
        break;
      case '--yes-disposable':
        opts.yesDisposable = true;
        break;
      case '--audit':
      case '--plan':
      case '--apply':
        modes.push(arg.slice(2));
        break;
      case '--json':
        opts.json = true;
        break;
      case '--help':
      case '-h':
        opts.help = true;
        break;
      default:
        throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (modes.length > 1) throw new Error(`only one mode may be given (got ${modes.join(', ')})`);
  if (modes.length === 1) opts.mode = modes[0];
  return opts;
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`error: ${err.message}\n${USAGE}`);
    return 1;
  }
  if (opts.help) {
    console.log(USAGE);
    return 0;
  }

  // ---- target resolution (never automatic) --------------------------------
  let targetPath;
  try {
    targetPath = resolveTargetPath(opts.db);
  } catch (err) {
    console.error(`error: ${err.message}`);
    return 1;
  }
  if (!fs.existsSync(targetPath)) {
    console.error(`error: database file does not exist: ${targetPath}`);
    return 1;
  }

  const outDir = opts.out
    ? path.resolve(opts.out)
    : path.join(os.tmpdir(), `db-reconcile-${timestamp()}`);
  fs.mkdirSync(outDir, { recursive: true });
  const workDir = path.join(outDir, 'work');
  fs.mkdirSync(workDir, { recursive: true });

  const target = describeFile(targetPath);

  // ---- mode gating --------------------------------------------------------
  let allowWrites = false;
  if (opts.mode === 'apply') {
    if (!opts.yesDisposable) {
      console.error(
        'error: --apply requires --yes-disposable.\n' +
          'The tool only writes to a database you have explicitly declared disposable.',
      );
      return 1;
    }
    const disposable = isDisposable(targetPath, opts.disposableRoots);
    if (!disposable.disposable) {
      console.error(
        `error: refusing to write to ${targetPath}.\n` +
          `It is not inside a disposable root (${opts.disposableRoots.join(', ')}).\n` +
          'Copy the database to a disposable location first.',
      );
      return 1;
    }
    allowWrites = true;
  }

  // ---- resolved target banner ---------------------------------------------
  const protectedCheck = isProtectedPath(targetPath);
  console.log('========================================================================');
  console.log(' SQLite reconciliation - cosmetic-shop');
  console.log('========================================================================');
  console.log(` resolved database path : ${target.path}`);
  console.log(` size / modified        : ${target.sizeBytes} bytes, ${target.modifiedAt}`);
  console.log(` sha256                 : ${target.sha256}`);
  console.log(` mode                   : ${opts.mode}${allowWrites ? ' (writes enabled)' : ' (read-only)'}`);
  console.log(` protected path         : ${protectedCheck.protected ? 'YES' : 'no'}`);
  console.log(` output directory       : ${outDir}`);
  console.log('========================================================================');

  // ---- run ----------------------------------------------------------------
  let result;
  try {
    result = await reconcile({
      dbPath: targetPath,
      mode: opts.mode,
      schemaPath: opts.schema,
      migrationsDir: opts.migrations,
      expectedDdlFile: opts.expectedDdl,
      workDir,
      cliCwd: BACKEND_ROOT,
      backupDir: path.join(outDir, 'backups'),
      allowWrites,
    });
  } catch (err) {
    console.error(`error: ${err.message}`);
    return 1;
  }

  const report = {
    tool: 'cosmetic-shop db-reconcile',
    version: 1,
    generatedAt: new Date().toISOString(),
    mode: opts.mode,
    target,
    database: result.dbMeta,
    expected: {
      source: result.expectedSource,
      tables: result.expectedSpec.tables.length,
      columns: result.expectedSpec.tables.reduce((n, t) => n + t.columns.length, 0),
      uniqueIndexes: result.expectedSpec.tables.reduce(
        (n, t) => n + t.indexes.filter((i) => i.unique).length,
        0,
      ),
      regularIndexes: result.expectedSpec.tables.reduce(
        (n, t) => n + t.indexes.filter((i) => !i.unique).length,
        0,
      ),
      foreignKeys: result.expectedSpec.tables.reduce((n, t) => n + t.fks.length, 0),
      migrationChainTables: result.chainSpec.tables.length,
      migrationChainDelta: result.chainDelta.map((d) => ({
        kind: d.kind,
        table: d.table,
        name: d.name,
        status: d.status,
        details: d.details,
      })),
    },
    classification: {
      before: { counts: result.before.counts, byKind: result.before.byKind },
      after: result.after ? { counts: result.after.counts, byKind: result.after.byKind } : null,
      findings: result.comparison
        .filter((r) => r.status !== 'CORRECT')
        .map((r) => ({
          kind: r.kind,
          table: r.table,
          name: r.name,
          status: r.status,
          details: r.details,
        })),
    },
    plan: result.plan,
    history: result.history,
    data: result.applyResult
      ? {
          tablesCompared: Object.keys(result.applyResult.before ?? {}).length,
          rowCountChanges: (result.applyResult.deltas ?? []).filter(
            (d) => d.kind === 'row-count-changed',
          ).length,
          dataLoss: (result.applyResult.dataLoss ?? []).length,
          deltas: result.applyResult.deltas ?? [],
        }
      : null,
    apply: result.applyResult
      ? {
          log: result.applyResult.log,
          aborted: result.applyResult.state?.aborted ?? false,
          abortReason: result.applyResult.state?.abortReason ?? null,
          backups: result.applyResult.state?.backups ?? [],
        }
      : null,
    output: {
      dir: outDir,
      json: path.join(outDir, 'reconciliation-report.json'),
      sql: path.join(outDir, 'reconciliation-plan.sql'),
    },
  };

  const jsonFile = writeJsonReport(outDir, report);
  const sqlFile = writeSqlPlan(outDir, result.plan, {
    target: target.path,
    history: result.history,
  });
  report.output.json = jsonFile;
  report.output.sql = sqlFile;
  writeJsonReport(outDir, report);

  if (opts.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log('');
    console.log(renderSummary(report));
  }

  if (result.applyResult?.state?.aborted) {
    console.log('');
    console.log('*** RUN ABORTED ***');
    console.log(`reason: ${result.applyResult.state.abortReason}`);
    for (const backup of result.applyResult.state.backups ?? []) {
      console.log(`restore with: cp "${backup}" "${target.path}"`);
    }
    return 3;
  }
  if (
    result.before.counts.MISSING ||
    result.before.counts.MISMATCH ||
    result.before.counts.UNSUPPORTED
  ) {
    return 2;
  }
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(`error: ${err.stack ?? err.message}`);
    process.exit(1);
  });
