import {
  edgeTypes,
  canBeTwoWay,
  hasStandardEdgeProperty,
  isStandardPropertyKey,
  isStandardPropertyOf,
  nodeTypeKey,
  nodeTypes,
  standardProperties,
  type CountsByReasonAndType,
  type EdgeType,
  type JgfDocument,
  type JgfEdge,
  type JgfNode,
  type NodeType,
  type OefMappingReport,
} from '@simplearchitecture/shared';
import { retiredInformationFlowKey } from '../jgf/older-types.js';
import { maxEchoLength, reservedKey } from '../jgf/validate.js';
import { ImportTooLargeError, maxImportEdges, maxImportNodes } from '../limits.js';
import type { OefMapping, RelationshipRule } from './mapping-config.js';
import { parseXml, type XmlLimits } from './xml.js';

export interface OefConversion {
  jgf: JgfDocument;
  report: OefMappingReport;
}

type XmlNode = Record<string, unknown>;

interface OefProperty {
  name: string;
  value: string;
}

interface OefElement {
  id: string;
  type: string;
  name: string;
  documentation: string;
  properties: OefProperty[];
}

interface OefRelationship extends OefElement {
  source: string;
  target: string;
  /**
   * An Association without `isDirected="true"` (ArchiMate's default is undirected): it imports
   * as two-way when its edge type can be. Every other relationship is one-way.
   */
  undirected: boolean;
}

// --- Reading the parsed XML -------------------------------------------------------------------

function isXmlNode(value: unknown): value is XmlNode {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function list(value: unknown): unknown[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function child(node: unknown, name: string): XmlNode | undefined {
  if (!isXmlNode(node)) return undefined;
  const value = node[name];
  const first = Array.isArray(value) ? (value[0] as unknown) : value;
  return isXmlNode(first) ? first : undefined;
}

function attribute(node: XmlNode, name: string): string {
  const value = node[`@_${name}`];
  return typeof value === 'string' ? value.trim() : '';
}

function textOf(value: unknown): string {
  if (typeof value === 'string') return value;
  if (isXmlNode(value)) {
    const text = value['#text'];
    return typeof text === 'string' ? text : '';
  }
  return '';
}

/** A multilingual OEF value (name, documentation, property value): English, else the first. */
function pickLanguage(values: unknown): string {
  const all = list(values);
  const english = all.find(
    (value) => isXmlNode(value) && /^en(-|$)/i.test(attribute(value, 'lang')),
  );
  return textOf(english ?? all[0]).trim();
}

// --- camelCase keys -----------------------------------------------------------------------------

/**
 * The custom metadata key for an OEF property name: split into words on anything that is not a
 * letter or digit, lower-case the first word, capitalise the first letter of each next word.
 * "Internal/External" → internalExternal, "HQ Country" → hqCountry.
 */
export function camelCaseKey(name: string): string {
  const words = name.split(/[^\p{L}\p{N}]+/u).filter((word) => word !== '');
  const [first, ...rest] = words;
  if (first === undefined) return 'property';
  return (
    first.toLowerCase() + rest.map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join('')
  );
}

// --- The mapper ---------------------------------------------------------------------------------

/** The OEF file is well-formed XML but not an ArchiMate model. The message is user-safe. */
export class OefFormatError extends Error {
  override name = 'OefFormatError';
}

/** A folded function's entry is cut to this length; longer names are counted in the report. */
export const maxFunctionEntryLength = 200;
/** At most this many entries are added to `functions` lists in one import; the rest are counted. */
export const maxFunctionEntries = 50_000;
/** Custom metadata keys derived from property names are cut to this length. */
export const maxCustomKeyLength = 100;
/** At most this many relationships with a folded end are listed one by one; all are counted. */
export const maxListedFoldedEnds = 1000;

/** A counter keyed by text from the input: no prototype, so `__proto__` or `toString` are plain keys. */
function counter(): Record<string, number> {
  return Object.create(null) as Record<string, number>;
}

function increment(counts: Record<string, number>, key: string): void {
  counts[key] = (counts[key] ?? 0) + 1;
}

function incrementByReason(counts: CountsByReasonAndType, reason: string, type: string): void {
  counts[reason] ??= counter();
  increment(counts[reason], type || '(no type)');
}

function zeroCounts<T extends string>(keys: readonly T[]): Record<T, number> {
  return Object.fromEntries(keys.map((key) => [key, 0])) as Record<T, number>;
}

function emptyReport(): OefMappingReport {
  return {
    elements: {
      total: 0,
      mapped: zeroCounts(nodeTypes),
      mappedByElementType: counter(),
      folded: counter(),
      skipped: Object.create(null) as CountsByReasonAndType,
    },
    functions: {
      folded: 0,
      hosts: 0,
      foldedWithDetailsNotCarried: 0,
      duplicateEntries: 0,
      entriesTruncated: 0,
      entriesNotAdded: 0,
      keptAsNodes: [],
    },
    relationships: {
      total: 0,
      mapped: zeroCounts(edgeTypes),
      skipped: Object.create(null) as CountsByReasonAndType,
      foldedEnds: { count: 0, listed: [], truncated: false },
    },
    properties: {
      mapped: counter(),
      keptAsCustom: counter(),
      valuesTranslated: 0,
      valuesNotTranslated: counter(),
      defaultsApplied: counter(),
      onRelationships: { mapped: counter(), defaultsApplied: counter() },
      renamedKeys: 0,
      unknownDefinitions: 0,
    },
    viewsSkipped: 0,
    organizationItemsSkipped: 0,
  };
}

function countItems(node: unknown): number {
  if (Array.isArray(node)) return node.reduce((sum: number, entry) => sum + countItems(entry), 0);
  if (!isXmlNode(node)) return 0;
  const items = list(node.item);
  return items.reduce((sum: number, item) => sum + countItems(item), items.length);
}

/** A section that OEF allows once. A second one is refused rather than silently ignored. */
function single(node: XmlNode, name: string, where: string): XmlNode | undefined {
  const value = node[name];
  if (Array.isArray(value) && value.length > 1) {
    throw new OefFormatError(`${where} has more than one <${name}> section.`);
  }
  return child(node, name);
}

function cut(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/**
 * Converts an ArchiMate OEF document to JGF, driven by the mapping config. Everything not
 * imported is counted in the report. Linear in the size of the input. Throws XmlRejectedError
 * (unsafe or malformed XML), OefFormatError (not an OEF model) or ImportTooLargeError.
 */
export function convertOef(xml: string, mapping: OefMapping, limits?: XmlLimits): OefConversion {
  const parsed = parseXml(xml, limits);
  if (!Object.hasOwn(parsed, 'model')) {
    throw new OefFormatError(
      'This is not an ArchiMate Open Exchange Format file: the root element must be <model>.',
    );
  }
  // An empty <model/> parses as text: it is an empty model.
  const model: XmlNode = isXmlNode(parsed.model) ? parsed.model : {};

  const report = emptyReport();
  const props = report.properties;

  // Property definitions: identifier → name, and each name's custom key (computed once).
  const definitions = new Map<string, string>();
  for (const definition of list(
    single(model, 'propertyDefinitions', 'The model')?.propertyDefinition,
  )) {
    if (!isXmlNode(definition)) continue;
    const id = attribute(definition, 'identifier');
    const name = pickLanguage(definition.name) || attribute(definition, 'name');
    if (id !== '') definitions.set(id, name || id);
  }
  const customKeys = new Map<string, string>();
  const customKeyOf = (name: string): string => {
    let key = customKeys.get(name);
    if (key === undefined) {
      key = camelCaseKey(name).slice(0, maxCustomKeyLength);
      customKeys.set(name, key);
    }
    return key;
  };

  const readProperties = (node: XmlNode): OefProperty[] => {
    const result: OefProperty[] = [];
    for (const property of list(single(node, 'properties', 'An element')?.property)) {
      if (!isXmlNode(property)) continue;
      const name = definitions.get(attribute(property, 'propertyDefinitionRef'));
      if (name === undefined) {
        props.unknownDefinitions += 1;
        continue;
      }
      result.push({ name, value: pickLanguage(property.value) });
    }
    return result;
  };

  // A tag without attributes or children (<element/>) parses as text: read it as empty, so it
  // is still counted (and skipped for its missing identifier).
  const readElement = (value: unknown): OefElement => {
    const node = isXmlNode(value) ? value : {};
    return {
      id: attribute(node, 'identifier'),
      type: attribute(node, 'type'),
      name: pickLanguage(node.name),
      documentation: pickLanguage(node.documentation),
      properties: readProperties(node),
    };
  };

  const elementNodes = list(single(model, 'elements', 'The model')?.element);
  const relationshipNodes = list(single(model, 'relationships', 'The model')?.relationship);
  if (elementNodes.length > maxImportNodes) {
    throw new ImportTooLargeError(`The model has more than ${maxImportNodes} elements.`);
  }
  if (relationshipNodes.length > maxImportEdges) {
    throw new ImportTooLargeError(`The model has more than ${maxImportEdges} relationships.`);
  }

  // 1. Elements: decide each element's node type, or why it is skipped.
  const elementsById = new Map<string, OefElement>();
  const nodeTypeOf = new Map<string, NodeType>(); // candidates for a node
  for (const value of elementNodes) {
    report.elements.total += 1;
    const element = readElement(value);
    const skip = (reason: string): void => {
      incrementByReason(report.elements.skipped, reason, element.type);
    };
    if (element.id === '') {
      skip('missing-identifier');
      continue;
    }
    if (elementsById.has(element.id)) {
      skip('duplicate-identifier');
      continue;
    }
    elementsById.set(element.id, element);
    // The JGF import refuses this id (see jgf/validate.ts), so it is never output.
    if (element.id === reservedKey) {
      skip('reserved-identifier');
      continue;
    }
    const target = Object.hasOwn(mapping.elements, element.type)
      ? mapping.elements[element.type]
      : undefined;
    if (target === undefined) skip('unknown-element-type');
    else if (target === 'skip') skip('skipped-by-config');
    else nodeTypeOf.set(element.id, target);
  }

  const relationships: OefRelationship[] = relationshipNodes.map((value) => ({
    ...readElement(value),
    source: isXmlNode(value) ? attribute(value, 'source') : '',
    target: isXmlNode(value) ? attribute(value, 'target') : '',
    undirected:
      isXmlNode(value) &&
      attribute(value, 'type') === 'Association' &&
      attribute(value, 'isDirected').toLowerCase() !== 'true',
  }));
  report.relationships.total = relationships.length;

  // 2. Function folding: function id → host ids, and the relationships that link them.
  const functionTypes = new Set(
    mapping.functionFolding.rules.flatMap((rule) =>
      rule.fold === 'source' ? rule.sourceTypes : rule.targetTypes,
    ),
  );
  const hostsOf = new Map<string, Set<string>>();
  const foldingLinks = new Map<OefRelationship, { fn: string; host: string }>();
  for (const relationship of relationships) {
    const source = elementsById.get(relationship.source);
    const target = elementsById.get(relationship.target);
    if (!source || !target || !nodeTypeOf.has(source.id) || !nodeTypeOf.has(target.id)) continue;
    const rule = mapping.functionFolding.rules.find(
      (candidate) =>
        (candidate.relationshipTypes as readonly string[]).includes(relationship.type) &&
        candidate.sourceTypes.includes(source.type) &&
        candidate.targetTypes.includes(target.type),
    );
    if (!rule) continue;
    const [fn, host] = rule.fold === 'source' ? [source.id, target.id] : [target.id, source.id];
    foldingLinks.set(relationship, { fn, host });
    let hosts = hostsOf.get(fn);
    if (!hosts) {
      hosts = new Set();
      hostsOf.set(fn, hosts);
    }
    hosts.add(host);
  }
  // A host must stay a node itself; a function whose hosts are all folded stays a node.
  const folded = new Set(hostsOf.keys());
  for (const [fn, hosts] of hostsOf) {
    const remaining = new Set([...hosts].filter((host) => !folded.has(host)));
    if (remaining.size === 0) hostsOf.delete(fn);
    else hostsOf.set(fn, remaining);
  }
  folded.clear();
  for (const fn of hostsOf.keys()) folded.add(fn);

  // 3. Nodes.
  const typeKey = mapping.properties.archimateTypeKey;
  const ownKeys = [mapping.properties.documentation, ...(typeKey === undefined ? [] : [typeKey])];
  const reservedNodeKeys = new Set<string>([
    nodeTypeKey,
    ...ownKeys,
    // Keys standard on edges only (such as data) are free for an element's custom metadata.
    ...Object.keys(standardProperties).filter((key) =>
      nodeTypes.some((type) => isStandardPropertyOf(type, key)),
    ),
    ...mapping.properties.mappings.map((entry) => entry.key),
  ]);
  // Edges: custom keys never take a standard edge property's or a mapped property's key.
  const reservedEdgeKeys = new Set<string>([
    ...ownKeys,
    ...Object.keys(standardProperties).filter(
      (key) => isStandardPropertyKey(key) && hasStandardEdgeProperty(key),
    ),
    ...mapping.properties.mappings.map((entry) => entry.key),
    retiredInformationFlowKey,
  ]);
  const reservedGraphKeys = new Set<string>(ownKeys);
  const mappingsByName = new Map(mapping.properties.mappings.map((entry) => [entry.name, entry]));

  // Next suffix to try per metadata object and base key, so repeats stay linear.
  const nextSuffix = new WeakMap<Record<string, unknown>, Map<string, number>>();
  /** A free key: `key` itself, else oefKey, oefKey2, ... */
  const freeKey = (meta: Record<string, unknown>, key: string, reserved: Set<string>): string => {
    if (!reserved.has(key) && !Object.hasOwn(meta, key)) return key;
    props.renamedKeys += 1;
    const base = `oef${key.charAt(0).toUpperCase()}${key.slice(1)}`;
    let suffixes = nextSuffix.get(meta);
    if (!suffixes) {
      suffixes = new Map();
      nextSuffix.set(meta, suffixes);
    }
    let n = suffixes.get(base) ?? 1;
    let candidate = n === 1 ? base : `${base}${n}`;
    while (reserved.has(candidate) || Object.hasOwn(meta, candidate)) {
      n += 1;
      candidate = `${base}${n}`;
    }
    suffixes.set(base, n + 1);
    return candidate;
  };

  const addCustom = (
    meta: Record<string, unknown>,
    property: OefProperty,
    reserved: Set<string>,
  ): void => {
    const key = freeKey(meta, customKeyOf(property.name), reserved);
    meta[key] = property.value;
    increment(props.keptAsCustom, key);
  };

  /** Maps the configured properties (with value translations); the rest become custom metadata. */
  const applyProperties = (
    meta: Record<string, unknown>,
    properties: OefProperty[],
    reserved: Set<string>,
    onRelationship: boolean,
  ): void => {
    for (const property of properties) {
      const rule = mappingsByName.get(property.name);
      if (!rule || Object.hasOwn(meta, rule.key)) {
        // Unmapped, or a repeat of a mapped property: kept as custom metadata.
        addCustom(meta, property, reserved);
        continue;
      }
      let value = property.value;
      if (rule.values && value !== '') {
        const translated = Object.hasOwn(rule.values, value) ? rule.values[value] : undefined;
        if (translated === undefined) {
          increment(props.valuesNotTranslated, rule.key);
        } else {
          value = translated;
          props.valuesTranslated += 1;
        }
      }
      meta[rule.key] = value;
      increment(props.mapped, rule.key);
      if (onRelationship) increment(props.onRelationships.mapped, rule.key);
    }
  };

  /** Fills each applicable default where the value is empty or missing. */
  const applyDefaults = (
    meta: Record<string, unknown>,
    target: { nodeType: NodeType } | { relation: EdgeType },
  ): void => {
    for (const fallback of mapping.properties.defaults) {
      const applies =
        'nodeType' in target
          ? (fallback.nodeTypes?.includes(target.nodeType) ?? false)
          : (fallback.relations?.includes(target.relation) ?? false);
      if (!applies) continue;
      const current = meta[fallback.key];
      if (current === undefined || (typeof current === 'string' && current.trim() === '')) {
        meta[fallback.key] = fallback.value;
        increment(props.defaultsApplied, fallback.key);
        if ('relation' in target) increment(props.onRelationships.defaultsApplied, fallback.key);
      }
    }
  };

  const nodes = new Map<string, JgfNode>();
  for (const [id, nodeType] of nodeTypeOf) {
    const element = elementsById.get(id);
    if (!element) continue;
    if (folded.has(id)) {
      increment(report.elements.folded, element.type);
      continue;
    }
    const meta: Record<string, unknown> = { [nodeTypeKey]: nodeType };
    if (typeKey !== undefined) meta[typeKey] = element.type;
    if (element.documentation !== '')
      meta[mapping.properties.documentation] = element.documentation;

    applyProperties(meta, element.properties, reservedNodeKeys, false);
    applyDefaults(meta, { nodeType });

    nodes.set(id, { ...(element.name === '' ? {} : { label: element.name }), metadata: meta });
    report.elements.mapped[nodeType] += 1;
    increment(report.elements.mappedByElementType, element.type);
  }

  // Unfolded functions stay nodes, and are reported.
  for (const id of nodeTypeOf.keys()) {
    const element = elementsById.get(id);
    if (element && functionTypes.has(element.type) && !folded.has(id)) {
      report.functions.keptAsNodes.push({ id, name: element.name });
    }
  }

  // 4. Fold functions into their hosts' `functions` lists. Entries are cut short and capped in
  //    total, so one function with a long name and many hosts can't blow up the output.
  const entriesOf = new Map<string, { list: string[]; seen: Set<string> }>();
  let entries = 0;
  for (const [fn, hosts] of hostsOf) {
    const element = elementsById.get(fn);
    if (!element) continue;
    report.functions.folded += 1;
    if (element.documentation !== '' || element.properties.length > 0) {
      report.functions.foldedWithDetailsNotCarried += 1;
    }
    const name = element.name === '' ? element.id : element.name;
    const entry = cut(name, maxFunctionEntryLength);
    if (entry !== name) report.functions.entriesTruncated += 1;
    for (const host of hosts) {
      const meta = nodes.get(host)?.metadata;
      if (!meta) continue;
      let hostEntries = entriesOf.get(host);
      if (!hostEntries) {
        hostEntries = { list: [], seen: new Set() };
        entriesOf.set(host, hostEntries);
        meta.functions = hostEntries.list;
      }
      if (hostEntries.seen.has(entry)) {
        report.functions.duplicateEntries += 1;
      } else if (entries >= maxFunctionEntries) {
        report.functions.entriesNotAdded += 1;
      } else {
        hostEntries.list.push(entry);
        hostEntries.seen.add(entry);
        entries += 1;
      }
    }
  }
  report.functions.hosts = entriesOf.size;

  // 5. Relationships → edges.
  const rulesByType = new Map<string, RelationshipRule[]>();
  for (const rule of mapping.relationships.rules) {
    const rules = rulesByType.get(rule.type) ?? [];
    rules.push(rule);
    rulesByType.set(rule.type, rules);
  }
  const endpointProblem = (id: string, end: 'source' | 'target'): string | undefined => {
    if (nodes.has(id)) return undefined;
    if (folded.has(id)) return `${end}-folded`;
    if (elementsById.has(id)) return `${end}-not-imported`;
    return `${end}-not-an-element`;
  };

  const edges: JgfEdge[] = [];
  const edgeIds = new Set<string>();
  for (const relationship of relationships) {
    const skip = (reason: string): void => {
      incrementByReason(report.relationships.skipped, reason, relationship.type);
    };
    if (relationship.id === '') {
      skip('missing-identifier');
      continue;
    }
    if (edgeIds.has(relationship.id)) {
      skip('duplicate-identifier');
      continue;
    }
    if (relationship.id === reservedKey) {
      skip('reserved-identifier');
      continue;
    }
    const link = foldingLinks.get(relationship);
    if (link && hostsOf.get(link.fn)?.has(link.host)) {
      skip('used-for-folding');
      continue;
    }
    const candidates = rulesByType.get(relationship.type);
    if (!candidates) {
      skip('no-matching-rule');
      continue;
    }
    const problem =
      endpointProblem(relationship.source, 'source') ??
      endpointProblem(relationship.target, 'target');
    if (problem) {
      skip(problem);
      if (problem === 'source-folded' || problem === 'target-folded') {
        const foldedEnds = report.relationships.foldedEnds;
        foldedEnds.count += 1;
        if (foldedEnds.listed.length < maxListedFoldedEnds) {
          const both = folded.has(relationship.source) && folded.has(relationship.target);
          foldedEnds.listed.push({
            // Text from the input is cut short, so the report stays proportional to the file.
            id: cut(relationship.id, maxEchoLength),
            type: cut(relationship.type, maxEchoLength),
            reason: problem,
            end: both ? 'both' : problem === 'source-folded' ? 'source' : 'target',
          });
        } else {
          foldedEnds.truncated = true;
        }
      }
      continue;
    }
    const sourceType = nodeTypeOf.get(relationship.source);
    const targetType = nodeTypeOf.get(relationship.target);
    const rule = candidates.find(
      (candidate) =>
        (!candidate.sourceNodeTypes ||
          (sourceType && candidate.sourceNodeTypes.includes(sourceType))) &&
        (!candidate.targetNodeTypes ||
          (targetType && candidate.targetNodeTypes.includes(targetType))) &&
        (candidate.properties ?? []).every((condition) =>
          relationship.properties.some(
            (property) =>
              property.name === condition.name &&
              property.value !== '' &&
              (!condition.values || condition.values.includes(property.value)),
          ),
        ),
    );
    if (!rule) {
      skip('no-matching-rule');
      continue;
    }

    const meta: Record<string, unknown> = {};
    if (typeKey !== undefined) meta[typeKey] = relationship.type;
    if (relationship.documentation !== '') {
      meta[mapping.properties.documentation] = relationship.documentation;
    }
    applyProperties(meta, relationship.properties, reservedEdgeKeys, true);
    applyDefaults(meta, { relation: rule.relation });
    // The option once set Information flow; now, as for older files, the label becomes its Data.
    if (
      rule.informationFlow === true &&
      hasStandardEdgeProperty('data', rule.relation) &&
      relationship.name.trim() !== '' &&
      !Object.hasOwn(meta, 'data')
    ) {
      meta.data = relationship.name;
    }
    const [source, target] = rule.reverse
      ? [relationship.target, relationship.source]
      : [relationship.source, relationship.target];
    edges.push({
      id: relationship.id,
      source,
      target,
      relation: rule.relation,
      directed: !(relationship.undirected && canBeTwoWay(rule.relation)),
      ...(relationship.name === '' ? {} : { label: relationship.name }),
      metadata: meta,
    });
    edgeIds.add(relationship.id);
    report.relationships.mapped[rule.relation] += 1;
  }

  // 6. Not imported: diagrams and the folder structure.
  report.viewsSkipped = list(child(child(model, 'views'), 'diagrams')?.view).length;
  report.organizationItemsSkipped = countItems(model.organizations);

  // The model itself: id, name, documentation and properties.
  const graphMeta: Record<string, unknown> = {};
  const modelDocumentation = pickLanguage(model.documentation);
  if (modelDocumentation !== '') graphMeta[mapping.properties.documentation] = modelDocumentation;
  for (const property of readProperties(model)) addCustom(graphMeta, property, reservedGraphKeys);
  const modelName = pickLanguage(model.name);
  const modelId = attribute(model, 'identifier');

  return {
    jgf: {
      graph: {
        ...(modelId === '' ? {} : { id: modelId }),
        ...(modelName === '' ? {} : { label: modelName }),
        directed: true,
        metadata: graphMeta,
        // fromEntries defines own properties, so no id can touch an object prototype.
        nodes: Object.fromEntries(nodes),
        edges,
      },
    },
    report,
  };
}
