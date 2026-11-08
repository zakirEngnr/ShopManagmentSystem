import multer, { memoryStorage } from 'multer';
import { httpError } from '../utils/prismaErrors.js';

/**
 * Only filename pattern allowed for stored product images.
 * UUID v4 (any variant bits as emitted by crypto.randomUUID) + '.' + one of
 * jpg | png | webp.
 * Imported by every module that validates stored filenames; do not copy this
 * pattern anywhere else.
 */
export const IMAGE_NAME_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(jpg|png|webp)$/;

// Canonical IEND chunk (last 12 bytes of a structurally valid PNG): length +
// chunk type + CRC.
const PNG_IEND_TAIL = Buffer.from([
  0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
]);

const multerUpload = multer({
  storage: memoryStorage(),
  limits: {
    fileSize: 2 * 1024 * 1024,
    files: 1,
    fields: 0,
    parts: 2,
  },
});

const MULTER_STATUS = { LIMIT_FILE_SIZE: 413 };
const MULTER_MESSAGE = {
  LIMIT_FILE_SIZE: 'Image exceeds 2 MB limit',
  LIMIT_FILE_COUNT: 'Too many files',
  LIMIT_UNEXPECTED_FILE: 'Unexpected field',
  LIMIT_FIELD_COUNT: 'Too many fields',
  LIMIT_FIELD_KEY: 'Invalid field',
  LIMIT_FIELD_VALUE: 'Invalid field value',
  LIMIT_FIELD_NAME: 'Invalid field name',
  LIMIT_PART_COUNT: 'Too many parts',
};

/**
 * Multer single-file middleware for the `image` field (memory storage).
 * Maps MulterError codes to fixed HTTP responses and converts every
 * non-Multer multipart-parser error (malformed/truncated multipart, missing
 * boundary, aborted request) into a fixed 400 'Malformed upload request'.
 * Never forwards err.message to the client.
 */
export function runUpload(req, res, next) {
  multerUpload.single('image')(req, res, (err) => {
    if (err instanceof multer.MulterError) {
      const status = MULTER_STATUS[err.code] ?? 400;
      const message = MULTER_MESSAGE[err.code] ?? 'File upload rejected';
      next(httpError(status, message));
      return;
    }
    if (err) {
      next(httpError(400, 'Malformed upload request'));
      return;
    }
    next();
  });
}

/**
 * Structural signature validation of an image buffer.
 * The client-declared MIME type and filename are ignored; only the bytes
 * matter. Returns { valid: true, ext } or { valid: false, reason }.
 * `reason` is a short fixed token for tests/logs only; it is never sent to
 * the client.
 *
 * NOTE: this is a structural check only, not image decoding or re-encoding.
 * It is not proof that a file is harmless or decodable; a polyglot file can
 * pass. Such files are served with nosniff, CSP default-src 'none' and
 * sandbox to reduce the risk.
 */
export function validateImageBuffer(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) {
    return { valid: false, reason: 'too_short' };
  }
  const b = buffer;
  const len = b.length;

  // PNG: signature, IHDR length/type at bytes 8-15, and the canonical IEND
  // chunk as the exact last 12 bytes.
  if (
    b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 &&
    b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a &&
    b[8] === 0x00 && b[9] === 0x00 && b[10] === 0x00 && b[11] === 0x0d &&
    b[12] === 0x49 && b[13] === 0x48 && b[14] === 0x44 && b[15] === 0x52
  ) {
    const tail = b.subarray(len - 12);
    if (
      tail[0] === 0x00 && tail[1] === 0x00 && tail[2] === 0x00 && tail[3] === 0x00 &&
      tail[4] === 0x49 && tail[5] === 0x45 && tail[6] === 0x4e && tail[7] === 0x44 &&
      tail[8] === 0xae && tail[9] === 0x42 && tail[10] === 0x60 && tail[11] === 0x82
    ) {
      return { valid: true, ext: 'png' };
    }
    return { valid: false, reason: 'png_tail' };
  }

  // JPEG: FF D8 FF, byte 3 is a real marker (0xC0..0xFE excluding 0xD0..0xD9),
  // the first segment length (bytes 4-5, big-endian) is >= 2 and leaves room
  // (4 + length <= len - 2), and FF D9 are the final two bytes (nothing after
  // EOI).
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) {
    const marker = b[3];
    if (marker < 0xc0 || marker > 0xfe || (marker >= 0xd0 && marker <= 0xd9)) {
      return { valid: false, reason: 'jpeg_marker' };
    }
    if (len < 6) return { valid: false, reason: 'jpeg_short' };
    const segLen = b.readUInt16BE(4);
    if (segLen < 2 || 4 + segLen > len - 2) {
      return { valid: false, reason: 'jpeg_segment' };
    }
    if (b[len - 2] !== 0xff || b[len - 1] !== 0xd9) {
      return { valid: false, reason: 'jpeg_eoi' };
    }
    return { valid: true, ext: 'jpg' };
  }

  // WebP: 'RIFF', uint32LE at 4 == length - 8, length even, 'WEBP' at 8-11,
  // fourcc at 12-15 in {VP8 , VP8L, VP8X}, uint32LE at 16-19 <= length - 20.
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && len >= 20) {
    const riffSize = b.readUInt32LE(4);
    if (riffSize !== len - 8) return { valid: false, reason: 'webp_riff' };
    if (len % 2 !== 0) return { valid: false, reason: 'webp_odd_length' };
    if (b[8] !== 0x57 || b[9] !== 0x45 || b[10] !== 0x42 || b[11] !== 0x50) {
      return { valid: false, reason: 'webp_brand' };
    }
    const c0 = b[12];
    const c1 = b[13];
    const c2 = b[14];
    const c3 = b[15];
    if (
      !(c0 === 0x56 && c1 === 0x50 && c2 === 0x38 &&
        (c3 === 0x20 || c3 === 0x4c || c3 === 0x58))
    ) {
      return { valid: false, reason: 'webp_fourcc' };
    }
    if (b.readUInt32LE(16) > len - 20) {
      return { valid: false, reason: 'webp_first_chunk' };
    }
    return { valid: true, ext: 'webp' };
  }

  return { valid: false, reason: 'unknown_format' };
}
