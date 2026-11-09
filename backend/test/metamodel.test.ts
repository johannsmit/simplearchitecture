import { readFileSync } from 'node:fs';
import {
  architectureStates,
  checkStandardProperty,
  edgeTypeDefinitions,
  edgeTypes,
  hasStandardProperty,
  isIsoCountryCode,
  nodeTypeDefinitions,
  nodeTypes,
  relationTextProperties,
  sourcingOptions,
  standardProperties,
} from '@simplearchitecture/shared';
import { describe, expect, it } from 'vitest';

// The template in metamodel/ is the source of truth (read only; never changed by code).
const template = JSON.parse(
  readFileSync(new URL('../../metamodel/default-metamodel-jgf.json', import.meta.url), 'utf8'),
) as {
  graph: {
    nodes: Record<string, { metadata: Record<string, unknown> }>;
    edges: { relation: string; metadata: Record<string, unknown> }[];
  };
};
const templateNode = Object.values(template.graph.nodes)[0]?.metadata ?? {};
const options = (value: unknown) => String(value).split(' | ');

describe('the metamodel in shared/ matches metamodel/', () => {
  it('has the same node types, edge types and option lists', () => {
    expect(nodeTypes).toEqual(options(templateNode.type));
    expect(edgeTypes).toEqual(options(template.graph.edges[0]?.relation));
    expect(architectureStates).toEqual(options(templateNode.architectureState));
    expect(sourcingOptions).toEqual(options(templateNode.sourcing));
  });

  it('has the same standard properties', () => {
    const keys = Object.keys(templateNode).filter(
      (key) => key !== 'type' && key !== 'anyCustomKey',
    );
    // The template's two-way Relation shows the properties only a Relation has.
    const relationKeys = Object.keys(template.graph.edges[1]?.metadata ?? {}).filter(
      (key) => !['architectureState', 'anyCustomKey'].includes(key),
    );
    expect(relationKeys).toEqual([...relationTextProperties]);
    expect(Object.keys(standardProperties).sort()).toEqual([...keys, ...relationKeys].sort());
  });

  it('gives each node type its standard properties', () => {
    const propertiesOf = Object.fromEntries(
      nodeTypes.map((type) => [type, [...nodeTypeDefinitions[type].properties].sort()]),
    );
    expect(propertiesOf).toEqual({
      Stakeholder: ['description'],
      Business: ['description', 'owningTeam'],
      Application: [
        'architectureState',
        'description',
        'functions',
        'owningTeam',
        'sourcing',
        'supplierHqCountry',
      ],
      Infrastructure: [
        'architectureState',
        'description',
        'functions',
        'owningTeam',
        'supplierHqCountry',
      ],
      Other: ['description'],
    });
    expect(hasStandardProperty('Application', 'sourcing')).toBe(true);
    expect(hasStandardProperty('Infrastructure', 'sourcing')).toBe(false);
  });

  it('has two edge types, and no Information flow', () => {
    expect(edgeTypes).toEqual(['Relation', 'Contains']);
    expect(JSON.stringify(template)).not.toContain('informationFlow');
    expect(template.graph.edges[1]?.relation).toBe('Relation');
  });

  it('gives each edge type its standard properties, with Architecture state', () => {
    expect(edgeTypeDefinitions.Relation.properties).toEqual([
      'architectureState',
      'identity',
      'identityContext',
      'requestData',
      'responseData',
    ]);
    expect(edgeTypeDefinitions.Contains.properties).toEqual(['architectureState']);
  });
});

describe('standard property values', () => {
  it('knows the 249 ISO 3166-1 alpha-2 codes, upper case only', () => {
    let count = 0;
    for (let a = 65; a <= 90; a += 1) {
      for (let b = 65; b <= 90; b += 1) {
        if (isIsoCountryCode(String.fromCharCode(a, b))) count += 1;
      }
    }
    expect(count).toBe(249);
    for (const code of ['NL', 'US', 'GB', 'DE', 'SE']) expect(isIsoCountryCode(code)).toBe(true);
    for (const code of ['nl', 'UK', 'EU', 'XX', 'NLD', ''])
      expect(isIsoCountryCode(code)).toBe(false);
  });

  it('treats a non-ISO country as a warning and a non-text country as an error', () => {
    expect(checkStandardProperty('supplierHqCountry', 'NL')).toEqual({ ok: true });
    expect(checkStandardProperty('supplierHqCountry', 'Netherlands')).toMatchObject({
      ok: false,
      severity: 'warning',
    });
    expect(checkStandardProperty('supplierHqCountry', 31)).toMatchObject({
      ok: false,
      severity: 'error',
    });
  });

  it('checks choices, text and text lists', () => {
    expect(checkStandardProperty('architectureState', 'Target')).toEqual({ ok: true });
    expect(checkStandardProperty('sourcing', 'Buy')).toEqual({ ok: true });
    expect(checkStandardProperty('functions', [])).toEqual({ ok: true });
    expect(checkStandardProperty('owningTeam', '')).toEqual({ ok: true });
    expect(checkStandardProperty('architectureState', 'Future')).toMatchObject({
      severity: 'error',
    });
    expect(checkStandardProperty('functions', [1])).toMatchObject({ severity: 'error' });
    expect(checkStandardProperty('description', {})).toMatchObject({ severity: 'error' });
  });
});
