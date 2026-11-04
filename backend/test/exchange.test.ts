import { readFileSync } from 'node:fs';
import type {
  ApiError,
  JgfDocument,
  JgfValidationResult,
  OefImportResult,
} from '@simplearchitecture/shared';
import type { FastifyInstance } from 'fastify';
import type { OAuth2Server } from 'oauth2-mock-server';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { sampleModel } from '../src/jgf/sample.js';
import { maxImportEdges, maxImportNodes, maxJsonDepth } from '../src/limits.js';
import { jgfBodyLimit, oefBodyLimit } from '../src/routes/body.js';
import {
  buildTestApp,
  idpOptions,
  signIn,
  startMockIdp,
  webOrigin,
  withClaims,
} from './helpers.js';
import { expectGrowthBelow } from './growth.js';

const bakery = readFileSync(new URL('./fixtures/bakery-oef.xml', import.meta.url), 'utf8');

let idp: OAuth2Server;
let app: FastifyInstance | undefined;

beforeAll(async () => {
  idp = await startMockIdp();
});

afterAll(async () => {
  await idp.stop();
});

afterEach(async () => {
  idp.service.removeAllListeners('beforeTokenSigning');
  await app?.close();
  app = undefined;
});

async function start(): Promise<FastifyInstance> {
  app = await buildTestApp({}, idpOptions(idp));
  return app;
}

/** Starts the app and signs in with the given roles. Returns the session cookie. */
async function signedInAs(roles: string[]): Promise<{ target: FastifyInstance; cookie: string }> {
  const target = await start();
  withClaims(idp, { roles });
  const { sessionCookie } = await signIn(target);
  return { target, cookie: sessionCookie };
}

interface Send {
  cookie?: string;
  origin?: string | null;
  contentType?: string;
  payload?: string;
}

function post(target: FastifyInstance, url: string, send: Send = {}) {
  const origin = send.origin === undefined ? webOrigin : send.origin;
  return target.inject({
    method: 'POST',
    url,
    headers: {
      ...(origin === null ? {} : { origin }),
      ...(send.cookie ? { cookie: send.cookie } : {}),
      'content-type':
        send.contentType ?? (url.endsWith('/oef') ? 'application/xml' : 'application/json'),
    },
    payload: send.payload ?? (url.endsWith('/oef') ? bakery : JSON.stringify(sampleModel)),
  });
}

function get(target: FastifyInstance, url: string, cookie?: string) {
  return target.inject({ method: 'GET', url, headers: cookie ? { cookie } : {} });
}

const routes = [
  ['POST', '/api/import/jgf'],
  ['POST', '/api/import/oef'],
  ['GET', '/api/export/jgf'],
] as const;

function call(target: FastifyInstance, method: 'GET' | 'POST', url: string, cookie?: string) {
  return method === 'GET' ? get(target, url, cookie) : post(target, url, cookie ? { cookie } : {});
}

describe('import and export access (Modelling space: Modeller and Admin)', () => {
  it.each(routes)('%s %s returns 401 when signed out', async (method, url) => {
    const target = await start();
    const res = await call(target, method, url);
    expect(res.statusCode).toBe(401);
    expect(res.json<ApiError>().error).toBe('Unauthorized');
  });

  it.each([[['Viewer']], [[]], [['Superuser']]])(
    'roles %j get 403 on every route',
    async (roles) => {
      const { target, cookie } = await signedInAs(roles);
      for (const [method, url] of routes) {
        const res = await call(target, method, url, cookie);
        expect(res.statusCode, `${method} ${url}`).toBe(403);
        expect(res.json<ApiError>().message).toBe('You do not have access to this resource');
      }
    },
  );

  it.each([[['Modeller']], [['Admin']], [['Viewer', 'Modeller']]])(
    'roles %j may use every route',
    async (roles) => {
      const { target, cookie } = await signedInAs(roles);
      for (const [method, url] of routes) {
        const res = await call(target, method, url, cookie);
        expect(res.statusCode, `${method} ${url}`).toBe(200);
        expect(res.headers['cache-control']).toBe('no-store');
      }
    },
  );

  it.each(['/api/import/jgf', '/api/import/oef'])(
    'POST %s needs the web origin (CSRF), even for a Modeller',
    async (url) => {
      const { target, cookie } = await signedInAs(['Modeller']);
      for (const origin of [null, 'https://evil.example', 'http://localhost:3001']) {
        const res = await post(target, url, { cookie, origin });
        expect(res.statusCode, String(origin)).toBe(403);
        expect(res.json<ApiError>().message).toBe('Request origin not allowed');
      }
    },
  );
});

describe('body size limits', () => {
  it('refuses a JGF body over the limit with 413', async () => {
    const { target, cookie } = await signedInAs(['Modeller']);
    const res = await post(target, '/api/import/jgf', {
      cookie,
      payload: `{"graph":{"label":"${'x'.repeat(jgfBodyLimit)}"}}`,
    });
    expect(res.statusCode).toBe(413);
    expect(res.json<ApiError>()).toMatchObject({ statusCode: 413, error: 'Payload Too Large' });
  });

  it('accepts a JGF body above the default 1 MiB but within the limit', async () => {
    const { target, cookie } = await signedInAs(['Modeller']);
    const res = await post(target, '/api/import/jgf', {
      cookie,
      payload: JSON.stringify({ graph: { label: 'x'.repeat(2 * 1024 * 1024) } }),
    });
    expect(res.statusCode).toBe(200);
  });

  it('refuses an OEF body over 10 MB with 413', async () => {
    const { target, cookie } = await signedInAs(['Admin']);
    expect(oefBodyLimit).toBe(10 * 1024 * 1024);
    const res = await post(target, '/api/import/oef', {
      cookie,
      payload: `<model>${' '.repeat(oefBodyLimit)}</model>`,
    });
    expect(res.statusCode).toBe(413);
  });

  it('accepts an OEF file of a few MB', async () => {
    const { target, cookie } = await signedInAs(['Modeller']);
    const elements = Array.from(
      { length: 12_000 },
      (_, i) =>
        `<element identifier="e${i}" xsi:type="ApplicationComponent"><name xml:lang="en">App ${i}</name>` +
        `<documentation xml:lang="en">${'Made-up text. '.repeat(10)}</documentation></element>`,
    ).join('\n');
    const payload = bakery.replace('<elements>', `<elements>${elements}`);
    expect(payload.length).toBeGreaterThan(3 * 1024 * 1024);

    const res = await post(target, '/api/import/oef', { cookie, payload });
    expect(res.statusCode).toBe(200);
    expect(res.json<OefImportResult>().validation.summary.nodes.total).toBe(12_012);
  });

  it('checks access before reading an oversized body', async () => {
    const target = await start();
    const res = await post(target, '/api/import/oef', { payload: ' '.repeat(oefBodyLimit + 1) });
    expect(res.statusCode).toBe(401);
  });
});

describe('POST /api/import/jgf', () => {
  it('returns a summary of a valid file and stores nothing', async () => {
    const { target, cookie } = await signedInAs(['Modeller']);
    const body = (await post(target, '/api/import/jgf', { cookie })).json<JgfValidationResult>();
    expect(body).toMatchObject({ valid: true, errors: [], warnings: [], errorCount: 0 });
    expect(body.summary).toEqual({
      nodes: {
        total: 6,
        byType: { Stakeholder: 1, Business: 1, Application: 2, Infrastructure: 1, Other: 1 },
      },
      edges: { total: 3, byRelation: { Relation: 3, Contains: 0 } },
    });
    // Nothing stored: the export is still the sample.
    expect((await get(target, '/api/export/jgf', cookie)).json<JgfDocument>()).toEqual(sampleModel);
  });

  it('returns all errors and warnings of an invalid file, not just the first', async () => {
    const { target, cookie } = await signedInAs(['Modeller']);
    const payload = JSON.stringify({
      graph: {
        nodes: {
          a: { metadata: { type: 'Server' } },
          b: { metadata: { type: 'Application', sourcing: 'Lease', supplierHqCountry: 'Holland' } },
        },
        edges: [{ id: 'x', source: 'a', target: 'nowhere', relation: 'Calls' }],
      },
    });
    const res = await post(target, '/api/import/jgf', { cookie, payload });
    expect(res.statusCode).toBe(200);
    const body = res.json<JgfValidationResult>();
    expect(body.valid).toBe(false);
    expect(body.errors.map((e) => e.message)).toEqual([
      'Node "a": metadata.type "Server" is not a node type (use one of Stakeholder, Business, Application, Infrastructure, Other)',
      'Node "b": metadata.sourcing must be one of Build, Buy (got "Lease")',
      'Edge "x": relation "Calls" is not an edge type (use one of Relation, Contains)',
      'Edge "x": target "nowhere" is not a node in this graph',
    ]);
    expect(body.warnings.map((w) => [w.nodeId, w.field])).toEqual([
      ['b', 'metadata.supplierHqCountry'],
    ]);
  });

  it('answers 400 to malformed JSON', async () => {
    const { target, cookie } = await signedInAs(['Modeller']);
    const res = await post(target, '/api/import/jgf', { cookie, payload: '{"graph": ' });
    expect(res.statusCode).toBe(400);
  });

  it('refuses a prototype-poisoning body', async () => {
    const { target, cookie } = await signedInAs(['Modeller']);
    const res = await post(target, '/api/import/jgf', {
      cookie,
      payload: '{"graph":{"nodes":{"__proto__":{"metadata":{"type":"Other"}}}}}',
    });
    expect(res.statusCode).toBe(400);
  });

  it.each(['text/plain', 'application/xml'])('answers 415 to %s', async (contentType) => {
    const { target, cookie } = await signedInAs(['Modeller']);
    const res = await post(target, '/api/import/jgf', { cookie, contentType, payload: '{}' });
    expect(res.statusCode).toBe(415);
  });
});

describe('POST /api/import/oef', () => {
  it('returns the JGF, the mapping report and the validation result', async () => {
    const { target, cookie } = await signedInAs(['Modeller']);
    const res = await post(target, '/api/import/oef', { cookie });
    expect(res.statusCode).toBe(200);
    const body = res.json<OefImportResult>();
    expect(Object.keys(body.jgf.graph.nodes ?? {})).toHaveLength(12);
    expect(body.report.relationships.mapped).toEqual({
      Relation: 3,
      Contains: 0,
    });
    expect(body.report.viewsSkipped).toBe(2);
    expect(body.validation).toMatchObject({ valid: true, errorCount: 0, warningCount: 1 });
  });

  it('accepts text/xml with a charset', async () => {
    const { target, cookie } = await signedInAs(['Modeller']);
    const res = await post(target, '/api/import/oef', {
      cookie,
      contentType: 'text/xml; charset=utf-8',
    });
    expect(res.statusCode).toBe(200);
  });

  it.each([
    [
      'an XXE sample',
      '<?xml version="1.0"?><!DOCTYPE m [<!ENTITY x SYSTEM "file:///etc/passwd">]><model>&x;</model>',
    ],
    [
      'a billion-laughs sample',
      '<!DOCTYPE l [<!ENTITY a "aaaaaaaaaa"><!ENTITY b "&a;&a;&a;&a;&a;&a;&a;&a;&a;&a;">]><model>&b;</model>',
    ],
  ])('rejects %s with 400 and a clear message', async (_name, payload) => {
    const { target, cookie } = await signedInAs(['Modeller']);
    const res = await post(target, '/api/import/oef', { cookie, payload });
    expect(res.statusCode).toBe(400);
    expect(res.json<ApiError>().message).toBe('XML with a DOCTYPE declaration is not accepted.');
  });

  it.each([
    ['malformed XML', '<model><elements></model>', /not well-formed/],
    ['XML that is not an OEF model', '<html/>', /root element must be <model>/],
  ])('rejects %s with 400', async (_name, payload, message) => {
    const { target, cookie } = await signedInAs(['Modeller']);
    const res = await post(target, '/api/import/oef', { cookie, payload });
    expect(res.statusCode).toBe(400);
    expect(res.json<ApiError>().message).toMatch(message);
  });

  it.each(['application/json', 'text/plain'])('answers 415 to %s', async (contentType) => {
    const { target, cookie } = await signedInAs(['Modeller']);
    const res = await post(target, '/api/import/oef', {
      cookie,
      contentType,
      payload: '"<model/>"',
    });
    expect(res.statusCode).toBe(415);
  });
});

describe('GET /api/export/jgf', () => {
  it('returns the made-up sample model, which passes validation', async () => {
    const { target, cookie } = await signedInAs(['Modeller']);
    const res = await get(target, '/api/export/jgf', cookie);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/json');
    expect(res.json<JgfDocument>()).toEqual(sampleModel);

    const check = await post(target, '/api/import/jgf', { cookie, payload: res.body });
    expect(check.json<JgfValidationResult>()).toMatchObject({ valid: true, warningCount: 0 });
  });
});

describe('import limits and refusals at the edges', () => {
  it('accepts a body of exactly the limit on both routes', async () => {
    const { target, cookie } = await signedInAs(['Modeller']);
    const jgfStart = '{"graph":{"label":"';
    const jgf = `${jgfStart}${'x'.repeat(jgfBodyLimit - jgfStart.length - 3)}"}}`;
    expect(Buffer.byteLength(jgf)).toBe(jgfBodyLimit);
    expect((await post(target, '/api/import/jgf', { cookie, payload: jgf })).statusCode).toBe(200);

    const oefStart = '<model identifier="m">';
    const oef = `${oefStart}${' '.repeat(oefBodyLimit - oefStart.length - 8)}</model>`;
    expect(Buffer.byteLength(oef)).toBe(oefBodyLimit);
    expect((await post(target, '/api/import/oef', { cookie, payload: oef })).statusCode).toBe(200);
  });

  it.each(['/api/import/jgf', '/api/import/oef'])(
    'refuses a Viewer or a foreign origin on %s before reading an oversized body',
    async (url) => {
      const viewer = await signedInAs(['Viewer']);
      const payload = ' '.repeat(oefBodyLimit + 1);
      const asViewer = await post(viewer.target, url, { cookie: viewer.cookie, payload });
      expect(asViewer.statusCode).toBe(403);
      await viewer.target.close();

      const modeller = await signedInAs(['Modeller']);
      const foreign = await post(modeller.target, url, {
        cookie: modeller.cookie,
        origin: 'https://evil.example',
        payload,
      });
      expect(foreign.statusCode).toBe(403);
      expect(foreign.json<ApiError>().message).toBe('Request origin not allowed');
    },
  );

  it.each([
    ['/api/import/jgf', 'application/octet-stream'],
    ['/api/import/jgf', 'application/x-www-form-urlencoded'],
    ['/api/import/oef', 'application/octet-stream'],
    ['/api/import/oef', `application/${'evil'.repeat(1000)}`],
  ])('answers 415 on %s to %s, without echoing it', async (url, contentType) => {
    const { target, cookie } = await signedInAs(['Modeller']);
    const res = await post(target, url, { cookie, contentType, payload: 'x' });
    expect(res.statusCode).toBe(415);
    expect(res.body).not.toContain('evil');
    expect(res.body.length).toBeLessThan(200);
  });
});

describe('hardening', () => {
  it.each([
    ['/api/import/oef', 'application/json', oefBodyLimit],
    ['/api/import/jgf', 'text/plain', jgfBodyLimit],
  ])(
    'POST %s answers 415 to %s before reading an oversized body',
    async (url, contentType, limit) => {
      const { target, cookie } = await signedInAs(['Modeller']);
      const res = await post(target, url, { cookie, contentType, payload: 'x'.repeat(limit + 1) });
      expect(res.statusCode).toBe(415);
    },
  );

  it(`refuses a JGF file with more than ${maxImportNodes} nodes or ${maxImportEdges} edges with 413`, async () => {
    const { target, cookie } = await signedInAs(['Modeller']);
    const nodes = (count: number) =>
      `{${Array.from({ length: count }, (_, i) => `"n${i}":{}`).join(',')}}`;
    const tooManyNodes = await post(target, '/api/import/jgf', {
      cookie,
      payload: `{"graph":{"nodes":${nodes(maxImportNodes + 1)}}}`,
    });
    expect(tooManyNodes.statusCode).toBe(413);
    expect(tooManyNodes.json<ApiError>().message).toBe(
      `The model has more than ${maxImportNodes} nodes.`,
    );
    const tooManyEdges = await post(target, '/api/import/jgf', {
      cookie,
      payload: `{"graph":{"edges":[${Array(maxImportEdges + 1)
        .fill('{}')
        .join(',')}]}}`,
    });
    expect(tooManyEdges.statusCode).toBe(413);
    expect(tooManyEdges.json<ApiError>().message).toBe(
      `The model has more than ${maxImportEdges} edges.`,
    );
    const atTheCap = await post(target, '/api/import/jgf', {
      cookie,
      payload: `{"graph":{"nodes":${nodes(maxImportNodes)}}}`,
    });
    expect(atTheCap.statusCode).toBe(200);
  });

  it(`refuses an OEF file with more than ${maxImportNodes} elements with 413`, async () => {
    const { target, cookie } = await signedInAs(['Modeller']);
    const payload = `<model><elements>${'<element/>'.repeat(maxImportNodes + 1)}</elements></model>`;
    const res = await post(target, '/api/import/oef', { cookie, payload });
    expect(res.statusCode).toBe(413);
    expect(res.json<ApiError>().message).toBe(
      `The model has more than ${maxImportNodes} elements.`,
    );
  });

  it.each([
    ['__proto__ as a node id', '{"graph":{"nodes":{"__proto__":{"metadata":{"type":"Other"}}}}}'],
    ['__proto__ as a metadata key', '{"graph":{"nodes":{"a":{"metadata":{"__proto__":{}}}}}}'],
    ['constructor.prototype', '{"graph":{"constructor":{"prototype":{}}}}'],
  ])('refuses %s with a clear 400', async (_name, payload) => {
    const { target, cookie } = await signedInAs(['Modeller']);
    const res = await post(target, '/api/import/jgf', { cookie, payload });
    expect(res.statusCode).toBe(400);
    expect(res.json<ApiError>().message).toBe(
      'The key "__proto__" is reserved: it can\'t be a node id, edge id or metadata key.',
    );
  });

  it('still answers malformed JSON with a generic 400', async () => {
    const { target, cookie } = await signedInAs(['Modeller']);
    const res = await post(target, '/api/import/jgf', { cookie, payload: '{"graph":' });
    expect(res.json<ApiError>()).toMatchObject({
      statusCode: 400,
      message: 'Body is not valid JSON',
    });
  });

  it('never outputs an id the JGF import refuses: the OEF result posts back cleanly', async () => {
    const { target, cookie } = await signedInAs(['Modeller']);
    const payload = bakery.replace('identifier="e-baker"', 'identifier="__proto__"');
    const oef = (
      await post(target, '/api/import/oef', { cookie, payload })
    ).json<OefImportResult>();
    expect(oef.report.elements.skipped['reserved-identifier']).toEqual({ BusinessRole: 1 });
    const jgf = await post(target, '/api/import/jgf', { cookie, payload: JSON.stringify(oef.jgf) });
    expect(jgf.statusCode).toBe(200);
    expect(jgf.json<JgfValidationResult>().valid).toBe(true);
  });

  it('converts an empty <model/> to an empty graph', async () => {
    const { target, cookie } = await signedInAs(['Modeller']);
    const res = await post(target, '/api/import/oef', { cookie, payload: '<model/>' });
    expect(res.statusCode).toBe(200);
    expect(res.json<OefImportResult>().validation).toMatchObject({
      valid: true,
      summary: { nodes: { total: 0 }, edges: { total: 0 } },
    });
  });

  it('asks for UTF-8 when the file is UTF-16', async () => {
    const { target, cookie } = await signedInAs(['Modeller']);
    const res = await target.inject({
      method: 'POST',
      url: '/api/import/oef',
      headers: { origin: webOrigin, cookie, 'content-type': 'application/xml' },
      payload: Buffer.from('\ufeff<?xml version="1.0" encoding="UTF-16"?><model/>', 'utf16le'),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<ApiError>().message).toContain('Save the file as UTF-8');
  });

  it('keeps XML error bodies short whatever the names, and answers 400 to a huge tag', async () => {
    const { target, cookie } = await signedInAs(['Modeller']);
    for (const payload of [
      `<model><${'A'.repeat(5_000_000)}></model>`,
      `<model ${'a="x" '.repeat(1_200_000)} ! />`,
    ]) {
      const res = await post(target, '/api/import/oef', { cookie, payload });
      expect(res.statusCode).toBe(400);
      expect(res.body.length).toBeLessThan(400);
    }
  });
});

describe('JGF JSON parser', () => {
  // The reserved-key check was a JSON.parse reviver, which recurses, so JSON nested about
  // 3,000 levels deep overflowed the stack and was answered "Body is not valid JSON". Now the
  // parsed result is walked with an explicit stack, and nesting has a clear limit.
  const nested = (levels: number) =>
    `{"graph":{"nodes":{"a":{"metadata":{"type":"Other","deep":${'['.repeat(levels)}${']'.repeat(levels)}}}}}}`;

  it('answers deeply nested JSON with a clear 400, not "not valid JSON"', async () => {
    const { target, cookie } = await signedInAs(['Modeller']);
    for (const levels of [5000, 200_000]) {
      const res = await post(target, '/api/import/jgf', { cookie, payload: nested(levels) });
      expect(res.statusCode, String(levels)).toBe(400);
      expect(res.json<ApiError>().message).toBe(
        `The JSON is nested too deeply (more than ${maxJsonDepth} levels).`,
      );
    }
  });

  it(`accepts nesting up to ${maxJsonDepth} levels, and refuses one more`, async () => {
    const { target, cookie } = await signedInAs(['Modeller']);
    // The document is level 1 and metadata level 5, so the list is level 6.
    const atTheCap = await post(target, '/api/import/jgf', {
      cookie,
      payload: nested(maxJsonDepth - 5),
    });
    expect(atTheCap.statusCode).toBe(200);
    expect(atTheCap.json<JgfValidationResult>().valid).toBe(true);
    const overTheCap = await post(target, '/api/import/jgf', {
      cookie,
      payload: nested(maxJsonDepth - 4),
    });
    expect(overTheCap.statusCode).toBe(400);
  });

  it('counts objects and arrays alike, wherever they are', async () => {
    const { target, cookie } = await signedInAs(['Modeller']);
    const deepObject = `${'{"a":'.repeat(maxJsonDepth)}1${'}'.repeat(maxJsonDepth)}`;
    expect(
      (await post(target, '/api/import/jgf', { cookie, payload: deepObject })).statusCode,
    ).toBe(200);
    const tooDeep = `[${deepObject}]`;
    const res = await post(target, '/api/import/jgf', { cookie, payload: tooDeep });
    expect(res.json<ApiError>().message).toMatch(/nested too deeply/);
  });

  it('still finds a reserved key deep inside, and keeps a plain "constructor" key', async () => {
    const { target, cookie } = await signedInAs(['Modeller']);
    const reserved = await post(target, '/api/import/jgf', {
      cookie,
      payload: `{"graph":{"nodes":{"a":{"metadata":{"type":"Other","x":[[{"y":{"__proto__":1}}]]}}}}}`,
    });
    expect(reserved.json<ApiError>().message).toMatch(/is reserved/);
    const plain = await post(target, '/api/import/jgf', {
      cookie,
      payload: `{"graph":{"nodes":{"a":{"metadata":{"type":"Other","constructor":{"name":"x"}}}}}}`,
    });
    expect(plain.statusCode).toBe(200);
  });

  it('parses a large, realistic JGF body in linear time', async () => {
    const { target, cookie } = await signedInAs(['Modeller']);
    const payloadOf = (size: number) =>
      JSON.stringify({
        graph: {
          nodes: Object.fromEntries(
            Array.from({ length: size }, (_, i) => [
              `node-${i}`,
              {
                label: `Node ${i}`,
                metadata: {
                  type: 'Application',
                  description: 'Made-up text. '.repeat(10),
                  tags: ['a'],
                },
              },
            ]),
          ),
        },
      });
    const payloads = new Map([5000, 20_000].map((size) => [size, payloadOf(size)]));
    const payload = payloads.get(20_000);
    expect(payload?.length).toBeGreaterThan(4 * 1024 * 1024);
    await expectGrowthBelow(
      (size: number) => async () => {
        const res = await post(target, '/api/import/jgf', {
          cookie,
          payload: payloads.get(size) ?? '',
        });
        expect(res.statusCode).toBe(200);
      },
      5000,
      20_000,
    );
  });
});
