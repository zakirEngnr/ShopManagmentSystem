// Lockout / failed-login concurrency tests for src/services/auth.service.js.
// Safety: throwaway SQLite file under os.tmpdir() only. Env is set BEFORE any
// src/ module is imported. Never touches the real DB or .env contents.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-lockout-'));
const dbFile = path.join(tmpDir, 'test.db');

function abortIfNotTmpDb(url) {
  const resolved = path.resolve(url.replace(/^file:/, ''));
  const tmp = path.resolve(os.tmpdir());
  if (!resolved.startsWith(tmp + path.sep)) {
    throw new Error('refusing to run: DATABASE_URL is not inside os.tmpdir()');
  }
}

const dbUrl = `file:${dbFile}`;
abortIfNotTmpDb(dbUrl);
process.env.DATABASE_URL = dbUrl;
process.env.JWT_SECRET = 'test-jwt-secret-that-is-long-enough-0123456789';
process.env.NODE_ENV = 'test';

let prisma;
let login;
let getUserById;
let MAX_FAILED_ATTEMPTS = 5;
let LOCKOUT_MINUTES = 15;

const CORRECT = 'CorrectPass-12345';
const WRONG = 'WrongPass-00000';

function statusOf(err) {
  return err && (err.status || err.statusCode);
}

function msgOf(err) {
  return err && err.message ? String(err.message) : '';
}

async function makeUser(tag, overrides = {}) {
  const email = `lockout-${tag}-${Date.now()}-${Math.floor(Math.random() * 1e9)}@shop.local`;
  const { hashPassword } = await import('../src/utils/password.js');
  const hash = await hashPassword(CORRECT);
  const user = await prisma.user.create({
    data: { name: `Lockout ${tag}`, email, password: hash, role: 'ADMIN', isActive: true, ...overrides },
  });
  return user;
}

async function readUser(email) {
  return prisma.user.findUnique({ where: { email } });
}

async function tryLogin(email, password) {
  try {
    const result = await login(email, password);
    return { ok: true, result };
  } catch (err) {
    return { ok: false, status: statusOf(err), message: msgOf(err) };
  }
}

async function cleanupUser(email) {
  await prisma.user.deleteMany({ where: { email } });
}

before(async () => {
  abortIfNotTmpDb(dbUrl);
  if (process.env.DATABASE_URL && process.env.DATABASE_URL !== dbUrl) {
    // Force isolated tmp DB; never allow fallback to the real .env database.
    process.env.DATABASE_URL = dbUrl;
  }
  const backendDir = path.resolve(import.meta.dirname, '..');
  // Platform-compatible Prisma CLI resolution.
  const isWin = process.platform === 'win32';
  const prismaBinPosix = path.join(backendDir, 'node_modules', '.bin', 'prisma');
  const prismaBinWin = path.join(backendDir, 'node_modules', '.bin', 'prisma.cmd');
  let bin = 'prisma';
  if (isWin && fs.existsSync(prismaBinWin)) bin = prismaBinWin;
  else if (!isWin && fs.existsSync(prismaBinPosix)) bin = prismaBinPosix;
  else if (fs.existsSync(prismaBinPosix)) bin = prismaBinPosix;
  // Verify the effective database URL before executing any database command.
  const effectiveUrl = dbUrl;
  abortIfNotTmpDb(effectiveUrl);
  try {
    // Fresh temporary database: no --accept-data-loss needed or allowed.
    execFileSync(bin, ['db', 'push'], {
      cwd: backendDir,
      env: { ...process.env, DATABASE_URL: effectiveUrl },
      stdio: 'pipe',
    });
  } catch (err) {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    throw err;
  }
  const db = await import('../src/db/prisma.js');
  prisma = db.prisma;
  const svc = await import('../src/services/auth.service.js');
  login = svc.login;
  getUserById = svc.getUserById;
  if (typeof svc.MAX_FAILED_ATTEMPTS === 'number') MAX_FAILED_ATTEMPTS = svc.MAX_FAILED_ATTEMPTS;
  if (typeof svc.LOCKOUT_MINUTES === 'number') LOCKOUT_MINUTES = svc.LOCKOUT_MINUTES;
});

after(async () => {
  if (prisma) {
    try { await prisma.$disconnect(); } catch {}
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});
test('T1 sequential: 4 wrong -> 4; 5th wrong -> 401 + locked; 6th correct -> 423', async () => {
  const user = await makeUser('t1');
  try {
    for (let i = 0; i < 4; i++) {
      const r = await tryLogin(user.email, WRONG);
      assert.equal(r.ok, false);
      assert.equal(r.status, 401);
      assert.equal(r.message, 'Invalid credentials');
    }
    let row = await readUser(user.email);
    assert.equal(row.failedAttempts, 4);
    assert.equal(row.lockedUntil, null);
    const fifth = await tryLogin(user.email, WRONG);
    assert.equal(fifth.ok, false);
    assert.equal(fifth.status, 401);
    row = await readUser(user.email);
    assert.ok(row.lockedUntil instanceof Date, 'expected lock after 5th failure');
    const sixth = await tryLogin(user.email, CORRECT);
    assert.equal(sixth.ok, false);
    assert.equal(sixth.status, 423);
  } finally {
    await cleanupUser(user.email);
  }
});
test('T2 I1: N=4 concurrent wrong -> counter 4, not locked, all 401', async () => {
  const user = await makeUser('t2');
  try {
    const results = await Promise.all(Array.from({ length: 4 }, () => tryLogin(user.email, WRONG)));
    for (const r of results) {
      assert.equal(r.ok, false);
      assert.equal(r.status, 401);
      assert.equal(r.message, 'Invalid credentials');
    }
    const row = await readUser(user.email);
    assert.equal(row.failedAttempts, 4);
    assert.equal(row.lockedUntil, null);
  } finally {
    await cleanupUser(user.email);
  }
});
test('T3 I2: N=10 and N=20 concurrent wrong -> locked, no 500s, lockedUntil ~= now+15min', async () => {
  for (const n of [10, 20]) {
    const user = await makeUser(`t3-${n}`);
    try {
      const results = await Promise.all(Array.from({ length: n }, () => tryLogin(user.email, WRONG)));
      for (const r of results) {
        assert.equal(r.ok, false);
        assert.ok(r.status === 401 || r.status === 423, `expected 401/423 got ${r.status}`);
      }
      const row = await readUser(user.email);
      assert.ok(row.lockedUntil instanceof Date, `n=${n}: expected lockedUntil`);
      const expected = Date.now() + LOCKOUT_MINUTES * 60 * 1000;
      assert.ok(Math.abs(row.lockedUntil.getTime() - expected) < 60 * 1000, `n=${n}: lock time off`);
    } finally {
      await cleanupUser(user.email);
    }
  }
});
test('T4 I3 deterministic stale snapshot: correct pw must not clear a committed lock', async () => {
  const user = await makeUser('t4', { failedAttempts: 4 });
  const origFind = prisma.user.findUnique.bind(prisma.user);
  const stale = await origFind({ where: { email: user.email } });
  assert.equal(stale.failedAttempts, 4);
  const lockUntil = new Date(Date.now() + LOCKOUT_MINUTES * 60 * 1000);
  await prisma.user.update({ where: { id: user.id }, data: { failedAttempts: 0, lockedUntil: lockUntil } });
  let calls = 0;
  prisma.user.findUnique = async (...args) => {
    calls += 1;
    if (calls === 1) return stale;
    return origFind(...args);
  };
  try {
    const r = await tryLogin(user.email, CORRECT);
    assert.equal(r.ok, false, 'stale login must not issue token');
    assert.equal(r.status, 423);
    const row = await origFind({ where: { email: user.email } });
    assert.ok(row.lockedUntil instanceof Date, 'lock must survive stale login');
    assert.equal(row.failedAttempts, 0);
  } finally {
    prisma.user.findUnique = origFind;
    await cleanupUser(user.email);
  }
});
test('T5 I3 randomized: [wrong, wrong, correct] x12 from 4 -> zero tokens, ends locked', async () => {
  // From counter=4 every round reserves {5,6,7}: whoever draws 5 compares
  // while the others hit the over-threshold fast-lock path (no bcrypt), so a
  // correct password can never win fairly -- any token proves a stale
  // snapshot bypassed/erased a committed lock.
  const user = await makeUser('t5', { failedAttempts: 4 });
  try {
    let tokens = 0;
    for (let round = 0; round < 12; round++) {
      // Reset safely before EACH round so every round exercises the intended
      // concurrent-login scenario (counter=4, unlocked).
      await prisma.user.update({
        where: { id: user.id },
        data: { failedAttempts: 4, lockedUntil: null },
      });
      const results = await Promise.all([tryLogin(user.email, WRONG), tryLogin(user.email, WRONG), tryLogin(user.email, CORRECT)]);
      for (const r of results) {
        assert.notEqual(r.status, 500);
        assert.ok(r.ok === true || [401, 423].includes(r.status), `unexpected ${r.status}`);
        if (r.ok === true) tokens += 1;
      }
    }
    assert.equal(tokens, 0, `expected zero tokens across 12 rounds, got ${tokens}`);
    const row = await readUser(user.email);
    assert.ok(row.lockedUntil instanceof Date, 'expected lock to hold after 12 rounds');
  } finally {
    await cleanupUser(user.email);
  }
});

test('T6 active lock + correct password -> 423, counters and lock untouched', async () => {
  const lockUntil = new Date(Date.now() + LOCKOUT_MINUTES * 60 * 1000);
  const user = await makeUser('t6', { failedAttempts: 0, lockedUntil: lockUntil });
  try {
    const before = await readUser(user.email);
    const r = await tryLogin(user.email, CORRECT);
    assert.equal(r.ok, false);
    assert.equal(r.status, 423);
    const after = await readUser(user.email);
    assert.equal(after.failedAttempts, before.failedAttempts);
    assert.equal(after.lockedUntil.getTime(), before.lockedUntil.getTime());
  } finally {
    await cleanupUser(user.email);
  }
});
test('T7 expired lock: wrong -> 401 counter 1; correct -> success lock cleared', async () => {
  const past = new Date(Date.now() - 60 * 1000);
  const user = await makeUser('t7', { failedAttempts: 0, lockedUntil: past });
  try {
    const wrong = await tryLogin(user.email, WRONG);
    assert.equal(wrong.ok, false);
    assert.equal(wrong.status, 401);
    let row = await readUser(user.email);
    assert.equal(row.failedAttempts, 1);
    const user2 = await makeUser('t7b', { failedAttempts: 2, lockedUntil: past });
    try {
      const good = await tryLogin(user2.email, CORRECT);
      assert.equal(good.ok, true);
      row = await readUser(user2.email);
      assert.equal(row.failedAttempts, 0);
      assert.equal(row.lockedUntil, null);
      assert.ok(row.lastLoginAt instanceof Date);
    } finally {
      await cleanupUser(user2.email);
    }
  } finally {
    await cleanupUser(user.email);
  }
});
test('T8 success after 3 failures -> counter 0, lastLoginAt set, payload {userId, role}', async () => {
  const user = await makeUser('t8');
  try {
    for (let i = 0; i < 3; i++) {
      const r = await tryLogin(user.email, WRONG);
      assert.equal(r.status, 401);
    }
    const good = await tryLogin(user.email, CORRECT);
    assert.equal(good.ok, true);
    assert.ok(good.result.token);
    assert.equal(good.result.user.email, user.email);
    const row = await readUser(user.email);
    assert.equal(row.failedAttempts, 0);
    assert.ok(row.lastLoginAt instanceof Date);
    const { default: jwt } = await import('jsonwebtoken');
    const payload = jwt.verify(good.result.token, process.env.JWT_SECRET, { algorithms: ['HS256'] });
    assert.equal(payload.userId, user.id);
    assert.equal(payload.role, 'ADMIN');
  } finally {
    await cleanupUser(user.email);
  }
});
test('T9 contract: unknown 401 same body; disabled 403 untouched; no secret leak', async () => {
  const user = await makeUser('t9');
  try {
    const unknown = await tryLogin('nobody-t9-xyz@shop.local', WRONG);
    const wrong = await tryLogin(user.email, WRONG);
    assert.equal(unknown.ok, false);
    assert.equal(unknown.status, 401);
    assert.equal(unknown.message, 'Invalid credentials');
    assert.deepEqual({ ok: unknown.ok, status: unknown.status, message: unknown.message }, { ok: wrong.ok, status: wrong.status, message: wrong.message });
    const dis = await makeUser('t9d', { isActive: false });
    try {
      const before = await readUser(dis.email);
      const r = await tryLogin(dis.email, CORRECT);
      assert.equal(r.ok, false);
      assert.equal(r.status, 403);
      assert.equal(r.message, 'Account is disabled');
      const after = await readUser(dis.email);
      assert.equal(after.failedAttempts, before.failedAttempts);
      assert.equal(String(after.lockedUntil), String(before.lockedUntil));
      assert.ok(!JSON.stringify(r).includes('failedAttempts'));
      assert.ok(!JSON.stringify(r).includes('"password"'));
    } finally {
      await cleanupUser(dis.email);
    }
    const user2 = await makeUser('t9b');
    try {
      const good = await tryLogin(user2.email, CORRECT);
      assert.equal(good.ok, true);
      const out = JSON.stringify(good.result);
      assert.ok(!out.includes('failedAttempts'));
      assert.ok(!out.includes('"password"'));
      assert.ok(!('failedAttempts' in good.result.user));
      assert.ok(!('password' in good.result.user));
    } finally {
      await cleanupUser(user2.email);
    }
  } finally {
    await cleanupUser(user.email);
  }
});
test('T10 I4 reservation gate: N=20 wrong -> locked; comparisons bounded by design', async () => {
  const user = await makeUser('t10');
  // Count bcrypt.compare calls via the actual bcrypt export used by the
  // password utility. Patch reliably and always restore, even on failure.
  const bcryptMod = await import('bcryptjs');
  const bcryptDefault = bcryptMod.default ?? bcryptMod;
  const origCompare = bcryptDefault.compare;
  let compareCalls = 0;
  bcryptDefault.compare = async (...args) => {
    compareCalls += 1;
    return origCompare(...args);
  };
  try {
    const results = await Promise.all(Array.from({ length: 20 }, () => tryLogin(user.email, WRONG)));
    for (const r of results) {
      assert.ok(r.status === 401 || r.status === 423, `expected 401/423 got ${r.status}`);
    }
    const row = await readUser(user.email);
    assert.ok(row.lockedUntil instanceof Date, 'expected lock after 20 concurrent wrong');
    // I4: reservation gate skips bcrypt once over threshold, so no more than
    // five comparisons may occur in this 20-request lockout scenario.
    assert.ok(
      compareCalls <= 5,
      `expected no more than 5 bcrypt.compare calls, got ${compareCalls}`,
    );
  } finally {
    bcryptDefault.compare = origCompare;
    await cleanupUser(user.email);
  }
});
