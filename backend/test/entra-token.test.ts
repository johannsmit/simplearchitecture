import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DatabaseError } from '../src/db/db.js';
import {
  entraTokenPassword,
  entraUnreachable,
  postgresTokenScope,
  renewBeforeExpiryMs,
  type WorkloadIdentity,
} from '../src/db/entra-token.js';

interface Asked {
  url: string;
  form: Record<string, string>;
}

describe('the database password from Entra ID', () => {
  let dir: string;
  let identity: WorkloadIdentity;
  let asked: Asked[];
  let time: number;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sa-entra-'));
    const tokenFile = join(dir, 'azure-identity-token');
    writeFileSync(tokenFile, 'made-up-workload-token-1\n');
    identity = {
      authorityHost: 'https://login.example.test/',
      tenantId: 'made-up-tenant',
      clientId: 'made-up-identity',
      tokenFile,
    };
    asked = [];
    time = 1_000_000;
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** A token endpoint that answers each request with `answer(n)`, n counting from 1. */
  function endpoint(answer: (n: number) => Response): typeof fetch {
    return (async (url: URL | string, init?: RequestInit) => {
      asked.push({
        url: String(url),
        form: Object.fromEntries(new URLSearchParams(init?.body as URLSearchParams)),
      });
      await Promise.resolve();
      return answer(asked.length);
    }) as typeof fetch;
  }
  const token = (n: number) =>
    Response.json({ access_token: `made-up-db-token-${n}`, expires_in: 3600 });
  const password = (post: typeof fetch) =>
    entraTokenPassword(identity, { fetch: post, now: () => time });

  it("asks the tenant's token endpoint for the server's scope with the workload's token", async () => {
    expect(await password(endpoint(token))()).toBe('made-up-db-token-1');
    expect(asked).toEqual([
      {
        url: 'https://login.example.test/made-up-tenant/oauth2/v2.0/token',
        form: {
          grant_type: 'client_credentials',
          client_id: 'made-up-identity',
          scope: postgresTokenScope,
          client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
          client_assertion: 'made-up-workload-token-1',
        },
      },
    ]);
  });

  it('accepts the authority host without its trailing slash', async () => {
    identity.authorityHost = 'https://login.example.test';
    await password(endpoint(token))();
    expect(asked[0]?.url).toBe('https://login.example.test/made-up-tenant/oauth2/v2.0/token');
  });

  it('keeps the token until shortly before it expires, then renews it with the current file', async () => {
    const get = password(endpoint(token));
    expect(await get()).toBe('made-up-db-token-1');
    time += 3_600_000 - renewBeforeExpiryMs - 1;
    expect(await get()).toBe('made-up-db-token-1');
    expect(asked).toHaveLength(1);

    writeFileSync(identity.tokenFile, 'made-up-workload-token-2');
    time += 1;
    expect(await get()).toBe('made-up-db-token-2');
    expect(asked.map((a) => a.form.client_assertion)).toEqual([
      'made-up-workload-token-1',
      'made-up-workload-token-2',
    ]);
  });

  it('asks once for connections opened at the same time', async () => {
    const get = password(endpoint(token));
    expect(await Promise.all([get(), get(), get()])).toEqual([
      'made-up-db-token-1',
      'made-up-db-token-1',
      'made-up-db-token-1',
    ]);
    expect(asked).toHaveLength(1);
  });

  it("fails as an identity problem with Entra's error number only, and asks again next time", async () => {
    const refused = () =>
      Response.json(
        {
          error: 'invalid_client',
          error_description: 'AADSTS700213: No matching federated identity record found',
          error_codes: [700213],
        },
        { status: 400 },
      );
    const get = password(endpoint((n) => (n === 1 ? refused() : token(n))));
    const error: unknown = await get().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DatabaseError);
    expect(error).toMatchObject({ failure: 'identity', code: 'AADSTS700213' });
    expect((error as Error).message).not.toContain('made-up-workload-token');
    expect(await get()).toBe('made-up-db-token-2');
  });

  it.each([undefined, 'soon', 0, 300])(
    'does not keep a token whose lifetime is %j, and asks again for the next connection',
    async (expiresIn) => {
      const get = password(
        endpoint((n) =>
          Response.json({ access_token: `made-up-db-token-${String(n)}`, expires_in: expiresIn }),
        ),
      );
      expect(await get()).toBe('made-up-db-token-1');
      expect(await get()).toBe('made-up-db-token-2');
    },
  );

  it('keeps a token whose lifetime comes as a string', async () => {
    const get = password(
      endpoint(() => Response.json({ access_token: 'made-up-db-token', expires_in: '3600' })),
    );
    await get();
    await get();
    expect(asked).toHaveLength(1);
  });

  it.each([
    ['an answer without a token', () => Response.json({}), 'HTTP_200'],
    ['a server error without details', () => new Response('oops', { status: 503 }), 'HTTP_503'],
    [
      'an error number that is not a whole number',
      () => Response.json({ error_codes: ['AADSTS1 text'] }, { status: 400 }),
      'HTTP_400',
    ],
  ])('fails on %s', async (_name, answer, code) => {
    await expect(password(endpoint(answer))()).rejects.toMatchObject({ failure: 'identity', code });
  });

  it('fails as unreachable Entra when the request does not get through', async () => {
    const offline = (() => Promise.reject(new TypeError('fetch failed'))) as typeof fetch;
    await expect(password(offline)()).rejects.toMatchObject({
      failure: 'identity',
      code: entraUnreachable,
    });
  });

  it('fails without asking when the token file is missing', async () => {
    rmSync(identity.tokenFile);
    await expect(password(endpoint(token))()).rejects.toMatchObject({
      failure: 'identity',
      code: 'ENOENT',
    });
    expect(asked).toHaveLength(0);
  });
});
