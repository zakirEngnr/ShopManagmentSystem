// The compatibility of the database the application is about to use.
//
// The application must not silently serve a database it cannot work with.
// Two independent questions are answered:
//
//   * STRUCTURE - are all the tables and columns of prisma/schema.prisma
//     present? If not, the application cannot work and it must not start.
//   * BOOKKEEPING - is the migration history of the database in sync with the
//     migrations of the repository? The D24 audit found a shop database whose
//     schema already carried two migrations that _prisma_migrations did not
//     record; the data is fine, but the history is wrong and every future
//     "prisma migrate deploy" fails.
//
// Migrations are NEVER applied from here. This module only reports.
import fs from 'node:fs';

import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';
import { resolveDatabaseFilePath } from '../utils/databasePath.js';
import {
  inspectDatabaseCompatibility,
  listRepositoryMigrations,
  readSchemaRequirements,
} from '../utils/databaseCompatibility.js';

let lastCheck = null;

/**
 * Check the database the application is configured to use.
 *
 * @returns {Promise<object>} { ok, errors, warnings, structure, history }
 */
export async function checkDatabaseHealth(options = {}) {
  const databaseUrl = options.databaseUrl ?? env.DATABASE_URL;

  let databasePath = null;
  try {
    databasePath = options.databasePath ?? resolveDatabaseFilePath(databaseUrl);
  } catch (err) {
    return {
      ok: false,
      databasePath: null,
      errors: [`The DATABASE_URL cannot be resolved: ${err.message}`],
      warnings: [],
      structure: null,
      history: null,
    };
  }

  if (!fs.existsSync(databasePath)) {
    // A database that does not exist yet is created by the migrations; there
    // is nothing to check.
    const result = {
      ok: true,
      databasePath,
      errors: [],
      warnings: [],
      structure: { compatible: true, missingTables: [], missingColumns: [], extraTables: [] },
      history: { unrecorded: [], failed: [], applied: [] },
      missing: true,
    };
    lastCheck = result;
    return result;
  }

  try {
    const compatibility = await inspectDatabaseCompatibility(databasePath, {
      requirements: options.requirements ?? readSchemaRequirements(),
      repositoryMigrations: options.repositoryMigrations ?? listRepositoryMigrations(),
    });

    const errors = [];
    const warnings = [];

    if (!compatibility.structure.compatible) {
      for (const table of compatibility.structure.missingTables) {
        errors.push(`The table "${table}" is missing from the database.`);
      }
      for (const column of compatibility.structure.missingColumns) {
        errors.push(`The column "${column}" is missing from the database.`);
      }
    }

    if (compatibility.history.unrecorded.length > 0) {
      warnings.push(
        `The migration history of the database is out of sync: `
        + `${compatibility.history.unrecorded.join(', ')} ${compatibility.history.unrecorded.length === 1 ? 'is' : 'are'} `
        + 'not recorded in _prisma_migrations. The schema of the database already contains '
        + 'these changes, but a later "prisma migrate deploy" will fail until the history is '
        + 'repaired with: prisma migrate resolve --applied <migration-name>',
      );
    }

    if (compatibility.history.failed.length > 0) {
      warnings.push(
        `The database has ${compatibility.history.failed.length} failed migration(s): `
        + `${compatibility.history.failed.map((migration) => migration.name).join(', ')}. `
        + 'A migration cannot be applied until the failed one is resolved.',
      );
    }

    const result = {
      ok: errors.length === 0,
      databasePath,
      errors,
      warnings,
      structure: compatibility.structure,
      history: compatibility.history,
      missing: false,
    };
    lastCheck = result;
    return result;
  } catch (err) {
    const result = {
      ok: false,
      databasePath,
      errors: [`The database could not be checked: ${err.message}`],
      warnings: [],
      structure: null,
      history: null,
      missing: false,
    };
    lastCheck = result;
    return result;
  }
}

/**
 * The state of the database for the health endpoint. It never contains a
 * path, a file name or any other detail of the file system.
 */
export function getDatabaseHealthSummary() {
  if (!lastCheck) return { compatible: null, pendingMigrations: 0 };
  return {
    compatible: lastCheck.ok,
    pendingMigrations: lastCheck.history?.unrecorded?.length ?? 0,
  };
}

/**
 * Log the result of a check. A database that cannot be used is reported as an
 * error, a history that is out of sync as a warning.
 */
export function reportDatabaseHealth(health) {
  for (const warning of health.warnings) logger.warn(warning);
  for (const error of health.errors) logger.error(error);
  return health;
}

export default {
  checkDatabaseHealth,
  getDatabaseHealthSummary,
  reportDatabaseHealth,
};
