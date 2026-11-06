import {
  buildModelGraph,
  childrenOf,
  compareNames,
  containerOf,
  defaultNeighbourhoodCap,
  displayLabel,
  edgeTypes,
  findElements,
  hasStandardEdgeProperty,
  neighbourhood,
  nodeTypes,
  relationshipsOf,
  relationshipValue,
  relationTextProperties,
  type EdgeType,
  type ElementFilters,
  type ModelElement,
  type ModelGraph,
  type ModelRelationship,
  type NodeType,
  type RelationTextProperty,
} from '@simplearchitecture/shared';
import { isModelId, ModelUnreadableError, type ModelStore } from '../storage/model-store.js';

/**
 * What an AI agent may read through MCP: exactly what Viewing shows, in compact JSON. The tools
 * in mcp-server.ts are thin wrappers over these methods, which reuse the model store and the
 * shared graph and filter functions the web app uses. Who may call them (Viewer or higher) is the
 * caller's check.
 */

export const searchPageSize = 50;
export const listDescriptionLength = 200;
/** Relationships listed with one element at most; an element with more says so. */
export const maxElementRelationships = 500;

/** A tool call that can't be answered. The message is safe to show the agent. */
export class ToolError extends Error {
  override name = 'ToolError';
}

const internalPrefix = 'simplearchitecture:';

/** An element's own properties: its metadata without the type and the server's own keys. */
function propertiesOf(element: ModelElement, cut: boolean): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(element.metadata)) {
    if (key === 'type' || key.startsWith(internalPrefix)) continue;
    properties[key] =
      cut &&
      key === 'description' &&
      typeof value === 'string' &&
      value.length > listDescriptionLength
        ? `${value.slice(0, listDescriptionLength)}…`
        : value;
  }
  return properties;
}

function brief(element: ModelElement) {
  return { id: element.id, name: element.name, type: element.type };
}

function listed(element: ModelElement) {
  return { ...brief(element), properties: propertiesOf(element, true) };
}

/**
 * A relationship as the tools return it. Next to a stored `label`, `displayLabel` is what the
 * canvas shows: the label with its `{Property}` names filled in (empty when nothing is left).
 */
function relationshipFields(graph: ModelGraph, relationship: ModelRelationship) {
  return {
    id: relationship.id,
    type: relationship.type,
    ...(relationship.label === undefined
      ? {}
      : {
          label: relationship.label,
          displayLabel: displayLabel(relationship, graph) ?? '',
        }),
    architectureState: relationship.architectureState,
    ...(relationship.twoWay === true ? { twoWay: true } : {}),
    ...relationTexts(relationship),
  };
}

/** Identity, Identity Context and Data, on a Relation, when set (as the canvas reads them). */
function relationTexts(
  relationship: ModelRelationship,
): Partial<Record<RelationTextProperty, string>> {
  const texts: Partial<Record<RelationTextProperty, string>> = {};
  for (const key of relationTextProperties) {
    if (!hasStandardEdgeProperty(key, relationship.type)) continue;
    const value = relationshipValue(relationship, key);
    if (value !== undefined) texts[key] = value;
  }
  return texts;
}

function byName(a: ModelElement, b: ModelElement): number {
  return compareNames(a.name, b.name) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/** The page cursor: where the next page starts. Opaque to the agent. */
function encodeCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ o: offset })).toString('base64url');
}

function decodeCursor(cursor: string | undefined): number {
  if (cursor === undefined) return 0;
  try {
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { o?: unknown };
    if (typeof value.o === 'number' && Number.isInteger(value.o) && value.o >= 0) return value.o;
  } catch {
    // Not a cursor of ours: refused below.
  }
  throw new ToolError('The cursor is not valid. Start again without one.');
}

export interface SearchInput {
  query?: string | undefined;
  type?: NodeType | undefined;
  filters?: ElementFilters | undefined;
  cursor?: string | undefined;
}

export class McpReadService {
  constructor(private readonly store: ModelStore) {}

  /** Every model Viewing lists, newest first. Damaged models are left out, as there. */
  async listModels() {
    const models = await this.store.list();
    return {
      models: models.map((model) => ({
        id: model.id,
        name: model.name,
        createdAt: model.createdAt,
        elements: model.nodeCount,
        relationships: model.edgeCount,
      })),
    };
  }

  /** Counts per element type and per relationship type, so an agent can plan its searches. */
  async modelSummary(modelId: string) {
    const graph = await this.#graph(modelId);
    const elementsByType = Object.fromEntries(nodeTypes.map((type) => [type, 0])) as Record<
      NodeType,
      number
    >;
    for (const element of graph.elements.values()) elementsByType[element.type] += 1;
    const relationshipsByType = Object.fromEntries(edgeTypes.map((type) => [type, 0])) as Record<
      EdgeType,
      number
    >;
    for (const relationship of graph.relationships) {
      relationshipsByType[relationship.type] += 1;
    }
    return {
      id: modelId,
      name: graph.name,
      elements: graph.elements.size,
      elementsByType,
      relationships: graph.relationships.length,
      relationshipsByType,
    };
  }

  /**
   * Elements whose name contains the text and that match the type and the metadata filters (as
   * the element list and the catalog filter), by name, 50 a page.
   */
  async searchElements(modelId: string, input: SearchInput) {
    const graph = await this.#graph(modelId);
    const offset = decodeCursor(input.cursor);
    const matches = findElements(graph, {
      ...(input.query === undefined ? {} : { query: input.query }),
      ...(input.filters === undefined ? {} : { filters: input.filters }),
    })
      .filter((element) => input.type === undefined || element.type === input.type)
      .sort(byName);
    if (offset > matches.length) throw new ToolError('The cursor is past the last page.');
    const page = matches.slice(offset, offset + searchPageSize);
    const next = offset + page.length;
    return {
      total: matches.length,
      elements: page.map(listed),
      ...(next < matches.length ? { nextCursor: encodeCursor(next) } : {}),
    };
  }

  /** One element in full: its properties, its container, what it contains, its relationships. */
  async element(modelId: string, elementId: string) {
    const graph = await this.#graph(modelId);
    const element = this.#element(graph, elementId);
    const containerId = containerOf(graph, elementId);
    const container = containerId === undefined ? undefined : graph.elements.get(containerId);
    const all = relationshipsOf(graph, elementId);
    const relationships = all.slice(0, maxElementRelationships).map((relationship) => {
      const outgoing = relationship.source === elementId;
      const otherId = outgoing ? relationship.target : relationship.source;
      const other = graph.elements.get(otherId);
      return {
        ...relationshipFields(graph, relationship),
        direction: relationship.twoWay === true ? 'two-way' : outgoing ? 'outgoing' : 'incoming',
        other: other === undefined ? { id: otherId } : brief(other),
        properties: Object.fromEntries(
          Object.entries(relationship.metadata).filter(([key]) => !key.startsWith(internalPrefix)),
        ),
      };
    });
    return {
      ...brief(element),
      properties: propertiesOf(element, false),
      container: container === undefined ? null : brief(container),
      contains: childrenOf(graph, elementId).flatMap((id) => {
        const child = graph.elements.get(id);
        return child === undefined ? [] : [brief(child)];
      }),
      relationships,
      ...(all.length > relationships.length ? { relationshipsTotal: all.length } : {}),
    };
  }

  /** The elements within 1 to 3 relationship steps, like the canvas depth, with their lines. */
  async neighbours(modelId: string, elementId: string, depth: number, types?: readonly EdgeType[]) {
    const graph = await this.#graph(modelId);
    this.#element(graph, elementId);
    const found = neighbourhood(graph, elementId, {
      depth,
      cap: defaultNeighbourhoodCap,
      ...(types === undefined || types.length === 0 ? {} : { types: new Set(types) }),
    });
    const elements = [...found.hops].flatMap(([id, steps]) => {
      const element = graph.elements.get(id);
      return element === undefined ? [] : [{ ...brief(element), steps }];
    });
    return {
      element: elementId,
      depth,
      elements,
      relationships: found.relationships.map((relationship) => ({
        ...relationshipFields(graph, relationship),
        source: relationship.source,
        target: relationship.target,
      })),
      reachable: found.reachable,
      capped: found.capped,
    };
  }

  async #graph(modelId: string): Promise<ModelGraph> {
    if (!isModelId(modelId)) throw new ToolError('Model not found. Use list_models for the ids.');
    let document;
    try {
      document = await this.store.get(modelId);
    } catch (error) {
      if (error instanceof ModelUnreadableError) {
        throw new ToolError('The model is damaged and cannot be read. An Admin can see it.');
      }
      throw error;
    }
    if (document === undefined) {
      throw new ToolError('Model not found. Use list_models for the ids.');
    }
    return buildModelGraph(document);
  }

  #element(graph: ModelGraph, elementId: string): ModelElement {
    const element = graph.elements.get(elementId);
    if (element === undefined) {
      throw new ToolError('Element not found in this model. Use search_elements for the ids.');
    }
    return element;
  }
}
