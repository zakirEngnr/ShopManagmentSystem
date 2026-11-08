import { createHash, randomBytes } from 'node:crypto';
import { deflateSync } from 'node:zlib';

export const TWO_MB = 2 * 1024 * 1024;

export function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function crc32(data) {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      const mask = -(crc & 1);
      crc = (crc >>> 1) ^ (0xedb88320 & mask);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

function buildPngPayload(width = 1, height = 1) {
  const rowLen = 1 + width * 4;
  const rows = [];
  for (let y = 0; y < height; y += 1) {
    const row = Buffer.alloc(rowLen);
    row[0] = 0;
    for (let x = 0; x < width; x += 1) {
      const offset = 1 + x * 4;
      row[offset] = 0;
      row[offset + 1] = 0;
      row[offset + 2] = 0;
      row[offset + 3] = 255;
    }
    rows.push(row);
  }
  return Buffer.concat(rows);
}

export function buildPng({ w = 1, h = 1 } = {}) {
  const width = Number(w) || 1;
  const height = Number(h) || 1;
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(width, 0);
  ihdrData.writeUInt32BE(height, 4);
  ihdrData[8] = 8; // bit depth
  ihdrData[9] = 6; // RGBA color type
  ihdrData[10] = 0; // compression method
  ihdrData[11] = 0; // filter method
  ihdrData[12] = 0; // interlace method
  const idatData = deflateSync(buildPngPayload(width, height));
  const png = Buffer.concat([
    signature,
    pngChunk('IHDR', ihdrData),
    pngChunk('IDAT', idatData),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
  return png;
}

export const badPng = {
  noIend() {
    const png = buildPng();
    return png.subarray(0, png.length - 12);
  },
};

export function buildJpegOfSize(size) {
  const min = 64;
  const length = Math.max(size, min);
  const jpeg = Buffer.alloc(length, 0);
  jpeg[0] = 0xff;
  jpeg[1] = 0xd8;
  jpeg[2] = 0xff;
  jpeg[3] = 0xe0;
  jpeg[4] = 0x00;
  jpeg[5] = 0x10;
  jpeg[6] = 0x4a;
  jpeg[7] = 0x46;
  jpeg[8] = 0x49;
  jpeg[9] = 0x46;
  jpeg[10] = 0x00;
  jpeg[11] = 0x01;
  jpeg[12] = 0x01;
  jpeg[13] = 0x00;
  jpeg[14] = 0x00;
  jpeg[15] = 0x01;
  jpeg[16] = 0x00;
  jpeg[17] = 0x01;
  jpeg[18] = 0x00;
  jpeg[19] = 0x00;
  jpeg[20] = 0xff;
  jpeg[21] = 0xdb;
  jpeg[22] = 0x00;
  jpeg[23] = 0x43;
  jpeg[24] = 0x00;
  jpeg[25] = 0x08;
  jpeg[26] = 0x06;
  jpeg[27] = 0x06;
  jpeg[28] = 0x07;
  jpeg[29] = 0x06;
  jpeg[30] = 0x05;
  jpeg[31] = 0x08;
  jpeg[32] = 0x07;
  jpeg[33] = 0x07;
  jpeg[34] = 0x07;
  jpeg[35] = 0x09;
  jpeg[36] = 0x09;
  jpeg[37] = 0x08;
  jpeg[38] = 0x0a;
  jpeg[39] = 0x0c;
  jpeg[40] = 0x14;
  jpeg[41] = 0x0d;
  jpeg[42] = 0x0c;
  jpeg[43] = 0x0b;
  jpeg[44] = 0x0b;
  jpeg[45] = 0x0c;
  jpeg[46] = 0x19;
  jpeg[47] = 0x12;
  jpeg[48] = 0x13;
  jpeg[49] = 0x0f;
  jpeg[50] = 0x14;
  jpeg[51] = 0x1d;
  jpeg[52] = 0x1a;
  jpeg[53] = 0x1f;
  jpeg[54] = 0x1e;
  jpeg[55] = 0x1d;
  jpeg[56] = 0x1a;
  jpeg[57] = 0x1c;
  jpeg[58] = 0x1c;
  jpeg[59] = 0x20;
  jpeg[60] = 0x24;
  jpeg[61] = 0x2e;
  jpeg[62] = 0x27;
  jpeg[63] = 0x20;
  jpeg[length - 2] = 0xff;
  jpeg[length - 1] = 0xd9;
  return jpeg.subarray(0, length);
}

export function buildJpeg() {
  return buildJpegOfSize(64);
}

export const badJpeg = {
  trailingByte() {
    const jpeg = buildJpeg();
    return Buffer.concat([jpeg, Buffer.from([0x00])]);
  },
};

export function buildWebP() {
  const webp = Buffer.alloc(20, 0);
  webp[0] = 0x52;
  webp[1] = 0x49;
  webp[2] = 0x46;
  webp[3] = 0x46;
  webp.writeUInt32LE(webp.length - 8, 4);
  webp[8] = 0x57;
  webp[9] = 0x45;
  webp[10] = 0x42;
  webp[11] = 0x50;
  webp[12] = 0x56;
  webp[13] = 0x50;
  webp[14] = 0x38;
  webp[15] = 0x20;
  webp.writeUInt32LE(0, 16);
  return webp;
}

export const GIF_BYTES = Buffer.from('GIF89a\x01\x00\x01\x00\x80\x00\x00\x00\x00\x00\xff\xff\xff', 'binary');
export const SVG_BYTES = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>');
export const HTML_BYTES = Buffer.from('<html><body>not an image</body></html>');

export function buildMultipart(parts = []) {
  const boundary = `----${randomBytes(16).toString('hex')}`;
  const chunks = [];

  for (const part of parts) {
    if (part && typeof part === 'object' && 'buffer' in part) {
      chunks.push(Buffer.from(`--${boundary}\r\n`));
      chunks.push(Buffer.from(`Content-Disposition: form-data; name="${part.name}"; filename="${part.filename}"\r\n`));
      chunks.push(Buffer.from(`Content-Type: ${part.contentType}\r\n\r\n`));
      chunks.push(part.buffer);
      chunks.push(Buffer.from('\r\n'));
    } else if (part && typeof part === 'object' && 'value' in part) {
      chunks.push(Buffer.from(`--${boundary}\r\n`));
      chunks.push(Buffer.from(`Content-Disposition: form-data; name="${part.name}"\r\n\r\n`));
      chunks.push(Buffer.from(String(part.value)));
      chunks.push(Buffer.from('\r\n'));
    }
  }

  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return {
    boundary,
    contentType: `multipart/form-data; boundary=${boundary}`,
    buffer: Buffer.concat(chunks),
  };
}

export function imageFilePart(buffer, { name = 'image', filename = 'image.png', contentType = 'image/png' } = {}) {
  return {
    name,
    filename,
    contentType,
    buffer,
  };
}
