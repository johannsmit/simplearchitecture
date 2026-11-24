import {
  buildModelGraph,
  neighbourhood,
  relationshipOfEdge,
  type ChangedView,
  type DeletedRelationshipResult,
  type JgfDocument,
  type JgfEdge,
  type ModelElement,
  type ModelGraph,
  type ModelRelationship,
  type NestingChange,
  type RelationshipChangeResult,
} from '@simplearchitecture/shared';
import { withEdge, withoutEdge } from '../../modelling/document';
import { relationshipSentence } from '../../modelling/relationships';
import type { OpenView } from './useOpenView';
import { withoutDeleted, withRelationshipInView } from './views';

interface RelationshipChangeContext {
  graph: ModelGraph | undefined;
  document: JgfDocument | undefined;
  /** The focused element, when it is in the model. */
  element: ModelElement | undefined;
  elementId: string | undefined;
  viewId: string | undefined;
  inView: boolean;
  viewEditable: boolean;
  depth: number;
  nest: boolean;
  openView: OpenView;
  onCanvas: ReadonlySet<string>;
  addElement: (id: string) => void;
  requestArrange: () => void;
  updateDocument: (change: (document: JgfDocument) => JgfDocument) => void;
  showLines: (on: boolean) => void;
  light: (relationshipId: string) => void;
  announce: (text: string) => void;
  reloadModels: () => void;
  clearPanelState: () => void;
  closeRelationship: () => void;
  focusHeadingOf: (elementId: string) => void;
}

/**
 * What follows a relationship the server added, saved or deleted (Modelling): the model, the
 * canvas or open view, and what is announced.
 */
export function useRelationshipChanges({
  graph,
  document: document_,
  element,
  elementId,
  viewId,
  inView,
  viewEditable,
  depth,
  nest,
  openView,
  onCanvas,
  addElement,
  requestArrange,
  updateDocument,
  showLines,
  light,
  announce,
  reloadModels,
  clearPanelState,
  closeRelationship,
  focusHeadingOf,
}: RelationshipChangeContext) {
  /** A Contains change moved a nesting: the cards stay put, and a new layout shows it. */
  const nestingNote = (changes: readonly NestingChange[]) =>
    changes.length > 0 && nest ? ' The nesting updates when the canvas is opened again.' : '';
  const sentenceOf = (result: RelationshipChangeResult) => {
    const relationship = relationshipOfEdge(result.relationship.edge);
    return graph && relationship ? relationshipSentence(graph, relationship) : '';
  };
  const onRelationshipAdded = (result: RelationshipChangeResult) => {
    updateDocument((current) => withEdge(current, result.relationship.edge));
    // Lines come back on, so the new one shows.
    showLines(true);
    light(result.relationship.id);
    // In a view, added to it when both of its elements are in it.
    const { edge } = result.relationship;
    const notInView =
      viewEditable &&
      !openView.change((current) =>
        withRelationshipInView(current, {
          id: result.relationship.id,
          source: edge.source,
          target: edge.target,
        }),
      );
    announce(
      `Added: ${sentenceOf(result)}.${nestingNote(result.nestingChanges)}${notInView ? " It isn't in this view." : ''}`,
    );
    reloadModels();
  };
  const onRelationshipStored = (result: RelationshipChangeResult, saved: boolean) => {
    const { id, edge } = result.relationship;
    const before = graph?.relationships.find((r) => r.id === id);
    updateDocument((current) => withEdge(current, edge));
    if (!saved) return;
    const brought = before ? followNewEnds(before, edge, result.viewsChanged ?? []) : [];
    const names = brought.map((other) => `“${graph?.elements.get(other)?.name || '(unnamed)'}”`);
    const where = inView ? 'view' : 'canvas';
    announce(
      `Saved.${names.length > 0 ? ` Added ${names.join(' and ')} to the ${where}.` : ''}${nestingNote(result.nestingChanges)}`,
    );
    reloadModels();
  };
  /**
   * A relationship's ends changed: a new end not on the canvas joins it at a free spot, and the
   * old ends stay. In a view the server has added the new ends already, and dropped the route the
   * line was given there (also after a reverse), with a new version for the view; the view's
   * layout is then saved as for any added card. Returns the elements added.
   */
  function followNewEnds(
    before: ModelRelationship,
    edge: JgfEdge & { id: string },
    viewsChanged: readonly ChangedView[],
  ): string[] {
    const ends = [edge.source, edge.target];
    const fresh = ends.filter((end) => end !== before.source && end !== before.target);
    const moved = edge.source !== before.source || edge.target !== before.target;
    if (!moved || !graph || !document_) return [];
    if (inView) {
      const { contents } = openView;
      const changed = viewsChanged.find((changedView) => changedView.id === viewId);
      const missing = contents.relationshipIds.includes(before.id)
        ? fresh.filter((end) => !contents.elementIds.includes(end))
        : [];
      if (changed === undefined && missing.length === 0) return [];
      openView.adopt(
        (current) => ({
          ...current,
          elementIds: [
            ...current.elementIds,
            ...missing.filter((end) => !current.elementIds.includes(end)),
          ],
        }),
        changed?.version,
        [before.id],
      );
      if (missing.length > 0) requestArrange();
      return missing;
    }
    if (fresh.length === 0 || element === undefined) return [];
    // An end the focus doesn't reach after the change is kept on the canvas as an added card: an
    // old end that was there, and a new end.
    const after = buildModelGraph(withEdge(document_, edge));
    const reached = neighbourhood(after, element.id, { depth }).hops;
    for (const old of [before.source, before.target]) {
      if (onCanvas.has(old) && !reached.has(old)) addElement(old);
    }
    const missing = fresh.filter((end) => !onCanvas.has(end));
    for (const end of missing) if (!reached.has(end)) addElement(end);
    return missing;
  }
  const onRelationshipRemoved = (
    id: string,
    result: DeletedRelationshipResult | undefined,
    words: string,
  ) => {
    clearPanelState();
    if (inView) openView.adopt((current) => withoutDeleted(current, { relationshipIds: [id] }));
    updateDocument((current) => withoutEdge(current, id));
    const note = nestingNote(result?.nestingChanges ?? []);
    closeRelationship();
    if (elementId !== undefined) focusHeadingOf(elementId);
    if (words !== '') announce(`${words}${note}`);
    reloadModels();
  };
  return { onRelationshipAdded, onRelationshipStored, onRelationshipRemoved };
}
