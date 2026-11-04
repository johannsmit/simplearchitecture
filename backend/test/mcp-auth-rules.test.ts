import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  hashSecret,
  isSecretOf,
  newSecret,
  pkceMatches,
  redirectUriMatches,
  redirectUriProblem,
} from '../src/mcp-auth/rules.js';

describe('redirect URIs', () => {
  it.each([
    'https://agent.example.test/oauth/callback',
    'https://agent.example.test:8443/cb?x=1',
    'http://127.0.0.1:33418/callback',
    'http://localhost/callback',
    'http://[::1]:5000/cb',
  ])('accepts %s', (uri) => {
    expect(redirectUriProblem(uri)).toBeUndefined();
  });

  it.each([
    'http://agent.example.test/cb',
    'http://127.0.0.2/cb',
    'http://localhost.example.test/cb',
    'made-up-app://callback',
    'javascript:alert(1)',
    'https://agent.example.test/cb#',
    'https://agent.example.test/cb#x',
    'https://user@agent.example.test/cb',
    'https://@agent.example.test/cb',
    '/callback',
    `https://agent.example.test/${'a'.repeat(600)}`,
  ])('refuses %s', (uri) => {
    expect(redirectUriProblem(uri)).toBeDefined();
  });

  it('matches exactly, except the port on a loopback address', () => {
    const registered = 'http://localhost:3118/callback';
    expect(redirectUriMatches(registered, registered)).toBe(true);
    expect(redirectUriMatches(registered, 'http://localhost:40000/callback')).toBe(true);
    expect(redirectUriMatches(registered, 'http://localhost/callback')).toBe(true);
    expect(redirectUriMatches('http://127.0.0.1/callback', 'http://127.0.0.1:5000/callback')).toBe(
      true,
    );
    for (const other of [
      'http://127.0.0.1:3118/callback',
      'http://localhost:3118/callback/',
      'http://localhost:3118/Callback',
      'http://localhost:3118/callback?x=1',
      'http://localhost:3118/callback#x',
      'http://me@localhost:3118/callback',
      'https://localhost:3118/callback',
    ]) {
      expect(redirectUriMatches(registered, other), other).toBe(false);
    }
    const hosted = 'https://agent.example.test/cb';
    expect(redirectUriMatches(hosted, 'https://agent.example.test:443/cb')).toBe(false);
    expect(redirectUriMatches(hosted, 'https://agent.example.test:8443/cb')).toBe(false);
    expect(redirectUriMatches(hosted, 'https://AGENT.example.test/cb')).toBe(false);
  });
});

describe('PKCE and secrets', () => {
  it('checks S256', () => {
    const verifier = 'made-up-verifier-made-up-verifier-made-up-verifier';
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    expect(pkceMatches(verifier, challenge)).toBe(true);
    expect(pkceMatches(`${verifier}x`, challenge)).toBe(false);
    expect(pkceMatches(verifier, verifier)).toBe(false);
  });

  it('makes random secrets of a known shape, and stores only a hash', () => {
    const a = newSecret('access');
    const b = newSecret('access');
    expect(a).not.toBe(b);
    expect(isSecretOf('access', a)).toBe(true);
    expect(isSecretOf('refresh', a)).toBe(false);
    expect(isSecretOf('access', `${a}x`)).toBe(false);
    expect(hashSecret(a)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashSecret(a)).not.toContain(a.slice(6));
  });
});
