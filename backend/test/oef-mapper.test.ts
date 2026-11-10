import { readFileSync } from 'node:fs';
import type { JgfNode, OefMappingReport } from '@simplearchitecture/shared';
import { describe, expect, it } from 'vitest';
import { validateJgf } from '../src/jgf/validate.js';
import { ImportTooLargeError, maxImportEdges, maxImportNodes } from '../src/limits.js';
import {
  camelCaseKey,
  convertOef,
  maxCustomKeyLength,
  maxFunctionEntries,
  maxFunctionEntryLength,
  maxListedFoldedEnds,
  OefFormatError,
} from '../src/oef/mapper.js';
import { parseOefMapping, type OefMapping } from '../src/oef/mapping-config.js';
import { XmlRejectedError } from '../src/oef/xml.js';
import { agreedMapping } from './helpers.js';
import { expectGrowthBelow } from './growth.js';

const bakery = readFileSync(new URL('./fixtures/bakery-oef.xml', import.meta.url), 'utf8');
const mapping = agreedMapping;

function withMapping(change: (config: OefMapping) => void): OefMapping {
  const config = structuredClone(mapping);
  change(config);
  return parseOefMapping(config);
}

/** A minimal OEF document around the given XML fragments. */
function oef(parts: { elements?: string; relationships?: string; definitions?: string }): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<model xmlns="http://www.opengroup.org/xsd/archimate/3.0/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" identifier="m">
  <name xml:lang="en">Test</name>
  <elements>${parts.elements ?? ''}</elements>
  <relationships>${parts.relationships ?? ''}</relationships>
  <propertyDefinitions>
    <propertyDefinition identifier="pd-state" type="string"><name>Architecture State</name></propertyDefinition>
    <propertyDefinition identifier="pd-integration" type="string"><name>Integration Type</name></propertyDefinition>
    ${parts.definitions ?? ''}
  </propertyDefinitions>
</model>`;
}

const sum = (counts: Record<string, number>) =>
  Object.values(counts).reduce((total, count) => total + count, 0);
const sumByReason = (counts: Record<string, Record<string, number>>) =>
  Object.values(counts).reduce((total, byType) => total + sum(byType), 0);

function expectNothingDroppedSilently(report: OefMappingReport): void {
  expect(
    sum(report.elements.mapped) +
      sum(report.elements.folded) +
      sumByReason(report.elements.skipped),
  ).toBe(report.elements.total);
  expect(sum(report.relationships.mapped) + sumByReason(report.relationships.skipped)).toBe(
    report.relationships.total,
  );
  // Every relationship skipped for a folded end is counted in foldedEnds, and listed up to the cap.
  const { skipped, foldedEnds } = report.relationships;
  expect(foldedEnds.count).toBe(
    sum(skipped['source-folded'] ?? {}) + sum(skipped['target-folded'] ?? {}),
  );
  expect(foldedEnds.listed).toHaveLength(Math.min(foldedEnds.count, maxListedFoldedEnds));
  expect(foldedEnds.truncated).toBe(foldedEnds.count > maxListedFoldedEnds);
}

describe('convertOef: the made-up bakery sample', () => {
  const { jgf, report } = convertOef(bakery, mapping);
  const nodes = jgf.graph.nodes ?? {};
  const node = (id: string): JgfNode => {
    const found = nodes[id];
    if (!found) throw new Error(`no node ${id}`);
    return found;
  };

  it('passes JGF validation (warnings only: the country is imported as is)', () => {
    const validation = validateJgf(jgf);
    expect(validation.valid).toBe(true);
    expect(validation.warnings.map((w) => [w.nodeId, w.code])).toEqual([
      ['e-shop', 'non-iso-country'],
    ]);
  });

  it('uses the model identifier, name and documentation for the graph', () => {
    expect(jgf.graph).toMatchObject({
      id: 'model-bakery',
      label: 'Bakery landscape',
      directed: true,
      metadata: { description: 'A made-up bakery.' },
    });
  });

  it('maps element types to node types and uses OEF identifiers as node ids', () => {
    const types = Object.fromEntries(
      Object.entries(nodes).map(([id, n]) => [id, n.metadata?.type]),
    );
    expect(types).toEqual({
      'e-customer': 'Stakeholder',
      'e-baker': 'Stakeholder',
      'e-ordering': 'Business',
      'e-shop': 'Application',
      'e-stock': 'Application',
      'e-legacy': 'Application',
      'e-suite': 'Application',
      'e-fn-report': 'Application',
      'e-server': 'Infrastructure',
      'e-db': 'Infrastructure',
      'e-goal': 'Other',
      'e-location': 'Other',
    });
  });

  it('reads names and documentation in English when there are several languages', () => {
    expect(node('e-shop')).toMatchObject({
      label: 'Web shop',
      metadata: { description: 'Where customers order bread.' },
    });
  });

  it('decodes entities and character references in text', () => {
    expect(node('e-goal').label).toBe('Fresh & warm bread 🍞');
  });

  it('maps properties: names resolved, values translated, others kept as camelCase custom metadata', () => {
    expect(node('e-shop').metadata).toEqual({
      type: 'Application',
      archimateType: 'ApplicationComponent',
      description: 'Where customers order bread.',
      architectureState: 'Target',
      owningTeam: 'Web team',
      supplierHqCountry: 'Netherlands',
      internalExternal: 'External',
      // "Description" would clash with the documentation's key.
      oefDescription: 'Shop notes',
      functions: ['Checkout', 'Card payment'],
    });
    expect(node('e-legacy').metadata?.architectureState).toBe('Deprecate');
    expect(node('e-ordering').metadata).toEqual({
      type: 'Business',
      archimateType: 'BusinessProcess',
      owningTeam: 'Front desk',
    });
  });

  it('defaults an empty or missing Architecture State to Current on Application and Infrastructure nodes only', () => {
    expect(node('e-stock').metadata?.architectureState).toBe('Current'); // empty
    expect(node('e-suite').metadata?.architectureState).toBe('Current'); // missing
    expect(node('e-server').metadata?.architectureState).toBe('Current');
    expect(node('e-ordering').metadata).not.toHaveProperty('architectureState');
    expect(node('e-customer').metadata).not.toHaveProperty('architectureState');
    expect(node('e-goal').metadata).not.toHaveProperty('architectureState');
  });

  it('folds application functions into every linked component, in either direction', () => {
    for (const id of ['e-fn-checkout', 'e-fn-pay', 'e-fn-checkout-2']) {
      expect(nodes).not.toHaveProperty(id);
    }
    // Assignment from e-shop, Realization from the function to e-shop, Composition from e-suite.
    expect(node('e-shop').metadata?.functions).toEqual(['Checkout', 'Card payment']);
    expect(node('e-suite').metadata?.functions).toEqual(['Checkout']);
    expect(report.functions).toEqual({
      folded: 3,
      hosts: 2,
      foldedWithDetailsNotCarried: 1,
      duplicateEntries: 1,
      entriesTruncated: 0,
      entriesNotAdded: 0,
      keptAsNodes: [{ id: 'e-fn-report', name: 'Sales report' }],
    });
  });

  it('keeps a function without a component as an Application node, and reports it', () => {
    expect(node('e-fn-report').metadata?.type).toBe('Application');
    expect(report.functions.keptAsNodes).toEqual([{ id: 'e-fn-report', name: 'Sales report' }]);
  });

  it('maps Flow to a Relation with its name as Request Data, mapping relationship properties like element ones', () => {
    expect(jgf.graph.edges).toEqual([
      {
        id: 'r-orders',
        source: 'e-customer',
        target: 'e-shop',
        relation: 'Relation',
        directed: true,
        label: 'Orders',
        metadata: {
          requestData: ['Orders'],
          archimateType: 'Flow',
          description: 'Customers send orders.',
          integrationType: 'API Gateway',
          architectureState: 'Current',
        },
      },
      {
        id: 'r-recipes',
        source: 'e-shop',
        target: 'e-db',
        relation: 'Relation',
        directed: true,
        metadata: { archimateType: 'Flow', architectureState: 'Current' },
      },
      {
        id: 'r-report',
        source: 'e-fn-report',
        target: 'e-shop',
        relation: 'Relation',
        directed: true,
        metadata: { archimateType: 'Flow', architectureState: 'Current' },
      },
    ]);
  });

  it('never creates an edge to a missing node', () => {
    for (const edge of jgf.graph.edges ?? []) {
      expect(nodes).toHaveProperty([edge.source]);
      expect(nodes).toHaveProperty([edge.target]);
    }
  });

  it('reports everything that was mapped, folded or skipped, and why', () => {
    expect(report.elements).toEqual({
      total: 17,
      mapped: { Stakeholder: 2, Business: 1, Application: 5, Infrastructure: 2, Other: 2 },
      mappedByElementType: {
        BusinessActor: 1,
        BusinessRole: 1,
        BusinessProcess: 1,
        ApplicationComponent: 3,
        ApplicationCollaboration: 1,
        ApplicationFunction: 1,
        Node: 1,
        SystemSoftware: 1,
        Goal: 1,
        Location: 1,
      },
      folded: { ApplicationFunction: 3 },
      skipped: {
        'skipped-by-config': { AndJunction: 1 },
        'unknown-element-type': { Banana: 1 },
      },
    });
    expect(report.relationships).toEqual({
      total: 13,
      mapped: { Relation: 3, Contains: 0 },
      skipped: {
        'used-for-folding': { Assignment: 1, Composition: 2, Realization: 1 },
        'no-matching-rule': { Serving: 2, Triggering: 1 },
        'source-folded': { Flow: 1 },
        'source-not-imported': { Flow: 1 },
        'target-not-an-element': { Flow: 1 },
      },
      foldedEnds: {
        count: 1,
        listed: [{ id: 'r-from-function', type: 'Flow', reason: 'source-folded', end: 'source' }],
        truncated: false,
      },
    });
    expect(report.properties).toEqual({
      mapped: { owningTeam: 2, architectureState: 4, supplierHqCountry: 1 },
      keptAsCustom: { internalExternal: 1, oefDescription: 1, integrationType: 1 },
      valuesTranslated: 2,
      // r-orders says "Current", which the value map doesn't list: kept as is.
      valuesNotTranslated: { architectureState: 1 },
      defaultsApplied: { architectureState: 7 },
      onRelationships: {
        mapped: { architectureState: 1 },
        defaultsApplied: { architectureState: 2 },
      },
      renamedKeys: 1,
      unknownDefinitions: 1,
    });
    expect(report.viewsSkipped).toBe(2);
    expect(report.organizationItemsSkipped).toBe(2);
    expectNothingDroppedSilently(report);
  });
});

describe('convertOef: rules come from the config', () => {
  it('maps by relationship property value, first matching rule wins', () => {
    const custom = withMapping((m) => {
      m.relationships.rules.unshift({
        type: 'Flow',
        properties: [{ name: 'Integration Type', values: ['API Gateway', 'Point-to-Point'] }],
        relation: 'Relation',
      });
    });
    const edges = convertOef(bakery, custom).jgf.graph.edges ?? [];
    expect(edges.map((e) => [e.id, e.relation])).toEqual([
      ['r-orders', 'Relation'],
      ['r-recipes', 'Relation'],
      ['r-report', 'Relation'],
    ]);
  });

  it('maps by property presence and by source and target node type', () => {
    const custom = withMapping((m) => {
      m.relationships.rules = [
        { type: 'Flow', properties: [{ name: 'Integration Type' }], relation: 'Relation' },
        {
          type: 'Serving',
          sourceNodeTypes: ['Infrastructure'],
          targetNodeTypes: ['Application'],
          relation: 'Relation',
        },
      ];
    });
    const { jgf, report } = convertOef(bakery, custom);
    expect((jgf.graph.edges ?? []).map((e) => [e.id, e.relation])).toEqual([
      ['r-orders', 'Relation'],
      ['r-hosts', 'Relation'],
    ]);
    // e-shop → e-ordering is Application → Business: no rule matches.
    expect(report.relationships.skipped['no-matching-rule']).toEqual({
      Flow: 2,
      Serving: 1,
      Triggering: 1,
    });
    expectNothingDroppedSilently(report);
  });

  it('applies defaults only to the configured node types', () => {
    const custom = withMapping((m) => {
      m.properties.defaults = [
        { key: 'architectureState', value: 'Current', nodeTypes: ['Infrastructure'] },
      ];
    });
    const nodes = convertOef(bakery, custom).jgf.graph.nodes ?? {};
    expect(nodes['e-server']?.metadata?.architectureState).toBe('Current');
    expect(nodes['e-suite']?.metadata).not.toHaveProperty('architectureState');
  });

  it('skips element types the config marks as skip, and reports them', () => {
    const custom = withMapping((m) => {
      m.elements.Location = 'skip';
    });
    const { jgf, report } = convertOef(bakery, custom);
    expect(jgf.graph.nodes).not.toHaveProperty('e-location');
    expect(report.elements.skipped['skipped-by-config']).toEqual({ AndJunction: 1, Location: 1 });
  });

  it('keeps functions as nodes when folding is switched off', () => {
    const custom = withMapping((m) => {
      m.functionFolding.rules = [];
    });
    const { jgf, report } = convertOef(bakery, custom);
    expect(jgf.graph.nodes?.['e-fn-checkout']?.metadata?.type).toBe('Application');
    expect(jgf.graph.nodes?.['e-shop']?.metadata).not.toHaveProperty('functions');
    expect(report.functions.folded).toBe(0);
    expect(report.relationships.skipped).not.toHaveProperty('used-for-folding');
    expectNothingDroppedSilently(report);
  });

  it('folds only along the configured relationship types and element types', () => {
    const custom = withMapping((m) => {
      m.functionFolding.rules = [
        {
          relationshipTypes: ['Assignment'],
          sourceTypes: ['ApplicationComponent'],
          targetTypes: ['ApplicationFunction'],
          fold: 'target',
        },
      ];
    });
    const { jgf, report } = convertOef(bakery, custom);
    expect(jgf.graph.nodes?.['e-shop']?.metadata?.functions).toEqual(['Checkout']);
    expect(jgf.graph.nodes?.['e-suite']?.metadata).not.toHaveProperty('functions');
    expect(report.functions.keptAsNodes.map((f) => f.id)).toEqual([
      'e-fn-pay',
      'e-fn-checkout-2',
      'e-fn-report',
    ]);
  });
});

describe('convertOef: edge cases', () => {
  it('keeps an untranslated value as it is and reports it; validation then flags it', () => {
    const xml = oef({
      elements: `<element identifier="a" xsi:type="ApplicationComponent"><name>A</name>
        <properties><property propertyDefinitionRef="pd-state"><value>Sunset</value></property></properties>
      </element>`,
    });
    const { jgf, report } = convertOef(xml, mapping);
    expect(jgf.graph.nodes?.a?.metadata?.architectureState).toBe('Sunset');
    expect(report.properties.valuesNotTranslated).toEqual({ architectureState: 1 });
    expect(validateJgf(jgf).errors.map((e) => [e.nodeId, e.field])).toEqual([
      ['a', 'metadata.architectureState'],
    ]);
  });

  it('takes the first language when there is no English one', () => {
    const xml = oef({
      elements: `<element identifier="a" xsi:type="Goal">
        <name xml:lang="de">Ziel</name><name xml:lang="fr">But</name>
        <documentation xml:lang="fr">Texte</documentation>
      </element>`,
    });
    expect(convertOef(xml, mapping).jgf.graph.nodes?.a).toEqual({
      label: 'Ziel',
      metadata: { type: 'Other', archimateType: 'Goal', description: 'Texte' },
    });
  });

  it('renames clashing custom keys instead of overwriting', () => {
    const xml = oef({
      elements: `<element identifier="a" xsi:type="Goal"><name>A</name>
        <properties>
          <property propertyDefinitionRef="p1"><value>one</value></property>
          <property propertyDefinitionRef="p2"><value>two</value></property>
          <property propertyDefinitionRef="p3"><value>three</value></property>
        </properties></element>`,
      definitions: `
        <propertyDefinition identifier="p1"><name>Cost centre</name></propertyDefinition>
        <propertyDefinition identifier="p2"><name>cost-centre</name></propertyDefinition>
        <propertyDefinition identifier="p3"><name>Functions</name></propertyDefinition>`,
    });
    const { jgf, report } = convertOef(xml, mapping);
    expect(jgf.graph.nodes?.a?.metadata).toEqual({
      type: 'Other',
      archimateType: 'Goal',
      costCentre: 'one',
      oefCostCentre: 'two',
      oefFunctions: 'three',
    });
    expect(report.properties.renamedKeys).toBe(2);
  });

  it('skips elements without an identifier, and elements and relationships with a duplicate one', () => {
    const xml = oef({
      elements: `<element xsi:type="Goal"><name>No id</name></element>
        <element identifier="a" xsi:type="Goal"><name>A</name></element>
        <element identifier="a" xsi:type="Goal"><name>A again</name></element>`,
      relationships: `<relationship identifier="r" source="a" target="a" xsi:type="Flow"/>
        <relationship identifier="r" source="a" target="a" xsi:type="Flow"/>`,
    });
    const { jgf, report } = convertOef(xml, mapping);
    expect(Object.keys(jgf.graph.nodes ?? {})).toEqual(['a']);
    expect(jgf.graph.nodes?.a?.label).toBe('A');
    expect(report.elements.skipped).toEqual({
      'missing-identifier': { Goal: 1 },
      'duplicate-identifier': { Goal: 1 },
    });
    expect(report.relationships.skipped).toEqual({ 'duplicate-identifier': { Flow: 1 } });
    expectNothingDroppedSilently(report);
  });

  it('gives a relationship without an identifier a new, unique id, and keeps the others', () => {
    const xml = oef({
      elements: `<element identifier="a" xsi:type="Goal"><name>A</name></element>
        <element identifier="b" xsi:type="Goal"><name>B</name></element>`,
      relationships: `<relationship source="a" target="b" xsi:type="Flow"/>
        <relationship identifier="kept" source="b" target="a" xsi:type="Flow"/>
        <relationship source="b" target="a" xsi:type="Flow"/>`,
    });
    const { jgf, report } = convertOef(xml, mapping);
    const ids = (jgf.graph.edges ?? []).map((edge) => edge.id);
    expect(ids).toHaveLength(3);
    expect(ids[1]).toBe('kept');
    for (const id of [ids[0], ids[2]]) {
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    }
    expect(new Set(ids).size).toBe(3);
    expect(report.relationships.skipped).toEqual({});
    expect(validateJgf(jgf).valid).toBe(true);
    expectNothingDroppedSilently(report);
  });

  it('cannot be tricked into touching object prototypes; __proto__ ids are reserved', () => {
    const xml = oef({
      elements: `<element identifier="__proto__" xsi:type="Goal"><name>Proto</name></element>
        <element identifier="constructor" xsi:type="Goal"><name>Ctor</name></element>`,
      relationships: `<relationship identifier="__proto__" source="constructor" target="constructor" xsi:type="Flow"/>
        <relationship identifier="r" source="__proto__" target="constructor" xsi:type="Flow"/>`,
    });
    const { jgf, report } = convertOef(xml, mapping);
    // The same rule as the JGF import, which refuses a __proto__ id: never output, always reported.
    expect(Object.keys(jgf.graph.nodes ?? {})).toEqual(['constructor']);
    expect(jgf.graph.edges).toEqual([]);
    expect(report.elements.skipped).toEqual({ 'reserved-identifier': { Goal: 1 } });
    expect(report.relationships.skipped).toEqual({
      'reserved-identifier': { Flow: 1 },
      'source-not-imported': { Flow: 1 },
    });
    expect(({} as Record<string, unknown>).label).toBeUndefined();
    expect(validateJgf(jgf).valid).toBe(true);
    expectNothingDroppedSilently(report);
  });

  it('rejects XML that is not an OEF model', () => {
    expect(() => convertOef('<svg/>', mapping)).toThrow(OefFormatError);
  });

  it('rejects unsafe XML before mapping', () => {
    expect(() => convertOef('<!DOCTYPE model><model/>', mapping)).toThrow(XmlRejectedError);
  });
});

describe('camelCaseKey', () => {
  it.each([
    ['Internal/External', 'internalExternal'],
    ['Platform', 'platform'],
    ['Integration Type', 'integrationType'],
    ['HQ Country', 'hqCountry'],
    ['Vendor HQ Country', 'vendorHQCountry'],
    ['  cost -- centre  ', 'costCentre'],
    ['Größe (m2)', 'größeM2'],
    ['__proto__', 'proto'],
    ['!!!', 'property'],
  ])('%j → %s', (name, key) => {
    expect(camelCaseKey(name)).toBe(key);
  });
});

describe('convertOef: folding and counting edge cases', () => {
  const element = (id: string, type: string) =>
    `<element identifier="${id}" xsi:type="${type}"><name>${id}</name></element>`;
  const link = (id: string, source: string, target: string, type: string) =>
    `<relationship identifier="${id}" source="${source}" target="${target}" xsi:type="${type}"/>`;
  const twoEnds =
    element('c1', 'ApplicationComponent') +
    element('c2', 'ApplicationComponent') +
    element('c3', 'ApplicationCollaboration') +
    element('f', 'ApplicationFunction');

  it('folds one function into every host, from links in both directions, counting each link once', () => {
    const xml = oef({
      elements: twoEnds,
      relationships:
        link('r1', 'c1', 'f', 'Assignment') +
        link('r2', 'f', 'c1', 'Realization') + // the same pair the other way round
        link('r3', 'c2', 'f', 'Composition') +
        link('r4', 'f', 'c3', 'Assignment') +
        link('r5', 'c1', 'f', 'Serving') + // not a folding type
        link('r6', 'f', 'c2', 'Flow'),
    });
    const { jgf, report } = convertOef(xml, mapping);
    for (const host of ['c1', 'c2', 'c3']) {
      expect(jgf.graph.nodes?.[host]?.metadata?.functions).toEqual(['f']);
    }
    expect(jgf.graph.nodes).not.toHaveProperty('f');
    expect(report.functions).toMatchObject({ folded: 1, hosts: 3, duplicateEntries: 0 });
    expect(report.relationships.skipped).toEqual({
      'used-for-folding': { Assignment: 2, Realization: 1, Composition: 1 },
      'no-matching-rule': { Serving: 1 },
      'source-folded': { Flow: 1 },
    });
    expectNothingDroppedSilently(report);
  });

  it('keeps the function as a node when the component type is skipped', () => {
    const custom = withMapping((m) => {
      m.elements.ApplicationComponent = 'skip';
    });
    const xml = oef({
      elements: element('c1', 'ApplicationComponent') + element('f', 'ApplicationFunction'),
      relationships: link('r1', 'c1', 'f', 'Assignment') + link('r2', 'c1', 'f', 'Flow'),
    });
    const { jgf, report } = convertOef(xml, custom);
    expect(Object.keys(jgf.graph.nodes ?? {})).toEqual(['f']);
    expect(report.functions.keptAsNodes).toEqual([{ id: 'f', name: 'f' }]);
    expect(report.elements.skipped).toEqual({ 'skipped-by-config': { ApplicationComponent: 1 } });
    expect(report.relationships.skipped).toEqual({
      'no-matching-rule': { Assignment: 1 },
      'source-not-imported': { Flow: 1 },
    });
    expectNothingDroppedSilently(report);
  });

  it('skips the function and its links when the function type is skipped', () => {
    const custom = withMapping((m) => {
      m.elements.ApplicationFunction = 'skip';
    });
    const xml = oef({
      elements: element('c1', 'ApplicationComponent') + element('f', 'ApplicationFunction'),
      relationships: link('r1', 'c1', 'f', 'Assignment'),
    });
    const { jgf, report } = convertOef(xml, custom);
    expect(jgf.graph.nodes?.c1?.metadata).not.toHaveProperty('functions');
    expect(report.functions.folded).toBe(0);
    expect(report.elements.skipped).toEqual({ 'skipped-by-config': { ApplicationFunction: 1 } });
    expectNothingDroppedSilently(report);
  });

  // Each repeat of a property gets the next free key (oefX, oefX2, ...) by searching from 2
  // every time, which is quadratic: 16,000 repeats in a 0.6 MB file block the API for 10 s.
  it('handles many repeats of one property in linear time', async () => {
    const xmlOf = (count: number) => {
      const repeats = '<property propertyDefinitionRef="p1"/>'.repeat(count);
      return oef({
        elements: `<element identifier="a" xsi:type="Goal"><properties>${repeats}</properties></element>`,
        definitions: '<propertyDefinition identifier="p1"><name>Colour</name></propertyDefinition>',
      });
    };
    const inputs = new Map([5000, 20_000].map((count) => [count, xmlOf(count)]));
    await expectGrowthBelow(
      (count: number) => () => convertOef(inputs.get(count) ?? '', mapping),
      5000,
      20_000,
    );
  });

  // A folded function's name is copied into every host's functions list, so a long name
  // with many hosts turns a 0.4 MB file into a 200 MB response.
  it('keeps the output proportional to the input when one function has many hosts', () => {
    const hosts = Array.from({ length: 200 }, (_, i) => element(`c${i}`, 'ApplicationComponent'));
    const links = hosts.map((_, i) => link(`r${i}`, `c${i}`, 'f', 'Assignment'));
    const xml = oef({
      elements: `<element identifier="f" xsi:type="ApplicationFunction"><name>${'n'.repeat(50_000)}</name></element>${hosts.join('')}`,
      relationships: links.join(''),
    });
    expect(JSON.stringify(convertOef(xml, mapping)).length).toBeLessThan(10 * xml.length);
  });

  // Element and relationship tags with no attributes or children are not counted at all,
  // and type names such as "constructor" or "__proto__" corrupt or lose their counts.
  it('counts every element and relationship tag exactly once, whatever its type name', () => {
    const xml = oef({
      elements:
        '<element/><element>text</element>' +
        element('a', '__proto__') +
        element('b', 'constructor') +
        element('c', 'toString'),
      relationships:
        '<relationship/>' + link('r1', 'a', 'b', 'constructor') + link('r2', 'a', 'b', '__proto__'),
    });
    const { report } = convertOef(xml, mapping);
    expect(report.elements.total).toBe(5);
    expect(report.relationships.total).toBe(3);
    for (const byType of [
      ...Object.values(report.elements.skipped),
      ...Object.values(report.relationships.skipped),
    ]) {
      for (const count of Object.values(byType)) expect(typeof count).toBe('number');
    }
    expectNothingDroppedSilently(report);
  });
});

describe('convertOef: the ArchiMate type is kept as custom metadata', () => {
  const { jgf } = convertOef(bakery, mapping);

  it('stores the OEF xsi:type on every node and edge under archimateType', () => {
    const xsiTypes: Record<string, string | undefined> = Object.fromEntries(
      [...bakery.matchAll(/identifier="([^"]+)"[^>]*xsi:type="([^"]+)"/g)].map((m) => [
        m[1] ?? '',
        m[2],
      ]),
    );
    const nodes = Object.entries(jgf.graph.nodes ?? {});
    expect(nodes.length).toBeGreaterThan(0);
    for (const [id, node] of nodes) expect(node.metadata?.archimateType, id).toBe(xsiTypes[id]);
    for (const edge of jgf.graph.edges ?? []) {
      expect(edge.metadata?.archimateType, edge.id).toBe(xsiTypes[edge.id ?? '']);
    }
    expect(jgf.graph.nodes?.['e-suite']?.metadata?.archimateType).toBe('ApplicationCollaboration');
  });

  it('uses the configured key, or stores nothing when the key is left out', () => {
    const renamed = withMapping((m) => {
      m.properties.archimateTypeKey = 'sourceType';
    });
    const node = convertOef(bakery, renamed).jgf.graph.nodes?.['e-db'];
    expect(node?.metadata?.sourceType).toBe('SystemSoftware');
    expect(node?.metadata).not.toHaveProperty('archimateType');

    const off = withMapping((m) => {
      delete m.properties.archimateTypeKey;
    });
    const { jgf: plain } = convertOef(bakery, off);
    expect(plain.graph.nodes?.['e-db']?.metadata).toEqual({
      type: 'Infrastructure',
      architectureState: 'Current',
    });
    expect(plain.graph.edges?.[1]?.metadata).toEqual({
      architectureState: 'Current',
    });
  });

  it('never lets a property overwrite the type key', () => {
    const xml = oef({
      elements: `<element identifier="a" xsi:type="Goal"><name>A</name>
        <properties><property propertyDefinitionRef="p1"><value>fake</value></property></properties>
      </element>`,
      definitions:
        '<propertyDefinition identifier="p1"><name>Archimate Type</name></propertyDefinition>',
    });
    expect(convertOef(xml, mapping).jgf.graph.nodes?.a?.metadata).toEqual({
      type: 'Other',
      archimateType: 'Goal',
      oefArchimateType: 'fake',
    });
  });
});

describe('convertOef: function folding takes precedence over relationship rules', () => {
  // Like the shipped config: Realization maps to Contains, every other
  // relationship type to Relation.
  const allToRelation = withMapping((m) => {
    for (const type of [
      'Access',
      'Aggregation',
      'Assignment',
      'Association',
      'Composition',
      'Serving',
      'Triggering',
    ] as const) {
      m.relationships.rules.push({ type, relation: 'Relation' });
    }
  });

  it('never emits a folding link as an edge, and reports it as used for folding', () => {
    const { jgf, report } = convertOef(bakery, allToRelation);
    const ids = (jgf.graph.edges ?? []).map((edge) => [edge.id, edge.relation]);
    expect(ids).toEqual([
      ['r-orders', 'Relation'],
      ['r-recipes', 'Relation'],
      ['r-serves', 'Relation'],
      ['r-hosts', 'Relation'],
      ['r-triggers', 'Relation'],
      ['r-report', 'Relation'],
    ]);
    for (const folding of ['r-assign', 'r-compose', 'r-realize', 'r-compose-2']) {
      expect(ids.map(([id]) => id)).not.toContain(folding);
    }
    expect(report.relationships.mapped).toEqual({
      Relation: 6,
      Contains: 0,
    });
    expect(report.relationships.skipped).toEqual({
      'used-for-folding': { Assignment: 1, Composition: 2, Realization: 1 },
      'source-folded': { Flow: 1 },
      'source-not-imported': { Flow: 1 },
      'target-not-an-element': { Flow: 1 },
    });
    expect(report.functions.folded).toBe(3);
    expect(validateJgf(jgf).valid).toBe(true);
    expectNothingDroppedSilently(report);
  });

  it('maps a Realization that is not a folding link by the rules, as Contains', () => {
    const xml = oef({
      elements:
        '<element identifier="c" xsi:type="ApplicationComponent"/>' +
        '<element identifier="f" xsi:type="ApplicationFunction"/>' +
        '<element identifier="s" xsi:type="ApplicationService"/>',
      relationships:
        '<relationship identifier="fold" source="c" target="f" xsi:type="Realization"/>' +
        '<relationship identifier="plain" source="c" target="s" xsi:type="Realization"/>',
    });
    const { jgf, report } = convertOef(xml, allToRelation);
    expect(
      (jgf.graph.edges ?? []).map((edge) => [edge.id, edge.source, edge.target, edge.relation]),
    ).toEqual([['plain', 'c', 's', 'Contains']]);
    expect(report.relationships.mapped.Contains).toBe(1);
    expect(report.relationships.skipped).toEqual({ 'used-for-folding': { Realization: 1 } });
  });
});

describe('convertOef: Realization as Contains, and reversed rules', () => {
  const xml = oef({
    elements:
      '<element identifier="c" xsi:type="ApplicationComponent"/>' +
      '<element identifier="f" xsi:type="ApplicationFunction"/>' +
      '<element identifier="s" xsi:type="ApplicationService"/>' +
      '<element identifier="n" xsi:type="Node"/>',
    relationships:
      '<relationship identifier="fold" source="f" target="c" xsi:type="Realization"/>' +
      '<relationship identifier="r1" source="c" target="s" xsi:type="Realization"/>' +
      '<relationship identifier="r2" source="n" target="c" xsi:type="Realization">' +
      '<properties><property propertyDefinitionRef="pd-state"><value xml:lang="en">Target state</value></property></properties>' +
      '</relationship>',
  });

  it('imports Realization as Contains in the OEF direction by default, with Architecture state', () => {
    const { jgf, report } = convertOef(xml, mapping);
    const edges = jgf.graph.edges ?? [];
    expect(edges.map((edge) => [edge.id, edge.source, edge.target, edge.relation])).toEqual([
      ['r1', 'c', 's', 'Contains'],
      ['r2', 'n', 'c', 'Contains'],
    ]);
    expect(edges.map((edge) => edge.metadata?.architectureState)).toEqual(['Current', 'Target']);
    expect(report.relationships.mapped).toEqual({
      Relation: 0,
      Contains: 2,
    });
    expect(report.relationships.skipped).toEqual({ 'used-for-folding': { Realization: 1 } });
    expect(report.functions.folded).toBe(1);
    const result = validateJgf(jgf);
    expect(result.valid).toBe(true);
    expect(result.summary.edges.byRelation.Contains).toBe(2);
    expectNothingDroppedSilently(report);
  });

  it('swaps source and target with reverse: true; folding still comes first', () => {
    const reversed = withMapping((m) => {
      const rule = m.relationships.rules.find((r) => r.type === 'Realization');
      if (rule) rule.reverse = true;
    });
    const { jgf, report } = convertOef(xml, reversed);
    expect(
      (jgf.graph.edges ?? []).map((edge) => [edge.id, edge.source, edge.target, edge.relation]),
    ).toEqual([
      ['r1', 's', 'c', 'Contains'],
      ['r2', 'c', 'n', 'Contains'],
    ]);
    expect(report.relationships.skipped).toEqual({ 'used-for-folding': { Realization: 1 } });
    expect(report.functions.folded).toBe(1);
  });

  it('matches sourceNodeTypes and targetNodeTypes on the OEF direction, before reversing', () => {
    const reversed = withMapping((m) => {
      m.relationships.rules = [
        {
          type: 'Realization',
          sourceNodeTypes: ['Infrastructure'],
          relation: 'Contains',
          reverse: true,
        },
      ];
    });
    const { jgf } = convertOef(xml, reversed);
    expect((jgf.graph.edges ?? []).map((edge) => [edge.id, edge.source, edge.target])).toEqual([
      ['r2', 'c', 'n'],
    ]);
  });

  it('leaves reverse off unless it is true', () => {
    const off = withMapping((m) => {
      const rule = m.relationships.rules.find((r) => r.type === 'Realization');
      if (rule) rule.reverse = false;
    });
    expect((convertOef(xml, off).jgf.graph.edges ?? [])[0]).toMatchObject({
      source: 'c',
      target: 's',
    });
  });
});

describe('convertOef: bounded time and output', () => {
  function manyFunctionsOneHost(count: number): string {
    const functions = Array.from(
      { length: count },
      (_, i) =>
        `<element identifier="f${i}" xsi:type="ApplicationFunction"><name>F${i}</name></element>`,
    );
    const links = functions.map(
      (_, i) =>
        `<relationship identifier="a${i}" source="c0" target="f${i}" xsi:type="Assignment"/>`,
    );
    return oef({
      elements: `<element identifier="c0" xsi:type="ApplicationComponent"/>${functions.join('')}`,
      relationships: links.join(''),
    });
  }

  function oneFunctionManyHosts(count: number): string {
    const hosts = Array.from(
      { length: count },
      (_, i) => `<element identifier="c${i}" xsi:type="ApplicationComponent"/>`,
    );
    const links = hosts.map(
      (_, i) =>
        `<relationship identifier="b${i}" source="c${i}" target="f" xsi:type="Composition"/>`,
    );
    return oef({
      elements: `<element identifier="f" xsi:type="ApplicationFunction"><name>F</name></element>${hosts.join('')}`,
      relationships: links.join(''),
    });
  }

  it('stays linear when many functions share one host', async () => {
    const count = 24_000;
    const { jgf, report } = convertOef(manyFunctionsOneHost(count), mapping);
    expect(jgf.graph.nodes?.c0?.metadata?.functions).toHaveLength(count);
    expect(report.functions).toMatchObject({ folded: count, hosts: 1, duplicateEntries: 0 });

    const inputs = new Map([count, count / 4].map((n) => [n, manyFunctionsOneHost(n)]));
    await expectGrowthBelow(
      (n: number) => () => convertOef(inputs.get(n) ?? '', mapping),
      count / 4,
      count,
    );
  });

  it('stays linear when one function has many hosts', async () => {
    const count = 24_000;
    const { report } = convertOef(oneFunctionManyHosts(count), mapping);
    expect(report.functions).toMatchObject({ folded: 1, hosts: count });

    const inputs = new Map([count, count / 4].map((n) => [n, oneFunctionManyHosts(n)]));
    await expectGrowthBelow(
      (n: number) => () => convertOef(inputs.get(n) ?? '', mapping),
      count / 4,
      count,
    );
  });

  it("computes a long property name's key once, and cuts the key short", async () => {
    const xmlOf = (count: number) => {
      const repeats = '<property propertyDefinitionRef="p1"><value>v</value></property>'.repeat(
        count,
      );
      return oef({
        elements: `<element identifier="a" xsi:type="Goal"><properties>${repeats}</properties></element>`,
        definitions: `<propertyDefinition identifier="p1"><name>${'Long '.repeat(200_000)}</name></propertyDefinition>`,
      });
    };
    const xml = xmlOf(2000);
    const { jgf, report } = convertOef(xml, mapping);
    // 2000 uses cost about what one does: reading the 1 MB name once is nearly all the work.
    const inputs = new Map([1, 2000].map((count) => [count, xmlOf(count)]));
    await expectGrowthBelow(
      (count: number) => () => convertOef(inputs.get(count) ?? '', mapping),
      1,
      2000,
    );
    const keys = Object.keys(jgf.graph.nodes?.a?.metadata ?? {});
    expect(keys).toHaveLength(2 + 2000);
    for (const key of keys) expect(key.length).toBeLessThanOrEqual(maxCustomKeyLength + 10);
    expect(report.properties.renamedKeys).toBe(1999);
  });

  it(`cuts function entries to ${maxFunctionEntryLength} characters and reports it`, () => {
    const xml = oef({
      elements:
        `<element identifier="f" xsi:type="ApplicationFunction"><name>${'n'.repeat(50_000)}</name></element>` +
        '<element identifier="c" xsi:type="ApplicationComponent"/>',
      relationships: '<relationship identifier="r" source="c" target="f" xsi:type="Assignment"/>',
    });
    const { jgf, report } = convertOef(xml, mapping);
    expect(jgf.graph.nodes?.c?.metadata?.functions).toEqual([
      `${'n'.repeat(maxFunctionEntryLength)}…`,
    ]);
    expect(report.functions).toMatchObject({ entriesTruncated: 1, entriesNotAdded: 0 });
  });

  it(`adds at most ${maxFunctionEntries} function entries per import and reports the rest`, () => {
    const functions = 260;
    const hosts = 200;
    const elements = [
      ...Array.from(
        { length: functions },
        (_, i) => `<element identifier="f${i}" xsi:type="ApplicationFunction"/>`,
      ),
      ...Array.from(
        { length: hosts },
        (_, i) => `<element identifier="c${i}" xsi:type="ApplicationComponent"/>`,
      ),
    ];
    const links: string[] = [];
    for (let f = 0; f < functions; f += 1) {
      for (let c = 0; c < hosts; c += 1) {
        links.push(
          `<relationship identifier="r${f}-${c}" source="c${c}" target="f${f}" xsi:type="Assignment"/>`,
        );
      }
    }
    const { report } = convertOef(
      oef({ elements: elements.join(''), relationships: links.join('') }),
      mapping,
    );
    expect(report.functions.entriesNotAdded).toBe(functions * hosts - maxFunctionEntries);
    expect(report.functions.folded).toBe(functions);
    expectNothingDroppedSilently(report);
  });
});

describe('convertOef: sections, empty models and size caps', () => {
  it.each(['elements', 'relationships', 'propertyDefinitions'])(
    'refuses a second <%s> section instead of ignoring it',
    (section) => {
      const xml = `<model><${section}/><${section}/></model>`;
      expect(() => convertOef(xml, mapping)).toThrow(
        new OefFormatError(`The model has more than one <${section}> section.`),
      );
    },
  );

  it('refuses a second <properties> section on an element', () => {
    const xml = oef({
      elements: '<element identifier="a" xsi:type="Goal"><properties/><properties/></element>',
    });
    expect(() => convertOef(xml, mapping)).toThrow(/more than one <properties> section/);
  });

  it.each(['<model/>', '<model></model>', '<model identifier="m">  </model>'])(
    'converts the empty model %s to an empty graph',
    (xml) => {
      const { jgf, report } = convertOef(xml, mapping);
      expect(jgf.graph.nodes).toEqual({});
      expect(jgf.graph.edges).toEqual([]);
      expect(report.elements.total).toBe(0);
      expect(validateJgf(jgf).valid).toBe(true);
    },
  );

  it(`refuses more than ${maxImportNodes} elements`, () => {
    const xml = oef({ elements: '<element/>'.repeat(maxImportNodes + 1) });
    expect(() => convertOef(xml, mapping)).toThrow(ImportTooLargeError);
    expect(() =>
      convertOef(oef({ elements: '<element/>'.repeat(maxImportNodes) }), mapping),
    ).not.toThrow();
  });

  it(`refuses more than ${maxImportEdges} relationships`, () => {
    const xml = oef({ relationships: '<relationship/>'.repeat(maxImportEdges + 1) });
    expect(() => convertOef(xml, mapping)).toThrow(
      new ImportTooLargeError(`The model has more than ${maxImportEdges} relationships.`),
    );
  });
});

describe('convertOef: relationships skipped for a folded end (listed one by one)', () => {
  const element = (id: string, type: string) =>
    `<element identifier="${id}" xsi:type="${type}"><name>Made-up ${id}</name></element>`;
  const link = (id: string, source: string, target: string, type: string) =>
    `<relationship identifier="${id}" source="${source}" target="${target}" xsi:type="${type}"/>`;
  // f1 and f2 fold into c1; db stays a node.
  const elements =
    element('c1', 'ApplicationComponent') +
    element('f1', 'ApplicationFunction') +
    element('f2', 'ApplicationFunction') +
    element('db', 'DataObject');
  const folding =
    link('fold-1', 'c1', 'f1', 'Assignment') + link('fold-2', 'c1', 'f2', 'Assignment');

  it('lists each one with its id, ArchiMate type, reason and folded end', () => {
    const xml = oef({
      elements,
      relationships:
        folding +
        link('from-fn', 'f1', 'db', 'Flow') +
        link('to-fn', 'db', 'f2', 'Flow') +
        link('fn-to-fn', 'f1', 'f2', 'Flow') +
        link('ordinary', 'c1', 'db', 'Flow'),
    });
    const { jgf, report } = convertOef(xml, mapping);
    expect(report.relationships.foldedEnds).toEqual({
      count: 3,
      listed: [
        { id: 'from-fn', type: 'Flow', reason: 'source-folded', end: 'source' },
        { id: 'to-fn', type: 'Flow', reason: 'target-folded', end: 'target' },
        { id: 'fn-to-fn', type: 'Flow', reason: 'source-folded', end: 'both' },
      ],
      truncated: false,
    });
    expect(report.relationships.skipped).toMatchObject({
      'source-folded': { Flow: 2 },
      'target-folded': { Flow: 1 },
    });
    // The relationships used for folding are not in the list, and the ordinary one is an edge.
    expect((jgf.graph.edges ?? []).map((edge) => edge.id)).toEqual(['ordinary']);
    expectNothingDroppedSilently(report);
  });

  it('is empty when nothing touches a folded function', () => {
    const { report } = convertOef(oef({ elements, relationships: folding }), mapping);
    expect(report.relationships.foldedEnds).toEqual({ count: 0, listed: [], truncated: false });
  });

  it(`lists at most ${maxListedFoldedEnds}, keeps the count complete, and cuts long ids`, () => {
    const many = Array.from({ length: maxListedFoldedEnds + 5 }, (_, i) =>
      link(`r${i}`, 'f1', 'db', 'Flow'),
    ).join('');
    const longId = 'x'.repeat(5000);
    const xml = oef({
      elements,
      relationships: folding + link(longId, 'db', 'f1', 'Flow') + many,
    });
    const { report } = convertOef(xml, mapping);
    const { foldedEnds } = report.relationships;
    expect(foldedEnds.count).toBe(maxListedFoldedEnds + 6);
    expect(foldedEnds.listed).toHaveLength(maxListedFoldedEnds);
    expect(foldedEnds.truncated).toBe(true);
    expect(foldedEnds.listed[0]).toEqual({
      id: `${'x'.repeat(80)}…`,
      type: 'Flow',
      reason: 'target-folded',
      end: 'target',
    });
    expectNothingDroppedSilently(report);
  });

  it('lists relationships of a type with no rule as no-matching-rule, not as folded', () => {
    // Serving has no rule in the agreed defaults: it is skipped for that reason first.
    const xml = oef({ elements, relationships: folding + link('serves', 'f1', 'db', 'Serving') });
    const { report } = convertOef(xml, mapping);
    expect(report.relationships.foldedEnds.count).toBe(0);
    expect(report.relationships.skipped['no-matching-rule']).toEqual({ Serving: 1 });
  });
});

describe('convertOef: Architecture State on relationships', () => {
  const two = `<element identifier="a" xsi:type="Goal"><name>A</name></element>
    <element identifier="b" xsi:type="Goal"><name>B</name></element>`;
  const flow = (id: string, properties = '') =>
    `<relationship identifier="${id}" source="a" target="b" xsi:type="Flow">${
      properties === '' ? '' : `<properties>${properties}</properties>`
    }</relationship>`;
  const state = (value: string) =>
    `<property propertyDefinitionRef="pd-state"><value>${value}</value></property>`;

  it('maps the value like on elements, and empty or missing means Current', () => {
    const xml = oef({
      elements: two,
      relationships:
        flow('target', state('Target state')) +
        flow('deprecate', state('Deprecate')) +
        flow('empty', state('')) +
        flow('missing'),
    });
    const { jgf, report } = convertOef(xml, mapping);
    expect((jgf.graph.edges ?? []).map((e) => [e.id, e.metadata?.architectureState])).toEqual([
      ['target', 'Target'],
      ['deprecate', 'Deprecate'],
      ['empty', 'Current'],
      ['missing', 'Current'],
    ]);
    expect(report.properties.onRelationships).toEqual({
      mapped: { architectureState: 3 },
      defaultsApplied: { architectureState: 2 },
    });
    expect(report.properties.valuesTranslated).toBe(2);
    expect(validateJgf(jgf).valid).toBe(true);
  });

  it('keeps an untranslated relationship value; validation warns', () => {
    const xml = oef({ elements: two, relationships: flow('r', state('Sunset')) });
    const { jgf, report } = convertOef(xml, mapping);
    expect(jgf.graph.edges?.[0]?.metadata?.architectureState).toBe('Sunset');
    expect(report.properties.valuesNotTranslated).toEqual({ architectureState: 1 });
    const result = validateJgf(jgf);
    expect(result.errors).toEqual([]);
    expect(result.warnings.map((e) => [e.edgeId, e.field, e.code])).toEqual([
      ['r', 'metadata.architectureState', 'invalid-property-value'],
    ]);
  });

  it('keeps a repeated mapped property as custom metadata, never overwriting', () => {
    const xml = oef({
      elements: two,
      relationships: flow('r', state('Target state') + state('Deprecate')),
    });
    expect(convertOef(xml, mapping).jgf.graph.edges?.[0]?.metadata).toEqual({
      archimateType: 'Flow',
      architectureState: 'Target',
      oefArchitectureState: 'Deprecate',
    });
  });

  it('applies a default to the relations it lists, and only to them', () => {
    const xml = oef({ elements: two, relationships: flow('r') });
    const nodesOnly = withMapping((m) => {
      m.properties.defaults = [
        { key: 'architectureState', value: 'Current', nodeTypes: ['Other'] },
      ];
    });
    const fromNodesOnly = convertOef(xml, nodesOnly).jgf.graph;
    expect(fromNodesOnly.edges?.[0]?.metadata).not.toHaveProperty('architectureState');
    expect(fromNodesOnly.nodes?.a?.metadata?.architectureState).toBe('Current');

    const edgesOnly = withMapping((m) => {
      m.properties.defaults = [
        { key: 'reviewed', value: 'no', relations: ['Relation'] },
        { key: 'other', value: 'x', relations: ['Contains'] },
      ];
    });
    const fromEdgesOnly = convertOef(xml, edgesOnly);
    expect(fromEdgesOnly.jgf.graph.edges?.[0]?.metadata).toEqual({
      archimateType: 'Flow',
      reviewed: 'no',
    });
    expect(fromEdgesOnly.jgf.graph.nodes?.a?.metadata).not.toHaveProperty('reviewed');
    expect(fromEdgesOnly.report.properties.onRelationships.defaultsApplied).toEqual({
      reviewed: 1,
    });
  });
});

describe('convertOef: two-way relationships', () => {
  const elements = `
    <element identifier="a" xsi:type="ApplicationComponent"><name>Made-up A</name></element>
    <element identifier="b" xsi:type="ApplicationComponent"><name>Made-up B</name></element>`;

  // The pinned mapping has no Association rule; these tests add one.
  const withAssociation = (relation: 'Relation' | 'Contains') =>
    withMapping((draft) => {
      draft.relationships.rules = [
        ...draft.relationships.rules.filter((rule) => rule.type !== 'Association'),
        { type: 'Association', relation },
      ];
    });

  it('imports an undirected Association as a two-way Relation; others stay one-way', () => {
    const { jgf, report } = convertOef(
      oef({
        elements,
        relationships: `
          <relationship identifier="r-plain" source="a" target="b" xsi:type="Association" />
          <relationship identifier="r-false" source="a" target="b" xsi:type="Association" isDirected="false" />
          <relationship identifier="r-true" source="b" target="a" xsi:type="Association" isDirected="true" />
          <relationship identifier="r-flow" source="a" target="b" xsi:type="Flow" />`,
      }),
      withAssociation('Relation'),
    );
    const edges = Object.fromEntries(
      (jgf.graph.edges ?? []).map((edge): [string, unknown] => [
        edge.id ?? '',
        [edge.relation, edge.directed],
      ]),
    );
    expect(report.relationships.skipped).toEqual({});
    expect(edges).toEqual({
      'r-plain': ['Relation', false],
      'r-false': ['Relation', false],
      'r-true': ['Relation', true],
      'r-flow': ['Relation', true],
    });
    expect(validateJgf(jgf).warnings).toEqual([]);
  });

  it('sets Request Data from the name only where a rule says so, and keeps a custom property apart', () => {
    const { jgf } = convertOef(
      oef({
        elements,
        definitions: `<propertyDefinition identifier="pd-flow" type="string"><name>Information Flow</name></propertyDefinition><propertyDefinition identifier="pd-data" type="string"><name>Data</name></propertyDefinition>`,
        relationships: `
          <relationship identifier="r-flow" source="a" target="b" xsi:type="Flow">
            <name xml:lang="en">Made-up rows</name>
            <properties><property propertyDefinitionRef="pd-flow"><value xml:lang="en">Made-up</value></property><property propertyDefinitionRef="pd-data"><value xml:lang="en">Made-up data</value></property></properties>
          </relationship>
          <relationship identifier="r-plain" source="a" target="b" xsi:type="Association">
            <name xml:lang="en">Made-up link</name>
          </relationship>`,
      }),
      withAssociation('Relation'),
    );
    expect(jgf.graph.edges?.[0]?.metadata).toMatchObject({
      requestData: ['Made-up rows'],
      oefInformationFlow: 'Made-up',
      // A property named Data never takes the retired key.
      oefData: 'Made-up data',
    });
    expect(jgf.graph.edges?.[0]?.metadata).not.toHaveProperty('data');
    expect(jgf.graph.edges?.[0]?.metadata).not.toHaveProperty('informationFlow');
    expect(jgf.graph.edges?.[1]?.label).toBe('Made-up link');
    expect(jgf.graph.edges?.[1]?.metadata).not.toHaveProperty('requestData');
    expect(validateJgf(jgf).valid).toBe(true);
  });

  it('takes a property mapped to Response Data as one value of its list, and drops a blank one', () => {
    const config = withMapping((draft) => {
      draft.relationships.rules = [
        ...draft.relationships.rules.filter((rule) => rule.type !== 'Association'),
        { type: 'Association', relation: 'Relation' },
      ];
      draft.properties.mappings.push({ name: 'Returns', key: 'responseData' });
    });
    const { jgf } = convertOef(
      oef({
        elements,
        definitions: `<propertyDefinition identifier="pd-returns" type="string"><name>Returns</name></propertyDefinition>`,
        relationships: `
          <relationship identifier="r1" source="a" target="b" xsi:type="Association">
            <properties><property propertyDefinitionRef="pd-returns"><value xml:lang="en">Made-up totals, by day</value></property></properties>
          </relationship>
          <relationship identifier="r2" source="a" target="b" xsi:type="Association">
            <properties><property propertyDefinitionRef="pd-returns"><value xml:lang="en"> </value></property></properties>
          </relationship>`,
      }),
      config,
    );
    expect(jgf.graph.edges?.[0]?.metadata).toMatchObject({
      responseData: ['Made-up totals, by day'],
    });
    expect(jgf.graph.edges?.[1]?.metadata).not.toHaveProperty('responseData');
    expect(validateJgf(jgf).warnings).toEqual([]);
  });

  it('keeps an undirected Association one-way when the config maps it to Contains', () => {
    const config = withAssociation('Contains');
    const { jgf } = convertOef(
      oef({
        elements,
        relationships: `<relationship identifier="r1" source="a" target="b" xsi:type="Association" />`,
      }),
      config,
    );
    expect(jgf.graph.edges?.[0]).toMatchObject({ relation: 'Contains', directed: true });
  });
});
