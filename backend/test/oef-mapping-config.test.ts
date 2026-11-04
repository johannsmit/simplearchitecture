import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { allArchimateElementTypes, archimateElementTypes } from '../src/oef/archimate.js';
import {
  defaultOefMappingPath,
  loadOefMapping,
  OefMappingError,
  parseOefMapping,
  repoRoot,
  resolveOefMappingPath,
  type OefMapping,
} from '../src/oef/mapping-config.js';
import { agreedMappingPath } from './helpers.js';

const shipped = JSON.parse(readFileSync(defaultOefMappingPath, 'utf8')) as OefMapping;
// The defaults, pinned (the shipped file can change).
const agreed = JSON.parse(readFileSync(agreedMappingPath, 'utf8')) as OefMapping;

function withChange(change: (config: Record<string, unknown>) => void): unknown {
  const config = structuredClone(agreed) as unknown as Record<string, unknown>;
  change(config);
  return config;
}

function problem(input: unknown): string {
  try {
    parseOefMapping(input);
  } catch (error) {
    expect(error).toBeInstanceOf(OefMappingError);
    return (error as Error).message;
  }
  throw new Error('expected the config to be rejected');
}

const tempDir = mkdtempSync(join(tmpdir(), 'oef-mapping-test-'));
afterAll(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe('the shipped config/oef-mapping.json', () => {
  it('is valid', () => {
    expect(() => loadOefMapping()).not.toThrow();
    expect(defaultOefMappingPath.endsWith(join('config', 'oef-mapping.json'))).toBe(true);
  });

  it('lists every ArchiMate 3.1 element type explicitly', () => {
    expect(Object.keys(shipped.elements).sort()).toEqual([...allArchimateElementTypes].sort());
  });
});

describe('Realization imports as Contains', () => {
  it('in the shipped config, in the OEF direction, while function folding still takes Realization', () => {
    const config = parseOefMapping(shipped);
    expect(config.relationships.rules.filter((rule) => rule.type === 'Realization')).toEqual([
      { type: 'Realization', relation: 'Contains' },
    ]);
    for (const rule of config.functionFolding.rules) {
      expect(rule.relationshipTypes).toContain('Realization');
    }
  });

  it('accepts reverse: true or false on a relationship rule', () => {
    for (const reverse of [true, false]) {
      const config = parseOefMapping(
        withChange((c) => {
          (c.relationships as { rules: unknown[] }).rules = [
            { type: 'Realization', relation: 'Contains', reverse },
          ];
        }),
      );
      expect(config.relationships.rules[0]?.reverse).toBe(reverse);
    }
  });
});

describe('the agreed defaults (pinned in test/fixtures/oef-mapping-agreed.json)', () => {
  it('are valid and list every ArchiMate 3.1 element type', () => {
    expect(Object.keys(loadOefMapping(agreedMappingPath).elements).sort()).toEqual(
      [...allArchimateElementTypes].sort(),
    );
  });

  it('map element types as agreed', () => {
    const expected = (types: readonly string[], nodeType: string) =>
      Object.fromEntries(types.map((type) => [type, nodeType]));
    const { business, strategy, application, technology, physical, motivation } =
      archimateElementTypes;
    expect(agreed.elements).toEqual({
      ...expected(['BusinessActor', 'BusinessRole', 'Stakeholder'], 'Stakeholder'),
      ...expected(strategy, 'Business'),
      ...expected(
        business.filter((type) => type !== 'BusinessActor' && type !== 'BusinessRole'),
        'Business',
      ),
      ...expected(application, 'Application'),
      ...expected([...technology, ...physical], 'Infrastructure'),
      ...expected(
        [
          ...motivation.filter((type) => type !== 'Stakeholder'),
          ...archimateElementTypes.implementationAndMigration,
          'Location',
          'Grouping',
        ],
        'Other',
      ),
      AndJunction: 'skip',
      OrJunction: 'skip',
    });
  });

  it('hold the agreed defaults for relationships, folding and properties', () => {
    const mapping = loadOefMapping(agreedMappingPath);
    expect(mapping.relationships.rules).toEqual([
      { type: 'Flow', relation: 'Relation', informationFlow: true },
      { type: 'Realization', relation: 'Contains' },
    ]);
    for (const rule of mapping.functionFolding.rules) {
      expect(rule.relationshipTypes).toEqual(['Assignment', 'Realization', 'Composition']);
    }
    expect(mapping.properties.documentation).toBe('description');
    expect(
      mapping.properties.mappings.map(({ name, key, values }) => ({ name, key, values })),
    ).toEqual([
      {
        name: 'Architecture State',
        key: 'architectureState',
        values: { Deprecate: 'Deprecate', 'Target state': 'Target' },
      },
      { name: 'Responsible Team', key: 'owningTeam', values: undefined },
      { name: 'Vendor HQ Country', key: 'supplierHqCountry', values: undefined },
    ]);
    expect(mapping.properties.defaults).toEqual([
      expect.objectContaining({
        key: 'architectureState',
        value: 'Current',
        nodeTypes: ['Application', 'Infrastructure'],
        relations: ['Relation', 'Contains'],
      }),
    ]);
  });
});

describe('property defaults target node types, relations or both', () => {
  const withDefaults = (defaults: unknown[]) =>
    withChange((c) => {
      (c.properties as { defaults: unknown[] }).defaults = defaults;
    });

  it('the shipped config makes empty or missing Architecture State Current on relationships too', () => {
    const fallback = parseOefMapping(shipped).properties.defaults.find(
      (entry) => entry.key === 'architectureState',
    );
    expect(fallback?.relations).toEqual(['Relation', 'Contains']);
  });

  it('accepts a default for relations only', () => {
    const parsed = parseOefMapping(
      withDefaults([{ key: 'architectureState', value: 'Current', relations: ['Relation'] }]),
    );
    expect(parsed.properties.defaults[0]).toEqual({
      key: 'architectureState',
      value: 'Current',
      relations: ['Relation'],
    });
  });

  it('rejects a default that targets nothing', () => {
    expect(problem(withDefaults([{ key: 'architectureState', value: 'Current' }]))).toMatch(
      /must list nodeTypes, relations or both[\s\S]*properties\.defaults\[0\]/,
    );
    expect(
      problem(withDefaults([{ key: 'architectureState', value: 'Current', relations: [] }])),
    ).toMatch(/properties\.defaults\[0\]\.relations/);
  });

  it('rejects an unknown relation, and an invalid standard value', () => {
    expect(
      problem(withDefaults([{ key: 'owningTeam', value: 'x', relations: ['Data flow'] }])),
    ).toMatch(/must be one of Relation, Contains[\s\S]*defaults\[0\]\.relations\[0\]/);
    expect(
      problem(withDefaults([{ key: 'architectureState', value: 'Now', relations: ['Relation'] }])),
    ).toMatch(/architectureState must be one of Deprecate, Current, Target/);
  });
});

describe('invalid mapping configs are rejected, naming the bad entry', () => {
  it.each([
    [
      'an unknown node type',
      (c: Record<string, unknown>) => ((c.elements as Record<string, string>).Goal = 'Strategy'),
      /elements\.Goal/,
    ],
    [
      'a misspelt element type',
      (c: Record<string, unknown>) =>
        ((c.elements as Record<string, string>).ApplicationComponnent = 'Application'),
      /is not an ArchiMate 3\.1 element type[\s\S]*ApplicationComponnent/,
    ],
    [
      'an unknown edge type in a relationship rule',
      (c: Record<string, unknown>) =>
        ((c.relationships as { rules: unknown[] }).rules = [{ type: 'Flow', relation: 'Data' }]),
      /must be one of Relation, Contains[\s\S]*relationships\.rules\[0\]\.relation/,
    ],
    [
      'Information flow on a Contains rule',
      (c: Record<string, unknown>) =>
        ((c.relationships as { rules: unknown[] }).rules = [
          { type: 'Flow', relation: 'Contains', informationFlow: true },
        ]),
      /only applies to a type that can have it[\s\S]*relationships\.rules\[0\]\.informationFlow/,
    ],
    [
      'an unknown relationship type',
      (c: Record<string, unknown>) =>
        ((c.relationships as { rules: unknown[] }).rules = [
          { type: 'Flows', relation: 'Relation' },
        ]),
      /is not an ArchiMate 3\.1 relationship type[\s\S]*relationships\.rules\[0\]\.type/,
    ],
    [
      'a bad node type in a relationship condition',
      (c: Record<string, unknown>) =>
        ((c.relationships as { rules: unknown[] }).rules = [
          { type: 'Serving', sourceNodeTypes: ['App'], relation: 'Relation' },
        ]),
      /relationships\.rules\[0\]\.sourceNodeTypes\[0\]/,
    ],
    [
      'a value translation to a value the metamodel does not allow',
      (c: Record<string, unknown>) => {
        const mappings = (c.properties as { mappings: { values?: Record<string, string> }[] })
          .mappings;
        Object.assign(mappings[0] ?? {}, { values: { 'Target state': 'Future' } });
      },
      /architectureState must be one of Deprecate, Current, Target[\s\S]*properties\.mappings\[0\]\.values\["Target state"\]/,
    ],
    [
      'a default the metamodel does not allow',
      (c: Record<string, unknown>) =>
        ((c.properties as { defaults: unknown[] }).defaults = [
          { key: 'sourcing', value: 'Rent', nodeTypes: ['Application'] },
        ]),
      /sourcing must be one of Build, Buy[\s\S]*properties\.defaults\[0\]\.value/,
    ],
    [
      'the same OEF property mapped twice',
      (c: Record<string, unknown>) =>
        (c.properties as { mappings: unknown[] }).mappings.push({
          name: 'Responsible Team',
          key: 'team',
        }),
      /"Responsible Team" is mapped twice[\s\S]*properties\.mappings\[3\]\.name/,
    ],
    [
      'a metadata key that is not camelCase',
      (c: Record<string, unknown>) =>
        (c.properties as { mappings: unknown[] }).mappings.push({
          name: 'Cost',
          key: 'cost-centre',
        }),
      /must be a camelCase key[\s\S]*properties\.mappings\[3\]\.key/,
    ],
    [
      'the node type key as a property key',
      (c: Record<string, unknown>) =>
        (c.properties as { mappings: unknown[] }).mappings.push({ name: 'Kind', key: 'type' }),
      /must not be "type"[\s\S]*properties\.mappings\[3\]\.key/,
    ],
    [
      'a fold rule with a bad end',
      (c: Record<string, unknown>) => {
        const rules = (c.functionFolding as { rules: Record<string, unknown>[] }).rules;
        Object.assign(rules[0] ?? {}, { fold: 'both' });
      },
      /must be "source" or "target"[\s\S]*functionFolding\.rules\[0\]\.fold/,
    ],
    [
      'a fold rule with an empty type list',
      (c: Record<string, unknown>) => {
        const rules = (c.functionFolding as { rules: Record<string, unknown>[] }).rules;
        Object.assign(rules[1] ?? {}, { targetTypes: [] });
      },
      /must list at least one type[\s\S]*functionFolding\.rules\[1\]\.targetTypes/,
    ],
    [
      'an unknown field (a typo)',
      (c: Record<string, unknown>) => (c.relationship = {}),
      /Unrecognized key: "relationship"/,
    ],
    ['a missing section', (c: Record<string, unknown>) => delete c.properties, /properties/],
    ['a wrong version', (c: Record<string, unknown>) => (c.version = 2), /must be 1[\s\S]*version/],
    [
      'a reverse that is not true or false',
      (c: Record<string, unknown>) => {
        const rules = (c.relationships as { rules: Record<string, unknown>[] }).rules;
        (rules[0] as Record<string, unknown>).reverse = 'yes';
      },
      /must be true or false[\s\S]*relationships\.rules\[0\]\.reverse/,
    ],
  ])('rejects %s', (_name, change, message) => {
    expect(problem(withChange(change))).toMatch(message);
  });

  it('reports every bad entry at once', () => {
    const message = problem(
      withChange((c) => {
        (c.elements as Record<string, string>).Goal = 'Strategy';
        (c.elements as Record<string, string>).Value = 'Money';
      }),
    );
    expect(message).toMatch(
      /elements\.Goal[\s\S]*elements\.Value|elements\.Value[\s\S]*elements\.Goal/,
    );
  });
});

describe('loadOefMapping', () => {
  it('loads another file given by path (OEF_MAPPING_PATH)', () => {
    const file = join(tempDir, 'custom.json');
    writeFileSync(file, JSON.stringify(withChange((c) => (c.elements = { Goal: 'Business' }))));
    expect(loadOefMapping(file).elements).toEqual({ Goal: 'Business' });
  });

  it('names the file when it is invalid', () => {
    const file = join(tempDir, 'invalid.json');
    writeFileSync(file, JSON.stringify(withChange((c) => (c.version = 3))));
    expect(() => loadOefMapping(file)).toThrow(`Invalid OEF mapping config ${file}`);
  });

  it('rejects a file that is not JSON', () => {
    const file = join(tempDir, 'broken.json');
    writeFileSync(file, '{ "version": 1, ');
    expect(() => loadOefMapping(file)).toThrow(/is not valid JSON/);
  });

  it('rejects a missing file', () => {
    expect(() => loadOefMapping(join(tempDir, 'missing.json'))).toThrow(
      /Cannot read OEF mapping config .*missing\.json \(ENOENT\)/,
    );
  });
});

describe('loadOefMapping: more paths and entries', () => {
  it('resolves a relative path against the repo root, wherever the API starts', () => {
    const file = join(tempDir, 'relative.json');
    writeFileSync(file, JSON.stringify(withChange((c) => (c.elements = { Goal: 'Other' }))));
    const path = relative(repoRoot, file);
    expect(path.startsWith('/')).toBe(false);
    expect(loadOefMapping(path).elements).toEqual({ Goal: 'Other' });
    // Not the working directory: npm run dev starts the API in backend/.
    expect(resolveOefMappingPath('mapping.json')).toBe(join(repoRoot, 'mapping.json'));
    expect(resolveOefMappingPath('config/oef-mapping.json')).toBe(defaultOefMappingPath);
    expect(resolveOefMappingPath(file)).toBe(file);
  });

  // OEF property values are text, but `functions` holds a list. Folding then replaces the
  // text without a trace (documentation or a mapped value is lost), and validation passes.
  it.each([
    [
      'documentation stored in functions',
      (c: Record<string, unknown>) =>
        ((c.properties as { documentation: string }).documentation = 'functions'),
      /properties\.documentation/,
    ],
    [
      'a property mapped to functions',
      (c: Record<string, unknown>) =>
        (c.properties as { mappings: unknown[] }).mappings.push({
          name: 'Colour',
          key: 'functions',
        }),
      /properties\.mappings\[3\]\.key/,
    ],
  ])('rejects %s', (_name, change, message) => {
    expect(problem(withChange(change))).toMatch(message);
  });
});

describe('archimateTypeKey', () => {
  const setProperties = (change: (properties: Record<string, unknown>) => void) =>
    withChange((c) => {
      change(c.properties as Record<string, unknown>);
    });

  it('is archimateType in the shipped config and in the agreed defaults', () => {
    expect(loadOefMapping().properties.archimateTypeKey).toBe('archimateType');
    expect(loadOefMapping(agreedMappingPath).properties.archimateTypeKey).toBe('archimateType');
  });

  it('is optional', () => {
    const config = setProperties((p) => {
      delete p.archimateTypeKey;
    });
    expect(parseOefMapping(config).properties.archimateTypeKey).toBeUndefined();
  });

  it.each([
    ['the node type key', 'type', /must not be "type"/],
    ['a list property', 'functions', /must not be a list property \(functions\)/],
    ['a standard property', 'owningTeam', /must not be a standard property key/],
    ['a key that is not camelCase', 'archimate-type', /must be a camelCase key/],
    ['the prototype key', '__proto__', /must be a camelCase key/],
  ])('rejects %s (%s), naming the entry', (_name, key, message) => {
    const text = problem(setProperties((p) => (p.archimateTypeKey = key)));
    expect(text).toMatch(message);
    expect(text).toMatch(/properties\.archimateTypeKey/);
  });

  it('must differ from the documentation key and every mapped key', () => {
    expect(
      problem(
        setProperties((p) => {
          p.documentation = 'notes';
          p.archimateTypeKey = 'notes';
        }),
      ),
    ).toMatch(/must differ from documentation[\s\S]*properties\.archimateTypeKey/);
    expect(
      problem(
        setProperties((p) => {
          (p.mappings as unknown[]).push({ name: 'Kind', key: 'archimateType' });
        }),
      ),
    ).toMatch(/must differ from archimateTypeKey[\s\S]*properties\.mappings\[3\]\.key/);
  });
});

describe('reserved keys in the config', () => {
  it('rejects __proto__ as a key anywhere, naming where (JSON.parse keeps it, zod would drop it)', () => {
    const config = JSON.parse(
      JSON.stringify(agreed)
        .replace('"elements":{', '"elements":{"__proto__":"Business",')
        .replace('"mappings":[{', '"mappings":[{"__proto__":{},'),
    ) as unknown;
    const text = problem(config);
    expect(text).toContain('"__proto__" is not allowed as a key\n  → at elements.__proto__');
    expect(text).toContain('→ at properties.mappings[0].__proto__');
  });

  it('rejects functions as the documentation key or a mapping key', () => {
    expect(
      problem(
        withChange(
          (c) => ((c.properties as { documentation: string }).documentation = 'functions'),
        ),
      ),
    ).toMatch(/must not be a list property \(functions\): function folding fills it/);
  });
});
