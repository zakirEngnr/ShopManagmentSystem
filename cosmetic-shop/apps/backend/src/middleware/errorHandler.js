import { logger } from '../utils/logger.js';

export function notFoundHandler(req, res) {
  res.status(404).json({
    ok: false,
    error: { message: `Route not found: ${req.method} ${req.originalUrl}` },
  });
}

export function errorHandler(err, req, res, next) {
  const status = err.status || err.statusCode || 500;
  const isServer = status >= 500;

  if (isServer) {
    logger.error(`${req.method} ${req.originalUrl} ->`, err);
  } else {
    logger.warn(`${req.method} ${req.originalUrl} -> ${status}: ${err.message}`);
  }

  const message = err.expose === true ? err.message : (isServer ? 'Internal server error' : err.message);
  res.status(status).json({ ok: false, error: { message } });
}

export default { notFoundHandler, errorHandler };
