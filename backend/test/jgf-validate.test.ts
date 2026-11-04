import type { JgfDocument, ValidationIssue } from '@simplearchitecture/shared';
import { describe, expect, it } from 'vitest';
import { sampleModel } from '../src/jgf/sample.js';
import {
  countJgf,
  maxEchoLength,
  maxListedIssues,
  maxListedIssuesPerItem,
  validateJgf,
} from '../src/jgf/validate.js';
import { expectGrowthBelow } from './growth.js';

/** A small valid document (made up); each test breaks one thing. */
function validDocument(): JgfDocument & {
  graph: Required<Pick<JgfDocument['graph'], 'nodes' | 'edges'>>;
} {
  return {
    graph: {
      id: 'g',
      label: 'Garden centre',
      directed: true,
      nodes: {
        visitor: { label: 'Visitor', metadata: { type: 'Stakeholder' } },
        sales: { label: 'Plant sales', metadata: { type: 'Business', owningTeam: 'Shop floor' } },
        till: {
          label: 'Till app',
          metadata: {
            type: 'Application',
            description: 'Rings up plants.',
            architectureState: 'Current',
            functions: ['Scan', 'Pay'],
            owningTeam: 'IT',
            sourcing: 'Buy',
            supplierHqCountry: 'DE',
            anyCustomKey: { nested: [1, 2, 3] },
          },
        },
        router: {
          label: 'Router',
          metadata: { type: 'Infrastructure', architectureState: 'Deprecate', functions: [] },
        },
        policy: { metadata: { type: 'Other' } },
      },
      edges: [
        {
          id: 'e1',
          source: 'visitor',
          target: 'till',
          relation: 'Relation',
          metadata: { informationFlow: true },
        },
        {
          id: 'e2',
          source: 'till',
          target: 'router',
          relation: 'Relation',
          directed: true,
          label: 'LAN',
          metadata: { protocol: 'TCP' },
        },
      ],
    },
  };
}

function only(issues: ValidationIssue[]): ValidationIssue {
  expect(issues).toHaveLength(1);
  return issues[0] as ValidationIssue;
}

describe('validateJgf: valid documents', () => {
  it('passes a valid document and summarises it per node type and edge type', () => {
    const result = validateJgf(validDocument());

    expect(result).toMatchObject({ valid: true, errorCount: 0, warningCount: 0, truncated: false });
    expect(result.summary).toEqual({
      nodes: {
        total: 5,
        byType: { Stakeholder: 1, Business: 1, Application: 1, Infrastructure: 1, Other: 1 },
      },
      edges: { total: 2, byRelation: { Relation: 2, Contains: 0 } },
    });
  });

  it('passes the sample export model', () => {
    expect(validateJgf(sampleModel)).toMatchObject({ valid: true, warningCount: 0 });
  });

  it('passes an empty graph, and edges without ids', () => {
    expect(validateJgf({ graph: {} }).valid).toBe(true);
    const doc = validDocument();
    doc.graph.edges = [{ source: 'visitor', target: 'till', relation: 'Relation' }];
    expect(validateJgf(doc).valid).toBe(true);
  });

  it('allows any custom metadata on nodes and edges', () => {
    const doc = validDocument();
    Object.assign(doc.graph.nodes.policy?.metadata ?? {}, { reviewDate: '2027-01-01', score: 3 });
    expect(validateJgf(doc).valid).toBe(true);
  });
});

describe('validateJgf: JGF v2 structure', () => {
  it.each([
    ['not an object', [], '', 'must be a JSON object with a graph'],
    ['no graph', {}, 'graph', 'is required'],
    ['graph not an object', { graph: 'x' }, 'graph', 'must be an object'],
  ])('rejects a document that is %s', (_name, input, field, text) => {
    const error = only(validateJgf(input).errors);
    expect(error).toMatchObject({ severity: 'error', field });
    expect(error.message).toContain(text);
  });

  it('rejects several graphs and unknown top-level fields', () => {
    const result = validateJgf({ graph: {}, graphs: [], extra: 1 });
    expect(result.errors.map((e) => e.field)).toEqual(['graphs', 'extra']);
    expect(result.errors[0]?.message).toContain('single graph');
  });

  it('requires nodes to be an object keyed by id and edges to be a list', () => {
    const result = validateJgf({ graph: { nodes: [], edges: {} } });
    expect(result.errors.map((e) => [e.field, e.message])).toEqual([
      ['graph.nodes', 'Document: graph.nodes must be an object keyed by node id'],
      ['graph.edges', 'Document: graph.edges must be a list'],
    ]);
  });

  it('rejects unknown graph, node and edge fields, naming the node or edge', () => {
    const doc = validDocument() as unknown as { graph: Record<string, unknown> };
    doc.graph.colour = 'red';
    Object.assign((doc.graph.nodes as Record<string, object>).visitor ?? {}, {
      type: 'Stakeholder',
    });
    Object.assign((doc.graph.edges as object[])[0] ?? {}, { weight: 2 });

    const result = validateJgf(doc);
    expect(result.errors.map((e) => [e.nodeId ?? e.edgeId ?? '', e.field, e.code])).toEqual([
      ['', 'graph.colour', 'unknown-field'],
      ['visitor', 'type', 'unknown-field'],
      ['e1', 'weight', 'unknown-field'],
    ]);
    expect(result.errors[1]?.message).toBe(
      'Node "visitor": type is not a JGF v2 field (put custom data in metadata)',
    );
  });

  it('checks field types', () => {
    const doc = validDocument() as unknown as { graph: Record<string, unknown> };
    doc.graph.directed = 'yes';
    (doc.graph.nodes as Record<string, unknown>).visitor = { label: 7, metadata: 'x' };
    (doc.graph.edges as unknown[]).push('not an edge');

    const result = validateJgf(doc);
    expect(result.errors.map((e) => e.message)).toEqual([
      'Document: graph.directed must be true or false',
      'Node "visitor": label must be text',
      'Node "visitor": metadata must be an object',
      'Edge "edges[2]": must be an object',
    ]);
  });

  it('requires edge source and target, naming an edge without id by its position', () => {
    const doc = validDocument() as unknown as { graph: { edges: unknown[] } };
    doc.graph.edges = [{ relation: 'Relation' }];

    const result = validateJgf(doc);
    expect(result.errors.map((e) => e.message)).toEqual([
      'Edge "edges[0]": source is required',
      'Edge "edges[0]": target is required',
    ]);
    expect(result.errors[0]?.edgeId).toBe('edges[0]');
  });

  it('rejects an empty node id and duplicate edge ids', () => {
    const doc = validDocument();
    doc.graph.nodes[''] = { metadata: { type: 'Other' } };
    doc.graph.edges.push({ id: 'e1', source: 'visitor', target: 'till', relation: 'Relation' });

    const codes = validateJgf(doc).errors.map((e) => [e.nodeId ?? e.edgeId, e.code]);
    expect(codes).toEqual([
      ['', 'invalid-structure'],
      ['e1', 'duplicate-edge-id'],
    ]);
  });
});

describe('validateJgf: metamodel rules', () => {
  it('requires a node type', () => {
    const doc = validDocument();
    doc.graph.nodes.policy = { label: 'Policy' };
    const error = only(validateJgf(doc).errors);
    expect(error).toMatchObject({
      code: 'missing-node-type',
      nodeId: 'policy',
      field: 'metadata.type',
    });
    expect(error.message).toBe(
      'Node "policy": metadata.type is required (one of Stakeholder, Business, Application, Infrastructure, Other)',
    );
  });

  it.each([['Server'], ['application'], [42]])('rejects the unknown node type %j', (type) => {
    const doc = validDocument();
    doc.graph.nodes.policy = { metadata: { type } };
    const error = only(validateJgf(doc).errors);
    expect(error).toMatchObject({
      code: 'unknown-node-type',
      nodeId: 'policy',
      field: 'metadata.type',
    });
    expect(error.message).toContain('is not a node type');
  });

  it('requires a known edge relation', () => {
    const doc = validDocument();
    doc.graph.edges = [
      { id: 'no-relation', source: 'visitor', target: 'till' },
      { id: 'bad-relation', source: 'visitor', target: 'till', relation: 'Serving' },
    ];
    const result = validateJgf(doc);
    expect(result.errors.map((e) => [e.edgeId, e.field, e.code])).toEqual([
      ['no-relation', 'relation', 'missing-relation'],
      ['bad-relation', 'relation', 'unknown-relation'],
    ]);
    expect(result.errors[1]?.message).toBe(
      'Edge "bad-relation": relation "Serving" is not an edge type (use one of Relation, Contains)',
    );
  });

  it('requires edges to point to existing nodes', () => {
    const doc = validDocument();
    doc.graph.edges = [
      { id: 'dangling', source: 'ghost', target: 'phantom', relation: 'Relation' },
    ];
    const result = validateJgf(doc);
    expect(result.errors.map((e) => [e.edgeId, e.field, e.code])).toEqual([
      ['dangling', 'source', 'unknown-node'],
      ['dangling', 'target', 'unknown-node'],
    ]);
    expect(result.errors[0]?.message).toBe(
      'Edge "dangling": source "ghost" is not a node in this graph',
    );
  });

  it.each([
    ['architectureState', 'Legacy', 'must be one of Deprecate, Current, Target (got "Legacy")'],
    ['architectureState', 'current', 'must be one of Deprecate, Current, Target (got "current")'],
    ['sourcing', 'Rent', 'must be one of Build, Buy (got "Rent")'],
    ['functions', 'Scan', 'must be a list of text values'],
    ['functions', ['Scan', 3], 'must be a list of text values'],
    ['description', 12, 'must be text'],
    ['owningTeam', null, 'must be text'],
    ['supplierHqCountry', 31, 'must be text'],
  ])('rejects an invalid %s value (%j)', (key, value, problem) => {
    const doc = validDocument();
    (doc.graph.nodes.till?.metadata ?? {})[key] = value;
    const error = only(validateJgf(doc).errors);
    expect(error).toMatchObject({
      severity: 'error',
      code: 'invalid-property-value',
      nodeId: 'till',
      field: `metadata.${key}`,
      message: `Node "till": metadata.${key} ${problem}`,
    });
  });

  it.each([['Netherlands'], ['nl'], ['XX'], ['NLD']])(
    'warns, but does not reject, a non-ISO supplierHqCountry (%s)',
    (country) => {
      const doc = validDocument();
      (doc.graph.nodes.till?.metadata ?? {}).supplierHqCountry = country;
      const result = validateJgf(doc);
      expect(result.valid).toBe(true);
      expect(only(result.warnings)).toMatchObject({
        severity: 'warning',
        code: 'non-iso-country',
        nodeId: 'till',
        field: 'metadata.supplierHqCountry',
      });
    },
  );

  it('warns when a standard property is used on a node type that does not have it', () => {
    const doc = validDocument();
    Object.assign(doc.graph.nodes.sales?.metadata ?? {}, { sourcing: 'Build', functions: 'x' });
    const result = validateJgf(doc);
    expect(result.valid).toBe(true);
    expect(result.warnings.map((w) => [w.field, w.code])).toEqual([
      ['metadata.sourcing', 'not-standard-for-type'],
      ['metadata.functions', 'not-standard-for-type'],
    ]);
    expect(result.warnings[0]?.message).toBe(
      'Node "sales": metadata.sourcing is not a standard property of Business nodes; it is kept as custom metadata',
    );
  });

  it('still checks standard property values on a node with an unknown type', () => {
    const doc = validDocument();
    doc.graph.nodes.till = { metadata: { type: 'Gadget', architectureState: 'Maybe' } };
    expect(validateJgf(doc).errors.map((e) => e.code)).toEqual([
      'unknown-node-type',
      'invalid-property-value',
    ]);
  });
});

describe('validateJgf: reporting', () => {
  it('returns every problem at once, errors and warnings apart', () => {
    const doc = validDocument() as unknown as { graph: Record<string, unknown> };
    doc.graph.nodes = {
      a: { metadata: { type: 'Nope' } },
      b: {
        metadata: { type: 'Application', architectureState: 'Old', supplierHqCountry: 'Narnia' },
      },
      c: { metadata: {} },
    };
    doc.graph.edges = [
      { id: 'x', source: 'a', target: 'zzz', relation: 'Relation' },
      { id: 'y', source: 'b', target: 'c', relation: 'Flow' },
    ];

    const result = validateJgf(doc);
    expect(result.valid).toBe(false);
    expect(result.errors.map((e) => `${e.nodeId ?? e.edgeId ?? ''}:${e.field}`)).toEqual([
      'a:metadata.type',
      'b:metadata.architectureState',
      'c:metadata.type',
      'x:target',
      'y:relation',
    ]);
    expect(result.warnings.map((w) => `${w.nodeId ?? ''}:${w.field}`)).toEqual([
      'b:metadata.supplierHqCountry',
    ]);
    expect(result).toMatchObject({ errorCount: 5, warningCount: 1, truncated: false });
  });

  it(`lists at most ${maxListedIssues} errors, with complete counts`, () => {
    const nodes = Object.fromEntries(
      Array.from({ length: maxListedIssues + 5 }, (_, i) => [
        `n${i}`,
        { metadata: { type: 'Bad' } },
      ]),
    );
    const result = validateJgf({ graph: { nodes } });
    expect(result.errors).toHaveLength(maxListedIssues);
    expect(result.errorCount).toBe(maxListedIssues + 5);
    expect(result.truncated).toBe(true);
  });
});

describe('validateJgf: hostile input', () => {
  it('treats prototype-like names as ordinary ids, keys and values', () => {
    const result = validateJgf({
      graph: {
        nodes: {
          constructor: {
            metadata: { type: 'Other', constructor: 'x', toString: 1, hasOwnProperty: null },
          },
          toString: { metadata: { type: 'toString' } },
        },
        edges: [
          { id: 'valueOf', source: 'constructor', target: 'toString', relation: 'constructor' },
          { source: 'hasOwnProperty', target: 'constructor', relation: 'Relation' },
        ],
      },
    });
    expect(result.errors.map((e) => `${e.nodeId ?? e.edgeId ?? ''}:${e.code}`)).toEqual([
      'toString:unknown-node-type',
      'valueOf:unknown-relation',
      'edges[1]:unknown-node',
    ]);
    expect(result.summary.nodes.byType.Other).toBe(1);
    expect(({} as Record<string, unknown>).type).toBeUndefined();
  });

  // Every issue repeats the full node id (in `message` and `nodeId`), so one node with a
  // long id and many unknown fields turns a 0.1 MB upload into a 200 MB response.
  it('keeps the result small when a node with a long id has many problems', () => {
    const id = 'x'.repeat(100_000);
    const node = Object.fromEntries(Array.from({ length: 1000 }, (_, i) => [`k${i}`, 0]));
    const input = { graph: { nodes: { [id]: node } } };
    const result = validateJgf(input);
    expect(result.errorCount).toBe(1001);
    expect(JSON.stringify(result).length).toBeLessThan(10 * JSON.stringify(input).length);
  });

  it('cuts long ids and field names, and stays fast and small with a 1 MB id', async () => {
    const id = 'y'.repeat(1024 * 1024);
    const node = Object.fromEntries(
      Array.from({ length: 1000 }, (_, i) => [`${'k'.repeat(500)}${i}`, 0]),
    );
    const result = validateJgf({ graph: { nodes: { [id]: node } } });
    // The 1 MB id costs about what a short one does: it isn't carried into each of the 1001 issues.
    const inputs = new Map(
      ['short', id].map((key) => [key, { graph: { nodes: { [key]: node } } }]),
    );
    await expectGrowthBelow((key: string) => () => validateJgf(inputs.get(key)), 'short', id);

    expect(result.errorCount).toBe(1001);
    expect(result.truncated).toBe(true);
    expect(result.errors).toHaveLength(maxListedIssuesPerItem);
    for (const error of result.errors) {
      expect(error.nodeId).toBe(`${'y'.repeat(maxEchoLength)}…`);
      expect(error.field.length).toBeLessThanOrEqual(maxEchoLength + 1);
      expect(error.message.length).toBeLessThan(400);
    }
    expect(JSON.stringify(result).length).toBeLessThan(20_000);
  });

  it(`lists at most ${maxListedIssuesPerItem} issues per node or edge, so others still show`, () => {
    const noisy = Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`x${i}`, 0]));
    const result = validateJgf({
      graph: {
        nodes: { noisy: { ...noisy, metadata: { type: 'Other' } }, quiet: { metadata: {} } },
        edges: [{ id: 'e', source: 'noisy', target: 'nowhere', relation: 'Relation' }],
      },
    });
    expect(result.errorCount).toBe(52);
    expect(result.errors.filter((e) => e.nodeId === 'noisy')).toHaveLength(maxListedIssuesPerItem);
    expect(result.errors.filter((e) => e.nodeId === 'quiet').map((e) => e.code)).toEqual([
      'missing-node-type',
    ]);
    expect(result.errors.filter((e) => e.edgeId === 'e').map((e) => e.code)).toEqual([
      'unknown-node',
    ]);
    expect(result.truncated).toBe(true);
  });

  it('refuses the reserved __proto__ as a node id, edge id or metadata key', () => {
    // JSON.parse keeps __proto__ as an own key, as a caller could pass it.
    const input: unknown = JSON.parse(
      '{"graph":{"nodes":{"__proto__":{"metadata":{"type":"Other"}},' +
        '"a":{"metadata":{"type":"Other","__proto__":{"x":1}}}},' +
        '"edges":[{"id":"__proto__","source":"a","target":"a","relation":"Relation"}]}}',
    );
    const result = validateJgf(input);
    expect(result.errors.map((e) => [e.nodeId ?? e.edgeId, e.field, e.code])).toEqual([
      ['__proto__', '', 'reserved-id'],
      ['a', 'metadata.__proto__', 'reserved-key'],
      ['__proto__', 'id', 'reserved-id'],
    ]);
    expect(({} as Record<string, unknown>).x).toBeUndefined();
  });

  it('counts nodes and edges for the size caps without validating', () => {
    expect(countJgf({ graph: { nodes: { a: {}, b: 1 }, edges: [1, 2, 3] } })).toEqual({
      nodes: 2,
      edges: 3,
    });
    expect(countJgf({ graph: { nodes: [], edges: {} } })).toEqual({ nodes: 0, edges: 0 });
    expect(countJgf('x')).toEqual({ nodes: 0, edges: 0 });
  });
});

describe('validateJgf: standard edge properties', () => {
  const e1 = (metadata: Record<string, unknown>) => ({
    id: 'e1',
    source: 'visitor',
    target: 'till',
    relation: 'Relation',
    metadata,
  });
  const e2 = (metadata: Record<string, unknown>, relation = 'Relation') => ({
    id: 'e2',
    source: 'till',
    target: 'router',
    relation,
    metadata,
  });

  it('accepts every Architecture state on every edge type, and custom edge metadata', () => {
    const doc = validDocument();
    doc.graph.edges = [
      e1({ architectureState: 'Target' }),
      // Node-only standard keys are plain custom metadata on an edge.
      e2({ architectureState: 'Deprecate', protocol: 'TCP', description: 'W', sourcing: 'any' }),
    ];
    const result = validateJgf(doc);
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it('refuses an invalid Architecture state on a node, but only warns on an edge', () => {
    const doc = validDocument();
    doc.graph.edges = [e1({}), e2({ architectureState: 'Target state' })];
    doc.graph.nodes.router = {
      label: 'Router',
      metadata: { type: 'Infrastructure', architectureState: 'Later' },
    };
    const result = validateJgf(doc);
    expect(result.valid).toBe(false);
    const issue = (e: ValidationIssue) => [e.severity, e.code, e.nodeId ?? e.edgeId, e.field];
    expect(result.errors.map(issue)).toEqual([
      ['error', 'invalid-property-value', 'router', 'metadata.architectureState'],
    ]);
    expect(result.warnings.map(issue)).toEqual([
      ['warning', 'invalid-property-value', 'e2', 'metadata.architectureState'],
    ]);
    expect(result.warnings[0]?.message).toBe(
      'Edge "e2": metadata.architectureState must be one of Deprecate, Current, Target (got "Target state"); it is read as Current',
    );
  });

  it('keeps a model with only bad edge states valid, so a stored model stays readable', () => {
    const doc = validDocument();
    doc.graph.edges = [e1({ architectureState: 'Target state' }), e2({ architectureState: 7 })];
    const result = validateJgf(doc);
    expect(result.valid).toBe(true);
    expect(result.warningCount).toBe(2);
  });

  it('checks the state on an edge of unknown type too, and refuses a reserved key', () => {
    const doc = validDocument();
    const metadata = JSON.parse('{"architectureState":3,"__proto__":{"x":1}}') as Record<
      string,
      unknown
    >;
    doc.graph.edges = [e1({}), e2(metadata, 'Data')];
    const result = validateJgf(doc);
    expect(result.errors.map((e) => [e.code, e.field])).toEqual([
      ['reserved-key', 'metadata.__proto__'],
      ['unknown-relation', 'relation'],
    ]);
    expect(result.warnings.map((e) => [e.code, e.field])).toEqual([
      ['invalid-property-value', 'metadata.architectureState'],
    ]);
  });

  it('accepts edges without metadata (missing means Current)', () => {
    expect(validateJgf(validDocument()).valid).toBe(true);
  });
});
