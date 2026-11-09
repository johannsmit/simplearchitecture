/**
 * The default metamodel (the source of truth: metamodel/), as typed data.
 * The API (validation, import, export) and the web app both read it from here, so a change in
 * this file changes both.
 */

export const nodeTypes = [
  'Stakeholder',
  'Business',
  'Application',
  'Infrastructure',
  'Other',
] as const;
export type NodeType = (typeof nodeTypes)[number];

/** Edge types. In JGF the edge type is the edge's `relation`. */
export const edgeTypes = ['Relation', 'Contains'] as const;
export type EdgeType = (typeof edgeTypes)[number];

export const architectureStates = ['Deprecate', 'Current', 'Target'] as const;
export type ArchitectureState = (typeof architectureStates)[number];

export const sourcingOptions = ['Build', 'Buy'] as const;
export type Sourcing = (typeof sourcingOptions)[number];

/** How a standard property's value is checked. */
export type PropertyKind =
  | { kind: 'text' }
  | { kind: 'choice'; options: readonly string[] }
  | { kind: 'text-list' }
  | { kind: 'country' };

export interface StandardPropertyDefinition {
  label: string;
  value: PropertyKind;
}

/**
 * Standard node and edge metadata. Which keys apply is set per node type and per edge type
 * below. Any other metadata key is custom metadata, which is always allowed.
 */
export const standardProperties = {
  description: { label: 'Description', value: { kind: 'text' } },
  owningTeam: { label: 'Owning team', value: { kind: 'text' } },
  architectureState: {
    label: 'Architecture state',
    value: { kind: 'choice', options: architectureStates },
  },
  functions: { label: 'Functions', value: { kind: 'text-list' } },
  sourcing: { label: 'Sourcing', value: { kind: 'choice', options: sourcingOptions } },
  // ISO 3166-1 alpha-2, e.g. NL. Non-ISO values are warnings, not errors (imported as is for now).
  supplierHqCountry: { label: 'Supplier HQ country', value: { kind: 'country' } },
  // A Relation's exchange: the active identity used, more context on it, and the data sent with
  // the request and returned in the response.
  identity: { label: 'Identity', value: { kind: 'text' } },
  identityContext: { label: 'Identity Context', value: { kind: 'text' } },
  requestData: { label: 'Request Data', value: { kind: 'text' } },
  responseData: { label: 'Response Data', value: { kind: 'text' } },
} as const satisfies Record<string, StandardPropertyDefinition>;
export type StandardPropertyKey = keyof typeof standardProperties;

/** Metadata key that holds the node type. Not a property: every node must have it. */
export const nodeTypeKey = 'type';

export interface NodeTypeDefinition {
  description: string;
  /** Colour named in the metamodel; the web app maps it to its colour tokens. */
  colour: 'yellow' | 'blue' | 'green' | 'gray';
  /** Icon named in the metamodel, drawn with the type's colour (Stakeholder: a user icon). */
  icon?: 'user';
  /** Standard properties of this node type, in display order. */
  properties: readonly StandardPropertyKey[];
}

const applicationAndInfrastructure = [
  'description',
  'architectureState',
  'functions',
  'owningTeam',
  'supplierHqCountry',
] as const;

export const nodeTypeDefinitions: Record<NodeType, NodeTypeDefinition> = {
  Stakeholder: {
    description: 'Stakeholders and users.',
    colour: 'yellow',
    icon: 'user',
    properties: ['description'],
  },
  Business: {
    description: 'Business elements, such as business processes and capabilities.',
    colour: 'yellow',
    properties: ['description', 'owningTeam'],
  },
  Application: {
    description: 'Application elements.',
    colour: 'blue',
    properties: [...applicationAndInfrastructure, 'sourcing'],
  },
  Infrastructure: {
    description: 'Infrastructure elements.',
    colour: 'green',
    properties: applicationAndInfrastructure,
  },
  Other: {
    description: 'Any other elements.',
    colour: 'gray',
    properties: ['description'],
  },
};

export interface EdgeTypeDefinition {
  description: string;
  /** How the line is drawn. `contains` is drawn solid until the canvas design for it lands. */
  line: 'solid' | 'contains';
  /**
   * Whether a relationship of this type may be two-way: stored as JGF
   * `"directed": false`, drawn with an arrow at both ends. Otherwise it is always one-way.
   */
  twoWay: boolean;
  /** Standard properties of this edge type, in display order. */
  properties: readonly StandardPropertyKey[];
}

/** Standard properties of every edge type. */
const allEdges = ['architectureState'] as const;

/**
 * The free-text standard properties of a Relation, in display order: edited on the relationship
 * form under the label, and never custom metadata there.
 */
export const relationTextProperties = [
  'identity',
  'identityContext',
  'requestData',
  'responseData',
] as const;
export type RelationTextProperty = (typeof relationTextProperties)[number];

export function isRelationTextProperty(key: string): key is RelationTextProperty {
  return (relationTextProperties as readonly string[]).includes(key);
}

/**
 * Data, before it became Request Data and Response Data. Reading a model or a file turns it into
 * Request Data (unless it has Request Data already), so it is never set as custom metadata on a
 * relationship.
 */
export const retiredDataKey = 'data';

export const edgeTypeDefinitions: Record<EdgeType, EdgeTypeDefinition> = {
  Relation: {
    description:
      'Any relation between elements, such as integration, hosting or serving a business process.',
    line: 'solid',
    twoWay: true,
    properties: [...allEdges, ...relationTextProperties],
  },
  Contains: {
    description:
      'An element that contains another element. The target is drawn nested inside the source.',
    line: 'contains',
    // A container contains its element, not the other way round.
    twoWay: false,
    properties: allEdges,
  },
};

/** The Architecture state of an edge (or element) without one. */
export const defaultArchitectureState: ArchitectureState = 'Current';

export function isNodeType(value: unknown): value is NodeType {
  return typeof value === 'string' && (nodeTypes as readonly string[]).includes(value);
}

export function isEdgeType(value: unknown): value is EdgeType {
  return typeof value === 'string' && (edgeTypes as readonly string[]).includes(value);
}

export function isStandardPropertyKey(value: string): value is StandardPropertyKey {
  return Object.hasOwn(standardProperties, value);
}

/** Whether a relationship of this type may be two-way (Relation). */
export function canBeTwoWay(edgeType: EdgeType): boolean {
  return edgeTypeDefinitions[edgeType].twoWay;
}

/** Whether `key` is a standard property of `nodeType`. */
export function hasStandardProperty(nodeType: NodeType, key: StandardPropertyKey): boolean {
  return nodeTypeDefinitions[nodeType].properties.includes(key);
}

/**
 * The one rule for node metadata: a key is a standard property of an element when it is a
 * standard key of the element's type. Any other key (but `type`) is custom metadata, including a
 * standard key of another type. The validation, the details panel and the editing form all use it.
 */
export function isStandardPropertyOf(nodeType: NodeType, key: string): key is StandardPropertyKey {
  return isStandardPropertyKey(key) && hasStandardProperty(nodeType, key);
}

/**
 * The metadata keys that become custom metadata when an element's type changes from `from` to
 * `to`: standard for `from`, not for `to`. Their values are kept as they are (nothing is lost) and
 * become standard again if the type changes back. Sorted, so a form can list them before saving.
 */
export function keptAsCustomOnTypeChange(
  metadata: Readonly<Record<string, unknown>>,
  from: NodeType,
  to: NodeType,
): StandardPropertyKey[] {
  return Object.keys(metadata)
    .filter(
      (key): key is StandardPropertyKey =>
        isStandardPropertyOf(from, key) && !isStandardPropertyOf(to, key),
    )
    .sort();
}

/** Whether `key` is a standard property of `edgeType`, or of any edge type when it is omitted. */
export function hasStandardEdgeProperty(key: StandardPropertyKey, edgeType?: EdgeType): boolean {
  const types = edgeType === undefined ? edgeTypes : [edgeType];
  return types.some((type) => edgeTypeDefinitions[type].properties.includes(key));
}

// ISO 3166-1 alpha-2: the 249 officially assigned codes.
const isoCountryCodes = new Set(
  (
    'AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ ' +
    'BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ ' +
    'CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ ' +
    'DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR ' +
    'GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ' +
    'ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ ' +
    'LA LB LC LI LK LR LS LT LU LV LY ' +
    'MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ ' +
    'NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA ' +
    'RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ ' +
    'TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ ' +
    'VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW'
  ).split(' '),
);

/** An ISO 3166-1 alpha-2 code, upper case (e.g. `NL`). */
export function isIsoCountryCode(value: string): boolean {
  return isoCountryCodes.has(value);
}

/** The result of checking one standard property value against the metamodel. */
export type PropertyCheck =
  { ok: true } | { ok: false; severity: 'error' | 'warning'; problem: string };

/**
 * Checks a standard property value. Shared so that the API's validation and future web forms
 * apply the same rules. `problem` completes a sentence such as `architectureState <problem>`.
 */
export function checkStandardProperty(key: StandardPropertyKey, value: unknown): PropertyCheck {
  const rule: PropertyKind = standardProperties[key].value;
  switch (rule.kind) {
    case 'text':
      return typeof value === 'string'
        ? { ok: true }
        : { ok: false, severity: 'error', problem: 'must be text' };
    case 'choice':
      return typeof value === 'string' && rule.options.includes(value)
        ? { ok: true }
        : {
            ok: false,
            severity: 'error',
            problem: `must be one of ${rule.options.join(', ')}${describeValue(value)}`,
          };
    case 'text-list':
      return Array.isArray(value) && value.every((entry) => typeof entry === 'string')
        ? { ok: true }
        : { ok: false, severity: 'error', problem: 'must be a list of text values' };
    case 'country':
      if (typeof value !== 'string') {
        return { ok: false, severity: 'error', problem: 'must be text' };
      }
      return isIsoCountryCode(value)
        ? { ok: true }
        : {
            ok: false,
            severity: 'warning',
            problem: `should be an ISO 3166-1 alpha-2 code such as NL${describeValue(value)}`,
          };
  }
}

function describeValue(value: unknown): string {
  if (typeof value === 'string')
    return ` (got "${value.length > 80 ? `${value.slice(0, 80)}…` : value}")`;
  return ` (got ${value === null ? 'null' : Array.isArray(value) ? 'a list' : typeof value})`;
}
