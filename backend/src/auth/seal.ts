import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

const ivLength = 12;
const tagLength = 16;

/**
 * Encrypts and authenticates small values (AES-256-GCM) so they can travel in a cookie.
 * The browser can neither read nor change them. Used for the short-lived login state.
 */
export class Sealer {
  readonly #key: Buffer;

  constructor(secret: string, purpose: string) {
    this.#key = Buffer.from(hkdfSync('sha256', secret, '', `simplearchitecture:${purpose}`, 32));
  }

  seal(value: unknown, context: string): string {
    const iv = randomBytes(ivLength);
    const cipher = createCipheriv('aes-256-gcm', this.#key, iv);
    cipher.setAAD(Buffer.from(context));
    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify(value), 'utf8'),
      cipher.final(),
    ]);
    return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64url');
  }

  /** Returns the sealed value, or `undefined` if it was tampered with, truncated or sealed for another context. */
  unseal(sealed: string, context: string): unknown {
    try {
      const data = Buffer.from(sealed, 'base64url');
      if (data.length <= ivLength + tagLength) return undefined;
      const decipher = createDecipheriv('aes-256-gcm', this.#key, data.subarray(0, ivLength));
      decipher.setAAD(Buffer.from(context));
      decipher.setAuthTag(data.subarray(ivLength, ivLength + tagLength));
      const plaintext = Buffer.concat([
        decipher.update(data.subarray(ivLength + tagLength)),
        decipher.final(),
      ]);
      return JSON.parse(plaintext.toString('utf8')) as unknown;
    } catch {
      return undefined;
    }
  }
}
