import jwt from 'jsonwebtoken';
import prisma from '../db/prisma.js';
import { env } from '../config/env.js';

// Tokens issued before the tokenVersion release carry no tokenVersion and
// are rejected (one re-login). role always comes from the DB row.
export async function requireAuth(req, res, next) {
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
  let payload;
  try {
    payload = jwt.verify(token, env.JWT_SECRET, { algorithms: ['HS256'] });
  } catch {
    return res.status(401).json({
      ok: false,
      error: { message: 'Invalid or expired token' },
    });
  }
  if (
    !payload ||
    typeof payload.userId !== 'number' ||
    !Number.isSafeInteger(payload.userId) ||
    payload.userId <= 0 ||
    typeof payload.tokenVersion !== 'number' ||
    !Number.isInteger(payload.tokenVersion) ||
    payload.tokenVersion < 0
  ) {
    return res.status(401).json({
      ok: false,
      error: { message: 'Invalid or expired token' },
    });
  }
  try {
    const user = await prisma.user.findUnique({
      where: { id: payload.userId },
      select: { id: true, role: true, isActive: true, lockedUntil: true, tokenVersion: true },
    });
    if (!user) {
      return res.status(401).json({
        ok: false,
        error: { message: 'Invalid or expired token' },
      });
    }
    if (!user.isActive) {
      return res.status(403).json({
        ok: false,
        error: { message: 'Account is disabled' },
      });
    }
    if (user.tokenVersion !== payload.tokenVersion) {
      return res.status(401).json({
        ok: false,
        error: { message: 'Invalid or expired token' },
      });
    }
    req.user = { userId: user.id, role: user.role };
    return next();
  } catch (err) {
    return next(err);
  }
}

export default { requireAuth };
