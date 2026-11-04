import type { LogoMediaType } from '@simplearchitecture/shared';

/**
 * What a logo file is, read from its own bytes (never its name or declared type): PNG, JPEG or
 * WebP, with the width and height from the image header. No image is decoded. Every read is
 * bounds-checked and every loop moves forward, so truncated or hostile input gives 'damaged'
 * (or 'unknown'), never an exception or a hang.
 */
export type ImageInspection =
  | { kind: 'image'; type: LogoMediaType; width: number; height: number }
  /** Not a PNG, JPEG or WebP file (an SVG, HTML, a GIF, ...). */
  | { kind: 'unknown' }
  /** Starts like one of them, but its header is cut short or doesn't make sense. */
  | { kind: 'damaged'; type: LogoMediaType };

const pngSignature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function startsWith(bytes: Uint8Array, prefix: readonly number[], at = 0): boolean {
  if (bytes.length < at + prefix.length) return false;
  return prefix.every((byte, index) => bytes[at + index] === byte);
}

function ascii(bytes: Uint8Array, at: number, length: number): string {
  if (bytes.length < at + length) return '';
  return String.fromCharCode(...bytes.subarray(at, at + length));
}

/** Unsigned big-endian integers; undefined past the end. */
function u16be(bytes: Uint8Array, at: number): number | undefined {
  if (at < 0 || bytes.length < at + 2) return undefined;
  return ((bytes[at] ?? 0) << 8) | (bytes[at + 1] ?? 0);
}
function u32be(bytes: Uint8Array, at: number): number | undefined {
  if (at < 0 || bytes.length < at + 4) return undefined;
  return (
    (bytes[at] ?? 0) * 0x1000000 +
    (((bytes[at + 1] ?? 0) << 16) | ((bytes[at + 2] ?? 0) << 8) | (bytes[at + 3] ?? 0))
  );
}
/** Unsigned little-endian integer of `length` bytes (at most 4); undefined past the end. */
function uintle(bytes: Uint8Array, at: number, length: number): number | undefined {
  if (at < 0 || bytes.length < at + length) return undefined;
  let value = 0;
  for (let index = length - 1; index >= 0; index--) value = value * 256 + (bytes[at + index] ?? 0);
  return value;
}

function sized(
  type: LogoMediaType,
  width: number | undefined,
  height: number | undefined,
): ImageInspection {
  if (width === undefined || height === undefined || width < 1 || height < 1) {
    return { kind: 'damaged', type };
  }
  return { kind: 'image', type, width, height };
}

/**
 * PNG: the IHDR chunk comes first and holds the size. The chunks are walked to IEND, so a file
 * cut short is refused. Bytes after IEND are ignored (they are never shown as anything but a
 * PNG: the logo is served with its type and nosniff).
 */
function inspectPng(bytes: Uint8Array): ImageInspection {
  const type = 'image/png';
  if (u32be(bytes, 8) !== 13 || ascii(bytes, 12, 4) !== 'IHDR') return { kind: 'damaged', type };
  const width = u32be(bytes, 16);
  const height = u32be(bytes, 20);
  let at = 8;
  let sawData = false;
  for (;;) {
    const length = u32be(bytes, at);
    const name = ascii(bytes, at + 4, 4);
    // A chunk is its length, name, data and CRC; lengths are at most 2^31 - 1.
    if (length === undefined || name === '' || length > 0x7fffffff)
      return { kind: 'damaged', type };
    const next = at + 12 + length;
    if (next > bytes.length) return { kind: 'damaged', type };
    if (name === 'IDAT') sawData = true;
    if (name === 'IEND') break;
    at = next;
  }
  return sawData ? sized(type, width, height) : { kind: 'damaged', type };
}

// SOF markers hold the size: C0–CF, except DHT (C4), JPG (C8) and DAC (CC).
const isStartOfFrame = (marker: number) =>
  marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
// Markers without a length: TEM and RST0–RST7.
const isStandalone = (marker: number) => marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7);

/** JPEG: the segments are walked from SOI to the first start-of-frame, which holds the size. */
function inspectJpeg(bytes: Uint8Array): ImageInspection {
  const type = 'image/jpeg';
  let at = 2;
  for (;;) {
    if (bytes[at] !== 0xff) return { kind: 'damaged', type };
    // Any number of 0xFF fill bytes may come before a marker.
    while (bytes[at] === 0xff) at += 1;
    const marker = bytes[at];
    if (marker === undefined) return { kind: 'damaged', type };
    at += 1;
    if (isStandalone(marker)) continue;
    // No size before the image data or the end: not a file we can check.
    if (marker === 0x00 || marker === 0xd8 || marker === 0xd9 || marker === 0xda) {
      return { kind: 'damaged', type };
    }
    const length = u16be(bytes, at);
    if (length === undefined || length < 2 || at + length > bytes.length) {
      return { kind: 'damaged', type };
    }
    if (isStartOfFrame(marker)) {
      // Length, precision (1 byte), height, width.
      if (length < 8) return { kind: 'damaged', type };
      return sized(type, u16be(bytes, at + 5), u16be(bytes, at + 3));
    }
    at += length;
  }
}

/** WebP: a RIFF file whose first chunk is VP8 (lossy), VP8L (lossless) or VP8X (extended). */
function inspectWebp(bytes: Uint8Array): ImageInspection {
  const type = 'image/webp';
  const riffSize = uintle(bytes, 4, 4);
  const chunkSize = uintle(bytes, 16, 4);
  if (
    riffSize === undefined ||
    chunkSize === undefined ||
    riffSize < 4 ||
    riffSize + 8 > bytes.length ||
    20 + chunkSize > riffSize + 8
  ) {
    return { kind: 'damaged', type };
  }
  const chunk = ascii(bytes, 12, 4);
  const data = 20;
  if (chunk === 'VP8 ') {
    // A 3-byte frame tag, the start code 9D 01 2A, then 14-bit width and height.
    if (chunkSize < 10 || !startsWith(bytes, [0x9d, 0x01, 0x2a], data + 3)) {
      return { kind: 'damaged', type };
    }
    const width = uintle(bytes, data + 6, 2);
    const height = uintle(bytes, data + 8, 2);
    return sized(
      type,
      width === undefined ? undefined : width & 0x3fff,
      height === undefined ? undefined : height & 0x3fff,
    );
  }
  if (chunk === 'VP8L') {
    // The signature 2F, then width - 1 and height - 1 in 14 bits each.
    const bits = uintle(bytes, data + 1, 4);
    if (chunkSize < 5 || bytes[data] !== 0x2f || bits === undefined) {
      return { kind: 'damaged', type };
    }
    return sized(type, (bits & 0x3fff) + 1, (Math.floor(bits / 0x4000) & 0x3fff) + 1);
  }
  if (chunk === 'VP8X') {
    // Flags and 3 reserved bytes, then canvas width - 1 and height - 1 in 24 bits each.
    const width = uintle(bytes, data + 4, 3);
    const height = uintle(bytes, data + 7, 3);
    if (chunkSize < 10 || width === undefined || height === undefined) {
      return { kind: 'damaged', type };
    }
    return sized(type, width + 1, height + 1);
  }
  return { kind: 'damaged', type };
}

export function inspectImage(bytes: Uint8Array): ImageInspection {
  if (startsWith(bytes, pngSignature)) return inspectPng(bytes);
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return inspectJpeg(bytes);
  if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP') return inspectWebp(bytes);
  return { kind: 'unknown' };
}
