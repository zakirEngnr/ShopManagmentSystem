import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createApp } from './app.js';
import { env } from './config/env.js';
import { logger } from './utils/logger.js';
import { assertLocalDatabase, startBackupScheduler } from './services/backup.service.js';
import { checkDatabaseHealth, reportDatabaseHealth } from './services/databaseHealth.service.js';

/**
 * Create the Express app and bind it to `host`:`port`.
 * Returns the http.Server so callers (including tests) can control the
 * listening socket and close it. Does NOT install process signal handlers;
 * those are only installed by the entrypoint below.
 */
export function startServer({ port = env.PORT, host = env.HOST } = {}) {
  // Backups require a local file database. Fail fast at startup with a clear
  // message instead of silently skipping backups on a remote libSQL DB.
  assertLocalDatabase();

  const app = createApp();
  const server = app.listen(port, host, () => {
    const addr = server.address();
    logger.info(
      `backend listening on http://${addr.address}:${addr.port} (${env.NODE_ENV})`,
    );
  });

  // Automatic backup schedule: immediate check, then every 24 hours (unref'd).
  startBackupScheduler();

  return server;
}

// Only start listening when this file is run directly as the entrypoint.
// Tests import startServer and manage the server themselves.
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  // The database has to be usable before the shop is served. A database that
  // is missing tables or columns is refused; a migration history that is out
  // of sync is reported loudly but does not stop the application.
  const health = await checkDatabaseHealth();
  reportDatabaseHealth(health);
  if (!health.ok) {
    logger.error('The database is not compatible with this version of the application.');
    logger.error('The server was NOT started. Restore a compatible backup, or run the migrations.');
    process.exit(1);
  }

  const server = startServer({ port: env.PORT, host: env.HOST });

  function shutdown(signal) {
    logger.info(`received ${signal}; closing server`);
    server.close(() => {
      process.exit(0);
    });
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}
