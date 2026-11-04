import { createSign, generateKeyPairSync } from 'node:crypto';
import { type MeResponse } from '@simplearchitecture/shared';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import type { OAuth2Server } from 'oauth2-mock-server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OidcClient, OidcProviderRefused } from '../src/auth/oidc.js';
import type { Config } from '../src/config.js';
import {
  buildTestApp,
  captureLogs,
  clientId,
  idpOptions,
  leavesFor,
  signIn,
  startMockIdp,
  testConfig,
  webOrigin,
  withClaims,
} from './helpers.js';

let idp: OAuth2Server | undefined;
let app: FastifyInstance | undefined;

afterEach(async () => {
  vi.unstubAllGlobals();
  await app?.close();
  app = undefined;
  await idp?.stop();
  idp = undefined;
});

async function start(
  metadata: Record<string, unknown> = {},
  config: Partial<Config> = {},
): Promise<{ idp: OAuth2Server; app: FastifyInstance }> {
  idp = await startMockIdp(metadata);
  app = await buildTestApp({ LOG_LEVEL: 'info', ...config }, idpOptions(idp));
  return { idp, app };
}

const me = (target: FastifyInstance, cookie: string) =>
  target.inject({ method: 'GET', url: '/api/me', headers: { cookie } });

const logout = (target: FastifyInstance, cookie: string) =>
  target.inject({
    method: 'POST',
    url: '/auth/logout',
    headers: { origin: webOrigin, cookie },
  });

const lines = (logs: string[], level: number) =>
  logs
    .map((line) => JSON.parse(line) as { level: number; msg: string })
    .filter((l) => l.level >= level);

interface TokenRequest {
  headers: { authorization?: string };
  body: Record<string, unknown>;
}

describe('the client secret method', () => {
  async function tokenRequestWith(metadata: Record<string, unknown>): Promise<TokenRequest> {
    const started = await start(metadata);
    let seen: TokenRequest | undefined;
    started.idp.service.on('beforeTokenSigning', (_token: unknown, request: TokenRequest) => {
      seen = request;
    });
    // The mock takes the audience from the body only, where client_secret_basic has no client id.
    withClaims(started.idp, { aud: clientId });
    const { sessionCookie } = await signIn(started.app);
    expect(sessionCookie).not.toBe('');
    if (seen === undefined) throw new Error('no token request');
    return seen;
  }

  const expectBasic = (request: TokenRequest) => {
    const [scheme, encoded] = (request.headers.authorization ?? '').split(' ');
    expect(scheme).toBe('Basic');
    // openid-client form-encodes both parts, as RFC 6749 says.
    const parts = Buffer.from(encoded ?? '', 'base64')
      .toString()
      .split(':');
    expect(parts.map(decodeURIComponent)).toEqual([clientId, testConfig.OIDC_CLIENT_SECRET]);
    expect(request.body.client_secret).toBeUndefined();
  };
  const expectPost = (request: TokenRequest) => {
    expect(request.headers.authorization).toBeUndefined();
    expect(request.body.client_secret).toBe(testConfig.OIDC_CLIENT_SECRET);
  };

  it('prefers client_secret_post when both are offered, which keeps what Entra ID gets', async () => {
    expectPost(
      await tokenRequestWith({
        token_endpoint_auth_methods_supported: [
          'private_key_jwt',
          'client_secret_basic',
          'client_secret_post',
        ],
      }),
    );
  });

  it('uses client_secret_post when only it is offered', async () => {
    expectPost(
      await tokenRequestWith({ token_endpoint_auth_methods_supported: ['client_secret_post'] }),
    );
  });

  it('uses client_secret_basic when only it is offered', async () => {
    expectBasic(
      await tokenRequestWith({ token_endpoint_auth_methods_supported: ['client_secret_basic'] }),
    );
  });

  it('uses client_secret_basic, the standard default, when the provider advertises nothing', async () => {
    expectBasic(await tokenRequestWith({ token_endpoint_auth_methods_supported: undefined }));
  });

  it.each([
    ['only other methods', ['none', 'private_key_jwt']],
    ['an empty list', []],
    ['a list that is not a list', 'client_secret_post'],
  ])('refuses a provider offering %s, with a clear log line', async (_name, offered) => {
    const started = await start({ token_endpoint_auth_methods_supported: offered });
    const logs = captureLogs(started.app);

    const res = await started.app.inject({ method: 'GET', url: '/auth/login' });

    expect(res.statusCode).toBe(502);
    expect(res.cookies).toHaveLength(0);
    expect(logs.join('\n')).toContain('OIDC provider refused');
    expect(logs.join('\n')).toContain('neither client_secret_post nor client_secret_basic');
    expect(logs.join('\n')).not.toContain(testConfig.OIDC_CLIENT_SECRET);
  });
});

describe('the issuer', () => {
  /** A made-up provider at any address: the discovery document, without a network. */
  function fakeDiscovery(issuer: string): string[] {
    const asked: string[] = [];
    vi.stubGlobal('fetch', (url: string) => {
      asked.push(url);
      return Promise.resolve(
        Response.json({
          issuer,
          authorization_endpoint: 'https://idp.example.test/authorize',
          token_endpoint: 'https://idp.example.test/token',
          jwks_uri: 'https://idp.example.test/keys',
          token_endpoint_auth_methods_supported: ['client_secret_post'],
        }),
      );
    });
    return asked;
  }
  const clientFor = (issuer: string) =>
    new OidcClient({
      issuer,
      clientId,
      clientSecret: 'made-up-secret',
      redirectUri: 'https://app.example.test/auth/callback',
    });

  // openid-client lets these through by itself (handleEntraId, handleB2Clogin), which would accept
  // a token from any tenant, so they must fall to the app's own check.
  it.each([
    ['common', 'https://login.microsoftonline.com/common/v2.0'],
    ['organizations', 'https://login.microsoftonline.com/organizations/v2.0'],
  ])(
    'refuses an Entra-like /%s address, where the issuer holds {tenantid}',
    async (_name, address) => {
      fakeDiscovery('https://login.microsoftonline.com/{tenantid}/v2.0');
      await expect(clientFor(address).startLogin()).rejects.toBeInstanceOf(OidcProviderRefused);
    },
  );

  it('refuses a discovered issuer of another tenant on the same Entra-like host', async () => {
    fakeDiscovery('https://login.microsoftonline.com/made-up-tenant-b/v2.0');
    await expect(
      clientFor('https://login.microsoftonline.com/made-up-tenant-a/v2.0').startLogin(),
    ).rejects.toBeInstanceOf(OidcProviderRefused);
  });

  it('refuses a b2clogin address whose discovered issuer differs', async () => {
    fakeDiscovery('https://made-up.b2clogin.com/made-up-tenant/v2.0/');
    await expect(
      clientFor('https://made-up.b2clogin.com/made-up-policy/v2.0').startLogin(),
    ).rejects.toBeInstanceOf(OidcProviderRefused);
  });

  it('accepts an Entra-like tenant address that the provider names back exactly', async () => {
    const address = 'https://login.microsoftonline.com/made-up-tenant-a/v2.0';
    fakeDiscovery(address);
    const { url } = await clientFor(address).startLogin();
    expect(url.origin).toBe('https://idp.example.test');
  });

  it.each([
    ['without', 'https://idp.example.test/oauth2/default'],
    ['with', 'https://idp.example.test/oauth2/default/'],
    ['with, at the root,', 'https://idp.example.test/'],
  ])('uses an address %s a trailing slash as written', async (_name, address) => {
    const asked = fakeDiscovery(address);
    await clientFor(address).startLogin();
    expect(asked).toEqual([`${address.replace(/\/$/, '')}/.well-known/openid-configuration`]);
  });

  it.each([
    ['adds', 'https://idp.example.test', 'https://idp.example.test/'],
    ['leaves out', 'https://idp.example.test/', 'https://idp.example.test'],
  ])('refuses a provider that %s the slash', async (_name, address, discovered) => {
    fakeDiscovery(discovered);
    await expect(clientFor(address).startLogin()).rejects.toBeInstanceOf(OidcProviderRefused);
  });

  describe('tied to the ID token', () => {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const base64url = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const tenantA = 'https://login.microsoftonline.com/made-up-tenant-a/v2.0';
    const tenantB = 'https://login.microsoftonline.com/made-up-tenant-b/v2.0';

    /** A whole provider without a network, whose token endpoint returns a correctly signed ID token. */
    function fakeProvider(issuer: string, claimsFor: (nonce: string) => Record<string, unknown>) {
      let nonce = '';
      const handler = (url: string) => {
        if (url.endsWith('/.well-known/openid-configuration')) {
          return Response.json({
            issuer,
            authorization_endpoint: 'https://idp.example.test/authorize',
            token_endpoint: 'https://idp.example.test/token',
            jwks_uri: 'https://idp.example.test/keys',
            token_endpoint_auth_methods_supported: ['client_secret_post'],
          });
        }
        if (url.endsWith('/keys')) {
          return Response.json({
            keys: [{ ...publicKey.export({ format: 'jwk' }), kid: 'k', use: 'sig', alg: 'RS256' }],
          });
        }
        const now = Math.floor(Date.now() / 1000);
        const signed = `${base64url({ alg: 'RS256', kid: 'k' })}.${base64url({
          sub: 'made-up-sub',
          aud: clientId,
          iat: now,
          exp: now + 300,
          ...claimsFor(nonce),
        })}`;
        const signature = createSign('RSA-SHA256').update(signed).sign(privateKey, 'base64url');
        return Response.json({
          access_token: 'made-up-access-token',
          token_type: 'bearer',
          id_token: `${signed}.${signature}`,
        });
      };
      vi.stubGlobal('fetch', (url: string) => Promise.resolve(handler(url)));
      return {
        finish: async (client: OidcClient) => {
          const { checks } = await client.startLogin();
          nonce = checks.nonce;
          return client.finishLogin(`?code=made-up-code&state=${checks.state}`, checks);
        },
      };
    }

    /** Which claim openid-client refused the token on. */
    const refusedClaim = (login: Promise<unknown>) =>
      login.then(
        () => 'accepted',
        (error: unknown) => (error as { cause: { cause: { claim: string } } }).cause.cause.claim,
      );

    it('accepts a token of the configured tenant', async () => {
      const provider = fakeProvider(tenantA, (nonce) => ({
        nonce,
        iss: tenantA,
        tid: 'made-up-tenant-a',
      }));
      await expect(provider.finish(clientFor(tenantA))).resolves.toMatchObject({
        sub: 'made-up-sub',
      });
    });

    // openid-client can compare against the issuer with {tenantid} filled in from the token's own
    // tid. It only does that when the discovered issuer differs from the address, which the exact
    // check rules out, so on the Entra host too the token's tid must not choose the issuer.
    it('refuses a token of another tenant, on the Entra host, whatever its tid says', async () => {
      const provider = fakeProvider(tenantA, (nonce) => ({
        nonce,
        iss: tenantB,
        tid: 'made-up-tenant-b',
      }));
      expect(await refusedClaim(provider.finish(clientFor(tenantA)))).toBe('iss');
    });

    it('refuses a token of another issuer on any other host', async () => {
      const address = 'https://idp.example.test/tenant-a';
      const provider = fakeProvider(address, (nonce) => ({
        nonce,
        iss: 'https://idp.example.test/tenant-b',
      }));
      expect(await refusedClaim(provider.finish(clientFor(address)))).toBe('iss');
    });

    it('does not fill in an issuer holding a literal {tenantid} from the token', async () => {
      const address = 'https://login.microsoftonline.com/{tenantid}/v2.0';
      const provider = fakeProvider(address, (nonce) => ({
        nonce,
        iss: tenantB,
        tid: 'made-up-tenant-b',
      }));
      expect(await refusedClaim(provider.finish(clientFor(address)))).toBe('iss');
    });
  });

  describe('after a failed discovery', () => {
    const discoveryOf = (issuer: string) =>
      Response.json({
        issuer,
        authorization_endpoint: 'https://idp.example.test/authorize',
        token_endpoint: 'https://idp.example.test/token',
        jwks_uri: 'https://idp.example.test/keys',
        token_endpoint_auth_methods_supported: ['client_secret_post'],
      });
    const address = 'https://idp.example.test/tenant-a';
    const other = 'https://idp.example.test/tenant-b';
    const checks = { codeVerifier: 'made-up', state: 'made-up', nonce: 'made-up' };

    it('checks the issuer again on each try, and never finishes a login on a refused provider', async () => {
      const answers = [
        () => Promise.reject(new TypeError('made-up network failure')),
        () => Promise.resolve(discoveryOf(other)),
        () => Promise.resolve(discoveryOf(other)),
        () => Promise.resolve(discoveryOf(address)),
      ];
      const asked: string[] = [];
      vi.stubGlobal('fetch', (url: string) => {
        asked.push(url);
        const answer = answers.shift();
        if (answer === undefined) throw new Error(`unexpected call to ${url}`);
        return answer();
      });
      const target = clientFor(address);

      await expect(target.startLogin()).rejects.toThrow('made-up network failure');
      await expect(target.startLogin()).rejects.toThrow(/issuer/);
      // The token endpoint is never called: the stub would have thrown on a fifth call.
      await expect(target.finishLogin('?code=x&state=made-up', checks)).rejects.toThrow(/issuer/);
      await expect(target.startLogin()).resolves.toBeDefined();
      expect(asked).toHaveLength(4);
    });

    it('asks the provider only once when it was accepted', async () => {
      let calls = 0;
      vi.stubGlobal('fetch', () => {
        calls += 1;
        return Promise.resolve(discoveryOf(address));
      });
      const target = clientFor(address);
      await target.startLogin();
      await target.startLogin();
      expect(calls).toBe(1);
    });
  });

  describe('the end-session address', () => {
    const address = 'https://idp.example.test/tenant-a';
    const offering = (endSession: unknown) => {
      vi.stubGlobal('fetch', () =>
        Promise.resolve(
          Response.json({
            issuer: address,
            authorization_endpoint: 'https://idp.example.test/authorize',
            token_endpoint: 'https://idp.example.test/token',
            jwks_uri: 'https://idp.example.test/keys',
            token_endpoint_auth_methods_supported: ['client_secret_post'],
            end_session_endpoint: endSession,
          }),
        ),
      );
      return clientFor(address);
    };

    it.each([
      ['javascript:', 'javascript:alert(1)'],
      ['data:', 'data:text/html,<script>alert(1)</script>'],
      ['plain http', 'http://signout.example.test/end'],
    ])('is never used when it is %s', async (_name, endSession) => {
      await expect(offering(endSession).logoutUrl()).rejects.toBeInstanceOf(Error);
    });

    it('is used when it is https', async () => {
      const url = await offering('https://signout.example.test/end').logoutUrl();
      expect(url?.origin).toBe('https://signout.example.test');
    });
  });

  it('refuses another issuer on the local mock provider, with no sign-in', async () => {
    const started = await start({ issuer: 'https://idp.example.test/{tenantid}/v2.0' });
    const logs = captureLogs(started.app);

    const res = await started.app.inject({ method: 'GET', url: '/auth/login' });

    expect(res.statusCode).toBe(502);
    expect(logs.join('\n')).toContain('issuer');
  });

  it('signs in end to end with an issuer that ends in a slash', async () => {
    idp = await startMockIdp();
    const issuer = `${idp.issuer.url ?? ''}/`;
    idp.service.on(
      'beforeWellKnownOpenIdConfiguration',
      (response: { body: { issuer: string } }) => {
        response.body.issuer = issuer;
      },
    );
    withClaims(idp, { iss: issuer });
    app = await buildTestApp({}, idpOptions(idp, { oidcIssuer: issuer }));

    expect((await signIn(app)).sessionCookie).not.toBe('');
  });
});

describe('roles from the chosen claim', () => {
  async function rolesFrom(claims: Record<string, unknown>, config: Partial<Config>) {
    const started = await start({}, config);
    withClaims(started.idp, claims);
    const { sessionCookie, callback } = await signIn(started.app);
    expect(callback.headers.location).toBe(`${webOrigin}/`);
    return (await me(started.app, sessionCookie)).json<MeResponse>().roles;
  }

  it('reads a list from the named claim, with spaces in the values, and not from `roles`', async () => {
    expect(
      await rolesFrom(
        { groups: ['Architects (read and write)', 'Everyone'], roles: ['Admin'] },
        { OIDC_ROLES_CLAIM: 'groups', OIDC_ROLE_MODELLER: 'Architects (read and write)' },
      ),
    ).toEqual(['Modeller']);
  });

  it('reads a single text', async () => {
    expect(
      await rolesFrom(
        { role: 'App Admins' },
        { OIDC_ROLES_CLAIM: 'role', OIDC_ROLE_ADMIN: 'App Admins' },
      ),
    ).toEqual(['Admin']);
  });

  it('reads a claim whose name is an address, as one name', async () => {
    const claim = 'https://app.example.test/roles';
    expect(await rolesFrom({ [claim]: ['Viewer'] }, { OIDC_ROLES_CLAIM: claim })).toEqual([
      'Viewer',
    ]);
  });

  it.each([
    ['a missing claim', {}, 'groups'],
    ['a nested claim', { realm: { roles: ['Admin'] } }, 'realm.roles'],
    ['the name of a built-in property', {}, 'constructor'],
    ['a value in another case', { groups: ['admin'] }, 'groups'],
    ['part of a value', { groups: ['Admin Team'] }, 'groups'],
    ['a value with extra spaces', { groups: 'Admin ' }, 'groups'],
    ['a single text that holds a value', { groups: 'NotAdmin' }, 'groups'],
    ['a single text listing values', { groups: 'Admin Modeller,Viewer' }, 'groups'],
    ['a number', { groups: 1 }, 'groups'],
    ['true', { groups: true }, 'groups'],
    ['null', { groups: null }, 'groups'],
    ['an object naming a role', { groups: { Admin: true, 0: 'Admin' } }, 'groups'],
    ['a list of non-texts', { groups: [1, null, {}, ['Admin'], { Admin: 'Admin' }] }, 'groups'],
    ['the name __proto__', {}, '__proto__'],
    ['the name toString', {}, 'toString'],
  ])('gives no role for %s', async (_name, claims, name) => {
    expect(await rolesFrom(claims, { OIDC_ROLES_CLAIM: name })).toEqual([]);
  });

  it('takes the matching values from a list that also holds non-texts', async () => {
    expect(
      await rolesFrom({ groups: [1, null, ['Admin'], 'Viewer'] }, { OIDC_ROLES_CLAIM: 'groups' }),
    ).toEqual(['Viewer']);
  });

  it.each([
    ['`oid` when the provider sends it', { oid: 'made-up-oid', sub: 'made-up-sub' }, 'made-up-oid'],
    ['`sub` otherwise', { sub: 'made-up-sub' }, 'made-up-sub'],
  ])('keeps the user id: %s', async (_name, claims, id) => {
    const started = await start();
    withClaims(started.idp, claims);
    const logs = captureLogs(started.app);
    await signIn(started.app);
    const signedIn = logs
      .map((line) => JSON.parse(line) as { msg: string; userId?: string })
      .find((line) => line.msg === 'signed in');
    expect(signedIn?.userId).toBe(id);
  });
});

describe('signing out at the provider', () => {
  // On a page with Referrer-Policy: no-referrer, browsers send Origin: null with a form post,
  // so the CSRF check refuses the sign-out form (seen in Chromium).
  it('serves the app under a referrer policy that keeps the Origin of the sign-out form', async () => {
    app = await buildTestApp();
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    expect(res.headers['referrer-policy']).toBe('same-origin');
  });

  it('still refuses a sign-out sent with Origin: null', async () => {
    const { app: target } = await start({});
    const { sessionCookie: cookie } = await signIn(target);
    const res = await target.inject({
      method: 'POST',
      url: '/auth/logout',
      headers: { origin: 'null', cookie },
    });
    expect(res.statusCode).toBe(403);
  });

  const signOut = async (
    metadata: Record<string, unknown>,
  ): Promise<{
    res: LightMyRequestResponse;
    logs: string[];
    cookie: string;
    target: FastifyInstance;
  }> => {
    const { app: target } = await start(metadata);
    const logs = captureLogs(target);
    const { sessionCookie: cookie } = await signIn(target);
    return { res: await logout(target, cookie), logs, cookie, target };
  };

  it('leaves for an address on another origin by a page, not a redirect form-action would block', async () => {
    const { res, cookie, target } = await signOut({
      end_session_endpoint: 'https://signout.example.test/end?tenant=a&x=%3Cb%3E',
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('text/html; charset=utf-8');
    // Browsers apply form-action to the redirects of a form post. There are none here.
    expect(res.headers.location).toBeUndefined();
    expect(String(res.headers['content-security-policy'])).toMatch(/form-action 'self'(;|$)/);
    // The same policy holds: the page runs no script of its own.
    expect(res.body).not.toMatch(/<script|<style|<form|\son\w+=/);
    const address = leavesFor(res);
    expect(address.origin).toBe('https://signout.example.test');
    expect(address.searchParams.get('tenant')).toBe('a');
    expect(address.searchParams.get('client_id')).toBe(clientId);
    expect(address.searchParams.has('id_token_hint')).toBe(false);
    // A link too, for browsers that block automatic refresh; `&` escaped, nothing unescaped.
    expect(res.body).toContain(`<a href="${address.href.replaceAll('&', '&amp;')}">`);
    expect(res.body).not.toContain('tenant=a&x');
    expect(res.headers['cache-control']).toBe('no-store');
    expect((await me(target, cookie)).statusCode).toBe(401);
  });

  it('escapes the address in the page', async () => {
    const { res } = await signOut({
      end_session_endpoint: `https://signout.example.test/it's/end`,
    });
    expect(res.body).toContain('it&#39;s');
    expect(res.body).not.toContain("it's");
    expect(leavesFor(res).origin).toBe('https://signout.example.test');
  });

  it('goes to the home page without a warning when the provider has no address', async () => {
    const { res, logs, cookie, target } = await signOut({ end_session_endpoint: undefined });

    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe(`${webOrigin}/`);
    expect(res.cookies.find((c) => c.name.endsWith('sa_session'))?.value).toBe('');
    expect((await me(target, cookie)).statusCode).toBe(401);
    expect(lines(logs, 40)).toEqual([]);
  });

  it('still answers with the home page, with a warning, when the provider cannot be reached', async () => {
    app = await buildTestApp(
      { LOG_LEVEL: 'info' },
      { oidcIssuer: 'http://127.0.0.1:9/unreachable', allowInsecureOidcRequests: true },
    );
    const logs = captureLogs(app);

    const res = await logout(app, 'sa_session=unknown');

    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe(`${webOrigin}/`);
    expect(logs.join('\n')).toContain('end-session address unavailable');
  });
});
