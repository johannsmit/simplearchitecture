import { buildModelGraph } from '@simplearchitecture/shared';
import { describe, expect, it } from 'vitest';
import {
  canvasContents,
  nestingParents,
  viewHood,
  withElementInView,
  withoutDeleted,
  withoutElementInView,
  withoutRelationshipInView,
  withRelationshipInView,
} from '../src/viewing/explorer/views';

// A view's contents, worked out on the client. Made up: a campus with a hall, a room and a desk.
const graph = buildModelGraph({
  graph: {
    nodes: {
      campus: { label: 'Campus', metadata: { type: 'Infrastructure' } },
      hall: { label: 'Hall', metadata: { type: 'Infrastructure' } },
      room: { label: 'Room', metadata: { type: 'Infrastructure' } },
      desk: { label: 'Desk app', metadata: { type: 'Application' } },
      porter: { label: 'Porter', metadata: { type: 'Stakeholder' } },
    },
    edges: [
      { id: 'c1', source: 'campus', target: 'hall', relation: 'Contains' },
      { id: 'c2', source: 'hall', target: 'room', relation: 'Contains' },
      { id: 'u1', source: 'porter', target: 'desk', relation: 'Relation' },
      { id: 'u2', source: 'desk', target: 'room', relation: 'Relation' },
      { source: 'porter', target: 'room', relation: 'Relation' },
    ],
  },
});
const hasId = (id: string) => !id.startsWith('edges[');

describe('a view on the canvas', () => {
  it('draws only what it holds that is still in the model', () => {
    const hood = viewHood(graph, {
      elementIds: ['hall', 'room', 'gone'],
      relationshipIds: ['c2', 'u2', 'missing'],
    });
    expect([...hood.hops.keys()]).toEqual(['hall', 'room']);
    // u2 needs the desk, which isn't in the view.
    expect(hood.relationships.map((r) => r.id)).toEqual(['c2']);
    expect(hood.focusId).toBe('');
  });

  it('nests only along a Contains the view holds', () => {
    const held = viewHood(graph, { elementIds: ['hall', 'room'], relationshipIds: ['c2'] });
    expect([...nestingParents(graph, held)]).toEqual([['room', 'hall']]);
    const without = viewHood(graph, { elementIds: ['hall', 'room'], relationshipIds: [] });
    expect(nestingParents(graph, without).size).toBe(0);
  });

  it('saves what a canvas draws, leaving out relationships without an id', () => {
    const hood = viewHood(graph, {
      elementIds: ['porter', 'room', 'desk'],
      relationshipIds: ['u1', 'u2'],
    });
    expect(canvasContents(hood, hasId)).toEqual({
      elementIds: ['porter', 'room', 'desk'],
      relationshipIds: ['u1', 'u2'],
    });
  });
});

describe('changing a view', () => {
  it('adds an element with its relationships to elements in the view, never its containers', () => {
    const added = withElementInView(
      graph,
      { elementIds: ['porter', 'room'], relationshipIds: [] },
      'desk',
      hasId,
    );
    expect(added).toEqual({
      contents: { elementIds: ['porter', 'room', 'desk'], relationshipIds: ['u1', 'u2'] },
      relationships: 2,
    });
    expect(
      withElementInView(graph, { elementIds: ['desk'], relationshipIds: [] }, 'desk', hasId),
    ).toBeUndefined();
  });

  it('adds a relationship only with both of its elements in the view', () => {
    const contents = { elementIds: ['porter', 'desk'], relationshipIds: [] };
    expect(
      withRelationshipInView(contents, { id: 'u1', source: 'porter', target: 'desk' }),
    ).toEqual({ elementIds: ['porter', 'desk'], relationshipIds: ['u1'] });
    expect(
      withRelationshipInView(contents, { id: 'u2', source: 'desk', target: 'room' }),
    ).toBeUndefined();
  });

  it('removes a card with its lines and, nested, the cards drawn inside it', () => {
    const contents = {
      elementIds: ['campus', 'hall', 'room', 'desk'],
      relationshipIds: ['c1', 'c2', 'u2'],
    };
    expect(withoutElementInView(graph, contents, 'hall', true)).toEqual({
      elementIds: ['campus', 'desk'],
      relationshipIds: [],
    });
    expect(withoutElementInView(graph, contents, 'hall', false)).toEqual({
      elementIds: ['campus', 'room', 'desk'],
      relationshipIds: ['u2'],
    });
  });

  it('removes one relationship, and what was deleted from the model', () => {
    const contents = { elementIds: ['porter', 'desk'], relationshipIds: ['u1'] };
    expect(withoutRelationshipInView(contents, 'u1')).toEqual({
      elementIds: ['porter', 'desk'],
      relationshipIds: [],
    });
    expect(withoutDeleted(contents, { elementIds: ['desk'], relationshipIds: ['u1'] })).toEqual({
      elementIds: ['porter'],
      relationshipIds: [],
    });
  });
});
