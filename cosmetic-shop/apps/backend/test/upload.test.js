// Product image upload tests (HTTP + DB + filesystem).
// Isolated temp DB + isolated temp upload dir only, via test-support/tempDb.js.
// Pure validator rules live in test/upload-validator.test.js.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import http from 'node:http';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { createTempDb } from '../test-support/tempDb.js';
import { createUser, signToken } from '../test-support/auth.js';
import { IMAGE_NAME_RE } from '../src/middleware/upload.js';
import {
  TWO_MB, sha256, buildPng, badPng, buildJpeg, buildJpegOfSize, buildWebP,
  badJpeg, GIF_BYTES, SVG_BYTES, HTML_BYTES, buildMultipart, imageFilePart,
} from '../test-support/imageFixtures.js';

const backendDir = path.resolve(import.meta.dirname, '..');
const backendUrl = pathToFileURL(backendDir + path.sep).href;
const IS_WIN = process.platform === 'win32';

// Env must be complete BEFORE any src/ module that reads it is imported.
process.env.JWT_SECRET = 'test-jwt-secret-that-is-long-enough-012345678';
process.env.NODE_ENV = 'test';
const ctx = await createTempDb({ prefix: 'upload-', backendDir }); // sets DATABASE_URL + UPLOAD_DIR
const { tmpDir, dbUrl, uploadDir } = ctx;

let prisma;
let server;
let port;
let token;
let categoryId;

// ---------- helpers ----------
function request(method, requestPath, { token: tok, body, contentType } = {}) {
  return new Promise((resolve, reject) => {
    const headers = { Accept: 'application/json', Connection: 'close' };
    if (body !== undefined && body !== null) {
      headers['Content-Type'] = contentType ?? 'application/json';
      headers['Content-Length'] = Buffer.byteLength(body);
    }
    if (tok) headers.Authorization = 'Bearer ' + tok;
    const req = http.request({ host: '127.0.0.1', port, path: requestPath, method, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buffer = Buffer.concat(chunks);
        const raw = buffer.toString('utf8');
        let json = null;
        try { json = raw ? JSON.parse(raw) : null; } catch { json = { _raw: raw }; }
        resolve({ status: res.statusCode, headers: res.headers, body: json, raw, buffer });
      });
    });
    req.on('error', reject);
    if (body !== undefined && body !== null) req.write(body);
    req.end();
  });
}

const NO_TOKEN = Symbol('no-token');
function upload(id, buffer, { filename = 'image.png', contentType = 'image/png', tok = NO_TOKEN } = {}) {
  const mp = buildMultipart([imageFilePart(buffer, { filename, contentType })]);
  return request('POST', `/api/products/${id}/image`, {
    token: tok === NO_TOKEN ? token : tok, body: mp.buffer, contentType: mp.contentType,
  });
}
function postMultipart(id, parts) {
  const mp = buildMultipart(parts);
  return request('POST', `/api/products/${id}/image`, { token, body: mp.buffer, contentType: mp.contentType });
}

const nameOf = (res) => res.body.product.imageUrl.replace(/^\/uploads\//, '');
const dirFiles = () => fs.readdirSync(uploadDir).sort();
const imageUrlOf = async (id) => (await prisma.product.findUnique({ where: { id } }))?.imageUrl ?? null;

function clearUploadDir() {
  for (const f of fs.readdirSync(uploadDir)) fs.rmSync(path.join(uploadDir, f), { recursive: true, force: true });
}

async function makeProduct(over = {}) {
  return prisma.product.create({
    data: {
      sku: 'UP-' + crypto.randomBytes(4).toString('hex'), name: 'Upload Product', type: 'COSMETIC',
      costPrice: 10, sellPrice: 15, categoryId, ...over,
    },
  });
}

/** Core helper: a rejected request leaves no file (no .tmp) and the DB row untouched. */
async function assertRejected(res, status, id, { filesBefore = [], urlBefore = null } = {}) {
  assert.equal(res.status, status, JSON.stringify(res.body));
  assert.deepEqual(dirFiles(), [...filesBefore].sort(), 'upload dir changed');
  if (id !== undefined) assert.equal(await imageUrlOf(id), urlBefore, 'imageUrl changed');
}

/** Upload expecting rejection; snapshots before/after. */
async function expectUploadRejected(buffer, status, opts) {
  const prod = await makeProduct();
  const res = await upload(prod.id, buffer, opts);
  await assertRejected(res, status, prod.id);
  return res;
}

// ---------- lifecycle ----------
before(async () => {
  const db = await import(backendUrl + 'src/db/prisma.js');
  prisma = db.prisma;
  assert.equal(process.env.DATABASE_URL, dbUrl);
  const { createApp } = await import(backendUrl + 'src/app.js');
  const app = createApp();
  server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  port = server.address().port;

  token = signToken(await createUser(prisma, { role: 'ADMIN', tag: 'upload-admin' }));
  categoryId = (await prisma.category.create({ data: { name: 'UploadCat', type: 'COSMETIC' } })).id;
});

after(async () => {
  if (server) await new Promise((r) => server.close(r));
  if (prisma) await prisma.$disconnect();
  ctx.cleanup();
});

beforeEach(() => clearUploadDir());

// ---------- 1-6: accepted uploads ----------
test('1 valid PNG -> 200, UUID name, bytes equal; modes 0600/0700 on POSIX', async () => {
  const prod = await makeProduct();
  const png = buildPng();
  const res = await upload(prod.id, png);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.ok, true);
  const name = nameOf(res);
  assert.ok(IMAGE_NAME_RE.test(name), name);
  assert.equal(sha256(fs.readFileSync(path.join(uploadDir, name))), sha256(png));
  if (!IS_WIN) {
    assert.equal(fs.statSync(path.join(uploadDir, name)).mode & 0o777, 0o600);
    assert.equal(fs.statSync(uploadDir).mode & 0o777, 0o700);
  }
  assert.deepEqual(dirFiles(), [name]);
  assert.equal(await imageUrlOf(prod.id), '/uploads/' + name);
});

test('2 valid JPEG -> .jpg', async () => {
  const prod = await makeProduct();
  const res = await upload(prod.id, buildJpeg(), { filename: 'photo.jpg', contentType: 'image/jpeg' });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.ok(nameOf(res).endsWith('.jpg'));
});

test('3 valid WebP -> .webp', async () => {
  const prod = await makeProduct();
  const res = await upload(prod.id, buildWebP(), { filename: 'pic.webp', contentType: 'image/webp' });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.ok(nameOf(res).endsWith('.webp'));
});

test('4 declared image/gif + PNG bytes -> stored .png (bytes decide)', async () => {
  const prod = await makeProduct();
  const res = await upload(prod.id, buildPng(), { filename: 'x.gif', contentType: 'image/gif' });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.ok(nameOf(res).endsWith('.png'));
});

test('5 .png filename + JPEG bytes -> stored .jpg', async () => {
  const prod = await makeProduct();
  const res = await upload(prod.id, buildJpeg(), { filename: 'x.png', contentType: 'image/png' });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.ok(nameOf(res).endsWith('.jpg'));
});

test("6 filename '../../etc/passwd' -> UUID name, nothing escapes the upload dir", async () => {
  const prod = await makeProduct();
  const parent = path.dirname(uploadDir);
  const parentBefore = fs.readdirSync(parent).sort();
  const res = await upload(prod.id, buildPng(), { filename: '../../etc/passwd' });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const name = nameOf(res);
  assert.ok(IMAGE_NAME_RE.test(name));
  assert.deepEqual(dirFiles(), [name]);
  assert.deepEqual(fs.readdirSync(parent).sort(), parentBefore);
});

// ---------- 7-14: rejected content ----------
test('7 GIF bytes -> 400', () => expectUploadRejected(GIF_BYTES, 400));
test('8 SVG bytes -> 400', () => expectUploadRejected(SVG_BYTES, 400));
test('9 HTML bytes named .png -> 400', () => expectUploadRejected(HTML_BYTES, 400, { filename: 'x.png' }));
test('10 0-byte file -> 400', () => expectUploadRejected(Buffer.alloc(0), 400));
test('11 11-byte file -> 400', () => expectUploadRejected(Buffer.alloc(11), 400));
test('12 truncated PNG (no IEND) -> 400', () => expectUploadRejected(badPng.noIend(), 400));
test('13 JPEG with trailing byte after EOI -> 400', () => expectUploadRejected(badJpeg.trailingByte(), 400, { filename: 'x.jpg' }));

test('14 exactly 2 MB -> 200; 2 MB + 1 -> 413 with fixed message', async () => {
  const prod = await makeProduct();
  const ok = await upload(prod.id, buildJpegOfSize(TWO_MB), { filename: 'x.jpg' });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  const stored = nameOf(ok);
  assert.equal(fs.statSync(path.join(uploadDir, stored)).size, TWO_MB);

  const prod2 = await makeProduct();
  const before = dirFiles();
  const big = await upload(prod2.id, buildJpegOfSize(TWO_MB + 1), { filename: 'x.jpg' });
  await assertRejected(big, 413, prod2.id, { filesBefore: before });
  assert.equal(big.body.error.message, 'Image exceeds 2 MB limit');
});

// ---------- 15-22: request shape ----------
test('15 no file part -> 400', async () => {
  const prod = await makeProduct();
  assert.equal((await postMultipart(prod.id, [])).status, 400);
  await assertRejected({ status: 400 }, 400, prod.id);
});

test('16 JSON content-type -> 400', async () => {
  const prod = await makeProduct();
  const res = await request('POST', `/api/products/${prod.id}/image`, { token, body: '{}' });
  await assertRejected(res, 400, prod.id);
});

test('17 field named `file` instead of `image` -> 400', async () => {
  const prod = await makeProduct();
  const res = await postMultipart(prod.id, [imageFilePart(buildPng(), { name: 'file' })]);
  await assertRejected(res, 400, prod.id);
});

test('18 two files -> 400', async () => {
  const prod = await makeProduct();
  const res = await postMultipart(prod.id, [imageFilePart(buildPng()), imageFilePart(buildPng())]);
  await assertRejected(res, 400, prod.id);
});

test('19 extra text field -> 400', async () => {
  const prod = await makeProduct();
  const res = await postMultipart(prod.id, [imageFilePart(buildPng()), { name: 'title', value: 'hello' }]);
  await assertRejected(res, 400, prod.id);
});

test('20 malformed multipart body -> 400 (never 500), no path leak', async () => {
  const prod = await makeProduct();
  const res = await request('POST', `/api/products/${prod.id}/image`, {
    token, body: 'this is definitely not multipart', contentType: 'multipart/form-data; boundary=----xyz',
  });
  await assertRejected(res, 400, prod.id);
  assert.ok(!res.raw.includes(tmpDir));
});

test('21 missing boundary -> 400 (never 500)', async () => {
  const prod = await makeProduct();
  const res = await request('POST', `/api/products/${prod.id}/image`, {
    token, body: '--x\r\nContent-Disposition: form-data; name="image"; filename="a.png"\r\n\r\nPNG',
    contentType: 'multipart/form-data',
  });
  await assertRejected(res, 400, prod.id);
});

test('22 aborted request mid-body -> no side effects, server keeps serving', async () => {
  const prod = await makeProduct();
  const mp = buildMultipart([imageFilePart(buildPng())]);
  await new Promise((resolve) => {
    const sock = net.connect(port, '127.0.0.1', () => {
      sock.write(
        `POST /api/products/${prod.id}/image HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer ${token}\r\n` +
        `Content-Type: ${mp.contentType}\r\nContent-Length: ${mp.buffer.length}\r\n\r\n`,
      );
      sock.write(mp.buffer.subarray(0, Math.floor(mp.buffer.length / 2)));
      setTimeout(() => sock.destroy(), 50);
    });
    sock.on('error', () => {});
    sock.on('close', resolve);
  });
  await new Promise((r) => setTimeout(r, 100)); // let the server observe the abort
  assert.deepEqual(dirFiles(), []);
  assert.equal(await imageUrlOf(prod.id), null);
  assert.equal((await request('GET', '/api/health')).status, 200);
});

// ---------- 23-26: auth / ids / existence ----------
test('23 no token -> 401, no file', async () => {
  const prod = await makeProduct();
  await assertRejected(await upload(prod.id, buildPng(), { tok: null }), 401, prod.id);
});

test('24 invalid token -> 401, no file', async () => {
  const prod = await makeProduct();
  await assertRejected(await upload(prod.id, buildPng(), { tok: 'invalid.token.value' }), 401, prod.id);
});

test('25 invalid ids -> 400 before upload parsing, no file', async () => {
  for (const badId of ['abc', '0', '-1', '1e3', '0x10', '9007199254740993']) {
    const res = await request('POST', `/api/products/${badId}/image`, {
      token, body: 'not multipart at all', contentType: 'multipart/form-data; boundary=----x',
    });
    await assertRejected(res, 400, undefined);
  }
});

test('26 nonexistent product -> 404, no file', async () => {
  await assertRejected(await upload(999999, buildPng()), 404, undefined);
});

// ---------- 27-33: replacement, failures, delete, schema ----------
test('27 replacement: old file gone, new present, imageUrl updated', async () => {
  const prod = await makeProduct();
  const first = await upload(prod.id, buildPng({ w: 2, h: 2 }));
  const oldName = nameOf(first);
  const second = await upload(prod.id, buildJpeg(), { filename: 'b.jpg', contentType: 'image/jpeg' });
  const newName = nameOf(second);
  assert.notEqual(newName, oldName);
  assert.deepEqual(dirFiles(), [newName]);
  assert.equal(await imageUrlOf(prod.id), '/uploads/' + newName);
});

test('28 replacement DB failure -> new file removed, OLD kept, URL unchanged, 500 generic', async () => {
  const prod = await makeProduct();
  const oldName = nameOf(await upload(prod.id, buildPng()));
  const orig = prisma.product.updateMany;
  prisma.product.updateMany = async () => { throw new Error(`db boom ${tmpDir}`); };
  try {
    const res = await upload(prod.id, buildJpeg(), { filename: 'b.jpg' });
    assert.equal(res.status, 500);
    assert.equal(res.body.error.message, 'Internal server error');
    assert.ok(!res.raw.includes(tmpDir));
  } finally {
    prisma.product.updateMany = orig;
  }
  assert.deepEqual(dirFiles(), [oldName]);
  assert.equal(await imageUrlOf(prod.id), '/uploads/' + oldName);
});

test('29 disk failure (UPLOAD_DIR is a file) -> 500 generic, no DB change', async () => {
  const prod = await makeProduct();
  fs.rmSync(uploadDir, { recursive: true, force: true });
  fs.writeFileSync(uploadDir, 'blocker');
  try {
    const res = await upload(prod.id, buildPng());
    assert.equal(res.status, 500);
    assert.equal(res.body.error.message, 'Internal server error');
    assert.ok(!res.raw.includes(tmpDir));
    assert.equal(await imageUrlOf(prod.id), null);
  } finally {
    fs.rmSync(uploadDir, { force: true });
    fs.mkdirSync(uploadDir, { recursive: true, mode: 0o700 });
  }
});

test('30 six concurrent uploads -> 200/409 only, exactly one file, equals DB value', async () => {
  const prod = await makeProduct();
  const results = await Promise.all(Array.from({ length: 6 }, () => upload(prod.id, buildPng())));
  for (const r of results) assert.ok(r.status === 200 || r.status === 409, `unexpected ${r.status}`);
  assert.ok(results.some((r) => r.status === 200));
  const files = dirFiles();
  assert.equal(files.length, 1, files.join(','));
  assert.ok(!files.some((f) => f.endsWith('.tmp')));
  assert.equal(await imageUrlOf(prod.id), '/uploads/' + files[0]);
});

test('31 product delete -> image file removed', async () => {
  const prod = await makeProduct();
  const name = nameOf(await upload(prod.id, buildPng()));
  assert.ok(fs.existsSync(path.join(uploadDir, name)));
  const del = await request('DELETE', `/api/products/${prod.id}`, { token });
  assert.equal(del.status, 200, JSON.stringify(del.body));
  assert.deepEqual(dirFiles(), []);
});

test('32 delete rejected with 409 (sale reference) -> image file kept', async () => {
  const prod = await makeProduct();
  const name = nameOf(await upload(prod.id, buildPng()));
  const sale = await prisma.sale.create({
    data: {
      invoiceNo: 'INV-' + crypto.randomBytes(4).toString('hex'), subtotal: 5, total: 5, paymentMethod: 'CASH',
      items: { create: [{ productId: prod.id, quantity: 1, unitPrice: 5, total: 5 }] },
    },
  });
  try {
    const del = await request('DELETE', `/api/products/${prod.id}`, { token });
    assert.equal(del.status, 409, JSON.stringify(del.body));
    assert.deepEqual(dirFiles(), [name]);
    assert.equal(await imageUrlOf(prod.id), '/uploads/' + name);
  } finally {
    await prisma.sale.delete({ where: { id: sale.id } });
  }
});

test('33 PUT and POST product with imageUrl in JSON -> 400 (strict schema)', async () => {
  const prod = await makeProduct();
  const put = await request('PUT', `/api/products/${prod.id}`, { token, body: JSON.stringify({ imageUrl: '/uploads/evil.png' }) });
  assert.equal(put.status, 400);
  const post = await request('POST', '/api/products', {
    token,
    body: JSON.stringify({ sku: 'NOIMG-' + crypto.randomBytes(3).toString('hex'), name: 'X', type: 'COSMETIC', costPrice: 1, sellPrice: 2, categoryId, imageUrl: '/uploads/evil.png' }),
  });
  assert.equal(post.status, 400);
  assert.equal(await imageUrlOf(prod.id), null);
});

// 34 (validateImageBuffer rules) lives in test/upload-validator.test.js.

// ---------- 35-44: static serving ----------
test('35 GET and HEAD of each stored format -> 200, exact bytes, restrictive headers', async () => {
  const cases = [
    [buildPng({ w: 3, h: 3 }), 'image/png', 'x.png', 'image/png'],
    [buildJpeg(), 'image/jpeg', 'x.jpg', 'image/jpeg'],
    [buildWebP(), 'image/webp', 'x.webp', 'image/webp'],
  ];
  for (const [buf, type, filename, contentType] of cases) {
    const prod = await makeProduct();
    const name = nameOf(await upload(prod.id, buf, { filename, contentType }));
    for (const method of ['GET', 'HEAD']) {
      const res = await request(method, '/uploads/' + name);
      assert.equal(res.status, 200, `${method} ${name}`);
      assert.equal(res.headers['content-type'], type);
      assert.equal(res.headers['cross-origin-resource-policy'], 'cross-origin');
      assert.equal(res.headers['x-content-type-options'], 'nosniff');
      assert.equal(res.headers['content-security-policy'], "default-src 'none'; sandbox");
      assert.equal(res.headers['cache-control'], 'public, max-age=31536000, immutable');
      if (method === 'GET') assert.equal(sha256(res.buffer), sha256(buf));
    }
  }
});

const NOT_FOUND = { ok: false, error: { message: 'Not found' } };

test('36 GET missing (well-formed) uuid file -> 404 fixed body', async () => {
  const res = await request('GET', `/uploads/${crypto.randomUUID()}.png`);
  assert.equal(res.status, 404);
  assert.deepEqual(res.body, NOT_FOUND);
});

test('37 GET /uploads/ -> 404', async () => {
  const res = await request('GET', '/uploads/');
  assert.equal(res.status, 404);
  assert.deepEqual(res.body, NOT_FOUND);
});

test('38 GET /uploads/.hidden -> 404', async () => {
  const res = await request('GET', '/uploads/.hidden');
  assert.equal(res.status, 404);
  assert.deepEqual(res.body, NOT_FOUND);
});

test('39 encoded traversal -> 404 fixed body', async () => {
  for (const p of ['/uploads/%2e%2e%2f%2e%2e%2fetc/passwd', '/uploads/..%2f..%2fetc/passwd', '/uploads/%2e%2e/', '/uploads/..']) {
    const res = await request('GET', p);
    assert.equal(res.status, 404, p);
    assert.deepEqual(res.body, NOT_FOUND, p);
  }
});

test('40 planted secret.txt / .env / <uuid>.png.tmp -> 404, no leak of paths, errors or contents', async () => {
  const prod = await makeProduct();
  const name = nameOf(await upload(prod.id, buildPng()));
  fs.writeFileSync(path.join(uploadDir, 'secret.txt'), 'TOP-SECRET-CONTENT');
  fs.writeFileSync(path.join(uploadDir, '.env'), 'SECRET=TOP-SECRET-CONTENT');
  fs.writeFileSync(path.join(uploadDir, name + '.tmp'), 'TOP-SECRET-CONTENT');
  for (const p of ['/uploads/secret.txt', '/uploads/.env', `/uploads/${name}.tmp`]) {
    const res = await request('GET', p);
    assert.equal(res.status, 404, p);
    assert.deepEqual(res.body, NOT_FOUND, p);
    assert.ok(!res.raw.includes('TOP-SECRET') && !res.raw.includes(tmpDir) && !/ENOENT/.test(res.raw), p);
  }
});

test('41 uppercase UUID and .gif/.svg extensions -> 404', async () => {
  const prod = await makeProduct();
  const base = nameOf(await upload(prod.id, buildPng())).replace(/\.png$/, '');
  for (const p of [`/uploads/${base.toUpperCase()}.png`, `/uploads/${base}.PNG`, `/uploads/${base}.gif`, `/uploads/${base}.svg`]) {
    const res = await request('GET', p);
    assert.equal(res.status, 404, p);
    assert.deepEqual(res.body, NOT_FOUND, p);
  }
});

test('42 non-GET/HEAD methods on /uploads -> 404', async () => {
  for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
    const res = await request(method, '/uploads/x.png');
    assert.equal(res.status, 404, method);
    assert.deepEqual(res.body, NOT_FOUND, method);
  }
});

test('43 GET /api/health still works', async () => {
  const res = await request('GET', '/api/health');
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
});

test('44 GET existing product route still works', async () => {
  const prod = await makeProduct();
  const res = await request('GET', `/api/products/${prod.id}`, { token });
  assert.equal(res.status, 200);
  assert.equal(res.body.product.id, prod.id);
});

// ---------- 45-50: resolveUploadDir / startup ----------
const mkTmp = (prefix) => fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), prefix));
const rmTmp = (p) => fs.rmSync(p, { recursive: true, force: true });
let svcPromise;
const svc = () => (svcPromise ??= import(backendUrl + 'src/services/upload.service.js'));

test('45 refuses BACKEND, its ancestor, and uploads/..', async () => {
  const { resolveUploadDir } = await svc();
  assert.throws(() => resolveUploadDir(backendDir));
  assert.throws(() => resolveUploadDir(path.dirname(backendDir)));
  assert.throws(() => resolveUploadDir(path.join(backendDir, 'uploads', '..')));
});

test('46 refuses the DB directory (from dbUrl) and its ancestor', async () => {
  const { resolveUploadDir } = await svc();
  const dbDir = mkTmp('uploaddb-');
  const opts = { dbUrl: 'file:' + path.join(dbDir, 'test.db') };
  try {
    assert.throws(() => resolveUploadDir(dbDir, opts));
    assert.throws(() => resolveUploadDir(path.dirname(dbDir), opts));
  } finally { rmTmp(dbDir); }
});

test('47 content allowlist: refuses foreign entries, accepts images/.tmp/.gitkeep/Thumbs.db/missing dir', async () => {
  const { resolveUploadDir } = await svc();
  for (const entry of ['shop.db', '.env', 'x.db-wal', 'x.sqlite', 'secret.txt', 'subdir']) {
    const trap = mkTmp('uploada-');
    try {
      if (entry === 'subdir') fs.mkdirSync(path.join(trap, entry)); else fs.writeFileSync(path.join(trap, entry), 'x');
      assert.throws(() => resolveUploadDir(trap), undefined, entry);
    } finally { rmTmp(trap); }
  }
  const good = mkTmp('uploade-');
  try {
    const okName = '11111111-1111-4111-8111-111111111111.png';
    for (const f of [okName, okName + '.tmp', '.gitkeep', 'Thumbs.db']) fs.writeFileSync(path.join(good, f), '');
    assert.equal(resolveUploadDir(good), fs.realpathSync(good));
  } finally { rmTmp(good); }
  const missing = path.join(fs.realpathSync(os.tmpdir()), 'upload-missing-' + crypto.randomBytes(8).toString('hex'));
  assert.equal(resolveUploadDir(missing), missing);
  assert.equal(fs.existsSync(missing), false, 'resolveUploadDir must not create the directory');
});

test('48 refuses home dir, filesystem root and BACKEND/src', async () => {
  const { resolveUploadDir } = await svc();
  assert.throws(() => resolveUploadDir(os.homedir()));
  assert.throws(() => resolveUploadDir(path.parse(backendDir).root));
  assert.throws(() => resolveUploadDir(path.join(backendDir, 'src')));
});

test('49 refuses a symlink/junction whose target is BACKEND (when the link can be created)', async () => {
  const { resolveUploadDir } = await svc();
  const holder = mkTmp('uploadlink-');
  const link = path.join(holder, 'link');
  let created = false;
  try {
    fs.symlinkSync(backendDir, link, IS_WIN ? 'junction' : 'dir');
    created = true;
  } catch (err) {
    if (!['EPERM', 'EACCES', 'ENOSYS'].includes(err.code)) throw err;
  }
  try {
    if (created) assert.throws(() => resolveUploadDir(link));
  } finally { rmTmp(holder); }
});

test('50 createApp refuses a dirty upload dir; starts with a clean one', async () => {
  const child = path.join(tmpDir, 'createapp-child.mjs');
  const appUrl = pathToFileURL(path.join(backendDir, 'src', 'app.js')).href;
  fs.writeFileSync(child, `import { createApp } from ${JSON.stringify(appUrl)};
const app = createApp();
const server = app.listen(0, '127.0.0.1', () => server.close(() => process.exit(0)));
setTimeout(() => process.exit(2), 10000);
`);
  const run = (uploadDirValue) => {
    try {
      execFileSync(process.execPath, [child], {
        env: { ...process.env, DATABASE_URL: dbUrl, UPLOAD_DIR: uploadDirValue }, timeout: 20000, stdio: 'pipe',
      });
      return { status: 0, stderr: '' };
    } catch (err) {
      return { status: err.status ?? -1, stderr: String(err.stderr ?? '') };
    }
  };
  const dirty = mkTmp('uploaddirty-');
  const clean = mkTmp('uploadclean-');
  try {
    fs.writeFileSync(path.join(dirty, 'x.db'), 'x');
    const bad = run(dirty);
    assert.notEqual(bad.status, 0, 'createApp must refuse to start');
    assert.match(bad.stderr, /refusing/i);
    assert.equal(run(clean).status, 0, 'clean dir must start');
  } finally {
    rmTmp(dirty);
    rmTmp(clean);
  }
});