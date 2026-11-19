import {
  buildModelGraph,
  definitionsForKeys,
  displayLabel,
  fillLabel,
  keyFromName,
  labelExpressionNames,
  labelPropertyNames,
  nameFromKey,
  newRelationshipKeys,
  prototypeKeyMessage,
  propertyKeyProblem,
  propertyNameProblem,
  propertyOptionsProblems,
  relationshipKeyRole,
  relationshipMetadataNames,
  relationshipPropertyValues,
  relationshipViewFields,
  type JgfDocument,
  type RelationshipPropertyDefinition,
} from '@simplearchitecture/shared';
import { describe, expect, it } from 'vitest';

const costCentre: RelationshipPropertyDefinition = {
  key: 'costCentre',
  name: 'Cost centre',
  kind: 'text',
  fromModels: false,
  version: 1,
};
const tier: RelationshipPropertyDefinition = {
  key: 'tier',
  name: 'Service tier',
  kind: 'choice',
  options: ['Gold', 'Silver'],
  fromModels: false,
  version: 1,
};
const definitions = [tier, costCentre];

describe('the rules for names, keys and options', () => {
  it('makes a key from a name in camel case', () => {
    expect(keyFromName('Cost centre')).toBe('costCentre');
    expect(keyFromName('  API owner (team) ')).toBe('apiOwnerTeam');
    expect(keyFromName('Één-twee')).toBe('éénTwee');
    expect(keyFromName('{}')).toBe('');
  });

  it('refuses names that clash with the form, a standard property, another name or key', () => {
    expect(propertyNameProblem('Cost  CENTRE', definitions)).toBe(
      "There's already a property called “Cost centre”.",
    );
    expect(propertyNameProblem('source to target data', definitions)).toBe(
      '“Source to target data” is a standard property.',
    );
    expect(propertyNameProblem('request data', definitions)).toBe(
      '“Request Data” is the older name of Source to target data.',
    );
    expect(propertyNameProblem('Direction', definitions)).toBe(
      '“Direction” is used on the relationship form already.',
    );
    expect(propertyNameProblem('TIER', definitions)).toBe("“TIER” is another property's key.");
    expect(propertyNameProblem('Two\nlines', [])).toBe('Keep the name on one line.');
    expect(propertyNameProblem('Fine', definitions)).toBeUndefined();
  });

  it('refuses keys that are standard, reserved, retired or taken ignoring case', () => {
    expect(propertyKeyProblem('architectureState', [])).toBe(
      "“architectureState” is a standard property's key.",
    );
    expect(propertyKeyProblem('__proto__', [])).toBe(prototypeKeyMessage);
    expect(propertyKeyProblem('type', [])).toBe('This key is reserved. Use another one.');
    expect(propertyKeyProblem('COSTCENTRE', definitions)).toBe(
      "There's already a property with the key “costCentre”.",
    );
    expect(propertyKeyProblem('k'.repeat(101), [])).toBe('Use 100 characters or fewer.');
    // A key standard on elements only is custom on a relationship, and `archimateType` is free.
    expect(propertyKeyProblem('owningTeam', [])).toBeUndefined();
    expect(propertyKeyProblem('archimateType', [])).toBeUndefined();
  });

  it('checks options one by one and as a list', () => {
    expect(propertyOptionsProblems(['Low', ' ', 'low', 'x'.repeat(101)])).toEqual([
      { field: 'options.1', message: 'Enter the option, or remove it.' },
      { field: 'options.2', message: 'low is in the list twice.' },
      { field: 'options.3', message: 'Use 100 characters or fewer.' },
    ]);
    expect(propertyOptionsProblems(Array.from({ length: 51 }, (_, i) => `o${i}`))).toEqual([
      { field: 'options', message: 'Use 50 options or fewer.' },
    ]);
  });

  it('names properties from keys apart from each other, within 60 characters', () => {
    expect(nameFromKey('a{b}\nc', [])).toBe('ab c');
    expect(nameFromKey('{}', [])).toBe('Property');
    expect(nameFromKey('identityContext', [])).toBe('identityContext');
    expect(nameFromKey('Identity Context', [])).toBe('Identity Context (2)');
    const long = 'x'.repeat(80);
    const [first, second] = definitionsForKeys([long, `${long}y`], []);
    expect(first?.name).toBe('x'.repeat(60));
    expect(second?.name).toBe(`${'x'.repeat(56)} (2)`);
  });

  it('finds new keys on relationships, leaving out standard, reserved, retired and known ones', () => {
    const edges = [
      { metadata: { tier: 'Gold', identity: 'x', type: 'x', data: 'x', zone: 'A' } },
      { metadata: { zone: 'B', 'simplearchitecture:x': 1 } },
      { metadata: ['not an object'] },
      {},
    ];
    expect(newRelationshipKeys(edges, (key) => key === 'tier')).toEqual([
      { key: 'zone', values: 2 },
    ]);
  });

  it('tells standard, defined and custom keys apart per type', () => {
    expect(relationshipKeyRole('Relation', 'identity', definitions)).toEqual({ role: 'standard' });
    expect(relationshipKeyRole('Contains', 'identity', definitions)).toEqual({ role: 'custom' });
    expect(relationshipKeyRole('Relation', 'tier', definitions)).toEqual({
      role: 'defined',
      definition: tier,
    });
    expect(relationshipKeyRole('Contains', 'tier', definitions)).toEqual({ role: 'custom' });
    expect(relationshipKeyRole('Relation', 'Tier', definitions)).toEqual({ role: 'custom' });
  });
});

// Made up: a theatre with a box office and a ticket system.
const theatre: JgfDocument = {
  graph: {
    nodes: {
      office: { label: 'Box office', metadata: { type: 'Business' } },
      tickets: { label: 'Tickets', metadata: { type: 'Application' } },
      hall: { label: 'Hall', metadata: { type: 'Infrastructure' } },
    },
    edges: [
      {
        id: 't1',
        source: 'office',
        target: 'tickets',
        relation: 'Relation',
        label: '{Service tier} via {tier} for {Cost centre}',
        metadata: { tier: 'Gold', archimateType: 'Serving', legacy: 'old' },
      },
      {
        id: 't2',
        source: 'hall',
        target: 'tickets',
        relation: 'Contains',
        label: 'Holds {Service tier}{tier}',
        metadata: { tier: 'Bronze' },
      },
    ],
  },
};

describe('defined properties in labels, viewpoints and suggestions', () => {
  const archimate: RelationshipPropertyDefinition = {
    key: 'archimateType',
    name: 'ArchiMate type',
    kind: 'text',
    fromModels: true,
    version: 1,
  };
  const graph = buildModelGraph(theatre, [...definitions, archimate]);
  const [relation, contains] = graph.relationships;
  if (relation === undefined || contains === undefined) throw new Error('fixture changed');

  it('fills a Relation’s label by name, then by key; on a Contains the name gives nothing', () => {
    expect(displayLabel(relation, graph)).toBe('Gold via Gold for');
    // On a Contains the value is custom metadata: its key fills in, its name gives nothing.
    expect(displayLabel(contains, graph)).toBe('Holds Bronze');
    expect(fillLabel('{Nope} {Cost centre}', relation, [], definitions).unknown).toEqual(['Nope']);
  });

  it('suggests defined names after the standard ones, and not their keys', () => {
    const names = labelPropertyNames(relation, relationshipMetadataNames(graph), definitions);
    expect(names.slice(-4)).toEqual(['Cost centre', 'Service tier', 'archimateType', 'legacy']);
    expect(relationshipMetadataNames(graph)).toEqual(['legacy']);
  });

  it('lists defined properties in Show Viewpoints by name, whenever the model has a Relation', () => {
    const fields = relationshipViewFields(graph);
    expect(fields).toEqual(
      expect.arrayContaining([
        { key: 'archimateType', label: 'ArchiMate type' },
        { key: 'costCentre', label: 'Cost centre' },
        { key: 'tier', label: 'Service tier' },
      ]),
    );
    expect(fields.filter((field) => field.key === 'tier')).toHaveLength(1);
    // Without definitions `archimateType` isn't offered, as before.
    expect(
      relationshipViewFields(buildModelGraph(theatre)).map((field) => field.key),
    ).not.toContain('archimateType');
  });

  it('offers a defined key’s values whatever its key', () => {
    expect(relationshipPropertyValues(graph).get('archimateType')).toEqual(['Serving']);
  });

  it('reads the names a label uses', () => {
    expect(labelExpressionNames('{{literal}} { A } {B}{} {C')).toEqual(['A', 'B']);
  });
});
