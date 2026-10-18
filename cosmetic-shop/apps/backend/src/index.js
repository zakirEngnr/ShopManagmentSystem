import { createApp } from './app.js';
import { env } from './config/env.js';
import { logger } from './utils/logger.js';

const app = createApp();
const port = env.PORT;

const server = app.listen(port, () => {
  logger.info(`backend listening on http://localhost:${port} (${env.NODE_ENV})`);
});

function shutdown(signal) {
  logger.info(`received ${signal}; closing server`);
  server.close(() => {
    process.exit(0);
  });
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
