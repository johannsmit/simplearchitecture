import {
  nodeTypeKey,
  spacesForRoles,
  type ElementChangeResult,
  type ElementFieldIssue,
  type RelationshipChangeResult,
  type ValidationIssue,
} from '@simplearchitecture/shared';
import type { McpAuth } from '../auth/access.js';
import {
  ConflictError,
  NotFoundError,
  RejectedError,
  rejectedMessage,
  type EditOptions,
  type Entries,
  type Missing,
} from '../editing/common.js';
import type { ElementService } from '../editing/element-service.js';
import type { RelationshipService } from '../editing/relationship-service.js';
import { RateLimiter } from '../rate-limit.js';
import {
  ModelNotStorableError,
  ModelTooLargeError,
  ModelUnreadableError,
  ViewFullError,
} from '../storage/model-store.js';
import { ToolError } from './read-service.js';

/**
 * What an AI agent may change through MCP for a Modeller or Admin: one element or relationship
 * per call, through the same ElementService and RelationshipService (and so the same input
 * checks, metamodel rules and validation) as the app. The tools in mcp-server.ts are thin
 * wrappers over these methods.
 *
 * - Deny by default: every call checks again that the user's roles open Modelling.
 * - `dryRun` runs the change exactly as a save and rolls it back: nothing is stored or audited.
 * - A saved change has the app's audit row with the user as actor, and `via` in its details:
 *   the agent (client and connection ids) that made it.
 * - At most `mcpWritesPerMinute` write calls per user, previews included, on top of the
 *   endpoint's request limit.
 */

/** Write tool calls per user per minute, previews included: a preview takes the same work. */
export const mcpWritesPerMinute = 60;
export const tooManyWritesMessage = `Too many changes: at most ${mcpWritesPerMinute} write tool calls (previews included) a minute. Wait a minute and try again.`;
export const readOnlyMessage =
  'Changing the model needs the Modeller role or higher. This connection can only read.';

/** Whether the user's roles allow changes (they open Modelling: Modeller and Admin). */
export function canWrite(auth: McpAuth): boolean {
  return spacesForRoles(auth.roles).includes('modelling');
}

export interface NewElementInput {
  type: unknown;
  name: unknown;
  description?: unknown;
  properties?: unknown;
}

export interface ElementUpdateInput {
  version: unknown;
  name?: unknown;
  type?: unknown;
  description?: unknown;
  properties?: unknown;
}

export interface NewRelationshipInput {
  source: unknown;
  target: unknown;
  type: unknown;
  architectureState?: unknown;
  description?: unknown;
}

export interface RelationshipUpdateInput {
  version: unknown;
  source?: unknown;
  target?: unknown;
  type?: unknown;
  architectureState?: unknown;
  description?: unknown;
  label?: unknown;
  reverse?: unknown;
  twoWay?: unknown;
  identity?: unknown;
  identityContext?: unknown;
  sourceToTargetData?: unknown;
  targetToSourceData?: unknown;
  properties?: unknown;
}

const internalPrefix = 'simplearchitecture:';

/** The fields that were sent, `properties` under the services' name `metadata`. */
function body(input: object): Entries {
  const sent: Entries = {};
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined) continue;
    sent[key === 'properties' ? 'metadata' : key] = value;
  }
  return sent;
}

/** A metadata object without the type and the server's own keys, as the read tools show it. */
function propertiesOf(metadata: unknown): Entries {
  if (typeof metadata !== 'object' || metadata === null) return {};
  return Object.fromEntries(
    Object.entries(metadata).filter(
      ([key]) => key !== nodeTypeKey && !key.startsWith(internalPrefix),
    ),
  );
}

const warningTexts = (warnings: readonly ValidationIssue[]): string[] =>
  warnings.map((warning) => warning.message);

/** A field as the tools name it. */
const toolField = (field: string): string =>
  field === 'metadata' || field.startsWith('metadata.')
    ? `properties${field.slice('metadata'.length)}`
    : field;

function fieldLines(fields: readonly ElementFieldIssue[]): string {
  return fields
    .map(({ field, message }) =>
      field === '' ? `- ${message}` : `- ${toolField(field)}: ${message}`,
    )
    .join('\n');
}

const missingMessages: Record<Missing, string> = {
  model: 'Model not found. Use list_models for the ids.',
  element: 'Element not found in this model. Use search_elements for the ids.',
  relationship:
    'Relationship not found in this model. get_element lists an element’s relationships with their ids.',
  source: 'The source element is not in the model. Use search_elements for the ids.',
  target: 'The target element is not in the model. Use search_elements for the ids.',
  view: 'View not found.',
  folder: 'Folder not found.',
  property: 'Property not found.',
};

/** A refused change as a tool error the agent can act on; anything else is rethrown. */
function refusal(error: unknown): unknown {
  if (error instanceof RejectedError) {
    const repeat =
      error.duplicateOf === undefined
        ? ''
        : `\nIt would repeat the relationship ${error.duplicateOf}.`;
    return new ToolError(`${rejectedMessage}\n${fieldLines(error.fields)}${repeat}`);
  }
  if (error instanceof ConflictError) {
    return new ToolError(
      `${error.message} Nothing was saved. Its current version is ${String(error.currentVersion)}: read it again with get_element, check that the change still makes sense, and send that version.`,
    );
  }
  if (error instanceof NotFoundError) return new ToolError(missingMessages[error.what]);
  if (
    error instanceof ModelNotStorableError ||
    error instanceof ViewFullError ||
    error instanceof ModelTooLargeError
  ) {
    return new ToolError(`${rejectedMessage}\n- ${error.message}`);
  }
  if (error instanceof ModelUnreadableError) {
    return new ToolError('The model is damaged and cannot be changed. An Admin can see it.');
  }
  return error;
}

/** What a preview says: what would be saved, never an id or version to use. */
const previewNote =
  'Preview only: nothing was saved. Show the user this change and save it (the same call without dry_run) only when they confirm.';

export class McpWriteService {
  readonly #elements: ElementService;
  readonly #relationships: RelationshipService;
  readonly #writes: RateLimiter;

  constructor(
    elements: ElementService,
    relationships: RelationshipService,
    now: () => number = Date.now,
  ) {
    this.#elements = elements;
    this.#relationships = relationships;
    this.#writes = new RateLimiter(mcpWritesPerMinute, 60_000, now);
  }

  async createElement(auth: McpAuth, modelId: string, input: NewElementInput, dryRun: boolean) {
    const result = await this.#write(auth, dryRun, (actor, edit) =>
      this.#elements.addElement(modelId, body(input), actor, edit),
    );
    return elementResult(result, dryRun);
  }

  async updateElement(
    auth: McpAuth,
    modelId: string,
    elementId: string,
    input: ElementUpdateInput,
    dryRun: boolean,
  ) {
    const result = await this.#write(auth, dryRun, (actor, edit) =>
      this.#elements.updateElement(modelId, elementId, body(input), actor, edit),
    );
    return elementResult(result, dryRun, input.version);
  }

  async createRelationship(
    auth: McpAuth,
    modelId: string,
    input: NewRelationshipInput,
    dryRun: boolean,
  ) {
    const result = await this.#write(auth, dryRun, (actor, edit) =>
      this.#relationships.addRelationship(modelId, body(input), actor, edit),
    );
    return relationshipResult(result, dryRun);
  }

  async updateRelationship(
    auth: McpAuth,
    modelId: string,
    relationshipId: string,
    input: RelationshipUpdateInput,
    dryRun: boolean,
  ) {
    const result = await this.#write(auth, dryRun, (actor, edit) =>
      this.#relationships.updateRelationship(modelId, relationshipId, body(input), actor, edit),
    );
    return relationshipResult(result, dryRun, input.version);
  }

  /** The role check, the write limit, then the change as the user, marked as the agent's. */
  async #write<T>(
    auth: McpAuth,
    dryRun: boolean,
    change: (actor: { id: string; name: string }, edit: EditOptions) => Promise<T>,
  ): Promise<T> {
    if (!canWrite(auth)) throw new ToolError(readOnlyMessage);
    if (!this.#writes.allow(auth.userId)) throw new ToolError(tooManyWritesMessage);
    const edit: EditOptions = {
      dryRun,
      via: { kind: 'mcp', clientId: auth.clientId, connectionId: auth.connectionId },
    };
    try {
      return await change({ id: auth.userId, name: auth.userName }, edit);
    } catch (error) {
      throw refusal(error);
    }
  }
}

/**
 * The element as saved, in the read tools' shape. A preview leaves out the id of a new element
 * (a save makes another) and gives the version to send for an update: the one sent.
 */
function elementResult(result: ElementChangeResult, dryRun: boolean, sentVersion?: unknown) {
  const { element } = result;
  const { node } = element;
  const metadata = node.metadata as Entries | undefined;
  const fields = {
    name: node.label ?? '',
    type: metadata?.[nodeTypeKey],
    properties: propertiesOf(metadata),
  };
  const warnings = warningTexts(result.warnings);
  if (dryRun) {
    const ids = sentVersion === undefined ? {} : { id: element.id, version: sentVersion };
    return {
      dryRun: true,
      saved: false,
      note: previewNote,
      element: { ...ids, ...fields },
      warnings,
    };
  }
  return {
    saved: true,
    element: { id: element.id, version: element.version, ...fields },
    warnings,
  };
}

function relationshipResult(
  result: RelationshipChangeResult,
  dryRun: boolean,
  sentVersion?: unknown,
) {
  const { relationship } = result;
  const { edge } = relationship;
  const fields = {
    source: edge.source,
    target: edge.target,
    type: edge.relation,
    ...(edge.directed === false ? { twoWay: true } : {}),
    ...(edge.label === undefined ? {} : { label: edge.label }),
    properties: propertiesOf(edge.metadata),
  };
  const extra = {
    warnings: warningTexts(result.warnings),
    ...(result.nestingChanges.length === 0 ? {} : { nestingChanges: result.nestingChanges }),
  };
  if (dryRun) {
    const ids = sentVersion === undefined ? {} : { id: relationship.id, version: sentVersion };
    return {
      dryRun: true,
      saved: false,
      note: previewNote,
      relationship: { ...ids, ...fields },
      ...extra,
    };
  }
  return {
    saved: true,
    relationship: { id: relationship.id, version: relationship.version, ...fields },
    ...extra,
    ...(result.viewsChanged === undefined ? {} : { viewsChanged: result.viewsChanged }),
  };
}
