// Env validation tests: env.js must reject placeholder JWT secrets,
// including the exact placeholder shipped in .env.example (MEDIUM-3).
// Safety: child processes run with cwd inside os.tmpdir() so the real
// apps/backend/.env is never read; DATABASE_URL points at a dummy file
// path (env.js only checks presence, never opens it).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const backendDir = path.resolve(import.meta.dirname, '..');
const envJsUrl = pathToFileURL(path.join(backendDir, 'src', 'config', 'env.js')).href;
const cwd = fs.realpathSync(os.tmpdir());

// The exact JWT_SECRET value from .env.example — if that file changes,
// this test follows it automatically.
function exampleJwtSecret() {
  const text = fs.readFileSync(path.join(backendDir, '.env.example'), 'utf8');
  const m = text.match(/^JWT_SECRET="?([^"\n]+)"?/m);
  assert.ok(m, 'JWT_SECRET line not found in .env.example');
  return m[1];
}

function loadEnv(jwtSecret) {
  return spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import(${JSON.stringify(envJsUrl)}).then(() => console.log('LOADED'));`,
    ],
    {
      cwd,
      encoding: 'utf8',
      timeout: 15000,
      env: {
        ...process.env,
        NODE_ENV: 'test',
        DATABASE_URL: 'file:./env-validation-dummy.db',
        JWT_SECRET: jwtSecret,
      },
    },
  );
}

test('env.js rejects the exact .env.example JWT_SECRET placeholder', () => {
  const secret = exampleJwtSecret();
  const r = loadEnv(secret);
  assert.notEqual(r.status, 0, 'expected non-zero exit, got stdout=' + r.stdout);
  assert.match(r.stderr, /placeholder/, 'stderr should mention placeholder: ' + r.stderr);
});

test('env.js accepts a real 64-hex-char JWT_SECRET', () => {
  const secret = 'a3f1c8d2'.repeat(8); // 64 hex chars, no placeholder substrings
  assert.equal(secret.length, 64);
  const r = loadEnv(secret);
  assert.equal(r.status, 0, 'expected exit 0, stderr=' + r.stderr);
  assert.match(r.stdout, /LOADED/);
});
