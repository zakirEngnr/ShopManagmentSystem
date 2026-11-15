// Structural compatibility between the database and the application schema.
//
// The migration history of a database can be out of sync (the D24 audit found
// a shop database whose schema already carried two migrations that
// _prisma_migrations did not record). The migration bookkeeping therefore
// cannot be the only source of truth: what matters is whether the database
// actually HAS everything the application needs.
//
// Two independent answers are produced:
//   * the structural answer  - are all the tables and columns of
//     prisma/schema.prisma present in the database?
//   * the bookkeeping answer - which migrations of the repository are not
//     recorded in _prisma_migrations?
import fs from 'node:fs';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { PrismaLibSql } from '@prisma/adapter-libsql';

import { BACKEND_ROOT } from './databasePath.js';

export const SCHEMA_PATH = path.join(BACKEND_ROOT, 'prisma', 'schema.prisma');
export const MIGRATIONS_DIR = path.join(BACKEND_ROOT, 'prisma', 'migrations');

const SCALAR_TYPES = new Set([
  'String', 'Int', 'Float', 'Boolean', 'DateTime', 'Json', 'Bytes', 'Decimal', 'BigInt',
]);

/** The migration directories of the repository, in order. */
export function listRepositoryMigrations(migrationsDir = MIGRATIONS_DIR) {
  if (!fs.existsSync(migrationsDir)) return [];
  return fs
    .readdirSync(migrationsDir)
    .filter((name) => fs.existsSync(path.join(migrationsDir, name, 'migration.sql')))
    .sort();
}

/**
 * Parse prisma/schema.prisma into the tables and columns it requires.
 *
 * Only the facts that a SQLite file can be checked against are used: the
 * table name of a model and the names of its scalar fields. Relation fields
 * have no column of their own.
 */
export function parsePrismaSchema(schemaText) {
  const models = [];
  const modelRe = /^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm;
  let match = modelRe.exec(schemaText);
  while (match !== null) {
    const name = match[1];
    const body = match[2];
    const columns = [];
    for (const rawLine of body.split('\n')) {
      const line = rawLine.replace(/\/\/.*$/, '').trim();
      if (!line || line.startsWith('@@')) continue;
      const field = /^(\w+)\s+(\w+)(\[\])?/.exec(line);
      if (!field) continue;
      if (!SCALAR_TYPES.has(field[2])) continue; // a relation, not a column
      columns.push(field[1]);
    }
    models.push({ model: name, table: name, columns });
    match = modelRe.exec(schemaText);
  }
  return models;
}

/** The requirements of the application, read from prisma/schema.prisma. */
export function readSchemaRequirements(schemaPath = SCHEMA_PATH) {
  return parsePrismaSchema(fs.readFileSync(schemaPath, 'utf8'));
}

/** A Prisma client bound to one database file. */
export function clientForFile(filePath) {
  const adapter = new PrismaLibSql({ url: `file:${filePath}` });
  return new PrismaClient({ adapter });
}

/**
 * Read the facts of a database file: its tables, its columns, its indexes and
 * its migration history.
 */
export async function readDatabaseFacts(dbFile) {
  const prisma = clientForFile(dbFile);
  try {
    const tableRows = await prisma.$queryRawUnsafe(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
    );
    const tables = [];
    for (const row of tableRows) {
      const tableName = String(row.name);
      const quoted = `"${tableName.replace(/"/g, '""')}"`;
      let columns = [];
      try {
        columns = await prisma.$queryRawUnsafe(`PRAGMA table_info(${quoted})`);
      } catch {
        columns = [];
      }
      tables.push({
        name: tableName,
        columns: columns.map((column) => ({
          name: String(column.name),
          type: String(column.type ?? ''),
          notNull: Number(column.notnull ?? 0) === 1,
          default: column.dflt_value ?? null,
          primaryKey: Number(column.pk ?? 0) === 1,
        })),
      });
    }

    const indexRows = await prisma.$queryRawUnsafe(
      "SELECT name FROM sqlite_master WHERE type='index' ORDER BY name",
    );

    let migrations = [];
    const hasMigrationTable = tables.some((table) => table.name === '_prisma_migrations');
    if (hasMigrationTable) {
      try {
        const rows = await prisma.$queryRawUnsafe(
          'SELECT migration_name, finished_at, rolled_back_at FROM _prisma_migrations ORDER BY started_at',
        );
        migrations = rows.map((row) => ({
          name: String(row.migration_name),
          finished: row.finished_at !== null && row.finished_at !== undefined,
          rolledBack: row.rolled_back_at !== null && row.rolled_back_at !== undefined,
        }));
      } catch {
        migrations = [];
      }
    }

    return {
      tables,
      tableNames: tables.map((table) => table.name),
      indexNames: indexRows.map((row) => String(row.name)),
      migrations,
    };
  } finally {
    try { await prisma.$disconnect(); } catch { /* the client is already gone */ }
  }
}

/**
 * Compare the requirements of the application with the facts of a database.
 *
 * @returns {object} { compatible, missingTables, missingColumns, extraTables }
 */
export function compareWithSchema(requirements, facts) {
  const missingTables = [];
  const missingColumns = [];

  for (const requirement of requirements) {
    const table = facts.tables.find((candidate) => candidate.name === requirement.table);
    if (!table) {
      missingTables.push(requirement.table);
      continue;
    }
    const present = new Set(table.columns.map((column) => column.name));
    for (const column of requirement.columns) {
      if (!present.has(column)) {
        missingColumns.push(`${requirement.table}.${column}`);
      }
    }
  }

  const required = new Set(requirements.map((requirement) => requirement.table));
  const extraTables = facts.tableNames.filter(
    (name) => !required.has(name) && !name.startsWith('sqlite_') && name !== '_prisma_migrations',
  );

  return {
    compatible: missingTables.length === 0 && missingColumns.length === 0,
    missingTables,
    missingColumns,
    extraTables,
  };
}

/**
 * The migration bookkeeping of a database: which migrations of the repository
 * are not recorded as applied.
 */
export function compareMigrationHistory(facts, repositoryMigrations = listRepositoryMigrations()) {
  const applied = new Set(
    facts.migrations.filter((migration) => migration.finished).map((migration) => migration.name),
  );
  const unrecorded = repositoryMigrations.filter((name) => !applied.has(name));
  const failed = facts.migrations.filter((migration) => !migration.finished && !migration.rolledBack);
  return {
    unrecorded,
    failed,
    applied: [...applied],
  };
}

/**
 * The full compatibility picture of a database file.
 */
export async function inspectDatabaseCompatibility(dbFile, options = {}) {
  const requirements = options.requirements ?? readSchemaRequirements();
  const repositoryMigrations = options.repositoryMigrations ?? listRepositoryMigrations();
  const facts = await readDatabaseFacts(dbFile);
  const structure = compareWithSchema(requirements, facts);
  const history = compareMigrationHistory(facts, repositoryMigrations);
  return { facts, structure, history };
}

export default {
  SCHEMA_PATH,
  MIGRATIONS_DIR,
  listRepositoryMigrations,
  parsePrismaSchema,
  readSchemaRequirements,
  clientForFile,
  readDatabaseFacts,
  compareWithSchema,
  compareMigrationHistory,
  inspectDatabaseCompatibility,
};
