import { describe, expect, it } from 'vitest';
import { Sealer } from '../src/auth/seal.js';

const secret = 'test-session-secret-that-is-long-enough';
const value = { codeVerifier: 'v', state: 's', nonce: 'n', expiresAt: 1 };

/** Flips one bit of the byte at `index` of a base64url string's decoded bytes. */
function flipBit(sealed: string, index: number): string {
  const bytes = Buffer.from(sealed, 'base64url');
  bytes[index] = (bytes[index] ?? 0) ^ 1;
  return bytes.toString('base64url');
}

// The login state (PKCE verifier, state, nonce) travels in a cookie, so its integrity rests here.
describe('Sealer', () => {
  it('round-trips a value and never shows it in clear text', () => {
    const sealer = new Sealer(secret, 'login-state');
    const sealed = sealer.seal(value, '__Host-sa_login');

    expect(sealer.unseal(sealed, '__Host-sa_login')).toEqual(value);
    expect(Buffer.from(sealed, 'base64url').toString('latin1')).not.toContain('codeVerifier');
    expect(sealer.seal(value, '__Host-sa_login')).not.toBe(sealed); // fresh IV every time
  });

  it('rejects any changed bit: IV, auth tag or ciphertext', () => {
    const sealer = new Sealer(secret, 'login-state');
    const sealed = sealer.seal(value, '__Host-sa_login');
    const length = Buffer.from(sealed, 'base64url').length;

    for (const index of [0, 11, 12, 27, 28, length - 1]) {
      expect(sealer.unseal(flipBit(sealed, index), '__Host-sa_login'), `byte ${index}`).toBe(
        undefined,
      );
    }
  });

  it('rejects truncated, empty and non-base64 input', () => {
    const sealer = new Sealer(secret, 'login-state');
    const sealed = sealer.seal(value, '__Host-sa_login');

    for (const input of [sealed.slice(0, -4), sealed.slice(0, 20), '', '!!!not-base64!!!']) {
      expect(sealer.unseal(input, '__Host-sa_login')).toBeUndefined();
    }
  });

  it('rejects a value sealed with another secret, purpose or cookie name', () => {
    const sealed = new Sealer(secret, 'login-state').seal(value, '__Host-sa_login');

    expect(new Sealer(`${secret}-other`, 'login-state').unseal(sealed, '__Host-sa_login')).toBe(
      undefined,
    );
    expect(new Sealer(secret, 'other-purpose').unseal(sealed, '__Host-sa_login')).toBeUndefined();
    expect(new Sealer(secret, 'login-state').unseal(sealed, 'sa_login')).toBeUndefined();
  });
});
