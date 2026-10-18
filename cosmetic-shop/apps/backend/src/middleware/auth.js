import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';

export function requireAuth(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({
      ok: false,
      error: { message: 'Missing or invalid Authorization header' },
    });
  }
  const token = header.slice('Bearer '.length).trim();
  if (!token) {
    return res.status(401).json({
      ok: false,
      error: { message: 'Missing or invalid Authorization header' },
    });
  }
  try {
    const payload = jwt.verify(token, env.JWT_SECRET, { algorithms: ['HS256'] });
    req.user = payload;
    return next();
  } catch {
    return res.status(401).json({
      ok: false,
      error: { message: 'Invalid or expired token' },
    });
  }
}

export default { requireAuth };
