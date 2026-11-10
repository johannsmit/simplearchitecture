import {
  analyseContainment,
  canBeTwoWay,
  checkStandardProperty,
  containsType,
  defaultArchitectureState,
  edgeTypes,
  hasStandardEdgeProperty,
  hasStandardProperty,
  isEdgeType,
  isNodeType,
  isRelationDataProperty,
  isRelationProperty,
  maxDataValues,
  repeatedDataValue,
  retiredDataKey,
  isStandardPropertyKey,
  nodeTypeKey,
  nodeTypes,
  type EdgeType,
  type JgfSummary,
  type JgfValidationResult,
  type ContainsEdge,
  type NodeType,
  type ValidationIssue,
} from '@simplearchitecture/shared';
import { z } from 'zod';

/** At most this many errors and this many warnings are listed; the counts are always complete. */
export const maxListedIssues = 1000;
/** At most this many issues are listed per node or edge, so one bad item can't fill the list. */
export const maxListedIssuesPerItem = 20;
/** Ids and field names from the input are cut to this length in issues, like quoted values. */
export const maxEchoLength = 80;

/**
 * The one key that is never accepted as a node id, edge id or metadata key, here or in the OEF
 * import: in a plain object it would replace the object's prototype.
 */
export const reservedKey = '__proto__';

function short(text: string): string {
  return text.length > maxEchoLength ? `${text.slice(0, maxEchoLength)}…` : text;
}

// JGF v2 structure (single graph). Strict objects: JGF v2 allows no other fields, and custom
// data belongs in `metadata`. Messages complete a sentence that names the node or edge and field.
const text = z.string({
  error: (issue) => (issue.input === undefined ? 'is required' : 'must be text'),
});
const flag = z.boolean({ error: 'must be true or false' });
const metadata = z.record(z.string(), z.unknown(), { error: 'must be an object' });

const graphSchema = z.strictObject({
  id: text.optional(),
  label: text.optional(),
  directed: flag.optional(),
  type: text.optional(),
  metadata: metadata.optional(),
  nodes: z
    .record(z.string(), z.unknown(), { error: 'must be an object keyed by node id' })
    .optional(),
  edges: z.array(z.unknown(), { error: 'must be a list' }).optional(),
});

const nodeSchema = z.strictObject(
  { label: text.optional(), metadata: metadata.optional() },
  { error: 'must be an object' },
);

const edgeSchema = z.strictObject(
  {
    id: text.optional(),
    source: text,
    target: text,
    relation: text.optional(),
    directed: flag.optional(),
    label: text.optional(),
    metadata: metadata.optional(),
  },
  { error: 'must be an object' },
);

type Subject = { kind: 'document' } | { kind: 'node'; id: string } | { kind: 'edge'; id: string };

class IssueList {
  readonly errors: ValidationIssue[] = [];
  readonly warnings: ValidationIssue[] = [];
  errorCount = 0;
  warningCount = 0;
  /** Issues listed per subject. Keyed by the subject object, never by its (possibly huge) id. */
  private readonly listedPerSubject = new Map<Subject, number>();

  add(
    severity: ValidationIssue['severity'],
    subject: Subject,
    field: string,
    code: string,
    problem: string,
  ): void {
    if (severity === 'error') this.errorCount += 1;
    else this.warningCount += 1;
    const list = severity === 'error' ? this.errors : this.warnings;
    const listed = this.listedPerSubject.get(subject) ?? 0;
    if (list.length >= maxListedIssues || listed >= maxListedIssuesPerItem) return;
    this.listedPerSubject.set(subject, listed + 1);

    const id = subject.kind === 'document' ? '' : short(subject.id);
    const name =
      subject.kind === 'node'
        ? `Node "${id}"`
        : subject.kind === 'edge'
          ? `Edge "${id}"`
          : 'Document';
    const shortField = short(field);
    list.push({
      severity,
      code,
      message: field === '' ? `${name}: ${problem}` : `${name}: ${shortField} ${problem}`,
      field: shortField,
      ...(subject.kind === 'node' ? { nodeId: id } : {}),
      ...(subject.kind === 'edge' ? { edgeId: id } : {}),
    });
  }

  /** Adds every zod issue as a structural error. Unknown fields get one issue each. */
  addStructural(subject: Subject, prefix: string, error: z.ZodError): void {
    for (const issue of error.issues) {
      const path = [prefix, ...issue.path.map(String)].filter((part) => part !== '').join('.');
      if (issue.code === 'unrecognized_keys') {
        for (const key of issue.keys) {
          const field = path === '' ? key : `${path}.${key}`;
          this.add(
            'error',
            subject,
            field,
            'unknown-field',
            'is not a JGF v2 field (put custom data in metadata)',
          );
        }
      } else {
        this.add('error', subject, path, 'invalid-structure', issue.message);
      }
    }
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function quoted(value: unknown): string {
  if (typeof value !== 'string') return value === null ? 'null' : typeof value;
  return `"${short(value)}"`;
}

function emptySummary(): JgfSummary {
  return {
    nodes: {
      total: 0,
      byType: Object.fromEntries(nodeTypes.map((type) => [type, 0])) as Record<NodeType, number>,
    },
    edges: {
      total: 0,
      byRelation: Object.fromEntries(edgeTypes.map((type) => [type, 0])) as Record<
        EdgeType,
        number
      >,
    },
  };
}

function checkNodeMetadata(
  issues: IssueList,
  subject: Subject,
  meta: Record<string, unknown> | undefined,
): NodeType | undefined {
  const typeField = `metadata.${nodeTypeKey}`;
  const type = meta?.[nodeTypeKey];
  let nodeType: NodeType | undefined;
  if (type === undefined) {
    issues.add(
      'error',
      subject,
      typeField,
      'missing-node-type',
      `is required (one of ${nodeTypes.join(', ')})`,
    );
  } else if (isNodeType(type)) {
    nodeType = type;
  } else {
    issues.add(
      'error',
      subject,
      typeField,
      'unknown-node-type',
      `${quoted(type)} is not a node type (use one of ${nodeTypes.join(', ')})`,
    );
  }

  for (const [key, value] of Object.entries(meta ?? {})) {
    if (key === reservedKey) {
      issues.add('error', subject, `metadata.${key}`, 'reserved-key', 'is a reserved key');
      continue;
    }
    if (key === nodeTypeKey || !isStandardPropertyKey(key)) continue; // custom metadata: any value
    // A key standard on edges only (such as requestData) is ordinary custom metadata on a node.
    if (!nodeTypes.some((type) => hasStandardProperty(type, key))) continue;
    const field = `metadata.${key}`;
    if (nodeType && !hasStandardProperty(nodeType, key)) {
      issues.add(
        'warning',
        subject,
        field,
        'not-standard-for-type',
        `is not a standard property of ${nodeType} nodes; it is kept as custom metadata`,
      );
      continue;
    }
    const check = checkStandardProperty(key, value);
    if (!check.ok) {
      const code = check.severity === 'warning' ? 'non-iso-country' : 'invalid-property-value';
      issues.add(check.severity, subject, field, code, check.problem);
    }
  }
  return nodeType;
}

/**
 * Checks an edge's standard properties. Any other key (including a node-only standard key such as
 * description) is custom metadata. With an unknown edge type, a key that is standard on any edge
 * type is checked.
 *
 * A bad value is a warning, never an error: edge properties became standard after models were
 * stored, and a stored model must stay readable. The graph reads a bad Architecture state as
 * Current. Identity, Identity Context, Request Data and Response Data apply to a Relation only. Data
 * (`data`) left from before, where Request Data had a value already, is kept as it is.
 */
function checkEdgeMetadata(
  issues: IssueList,
  subject: Subject,
  meta: Record<string, unknown>,
  edgeType: EdgeType | undefined,
): void {
  for (const [key, value] of Object.entries(meta)) {
    if (key === reservedKey) {
      issues.add('error', subject, `metadata.${key}`, 'reserved-key', 'is a reserved key');
      continue;
    }
    if (key === retiredDataKey) {
      issues.add(
        'warning',
        subject,
        `metadata.${key}`,
        'retired-property',
        'is Data from before it became Request Data and Response Data; it is kept as it is',
      );
      continue;
    }
    if (edgeType !== undefined && isRelationProperty(key)) {
      // Custom metadata before it became standard: kept and read as stored, never an error.
      if (!hasStandardEdgeProperty(key, edgeType)) {
        issues.add(
          'warning',
          subject,
          `metadata.${key}`,
          'property-not-for-type',
          `doesn't apply to a ${edgeType} relationship; it is kept as it is`,
        );
        continue;
      }
    }
    if (!isStandardPropertyKey(key) || !hasStandardEdgeProperty(key, edgeType)) continue;
    const check = checkStandardProperty(key, value);
    if (!check.ok) {
      const code = check.severity === 'warning' ? 'non-iso-country' : 'invalid-property-value';
      const readAs =
        key === 'architectureState' ? `; it is read as ${defaultArchitectureState}` : '';
      issues.add('warning', subject, `metadata.${key}`, code, `${check.problem}${readAs}`);
    } else if (isRelationDataProperty(key)) {
      const problem = dataValuesProblem(value as unknown[]);
      if (problem !== undefined) {
        issues.add('warning', subject, `metadata.${key}`, 'data-values-not-kept', problem);
      }
    }
  }
}

/**
 * What a stored list of Request Data or Response Data has that a change can't make: a blank value,
 * a value twice (ignoring case), more than `maxDataValues` values. A warning only: the list is kept
 * and read as it is.
 */
function dataValuesProblem(values: readonly unknown[]): string | undefined {
  const texts = values.filter((value): value is string => typeof value === 'string');
  const problems = [
    texts.some((text) => text.trim() === '') ? 'a blank value' : undefined,
    repeatedDataValue(texts.filter((text) => text.trim() !== '')) !== undefined
      ? 'a value more than once (ignoring case)'
      : undefined,
    values.length > maxDataValues ? `more than ${maxDataValues} values` : undefined,
  ].filter((problem) => problem !== undefined);
  if (problems.length === 0) return undefined;
  const listed =
    problems.length === 1
      ? problems[0]
      : `${problems.slice(0, -1).join(', ')} and ${problems[problems.length - 1]}`;
  return `has ${listed}; it is kept as it is, and a change to it must leave that out`;
}

/**
 * Validates a JGF v2 document against the structure and the default metamodel.
 * Collects every problem (it never stops at the first) and never throws.
 */
export function validateJgf(input: unknown): JgfValidationResult {
  const issues = new IssueList();
  const summary = emptySummary();
  const documentSubject: Subject = { kind: 'document' };

  const result = (): JgfValidationResult => ({
    valid: issues.errorCount === 0,
    summary,
    errorCount: issues.errorCount,
    warningCount: issues.warningCount,
    errors: issues.errors,
    warnings: issues.warnings,
    truncated:
      issues.errors.length < issues.errorCount || issues.warnings.length < issues.warningCount,
  });

  if (!isPlainObject(input)) {
    issues.add(
      'error',
      documentSubject,
      '',
      'invalid-structure',
      'must be a JSON object with a graph',
    );
    return result();
  }
  for (const key of Object.keys(input)) {
    if (key === 'graph') continue;
    const problem =
      key === 'graphs'
        ? 'is not supported: exchange a single graph in graph'
        : 'is not a JGF v2 field';
    issues.add('error', documentSubject, key, 'unknown-field', problem);
  }
  const graph = input.graph;
  if (!isPlainObject(graph)) {
    issues.add(
      'error',
      documentSubject,
      'graph',
      'invalid-structure',
      graph === undefined ? 'is required' : 'must be an object',
    );
    return result();
  }
  const graphCheck = graphSchema.safeParse(graph);
  if (!graphCheck.success) issues.addStructural(documentSubject, 'graph', graphCheck.error);

  // Nodes, each checked on its own so that one bad node doesn't hide the others.
  const nodeIds = new Set<string>();
  const nodes = isPlainObject(graph.nodes) ? graph.nodes : {};
  for (const [id, node] of Object.entries(nodes)) {
    nodeIds.add(id);
    const subject: Subject = { kind: 'node', id };
    summary.nodes.total += 1;
    if (id.trim() === '') {
      issues.add('error', subject, '', 'invalid-structure', 'node id must not be empty');
    } else if (id === reservedKey) {
      issues.add('error', subject, '', 'reserved-id', 'node id is reserved; use another id');
    }
    const parsed = nodeSchema.safeParse(node);
    if (!parsed.success) issues.addStructural(subject, '', parsed.error);
    // A node or metadata of the wrong shape is reported above; its metamodel rules can't be checked.
    if (!isPlainObject(node) || (node.metadata !== undefined && !isPlainObject(node.metadata))) {
      continue;
    }
    const meta = isPlainObject(node.metadata) ? node.metadata : undefined;
    const nodeType = checkNodeMetadata(issues, subject, meta);
    if (nodeType) summary.nodes.byType[nodeType] += 1;
  }

  // Edges.
  const edgeIds = new Set<string>();
  const containsEdges: (ContainsEdge & { subject: Subject })[] = [];
  const edges: unknown[] = Array.isArray(graph.edges) ? graph.edges : [];
  edges.forEach((edge, index) => {
    const ownId =
      isPlainObject(edge) && typeof edge.id === 'string' && edge.id !== '' ? edge.id : undefined;
    const subject: Subject = { kind: 'edge', id: ownId ?? `edges[${index}]` };
    summary.edges.total += 1;
    const parsed = edgeSchema.safeParse(edge);
    if (!parsed.success) issues.addStructural(subject, '', parsed.error);
    if (!isPlainObject(edge)) return;

    if (ownId !== undefined) {
      if (ownId === reservedKey) {
        issues.add('error', subject, 'id', 'reserved-id', 'is reserved; use another id');
      }
      if (edgeIds.has(ownId)) {
        issues.add('error', subject, 'id', 'duplicate-edge-id', 'is used by more than one edge');
      }
      edgeIds.add(ownId);
    }

    const relation = edge.relation;
    if (isPlainObject(edge.metadata)) {
      checkEdgeMetadata(
        issues,
        subject,
        edge.metadata,
        isEdgeType(relation) ? relation : undefined,
      );
    }
    if (relation === undefined) {
      issues.add(
        'error',
        subject,
        'relation',
        'missing-relation',
        `is required (one of ${edgeTypes.join(', ')})`,
      );
    } else if (isEdgeType(relation)) {
      summary.edges.byRelation[relation] += 1;
      // Two-way is `"directed": false`. Where the type can't be two-way it is a warning, never an
      // error, so a stored model stays readable; it is read as one-way.
      if (edge.directed === false && !canBeTwoWay(relation)) {
        issues.add(
          'warning',
          subject,
          'directed',
          'one-way-only',
          `is false, but a ${relation} relationship is always one-way; it is read as one-way`,
        );
      }
      const { source, target } = edge;
      if (
        relation === containsType &&
        typeof source === 'string' &&
        typeof target === 'string' &&
        nodeIds.has(source) &&
        nodeIds.has(target)
      ) {
        containsEdges.push({ id: subject.id, source, target, subject });
      }
    } else if (typeof relation === 'string') {
      issues.add(
        'error',
        subject,
        'relation',
        'unknown-relation',
        `${quoted(relation)} is not an edge type (use one of ${edgeTypes.join(', ')})`,
      );
    }

    for (const end of ['source', 'target'] as const) {
      const ref = edge[end];
      if (typeof ref === 'string' && !nodeIds.has(ref)) {
        issues.add(
          'error',
          subject,
          end,
          'unknown-node',
          `${quoted(ref)} is not a node in this graph`,
        );
      }
    }
  });

  checkContainment(issues, containsEdges);
  return result();
}

/**
 * Contains relationships that can't nest are warnings, never errors: the explorer draws them as
 * lines, so the model stays readable.
 */
function checkContainment(
  issues: IssueList,
  edges: readonly (ContainsEdge & { subject: Subject })[],
): void {
  const found = analyseContainment(edges);
  for (const edge of found.selfContains) {
    issues.add(
      'warning',
      edge.subject,
      '',
      'contains-self',
      "an element can't contain itself; this Contains edge is drawn as a line",
    );
  }
  for (const edge of found.inCycle) {
    issues.add(
      'warning',
      edge.subject,
      '',
      'contains-cycle',
      'this Contains edge is part of a cycle (an element contains itself through others); it is drawn as a line',
    );
  }
  for (const [id, count] of found.multipleContainers) {
    issues.add(
      'warning',
      { kind: 'node', id },
      '',
      'multiple-containers',
      `is contained by ${count} elements but is drawn inside one only; the other Contains edges are drawn as lines`,
    );
  }
}

/**
 * Node and edge counts of a JGF document, for the size caps, without validating it. Shapes that
 * aren't an object of nodes or a list of edges count as 0 (validation reports them).
 */
export function countJgf(input: unknown): { nodes: number; edges: number } {
  const graph = isPlainObject(input) ? input.graph : undefined;
  if (!isPlainObject(graph)) return { nodes: 0, edges: 0 };
  return {
    nodes: isPlainObject(graph.nodes) ? Object.keys(graph.nodes).length : 0,
    edges: Array.isArray(graph.edges) ? graph.edges.length : 0,
  };
}
