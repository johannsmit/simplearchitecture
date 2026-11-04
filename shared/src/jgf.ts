import type { EdgeType, NodeType } from './metamodel.js';

/** JSON Graph Format v2, single graph, as exchanged by SimpleArchitecture. */
export interface JgfDocument {
  graph: JgfGraph;
}

export interface JgfGraph {
  id?: string;
  label?: string;
  directed?: boolean;
  type?: string;
  metadata?: Record<string, unknown>;
  /** Keyed by node id. */
  nodes?: Record<string, JgfNode>;
  edges?: JgfEdge[];
}

export interface JgfNode {
  label?: string;
  /** Holds the node `type`, the standard properties and any custom metadata. */
  metadata?: Record<string, unknown>;
}

export interface JgfEdge {
  id?: string;
  source: string;
  target: string;
  /** The edge type, e.g. `Relation`. */
  relation?: string;
  directed?: boolean;
  label?: string;
  metadata?: Record<string, unknown>;
}

/** One problem found in a JGF document. */
export interface ValidationIssue {
  severity: 'error' | 'warning';
  /** Stable, machine-readable rule name, e.g. `unknown-node-type`. */
  code: string;
  /** A sentence naming the node or edge and the field. */
  message: string;
  /** Set when the issue is about a node. */
  nodeId?: string;
  /** Set when the issue is about an edge: its id, or `edges[3]` when it has none. */
  edgeId?: string;
  /** The field, e.g. `metadata.architectureState` or `source`. Empty for the document itself. */
  field: string;
}

export interface JgfSummary {
  nodes: { total: number; byType: Record<NodeType, number> };
  edges: { total: number; byRelation: Record<EdgeType, number> };
}

/** Response body of `POST /api/import/jgf`. Nothing is stored. */
export interface JgfValidationResult {
  /** True when there are no errors. Warnings don't make a document invalid. */
  valid: boolean;
  summary: JgfSummary;
  errorCount: number;
  warningCount: number;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
  /** True when more issues were found than are listed (the counts are always complete). */
  truncated: boolean;
}

/** Counts keyed by a reason, then by an ArchiMate type. */
export type CountsByReasonAndType = Record<string, Record<string, number>>;

/** A relationship not imported because its source or target was folded into a component. */
export interface FoldedEndRelationship {
  /** The relationship's identifier in the OEF file (cut short if very long). */
  id: string;
  /** ArchiMate relationship type, e.g. `Flow`. */
  type: string;
  reason: 'source-folded' | 'target-folded';
  /** Which end is a folded function. */
  end: 'source' | 'target' | 'both';
}

/** What the OEF mapper did. Nothing is dropped without appearing here. */
export interface OefMappingReport {
  elements: {
    total: number;
    /** Nodes created, by our node type. */
    mapped: Record<NodeType, number>;
    /** Nodes created, by ArchiMate element type. */
    mappedByElementType: Record<string, number>;
    /** Elements folded into a component's `functions`, by ArchiMate element type. */
    folded: Record<string, number>;
    /** Not imported, by reason (`skipped-by-config`, `unknown-element-type`, ...) and type. */
    skipped: CountsByReasonAndType;
  };
  functions: {
    /** Functions that became `functions` entries. */
    folded: number;
    /** Nodes that received at least one function. */
    hosts: number;
    /** Folded functions whose documentation or properties were not carried over. */
    foldedWithDetailsNotCarried: number;
    /** Function names already listed on that node, so not added twice. */
    duplicateEntries: number;
    /** Functions whose name was too long for an entry, so it was cut short. */
    entriesTruncated: number;
    /** Entries not added because the import reached its cap on function entries. */
    entriesNotAdded: number;
    /** Functions with no qualifying component: kept as nodes. */
    keptAsNodes: { id: string; name: string }[];
  };
  relationships: {
    total: number;
    /** Edges created, by edge type. */
    mapped: Record<EdgeType, number>;
    /** Not imported, by reason (`no-matching-rule`, `used-for-folding`, ...) and type. */
    skipped: CountsByReasonAndType;
    /**
     * The relationships skipped because an end is a folded function (reasons `source-folded`
     * and `target-folded`), one by one. The list is capped; `count` is always complete.
     */
    foldedEnds: {
      count: number;
      listed: FoldedEndRelationship[];
      /** True when more were skipped than are listed. */
      truncated: boolean;
    };
  };
  properties: {
    /** Values mapped by a config mapping (e.g. Responsible Team → owningTeam), by key. */
    mapped: Record<string, number>;
    /** Values kept as custom metadata, by key (nodes and edges together). */
    keptAsCustom: Record<string, number>;
    /** Values translated by a value map, e.g. "Target state" → Target. */
    valuesTranslated: number;
    /** Values with no translation, kept as they were, by key. */
    valuesNotTranslated: Record<string, number>;
    /** Defaults filled in where the value was empty or missing, by key (nodes and edges). */
    defaultsApplied: Record<string, number>;
    /** The part of `mapped` and `defaultsApplied` that is on relationships (edges), by key. */
    onRelationships: {
      mapped: Record<string, number>;
      defaultsApplied: Record<string, number>;
    };
    /** Keys renamed because the plain name was taken (e.g. by a standard property). */
    renamedKeys: number;
    /** Property values whose definition is missing from the file. */
    unknownDefinitions: number;
  };
  /** Diagrams (views): not imported. */
  viewsSkipped: number;
  /** Folder structure (organizations items): not imported. */
  organizationItemsSkipped: number;
}

/** Response body of `POST /api/import/oef`. Nothing is stored. */
export interface OefImportResult {
  jgf: JgfDocument;
  report: OefMappingReport;
  validation: JgfValidationResult;
}
