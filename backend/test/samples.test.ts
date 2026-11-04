import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  architectureStates,
  edgeTypes,
  nodeTypes,
  type JgfDocument,
  type JgfValidationResult,
} from '@simplearchitecture/shared';
import { describe, expect, it } from 'vitest';
import { validateImported } from '../src/jgf/older-types.js';
import { convertOef } from '../src/oef/mapper.js';
import { loadOefMapping } from '../src/oef/mapping-config.js';

// The made-up sample models in samples/ must keep importing cleanly as the metamodel, the
// validation and the shipped OEF mapping change.
const samples = new URL('../../samples/', import.meta.url);
const jgfText = readFileSync(new URL('sample-insurance.jgf.json', samples), 'utf8');
const oefText = readFileSync(new URL('sample-insurance.oef.xml', samples), 'utf8');
const shippedMapping = loadOefMapping(
  fileURLToPath(new URL('../../config/oef-mapping.json', import.meta.url)),
);

/** Listed issues first, so a failure names them. */
function expectClean(validation: JgfValidationResult): void {
  expect(validation.errors).toEqual([]);
  expect(validation.warnings).toEqual([]);
  expect(validation.errorCount).toBe(0);
  expect(validation.warningCount).toBe(0);
  expect(validation.valid).toBe(true);
}

describe('samples/sample-insurance.jgf.json', () => {
  const { document, validation } = validateImported(JSON.parse(jgfText));

  it('imports with no errors and no warnings', () => {
    expectClean(validation);
  });

  it('shows every element type, relationship type and relationship property', () => {
    for (const type of nodeTypes) expect(validation.summary.nodes.byType[type]).toBeGreaterThan(0);
    for (const type of edgeTypes) {
      expect(validation.summary.edges.byRelation[type]).toBeGreaterThan(0);
    }
    const edges = (document as JgfDocument).graph.edges ?? [];
    for (const state of architectureStates) {
      expect(edges.some((edge) => edge.metadata?.architectureState === state)).toBe(true);
    }
    const relations = edges.filter((edge) => edge.relation === 'Relation');
    for (const key of ['identity', 'identityContext', 'data']) {
      expect(relations.some((edge) => typeof edge.metadata?.[key] === 'string')).toBe(true);
      expect(relations.some((edge) => edge.metadata?.[key] === undefined)).toBe(true);
    }
    expect(edges.some((edge) => edge.metadata?.informationFlow !== undefined)).toBe(false);
    expect(relations.some((edge) => edge.directed === false)).toBe(true);
  });
});

describe('samples/sample-insurance.oef.xml', () => {
  const { jgf, report } = convertOef(oefText, shippedMapping);
  const { validation } = validateImported(jgf);
  const sample = validateImported(JSON.parse(jgfText)).validation;

  it('converts with the shipped config/oef-mapping.json and validates with no errors or warnings', () => {
    expectClean(validation);
  });

  it('imports every element and relationship of the JGF sample, and drops nothing else', () => {
    expect(validation.summary).toEqual(sample.summary);
    expect(report.elements.skipped).toEqual({});
    expect(report.functions.keptAsNodes).toEqual([]);
    // Only the links that fold application functions into their components are not imported.
    expect(Object.keys(report.relationships.skipped)).toEqual(['used-for-folding']);
    expect(report.properties.unknownDefinitions).toBe(0);
  });
});
