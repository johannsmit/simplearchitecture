import { randomUUID } from 'node:crypto';
import {
  compareNames,
  sameViewName,
  viewConflictMessage,
  viewNameTakenMessage,
  type DeletedViewResult,
  type ElementFieldIssue,
  type ModelAuthor,
  type RenamedViewResult,
  type StoredView,
  type ViewCardLayout,
  type ViewListResponse,
  type ViewResult,
  type ViewSummary,
} from '@simplearchitecture/shared';
import { z } from 'zod';
import {
  ConflictError,
  deleteSchema,
  EditingUnavailableError,
  issueId,
  NotFoundError,
  parse as parseRequest,
  RejectedError,
  Unchanged,
  versionSchema,
} from '../editing/common.js';
import {
  maxElementIdLength,
  maxViewCardCoordinate,
  maxViewCardWidth,
  maxViewElements,
  maxViewNameLength,
  maxViewRelationships,
  maxViewsPerModel,
  minViewCardWidth,
} from '../limits.js';
import type {
  PlannedViewChange,
  ViewAuditAction,
  ViewChangeState,
  ViewRecord,
  ViewStore,
  ViewWrite,
  ModelStore,
} from '../storage/model-store.js';
import { unstorable } from '../storage/stored-model.js';

/**
 * Views: a named, stored set of element and relationship ids of one model. The rules live here, so
 * the REST routes and a future MCP server behave the same. Input is `unknown` and checked here.
 * Who may call what (Viewer reads, Modeller changes) is the caller's check.
 *
 * - A view only refers to the model by id and never changes it.
 * - Every element and relationship must be in the model, and a relationship may be in a view only
 *   with both of its elements. The model's own rules (validation) don't apply: a view adds nothing
 *   to the model.
 * - A layout names cards of the view only, each once: where each was left on the canvas, and a
 *   width set by hand. Cards not named have no position afterwards. Taking a card out of the view
 *   (or deleting its element) drops its position.
 * - Rename, new contents, a new layout and delete carry the view's version as read; another one
 *   is a conflict. A change that changes nothing stores nothing and keeps the version.
 * - Nothing is stored for a refused change, and every stored change has one audit row with field
 *   names and counts only (the store writes it in the same transaction): never the view's name.
 */

/** The model already has the most views it may. The message is user-safe. */
export class ViewLimitError extends Error {
  override name = 'ViewLimitError';
  constructor() {
    super(
      `This model already has ${maxViewsPerModel} views, the most it may have. Delete a view before saving another.`,
    );
  }
}

const nameSchema = z
  .string({ error: 'Enter a name.' })
  .trim()
  .min(1, { error: 'Enter a name.' })
  .max(maxViewNameLength, { error: `Must be at most ${maxViewNameLength} characters.` })
  .refine((name) => !unstorable.test(name), {
    error: "The name contains a character that can't be stored. Remove it and try again.",
  });

const idMessage = 'Must be a list of ids.';
const idsSchema = (max: number, what: string) =>
  z
    .array(
      z
        .string({ error: idMessage })
        .min(1, { error: idMessage })
        .max(maxElementIdLength, { error: idMessage }),
      { error: idMessage },
    )
    .max(max, { error: `A view can hold at most ${max} ${what}.` });
const elementIdsSchema = idsSchema(maxViewElements, 'elements');
const relationshipIdsSchema = idsSchema(maxViewRelationships, 'relationships');

const newViewSchema = z.strictObject({
  name: nameSchema,
  elementIds: elementIdsSchema,
  relationshipIds: relationshipIdsSchema.optional(),
});

const renameSchema = z.strictObject({ version: versionSchema, name: nameSchema });

const contentsSchema = z.strictObject({
  version: versionSchema,
  elementIds: elementIdsSchema,
  relationshipIds: relationshipIdsSchema.optional(),
});

const coordinateMessage = `Must be a number from -${maxViewCardCoordinate} to ${maxViewCardCoordinate}.`;
const coordinateSchema = z
  .number({ error: coordinateMessage })
  .min(-maxViewCardCoordinate, { error: coordinateMessage })
  .max(maxViewCardCoordinate, { error: coordinateMessage });
const widthMessage = `Must be a whole number from ${minViewCardWidth} to ${maxViewCardWidth}.`;

const layoutSchema = z.strictObject({
  version: versionSchema,
  cards: z
    .array(
      z.strictObject({
        elementId: z
          .string({ error: idMessage })
          .min(1, { error: idMessage })
          .max(maxElementIdLength, { error: idMessage }),
        x: coordinateSchema,
        y: coordinateSchema,
        width: z
          .number({ error: widthMessage })
          .int({ error: widthMessage })
          .min(minViewCardWidth, { error: widthMessage })
          .max(maxViewCardWidth, { error: widthMessage })
          .optional(),
      }),
      { error: 'Must be a list of cards.' },
    )
    .max(maxViewElements, { error: `A view can hold at most ${maxViewElements} elements.` }),
});

/** Parses a request; a list's own index (and a card's field) isn't a field of it, so it goes. */
function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  try {
    return parseRequest(schema, input, 'a view');
  } catch (error) {
    if (!(error instanceof RejectedError)) throw error;
    const seen = new Set<string>();
    const fields = error.fields.flatMap((issue): ElementFieldIssue[] => {
      const field = issue.field.replace(/^(elementIds|relationshipIds|cards)\.\d+(\..*)?$/, '$1');
      const key = `${field}\n${issue.message}`;
      if (seen.has(key)) return [];
      seen.add(key);
      return [{ field, message: issue.message }];
    });
    throw new RejectedError(fields);
  }
}

/** Each id once, in the order first sent. */
const unique = (ids: readonly string[]): string[] => [...new Set(ids)];

/** A few ids for a message, cut short, and how many more there are. */
function listed(ids: readonly string[]): string {
  const shown = ids.slice(0, 5).map((id) => `"${issueId(id)}"`);
  const more = ids.length - shown.length;
  return more > 0 ? `${shown.join(', ')} and ${more} more` : shown.join(', ');
}

/** The ids the store may look up: text PostgreSQL can't hold is in no model. */
const storable = (ids: readonly string[]): string[] => ids.filter((id) => !unstorable.test(id));

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((id) => set.has(id));
}

function storedView(record: ViewRecord): StoredView {
  return {
    ...record.summary,
    elementIds: record.elementIds,
    relationshipIds: record.relationshipIds,
    layout: record.layout,
  };
}

/** A card's layout as a comparable key. */
const cardKey = (card: ViewCardLayout): string =>
  `${card.elementId}\n${card.x}\n${card.y}\n${card.width ?? ''}`;

/** Both name each card once, so the same keys are the same layout. */
const sameLayout = (a: readonly ViewCardLayout[], b: readonly ViewCardLayout[]): boolean =>
  sameSet(a.map(cardKey), b.map(cardKey));

/** The cards of a new layout, or RejectedError: cards of the view only, each once. */
function checkedLayout(
  view: ViewRecord,
  cards: readonly { elementId: string; x: number; y: number; width?: number | undefined }[],
): ViewCardLayout[] {
  const inView = new Set(view.elementIds);
  const issues: ElementFieldIssue[] = [];
  const seen = new Set<string>();
  const twice = new Set<string>();
  for (const card of cards) {
    if (seen.has(card.elementId)) twice.add(card.elementId);
    seen.add(card.elementId);
  }
  if (twice.size > 0) {
    issues.push({
      field: 'cards',
      message: `Each card can be in the layout once. These are in it more than once: ${listed([...twice])}.`,
    });
  }
  const outside = [...seen].filter((id) => !inView.has(id));
  if (outside.length > 0) {
    issues.push({
      field: 'cards',
      message: `These cards are not in the view (they may have been removed, or deleted from the model): ${listed(outside)}.`,
    });
  }
  if (issues.length > 0) throw new RejectedError(issues);
  return cards.map(({ elementId, x, y, width }) => ({
    elementId,
    x,
    y,
    ...(width === undefined ? {} : { width }),
  }));
}

/**
 * The relationships a view's new contents hold, or RejectedError. With `requested`, exactly those
 * (each in the model, with both of its elements in the view). Without it, those of the view's
 * current relationships whose two elements are still in it.
 */
function checkedContents(
  state: ViewChangeState,
  elementIds: readonly string[],
  requested: readonly string[] | undefined,
): string[] {
  const issues: ElementFieldIssue[] = [];
  const missingElements = elementIds.filter((id) => !state.elements.has(id));
  if (missingElements.length > 0) {
    issues.push({
      field: 'elementIds',
      message: `These elements are not in the model (they may have been deleted): ${listed(missingElements)}.`,
    });
  }
  const inView = new Set(elementIds);
  const bothEnds = (id: string): boolean => {
    const ends = state.relationships.get(id);
    return (
      ends !== undefined &&
      ends.source !== null &&
      ends.target !== null &&
      inView.has(ends.source) &&
      inView.has(ends.target)
    );
  };
  let relationshipIds: string[];
  if (requested === undefined) {
    relationshipIds = (state.view?.relationshipIds ?? []).filter(bothEnds);
  } else {
    relationshipIds = [...requested];
    const missing = requested.filter((id) => !state.relationships.has(id));
    if (missing.length > 0) {
      issues.push({
        field: 'relationshipIds',
        message: `These relationships are not in the model (they may have been deleted): ${listed(missing)}.`,
      });
    }
    const withoutEnds = requested.filter((id) => state.relationships.has(id) && !bothEnds(id));
    if (withoutEnds.length > 0) {
      issues.push({
        field: 'relationshipIds',
        message: `A relationship can be in a view only with both of its elements. Add them to the view, or leave out: ${listed(withoutEnds)}.`,
      });
    }
  }
  if (issues.length > 0) throw new RejectedError(issues);
  return relationshipIds;
}

/**
 * The rules for a view's name against the model's other views, the one place for them: a name is
 * unique within its model, ignoring case. A view may keep its own name in another case.
 */
function checkName(state: ViewChangeState, name: string, viewId: string): void {
  const taken = state.views.find((view) => view.id !== viewId && sameViewName(view.name, name));
  if (taken !== undefined) {
    throw new RejectedError([{ field: 'name', message: viewNameTakenMessage(taken.name) }]);
  }
}

function plan(
  write: ViewWrite,
  action: ViewAuditAction,
  actor: ModelAuthor,
  fields: string[],
): PlannedViewChange {
  return { write, audit: { action, actor: { id: actor.id, name: actor.name }, fields } };
}

/** The view a change is about, at the version sent, or NotFoundError or ConflictError. */
function currentView(state: ViewChangeState, version: number): ViewRecord {
  const { view } = state;
  if (view === undefined) throw new NotFoundError('view');
  if (view.summary.version !== version) {
    throw new ConflictError(view.summary.version, viewConflictMessage);
  }
  return view;
}

export class ViewService {
  readonly #store: ModelStore;

  constructor(store: ModelStore) {
    this.#store = store;
  }

  /** Whether views can be stored (the store is PostgreSQL). */
  get available(): boolean {
    return this.#store.views !== undefined;
  }

  #views(): ViewStore {
    const views = this.#store.views;
    if (views === undefined) throw new EditingUnavailableError();
    return views;
  }

  /** The model's views, by name. */
  async listViews(modelId: string): Promise<ViewListResponse> {
    const views = await this.#views().list(modelId);
    if (views === undefined) throw new NotFoundError('model');
    views.sort(
      (a, b) =>
        compareNames(a.name, b.name) ||
        a.createdAt.localeCompare(b.createdAt) ||
        a.id.localeCompare(b.id),
    );
    return { views };
  }

  async getView(modelId: string, viewId: string): Promise<ViewResult> {
    const found = await this.#views().get(modelId, viewId);
    if (found === 'no-model') throw new NotFoundError('model');
    if (found === 'no-view') throw new NotFoundError('view');
    return { view: storedView(found) };
  }

  async createView(modelId: string, input: unknown, actor: ModelAuthor): Promise<ViewResult> {
    const views = this.#views();
    const request = parse(newViewSchema, input);
    const elementIds = unique(request.elementIds);
    const requested = request.relationshipIds === undefined ? [] : unique(request.relationshipIds);
    const viewId = randomUUID();
    const changed = await views.change(
      modelId,
      { elementIds: storable(elementIds), relationshipIds: storable(requested) },
      (state) => {
        if (state.views.length >= maxViewsPerModel) throw new ViewLimitError();
        checkName(state, request.name, viewId);
        const relationshipIds = checkedContents(state, elementIds, requested);
        return plan(
          { kind: 'create', viewId, name: request.name, elementIds, relationshipIds },
          'view-added',
          actor,
          ['name', 'elementIds', 'relationshipIds'],
        );
      },
    );
    if (changed?.view === undefined) throw new NotFoundError('model');
    return { view: storedView(changed.view) };
  }

  async renameView(
    modelId: string,
    viewId: string,
    input: unknown,
    actor: ModelAuthor,
  ): Promise<RenamedViewResult> {
    const views = this.#views();
    const request = parse(renameSchema, input);
    try {
      const changed = await views.change(
        modelId,
        { viewId, elementIds: [], relationshipIds: [] },
        (state) => {
          const view = currentView(state, request.version);
          if (view.summary.name === request.name) throw new Unchanged(view.summary);
          checkName(state, request.name, viewId);
          return plan({ kind: 'rename', viewId, name: request.name }, 'view-renamed', actor, [
            'name',
          ]);
        },
      );
      if (changed?.view === undefined) throw new NotFoundError('model');
      return { view: changed.view.summary };
    } catch (error) {
      if (error instanceof Unchanged) return { view: error.result as ViewSummary };
      throw error;
    }
  }

  /**
   * New contents in place of the old. With `relationshipIds`, exactly those; without, the view
   * keeps those of its relationships whose two elements are still in it.
   */
  async replaceContents(
    modelId: string,
    viewId: string,
    input: unknown,
    actor: ModelAuthor,
  ): Promise<ViewResult> {
    const views = this.#views();
    const request = parse(contentsSchema, input);
    const elementIds = unique(request.elementIds);
    const requested =
      request.relationshipIds === undefined ? undefined : unique(request.relationshipIds);
    try {
      const changed = await views.change(
        modelId,
        {
          viewId,
          elementIds: storable(elementIds),
          relationshipIds: storable(requested ?? []),
        },
        (state) => {
          const view = currentView(state, request.version);
          const relationshipIds = checkedContents(state, elementIds, requested);
          const fields = [
            ...(sameSet(view.elementIds, elementIds) ? [] : ['elementIds']),
            ...(sameSet(view.relationshipIds, relationshipIds) ? [] : ['relationshipIds']),
          ];
          if (fields.length === 0) throw new Unchanged(view);
          return plan(
            { kind: 'replace', viewId, elementIds, relationshipIds },
            'view-changed',
            actor,
            fields,
          );
        },
      );
      if (changed?.view === undefined) throw new NotFoundError('model');
      return { view: storedView(changed.view) };
    } catch (error) {
      if (error instanceof Unchanged) return { view: storedView(error.result as ViewRecord) };
      throw error;
    }
  }

  /**
   * A new layout in place of the old: where each card named is, and its width when set by hand.
   * Saved only on what the person did on the canvas (the caller's rule); a layout the canvas made
   * on its own is never sent.
   */
  async replaceLayout(
    modelId: string,
    viewId: string,
    input: unknown,
    actor: ModelAuthor,
  ): Promise<ViewResult> {
    const views = this.#views();
    const request = parse(layoutSchema, input);
    try {
      const changed = await views.change(
        modelId,
        { viewId, elementIds: [], relationshipIds: [] },
        (state) => {
          const view = currentView(state, request.version);
          const cards = checkedLayout(view, request.cards);
          if (sameLayout(view.layout, cards)) throw new Unchanged(view);
          return plan({ kind: 'layout', viewId, cards }, 'view-changed', actor, ['layout']);
        },
      );
      if (changed?.view === undefined) throw new NotFoundError('model');
      return { view: storedView(changed.view) };
    } catch (error) {
      if (error instanceof Unchanged) return { view: storedView(error.result as ViewRecord) };
      throw error;
    }
  }

  /** Deletes the view. The model's elements and relationships stay as they are. */
  async deleteView(
    modelId: string,
    viewId: string,
    input: unknown,
    actor: ModelAuthor,
  ): Promise<DeletedViewResult> {
    const views = this.#views();
    const { version } = parse(deleteSchema, input);
    const changed = await views.change(
      modelId,
      { viewId, elementIds: [], relationshipIds: [] },
      (state) => {
        currentView(state, version);
        return plan({ kind: 'delete', viewId }, 'view-deleted', actor, []);
      },
    );
    if (changed === undefined) throw new NotFoundError('model');
    return { id: viewId };
  }
}
