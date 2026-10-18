import jwt from 'jsonwebtoken';
import { randomUUID } from 'node:crypto';
import { prisma } from '../db/prisma.js';
import { env } from '../config/env.js';
import { comparePassword, hashPassword } from '../utils/password.js';
import { logger } from '../utils/logger.js';

const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_MINUTES = 15;
const JWT_EXPIRES_IN = '8h';

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

  if (user.lockedUntil && user.lockedUntil > new Date()) {
    const remainingMs = user.lockedUntil.getTime() - Date.now();
    const remainingMinutes = Math.max(1, Math.ceil(remainingMs / 60000));
    throw httpError(
      423,
      `Account is locked. Try again in ${remainingMinutes} minute(s).`,
    );
  }

  const ok = await comparePassword(password, user.password);
  if (!ok) {
    const nextAttempts = (user.failedAttempts || 0) + 1;
    if (nextAttempts >= MAX_FAILED_ATTEMPTS) {
      await prisma.user.update({
        where: { id: user.id },
        data: {
          failedAttempts: 0,
          lockedUntil: new Date(Date.now() + LOCKOUT_MINUTES * 60 * 1000),
        },
      });
      logger.warn(`account locked id=${user.id} after ${MAX_FAILED_ATTEMPTS} failed attempts`);
    } else {
      await prisma.user.update({
        where: { id: user.id },
        data: { failedAttempts: { increment: 1 } },
      });
    }
    throw httpError(401, 'Invalid credentials');
  }

  const updated = await prisma.user.update({
    where: { id: user.id },
    data: { failedAttempts: 0, lockedUntil: null, lastLoginAt: new Date() },
    select: PUBLIC_FIELDS,
  });

  const token = jwt.sign(
    { userId: updated.id, role: updated.role },
    env.JWT_SECRET,
    { expiresIn: JWT_EXPIRES_IN, algorithm: 'HS256' },
  );

  return { token, user: toPublicUser(updated) };
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

export default { login, getUserById };
