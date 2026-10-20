import jwt from 'jsonwebtoken';
import { randomUUID } from 'node:crypto';
import { prisma } from '../db/prisma.js';
import { env } from '../config/env.js';
import { comparePassword, hashPassword } from '../utils/password.js';
import { logger } from '../utils/logger.js';

export const MAX_FAILED_ATTEMPTS = 5;
export const LOCKOUT_MINUTES = 15;
const JWT_EXPIRES_IN = '8h';

// failedAttempts counts *reserved* attempts: every login that passes the
// pre-checks reserves one slot via an atomic guarded increment BEFORE the
// slow bcrypt compare. The returned value decides the fate of the request:
//   n < MAX  -> this request owns a comparison slot, compare normally;
//   n === MAX -> this request owns the last slot; a wrong password locks;
//   n > MAX  -> over threshold: skip bcrypt, run the lock step, return 423.
// The guards (notLocked) make the DB row -- not the stale in-memory snapshot
// -- the source of truth at every write, so a lock can never be cleared or
// bypassed by a request holding an older snapshot.

const dummyHashPromise = hashPassword(randomUUID());

const PUBLIC_FIELDS = {
  id: true,
  name: true,
  email: true,
  role: true,
  isActive: true,
  lastLoginAt: true,
};

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  err.expose = true;
  return err;
}

function toPublicUser(user) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    isActive: user.isActive,
    lastLoginAt: user.lastLoginAt,
  };
}

function lockError(lockedUntil) {
  const remainingMs = lockedUntil.getTime() - Date.now();
  const remainingMinutes = Math.max(1, Math.ceil(remainingMs / 60000));
  return httpError(423, `Account is locked. Try again in ${remainingMinutes} minute(s).`);
}

// Guard matching "no active lock right now". Used on every write so the DB
// row -- never a stale in-memory snapshot -- decides the outcome.
function notLocked(now) {
  return { OR: [{ lockedUntil: null }, { lockedUntil: { lte: now } }] };
}

// First caller to reach the threshold commits the lock (updateMany count 1);
// concurrent callers get count 0 and stay silent.
async function runLockStep(userId) {
  const lockedUntil = new Date(Date.now() + LOCKOUT_MINUTES * 60 * 1000);
  const res = await prisma.user.updateMany({
    where: { id: userId, failedAttempts: { gte: MAX_FAILED_ATTEMPTS } },
    data: { lockedUntil, failedAttempts: 0 },
  });
  if (res.count === 1) {
    logger.warn(`account locked id=${userId} after ${MAX_FAILED_ATTEMPTS} failed attempts`);
  }
  return lockedUntil;
}

export async function login(email, password) {
  const user = await prisma.user.findUnique({ where: { email } });

  if (!user) {
    await comparePassword(password, await dummyHashPromise);
    throw httpError(401, 'Invalid credentials');
  }

  if (!user.isActive) {
    logger.warn(`login attempt for disabled account id=${user.id}`);
    throw httpError(403, 'Account is disabled');
  }

  // Fast path only: in-flight requests that passed this check before the lock
  // committed are still serialized correctly by the guarded writes below.
  if (user.lockedUntil && user.lockedUntil > new Date()) {
    throw lockError(user.lockedUntil);
  }

  // Reserve an attempt atomically BEFORE the slow bcrypt compare. The
  // returned counter is exact under concurrency (verified 1..20 for 20
  // concurrent callers). A guard miss (P2025) means the row is locked or gone:
  // re-read to tell the two apart.
  let reserved;
  try {
    const now = new Date();
    const updated = await prisma.user.update({
      where: { id: user.id, ...notLocked(now) },
      data: { failedAttempts: { increment: 1 } },
      select: { failedAttempts: true },
    });
    reserved = updated.failedAttempts;
  } catch (err) {
    if (err && err.code === 'P2025') {
      const fresh = await prisma.user.findUnique({ where: { id: user.id } });
      if (!fresh) throw httpError(401, 'Invalid credentials');
      if (fresh.lockedUntil && fresh.lockedUntil > new Date()) throw lockError(fresh.lockedUntil);
      if (!fresh.isActive) throw httpError(403, 'Account is disabled');
      throw httpError(401, 'Invalid credentials');
    }
    throw err;
  }

  // Over threshold: skip bcrypt entirely (I4), run the lock step, return 423.
  if (reserved > MAX_FAILED_ATTEMPTS) {
    const lockedUntil = await runLockStep(user.id);
    throw lockError(lockedUntil);
  }

  const ok = await comparePassword(password, user.password);
  if (!ok) {
    if (reserved === MAX_FAILED_ATTEMPTS) {
      const lockedUntil = await runLockStep(user.id);
      void lockedUntil;
    }
    throw httpError(401, 'Invalid credentials');
  }

  // Guarded success: a lock committed after our reservation wins (P2025 ->
  // 423, no token, lock and counters untouched). Never clears another
  // request's lock.
  let updated;
  try {
    updated = await prisma.user.update({
      where: { id: user.id, ...notLocked(new Date()) },
      data: { failedAttempts: 0, lockedUntil: null, lastLoginAt: new Date() },
      select: { ...PUBLIC_FIELDS, tokenVersion: true },
    });
  } catch (err) {
    if (err && err.code === 'P2025') {
      const fresh = await prisma.user.findUnique({ where: { id: user.id } });
      if (fresh && fresh.lockedUntil && fresh.lockedUntil > new Date()) {
        throw lockError(fresh.lockedUntil);
      }
      if (!fresh) throw httpError(401, 'Invalid credentials');
      if (!fresh.isActive) throw httpError(403, 'Account is disabled');
      throw httpError(401, 'Invalid credentials');
    }
    throw err;
  }

  const token = jwt.sign(
    { userId: updated.id, role: updated.role, tokenVersion: updated.tokenVersion },
    env.JWT_SECRET,
    { expiresIn: JWT_EXPIRES_IN, algorithm: 'HS256' },
  );

  return { token, user: toPublicUser(updated) };
}

export async function revokeUserTokens(userId) {
  return prisma.user.update({
    where: { id: userId },
    data: { tokenVersion: { increment: 1 } },
  });
}

export async function getUserById(id) {
  const user = await prisma.user.findUnique({
    where: { id },
    select: PUBLIC_FIELDS,
  });
  if (!user) {
    throw httpError(404, 'User not found');
  }
  if (!user.isActive) {
    throw httpError(403, 'Account is disabled');
  }
  return toPublicUser(user);
}

export default { login, getUserById, revokeUserTokens };
