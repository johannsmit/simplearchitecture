import { describe, expect, it } from 'vitest';
import { inspectImage } from '../src/branding/image.js';
import {
  jpeg,
  png,
  randomBytes,
  svg,
  textChunk,
  webpExtended,
  webpLossless,
  webpLossy,
} from './images.js';

describe('inspectImage: types and sizes from the bytes', () => {
  it.each([
    ['PNG', png(300, 120), 'image/png'],
    ['JPEG (baseline)', jpeg(300, 120), 'image/jpeg'],
    ['JPEG (progressive)', jpeg(300, 120, 0xc2), 'image/jpeg'],
    ['WebP lossy', webpLossy(300, 120), 'image/webp'],
    ['WebP lossless', webpLossless(300, 120), 'image/webp'],
    ['WebP extended', webpExtended(300, 120), 'image/webp'],
  ])('reads %s', (_name, bytes, type) => {
    expect(inspectImage(bytes)).toEqual({ kind: 'image', type, width: 300, height: 120 });
  });

  it('reads the largest sizes each header can hold', () => {
    expect(inspectImage(png(1, 1, { declared: [0x7fffffff, 0x7fffffff] }))).toMatchObject({
      width: 0x7fffffff,
      height: 0x7fffffff,
    });
    expect(inspectImage(jpeg(65535, 65535))).toMatchObject({ width: 65535, height: 65535 });
    expect(inspectImage(webpLossless(16384, 16384))).toMatchObject({ width: 16384, height: 16384 });
    expect(inspectImage(webpExtended(1 << 24, 1 << 24))).toMatchObject({ width: 1 << 24 });
  });

  it('skips JPEG fill bytes and standalone markers', () => {
    const file = jpeg(40, 30);
    const withFill = Buffer.concat([
      file.subarray(0, 2),
      Buffer.from([0xff, 0xff, 0xff, 0x01]),
      file.subarray(2),
    ]);
    expect(inspectImage(withFill)).toMatchObject({ kind: 'image', width: 40, height: 30 });
  });

  it('ignores the name and anything after the PNG end', () => {
    const polyglot = png(2, 2, { after: Buffer.from('<html><script>alert(1)</script></html>') });
    expect(inspectImage(polyglot)).toMatchObject({ kind: 'image', type: 'image/png' });
    const inText = png(2, 2, { extraChunks: [textChunk('<script>alert(1)</script>')] });
    expect(inspectImage(inText)).toMatchObject({ kind: 'image', type: 'image/png' });
  });
});

describe('inspectImage: refusals', () => {
  it.each([
    ['SVG', svg],
    ['HTML', Buffer.from('<!doctype html><title>x</title>')],
    ['GIF', Buffer.from('GIF89a\x01\x00\x01\x00\x00\x00\x00;', 'latin1')],
    ['BMP', Buffer.from('BM\x00\x00\x00\x00', 'latin1')],
    ['empty', Buffer.alloc(0)],
    ['a RIFF that is not WebP', Buffer.from('RIFF\x04\x00\x00\x00WAVE', 'latin1')],
  ])('does not take %s for an image', (_name, bytes) => {
    expect(inspectImage(bytes)).toEqual({ kind: 'unknown' });
  });

  it.each([
    ['PNG', png(3, 3)],
    ['JPEG', jpeg(3, 3)],
    ['WebP lossy', webpLossy(3, 3)],
    ['WebP lossless', webpLossless(3, 3)],
    ['WebP extended', webpExtended(3, 3)],
  ])('refuses %s cut short at every length, without throwing', (_name, file) => {
    // JPEG: the header is complete once the SOF segment is (the image data isn't checked).
    const complete = _name === 'JPEG' ? file.length - 2 : file.length;
    for (let length = 0; length < complete; length++) {
      const result = inspectImage(file.subarray(0, length));
      expect(result.kind, `cut at ${length}`).not.toBe('image');
    }
  });

  it('refuses a PNG without IHDR first, without image data, or with zero size', () => {
    const file = png(2, 2);
    const badName = Buffer.from(file);
    badName.write('IHDX', 12, 'ascii');
    expect(inspectImage(badName).kind).toBe('damaged');
    expect(inspectImage(png(0, 2, { declared: [0, 2] })).kind).toBe('damaged');
    // Signature, IHDR, then straight to IEND.
    const noData = Buffer.concat([file.subarray(0, 33), file.subarray(file.length - 12)]);
    expect(inspectImage(noData).kind).toBe('damaged');
  });

  it('refuses a PNG chunk whose length runs past the end or past 2^31', () => {
    const file = png(2, 2);
    const huge = Buffer.from(file);
    huge.writeUInt32BE(0xffffffff, 33);
    expect(inspectImage(huge).kind).toBe('damaged');
    const long = Buffer.from(file);
    long.writeUInt32BE(file.length, 33);
    expect(inspectImage(long).kind).toBe('damaged');
  });

  it('refuses a JPEG whose image data starts before any frame header, or with zero height', () => {
    const sosFirst = Buffer.from([0xff, 0xd8, 0xff, 0xda, 0x00, 0x02, 0xff, 0xd9]);
    expect(inspectImage(sosFirst).kind).toBe('damaged');
    expect(inspectImage(jpeg(10, 0)).kind).toBe('damaged');
    const badLength = jpeg(10, 10);
    badLength.writeUInt16BE(1, 4);
    expect(inspectImage(badLength).kind).toBe('damaged');
  });

  it('refuses a WebP whose sizes run past the end of the file', () => {
    const file = webpLossy(4, 4);
    const riffTooBig = Buffer.from(file);
    riffTooBig.writeUInt32LE(0xfffffff0, 4);
    expect(inspectImage(riffTooBig).kind).toBe('damaged');
    const chunkTooBig = Buffer.from(file);
    chunkTooBig.writeUInt32LE(0xfffffff0, 16);
    expect(inspectImage(chunkTooBig).kind).toBe('damaged');
    const unknownChunk = Buffer.from(file);
    unknownChunk.write('ALPH', 12, 'ascii');
    expect(inspectImage(unknownChunk).kind).toBe('damaged');
  });

  it('never throws on random bytes after each signature', () => {
    const signatures = [
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from([0xff, 0xd8, 0xff]),
      Buffer.from('RIFF\xff\xff\x00\x00WEBP', 'latin1'),
    ];
    for (const signature of signatures) {
      for (let seed = 1; seed <= 300; seed++) {
        const bytes = Buffer.concat([signature, randomBytes(seed, (seed * 37) % 600)]);
        expect(() => inspectImage(bytes)).not.toThrow();
      }
    }
  });
});
