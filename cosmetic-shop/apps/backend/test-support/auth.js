// Test auth helper: real DB rows + real HS256 JWTs for integration tests.
// Uses the backend's JWT_SECRET from process.env (set by the caller).
import jwt from 'jsonwebtoken';

export async function createUser(prisma, { role = 'ADMIN', isActive = true, tokenVersion = 0, tag = 't' } = {}) {
  const { hashPassword } = await import('../src/utils/password.js');
  const email = `auth-${tag}-${Date.now()}-${Math.floor(Math.random() * 1e9)}@shop.local`;
  const hash = await hashPassword('TestPass-12345-Long');
  return prisma.user.create({
    data: { name: `Auth ${tag}`, email, password: hash, role, isActive, tokenVersion },
  });
}

export function signToken(user, secret = process.env.JWT_SECRET) {
  return jwt.sign(
    { userId: user.id, role: user.role, tokenVersion: user.tokenVersion ?? 0 },
    secret,
    { algorithm: 'HS256' },
  );
}
