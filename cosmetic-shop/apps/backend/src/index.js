import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createApp } from './app.js';
import { env } from './config/env.js';
import { logger } from './utils/logger.js';

/**
 * Create the Express app and bind it to `host`:`port`.
 * Returns the http.Server so callers (including tests) can control the
 * listening socket and close it. Does NOT install process signal handlers;
 * those are only installed by the entrypoint below.
 */
export function startServer({ port = env.PORT, host = env.HOST } = {}) {
  const app = createApp();
  const server = app.listen(port, host, () => {
    const addr = server.address();
    logger.info(
      `backend listening on http://${addr.address}:${addr.port} (${env.NODE_ENV})`,
    );
  });
  return server;
}

// Only start listening when this file is run directly as the entrypoint.
// Tests import startServer and manage the server themselves.
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
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
