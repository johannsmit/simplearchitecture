import { crc32, deflateSync } from 'node:zlib';

/** Made-up image files for the logo tests, built in code (no files from anywhere else). */

function u32be(value: number): Buffer {
  const out = Buffer.alloc(4);
  out.writeUInt32BE(value);
  return out;
}

function pngChunk(name: string, data: Buffer): Buffer {
  const nameBytes = Buffer.from(name, 'ascii');
  return Buffer.concat([
    u32be(data.length),
    nameBytes,
    data,
    u32be(crc32(Buffer.concat([nameBytes, data]))),
  ]);
}

/**
 * A real PNG of `width` × `height` grey pixels (decodable when small). `declared` writes other
 * dimensions into IHDR than the pixel data has. `extraChunks` go before IDAT.
 */
export function png(
  width = 2,
  height = 2,
  options: { declared?: [number, number]; extraChunks?: Buffer[]; after?: Buffer } = {},
): Buffer {
  const [w, h] = options.declared ?? [width, height];
  const ihdr = Buffer.concat([u32be(w), u32be(h), Buffer.from([8, 0, 0, 0, 0])]);
  // One filter byte and one grey byte per pixel, per row.
  const raw = Buffer.alloc(Math.min(height, 64) * (Math.min(width, 64) + 1), 0x80);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    ...(options.extraChunks ?? []),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
    options.after ?? Buffer.alloc(0),
  ]);
}

export function textChunk(text: string): Buffer {
  return pngChunk('tEXt', Buffer.concat([Buffer.from('Comment\0', 'latin1'), Buffer.from(text)]));
}

function segment(marker: number, data: Buffer): Buffer {
  const length = Buffer.alloc(2);
  length.writeUInt16BE(data.length + 2);
  return Buffer.concat([Buffer.from([0xff, marker]), length, data]);
}

/** A JPEG header (SOI, APP0, SOF0 with one component, EOI); `sof` picks the frame marker. */
export function jpeg(width = 2, height = 2, sof = 0xc0): Buffer {
  const sofData = Buffer.alloc(9);
  sofData.writeUInt8(8, 0);
  sofData.writeUInt16BE(height, 1);
  sofData.writeUInt16BE(width, 3);
  sofData.writeUInt8(1, 5);
  sofData.writeUInt8(1, 6);
  sofData.writeUInt8(0x11, 7);
  sofData.writeUInt8(0, 8);
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    segment(0xe0, Buffer.from('JFIF\0\x01\x01\0\0\x01\0\x01\0\0', 'latin1')),
    segment(sof, sofData),
    Buffer.from([0xff, 0xd9]),
  ]);
}

function riff(chunkName: string, data: Buffer): Buffer {
  const padded = data.length % 2 === 1 ? Buffer.concat([data, Buffer.alloc(1)]) : data;
  const chunkSize = Buffer.alloc(4);
  chunkSize.writeUInt32LE(data.length);
  const body = Buffer.concat([
    Buffer.from('WEBP', 'ascii'),
    Buffer.from(chunkName, 'ascii'),
    chunkSize,
    padded,
  ]);
  const size = Buffer.alloc(4);
  size.writeUInt32LE(body.length);
  return Buffer.concat([Buffer.from('RIFF', 'ascii'), size, body]);
}

/** A lossy WebP header (VP8). */
export function webpLossy(width = 2, height = 2): Buffer {
  const data = Buffer.alloc(10);
  data.set([0x9d, 0x01, 0x2a], 3);
  data.writeUInt16LE(width & 0x3fff, 6);
  data.writeUInt16LE(height & 0x3fff, 8);
  return riff('VP8 ', data);
}

/** A lossless WebP header (VP8L). */
export function webpLossless(width = 2, height = 2): Buffer {
  const data = Buffer.alloc(5);
  data.writeUInt8(0x2f, 0);
  data.writeUInt32LE(((width - 1) & 0x3fff) | (((height - 1) & 0x3fff) << 14), 1);
  return riff('VP8L', data);
}

/** An extended WebP header (VP8X). */
export function webpExtended(width = 2, height = 2): Buffer {
  const data = Buffer.alloc(10);
  data.writeUIntLE(width - 1, 4, 3);
  data.writeUIntLE(height - 1, 7, 3);
  return riff('VP8X', data);
}

export const svg = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><script>alert(1)</script></svg>',
);

/** A small deterministic random source, so fuzz tests are the same on every run. */
export function randomBytes(seed: number, length: number): Buffer {
  let state = seed >>> 0 || 1;
  const out = Buffer.alloc(length);
  for (let index = 0; index < length; index++) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    out[index] = state & 0xff;
  }
  return out;
}
