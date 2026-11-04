import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { JgfDocument } from '@simplearchitecture/shared';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { nextTrail, parseExplorerPath, trailLength } from '../src/viewing/ExplorerPage';
import { bakeryId, bakeryModel, bakerySummary } from './fixtures';
import {
  apiError,
  currentLocation,
  expectNoSeriousAxeViolations,
  renderAt,
  stubApi,
  viewer,
  type Handler,
} from './helpers';

const plannerId = 'oven/planner #1';
const base = `/viewing/models/${bakeryId}`;
const elementUrl = (id: string, depth = 1) =>
  `${base}/elements/${encodeURIComponent(id)}?depth=${depth}`;

function api(model: JgfDocument | (() => Response) = bakeryModel): Handler {
  return ({ url, method }) => {
    if (method !== 'GET') return undefined;
    if (url === '/api/models') return Response.json({ models: [bakerySummary] });
    if (url === `/api/models/${bakeryId}`) {
      return typeof model === 'function' ? model() : Response.json(model);
    }
    return undefined;
  };
}

function open(path: string, handler: Handler = api()) {
  const fetchMock = stubApi(viewer, handler);
  renderAt(path);
  return fetchMock;
}

const details = () => screen.getByRole('complementary', { name: 'Details' });
const tree = () => screen.getByRole('tree', { name: 'Elements by type' });
const canvas = () => screen.getByRole('region', { name: /^Diagram:/ });

async function cards() {
  await waitFor(() => {
    expect(canvas().querySelectorAll('.card').length).toBeGreaterThan(0);
  });
  // Each card's main button: it carries the card's accessible name and focuses the element.
  return [...canvas().querySelectorAll<HTMLElement>('.card-main')];
}

describe('explorer path', () => {
  it('reads the model and element ids, decoding any character', () => {
    expect(parseExplorerPath(`${base}/elements/${encodeURIComponent(plannerId)}`)).toEqual({
      space: 'viewing',
      modelId: bakeryId,
      elementId: plannerId,
    });
    expect(parseExplorerPath(base)).toEqual({
      space: 'viewing',
      modelId: bakeryId,
      elementId: undefined,
    });
    expect(parseExplorerPath(`/modelling/models/${bakeryId}`)?.space).toBe('modelling');
    expect(parseExplorerPath(`${base}/other`)).toBeUndefined();
  });
});

describe('breadcrumb trail', () => {
  it('adds new elements at the end and keeps the last 5', () => {
    expect(trailLength).toBe(5);
    expect(nextTrail([], 'a')).toEqual(['a']);
    expect(nextTrail(['a', 'b', 'c', 'd'], 'e')).toEqual(['a', 'b', 'c', 'd', 'e']);
    // A 6th element: the oldest drops off.
    expect(nextTrail(['a', 'b', 'c', 'd', 'e'], 'f')).toEqual(['b', 'c', 'd', 'e', 'f']);
  });

  it('cuts back to an element already in the trail (a crumb click or Back)', () => {
    expect(nextTrail(['a', 'b', 'c', 'd', 'e'], 'b')).toEqual(['a', 'b']);
    expect(nextTrail(['a', 'b', 'c'], 'c')).toEqual(['a', 'b', 'c']);
    // The last time it was visited counts.
    expect(nextTrail(['a', 'b', 'a', 'c'], 'a')).toEqual(['a', 'b', 'a']);
    // An element that dropped off is new again.
    expect(nextTrail(['b', 'c', 'd', 'e', 'f'], 'a')).toEqual(['c', 'd', 'e', 'f', 'a']);
  });
});

describe('deep link', () => {
  it('opens the element at the depth in the URL: tree, canvas and details agree', async () => {
    open(elementUrl(plannerId, 2));

    expect(await screen.findByRole('heading', { level: 2, name: 'Oven Planner' })).toBeTruthy();
    const depth = screen.getByRole('group', { name: 'Relationship depth' });
    expect(within(depth).getByRole('button', { name: '2' }).getAttribute('aria-pressed')).toBe(
      'true',
    );
    const selected = within(tree()).getByRole('treeitem', { selected: true });
    expect(selected.getAttribute('aria-label')).toBe('Oven Planner');
    // No relationship count next to an element, in the text or in its name.
    expect(selected.textContent).toBe('Oven Planner');
    expect(canvas().getAttribute('aria-label')).toBe(
      'Diagram: Oven Planner and its neighbours, depth 2',
    );

    // Depth 2 from the planner: everything but the lonely element.
    const shown = await cards();
    expect(shown).toHaveLength(6);
    const focused = shown.find((card) => card.getAttribute('aria-current') === 'true');
    // No function count on the card (it stays in the details panel).
    expect(focused?.getAttribute('aria-label')).toBe('Oven Planner, Application, Target');
    expect(focused?.closest('.card')?.textContent).not.toMatch(/function/);
    expect(within(details()).getByRole('heading', { name: /^Functions/ })).toBeTruthy();
    // The focused card is the canvas's one Tab stop.
    expect(shown.filter((card) => card.tabIndex === 0)).toEqual([focused]);
    // Every related element is on the canvas at depth 2: no relationship buttons at all.
    expect(canvas().querySelectorAll('.cpill')).toHaveLength(0);
  });

  it('uses the remembered depth when the URL has none', async () => {
    localStorage.setItem('sa-depth', '3');
    open(`${base}/elements/shop`);

    await screen.findByRole('heading', { level: 2, name: 'Web Shop' });
    expect(screen.getByRole('button', { name: '3' }).getAttribute('aria-pressed')).toBe('true');
  });

  it('says when the element is not in the model, with a way back', async () => {
    open(elementUrl('gone'));

    expect(
      await screen.findByRole('heading', { name: "This element isn't in this model." }),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('link', { name: 'Clear' }));
    expect(currentLocation()).toBe(base);
  });
});

describe('states', () => {
  it('suggests the most connected elements when nothing is focused', async () => {
    open(base);

    expect(
      await screen.findByRole('heading', { name: 'Choose an element to explore' }),
    ).toBeTruthy();
    expect(screen.queryByRole('complementary', { name: 'Details' })).toBeNull();
    const suggestions = screen.getAllByRole('button', {
      name: /^Web Shop|^Oven Planner|^Customer/,
    });
    expect(suggestions[0]?.textContent).toBe('Web Shop8');
    fireEvent.click(suggestions[0] as HTMLElement);
    expect(currentLocation()).toBe(elementUrl('shop'));
  });

  it('shows a loading state while the model loads', async () => {
    let answer: (response: Response) => void = () => undefined;
    const pending = new Promise<Response>((resolve) => {
      answer = resolve;
    });
    stubApi(viewer, ({ url }) =>
      url === '/api/models'
        ? Response.json({ models: [bakerySummary] })
        : url === `/api/models/${bakeryId}`
          ? pending
          : undefined,
    );
    renderAt(base);

    expect(
      (await screen.findByText(/^Loading Bakery landscape…|^Loading the model…/)).closest(
        '[role="status"]',
      ),
    ).toBeTruthy();
    expect(screen.getByRole('searchbox', { name: 'Search elements' })).toHaveProperty(
      'disabled',
      true,
    );
    await act(async () => {
      answer(Response.json(bakeryModel));
      await pending;
    });
    expect(
      await screen.findByRole('heading', { name: 'Choose an element to explore' }),
    ).toBeTruthy();
  });

  it.each([404, 400])('says the model does not exist on %i', async (status) => {
    open(
      base,
      api(() => apiError(status, 'Model not found')),
    );

    expect(await screen.findByRole('heading', { name: "This model doesn't exist." })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Go to models' }).getAttribute('href')).toBe(
      '/viewing',
    );
  });

  it('says the model could not be loaded on 500, with Try again', async () => {
    let fail = true;
    open(
      base,
      api(() =>
        fail ? apiError(500, 'The stored model is damaged.') : Response.json(bakeryModel),
      ),
    );

    expect(
      await screen.findByRole('heading', { name: "The model couldn't be loaded." }),
    ).toBeTruthy();
    expect(screen.getByText('The stored model is damaged.')).toBeTruthy();
    fail = false;
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(
      await screen.findByRole('heading', { name: 'Choose an element to explore' }),
    ).toBeTruthy();
  });

  it('opens an empty model in the normal explorer', async () => {
    open(base, api({ graph: { nodes: {}, edges: [] } }));

    expect(
      await screen.findByRole('heading', { name: 'This model has no elements yet' }),
    ).toBeTruthy();
    expect(screen.getByText('Elements added in Modelling show here.')).toBeTruthy();
    const list = screen.getByRole('complementary', { name: 'Elements' });
    expect(within(list).getByText('No elements yet.')).toBeTruthy();
    // Nothing to search, and no empty tree.
    expect(screen.queryByRole('searchbox', { name: 'Search elements' })).toBeNull();
    expect(screen.queryByRole('tree')).toBeNull();
    expect(screen.queryByRole('button', { name: /^Filter/ })).toBeNull();
    expect(document.querySelector('.suggestions')).toBeNull();
    expect(screen.queryByText('This model has no elements.')).toBeNull();
    expect(screen.queryByRole('link', { name: 'Go to models' })).toBeNull();
  });
});

describe('element tree', () => {
  it('groups elements by type in metamodel order with counts', async () => {
    open(base);

    await screen.findByRole('tree', { name: 'Elements by type' });
    const groups = within(tree())
      .getAllByRole('treeitem')
      .filter((item) => item.hasAttribute('aria-expanded'));
    expect(groups.map((group) => group.getAttribute('aria-label'))).toEqual([
      'Stakeholder, 1 element',
      'Business, 1 element',
      'Application, 3 elements',
      'Infrastructure, 1 element',
      'Other, 1 element',
    ]);
    expect(screen.getByText('7 elements')).toBeTruthy();
  });

  it('narrows live, marks the match, and clears on Esc', async () => {
    open(base);

    await screen.findByRole('tree');
    const search = screen.getByRole('searchbox', { name: 'Search elements' });
    fireEvent.change(search, { target: { value: 'OVEN' } });
    expect(screen.getByText('1 of 7 elements match')).toBeTruthy();
    const items = within(tree()).getAllByRole('treeitem');
    expect(items.map((item) => item.getAttribute('aria-label'))).toEqual([
      'Application, 1 element',
      'Oven Planner',
    ]);
    expect(tree().querySelector('mark')?.textContent).toBe('Oven');

    fireEvent.keyDown(search, { key: 'Escape' });
    expect((search as HTMLInputElement).value).toBe('');
  });

  it('says when nothing matches, with Clear search', async () => {
    open(base);

    await screen.findByRole('tree');
    const search = screen.getByRole('searchbox', { name: 'Search elements' });
    fireEvent.change(search, { target: { value: 'croissant' } });
    expect(screen.getByText(/No elements match “croissant”/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Clear search' }));
    expect(screen.getByRole('tree')).toBeTruthy();
  });

  it('focuses an element by double click and by keyboard', async () => {
    open(base);

    await screen.findByRole('tree');
    const application = within(tree()).getByRole('treeitem', { name: 'Application, 3 elements' });
    // Groups keep their open state per model for the session, so open it only if closed.
    if (application.getAttribute('aria-expanded') === 'false') {
      fireEvent.click(application.querySelector('.trow') as HTMLElement);
    }
    // A double click focuses (the second click has detail 2).
    fireEvent.click(within(tree()).getByText('Till'), { detail: 2 });
    expect(currentLocation()).toBe(elementUrl('till'));

    // Keyboard: the tree is one Tab stop; arrows move, Enter focuses.
    const current = within(tree()).getByRole('treeitem', { name: 'Till' });
    await waitFor(() => {
      expect(current.tabIndex).toBe(0);
    });
    current.focus();
    fireEvent.keyDown(current, { key: 'ArrowDown' });
    const next = within(tree()).getByRole('treeitem', { name: 'Web Shop' });
    expect(document.activeElement).toBe(next);
    fireEvent.keyDown(next, { key: 'Enter' });
    expect(currentLocation()).toBe(elementUrl('shop'));
    // Keyboard focus stays in the tree.
    expect(tree().contains(document.activeElement)).toBe(true);

    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'ArrowLeft' });
    expect(document.activeElement).toBe(application);
    fireEvent.keyDown(application, { key: 'ArrowLeft' });
    expect(application.getAttribute('aria-expanded')).toBe('false');
    fireEvent.keyDown(application, { key: '*' });
    expect(application.getAttribute('aria-expanded')).toBe('true');
  });

  it('moves to the search field on /', async () => {
    open(base);

    await screen.findByRole('tree');
    fireEvent.keyDown(document.body, { key: '/' });
    expect(document.activeElement).toBe(screen.getByRole('searchbox', { name: 'Search elements' }));
  });
});

describe('details panel', () => {
  it('shows description as text with only http(s) links', async () => {
    open(elementUrl('shop'));

    const panel = await screen.findByRole('complementary', { name: 'Details' });
    const description = within(panel).getByRole('region', { name: 'Description' });
    expect(description.textContent).toContain('<b>bold</b>');
    expect(description.querySelector('b')).toBeNull();
    const links = within(description).getAllByRole('link');
    expect(links).toHaveLength(1);
    expect(links[0]?.getAttribute('href')).toBe('https://wiki.example.com/shop');
    expect(links[0]?.getAttribute('rel')).toBe('noopener noreferrer');
    expect(links[0]?.getAttribute('target')).toBe('_blank');
  });

  it('lists standard properties in metamodel order, functions, and custom metadata', async () => {
    open(elementUrl('shop'));

    const panel = await screen.findByRole('complementary', { name: 'Details' });
    const terms = [...panel.querySelectorAll('section:not(:has(details)) .props dt')].map(
      (dt) => dt.textContent,
    );
    expect(terms).toEqual(['Architecture state', 'Owning team', 'Supplier HQ country', 'Sourcing']);
    expect(panel.textContent).toContain('NL · Netherlands');
    expect(within(panel).getByRole('heading', { level: 3, name: /^Functions/ }).textContent).toBe(
      'Functions 2',
    );
    expect(within(panel).getByText('Order capture')).toBeTruthy();

    const custom = panel.querySelector('details.meta');
    expect(custom?.hasAttribute('open')).toBe(false);
    expect(custom?.querySelector('summary')?.textContent).toBe('Custom metadata 2');
    expect([...(custom?.querySelectorAll('dt') ?? [])].map((dt) => dt.textContent)).toEqual([
      'archimateType',
      'hostingModel',
    ]);
    expect(panel.querySelector('.d-foot code')?.textContent).toBe('shop');
  });

  it('flags a country that is not an ISO code', async () => {
    open(elementUrl(plannerId));

    const panel = await screen.findByRole('complementary', { name: 'Details' });
    expect(within(panel).getByTitle('Not an ISO 3166-1 alpha-2 code').textContent).toContain(
      'Holland',
    );
    expect(within(panel).getAllByText('Not set')).toHaveLength(2);
  });

  it('lists relationships in words, and following one focuses that element', async () => {
    open(elementUrl('shop'));

    const panel = await screen.findByRole('complementary', { name: 'Details' });
    const headings = within(panel)
      .getAllByRole('heading', { level: 4 })
      .map((h) => h.textContent);
    expect(headings).toEqual([
      'Sends information to 4',
      'Receives information from 2',
      'Relates to 2',
    ]);
    expect(
      within(panel).getByRole('button', {
        name: 'Receives information from Customer, Stakeholder, "Places orders"',
      }),
    ).toBeTruthy();
    fireEvent.click(
      within(panel).getByRole('button', { name: 'Receives information from Till, Application' }),
    );
    expect(currentLocation()).toBe(elementUrl('till'));
    expect(await screen.findByRole('heading', { level: 2, name: 'Till' })).toBeTruthy();
  });

  it('says when an element stands alone, and hides sections its type does not have', async () => {
    open(elementUrl('lonely'));

    const panel = await screen.findByRole('complementary', { name: 'Details' });
    expect(within(panel).getByText('No relationships. This element stands alone.')).toBeTruthy();
    expect(within(panel).queryByRole('heading', { name: 'Properties' })).toBeNull();
    expect(within(panel).queryByRole('heading', { name: /^Functions/ })).toBeNull();
    expect(within(panel).getByText('No description.')).toBeTruthy();
  });
});

describe('navigation', () => {
  it('pushes each focus change, keeps a trail, and Back returns', async () => {
    open(elementUrl('customer'));

    await screen.findByRole('heading', { level: 2, name: 'Customer' });
    const back = screen.getByRole('button', { name: 'Back' });
    expect(back).toHaveProperty('disabled', true);

    fireEvent.click(screen.getByRole('button', { name: /^Sends information to Web Shop/ }));
    await screen.findByRole('heading', { level: 2, name: 'Web Shop' });
    const trail = screen.getByRole('navigation', { name: 'Visited elements' });
    expect(within(trail).getByRole('link', { name: 'Customer' })).toBeTruthy();
    expect(within(trail).getByText('Web Shop').getAttribute('aria-current')).toBe('page');

    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(await screen.findByRole('heading', { level: 2, name: 'Customer' })).toBeTruthy();
    expect(currentLocation()).toBe(elementUrl('customer'));
  });

  it('keeps the last 5 elements in the trail, with no "…", and a crumb cuts it back', async () => {
    open(elementUrl('customer'));

    await screen.findByRole('heading', { level: 2, name: 'Customer' });
    // Open every type group in the tree, so each element can be clicked.
    for (const group of within(tree()).queryAllByRole('treeitem', { expanded: false })) {
      fireEvent.click(group.querySelector('.trow') as HTMLElement);
    }
    const crumbs = () =>
      within(screen.getByRole('navigation', { name: 'Visited elements' }))
        .getAllByRole('listitem')
        .map((item) => item.textContent);
    const visit = async (name: string) => {
      fireEvent.click(within(tree()).getByText(name), { detail: 2 });
      await screen.findByRole('heading', { level: 2, name });
    };

    for (const name of ['Order to bake', 'Web Shop', 'Oven Planner', 'Till']) await visit(name);
    expect(crumbs()).toEqual(['Customer', 'Order to bake', 'Web Shop', 'Oven Planner', 'Till']);
    // A 6th: the oldest drops off.
    await visit('Back Office Server');
    expect(crumbs()).toEqual([
      'Order to bake',
      'Web Shop',
      'Oven Planner',
      'Till',
      'Back Office Server',
    ]);
    expect(screen.queryByText('…')).toBeNull();
    await visit('Recipe Archive');
    expect(crumbs()).toEqual([
      'Web Shop',
      'Oven Planner',
      'Till',
      'Back Office Server',
      'Recipe Archive',
    ]);
    const trail = screen.getByRole('navigation', { name: 'Visited elements' });
    expect(within(trail).getAllByRole('link')).toHaveLength(4);
    expect(within(trail).getByText('Recipe Archive').getAttribute('aria-current')).toBe('page');

    // A crumb cuts the trail back to its element.
    fireEvent.click(within(trail).getByRole('link', { name: 'Oven Planner' }));
    await screen.findByRole('heading', { level: 2, name: 'Oven Planner' });
    expect(currentLocation()).toBe(elementUrl(plannerId));
    expect(crumbs()).toEqual(['Web Shop', 'Oven Planner']);

    // Back still goes to the previous address.
    const back = screen.getByRole('button', { name: 'Back' });
    expect(back).toHaveProperty('disabled', false);
    fireEvent.click(back);
    await screen.findByRole('heading', { level: 2, name: 'Recipe Archive' });
    expect(currentLocation()).toBe(elementUrl('lonely'));
  });

  it('changes depth in place and remembers it', async () => {
    open(elementUrl('customer'));

    await cards();
    expect(canvas().querySelectorAll('.card')).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: '2' }));
    expect(currentLocation()).toBe(elementUrl('customer', 2));
    expect(localStorage.getItem('sa-depth')).toBe('2');
    await waitFor(() => {
      expect(canvas().querySelectorAll('.card')).toHaveLength(6);
    });
  });

  it('caps nothing on a small model and shows the lone element note', async () => {
    open(elementUrl('lonely'));

    await cards();
    expect(
      screen.getByText('No relationships. This element stands alone.', {
        selector: '.canvas-notice',
      }),
    ).toBeTruthy();
    expect(screen.queryByText(/^Showing/)).toBeNull();
  });
});

describe('canvas', () => {
  it('draws light cards: name, Stakeholder icon, colour from the metamodel, no type label', async () => {
    open(elementUrl('shop'));

    const shown = await cards();
    const labels = shown.map((card) => card.getAttribute('aria-label'));
    // The type is in the accessible name even though the card doesn't print it.
    expect(labels).toContain('Customer, Stakeholder');
    expect(labels).toContain('Till, Application, Deprecate');
    const cardOf = (name: string) =>
      shown.find((card) => card.getAttribute('aria-label')?.startsWith(name))?.closest('.card');
    const customer = cardOf('Customer');
    expect(customer?.className).toContain('colour-yellow');
    // A Stakeholder is a circle with the user icon, and the name underneath; circle and name are
    // one button.
    expect(customer?.classList.contains('is-circle')).toBe(true);
    const main = customer?.querySelector('.card-main');
    expect(main?.querySelector('.ccircle svg')).toBeTruthy();
    expect(main?.querySelector('.ccircle + .cname')?.textContent).toBe('Customer');
    expect(main?.getAttribute('title')).toBeNull();
    // Its handles sit on the circle's edge (centre 60,24, radius 24), never on the label.
    const handles = [...(customer?.querySelectorAll<HTMLElement>('.react-flow__handle') ?? [])];
    expect(handles.length).toBeGreaterThan(0);
    for (const handle of handles) {
      const x = parseFloat(handle.style.left);
      const y = parseFloat(handle.style.top);
      expect(Math.hypot(x - 60, y - 24)).toBeCloseTo(24);
    }
    expect(customer?.textContent).not.toContain('Stakeholder');
    const ordering = cardOf('Order to bake');
    expect(ordering?.className).toContain('colour-yellow');
    expect(ordering?.classList.contains('is-circle')).toBe(false);
    expect(ordering?.querySelector('.ccircle')).toBeNull();
    expect(ordering?.textContent).not.toContain('Business');
  });

  it('cuts a long Stakeholder name after 3 lines, with the full name in the title', async () => {
    const long = 'Regional field engineers for installation and maintenance partners in the north';
    open(
      elementUrl('people'),
      api({
        graph: {
          nodes: {
            people: { label: long, metadata: { type: 'Stakeholder' } },
            app: { label: 'App', metadata: { type: 'Application', architectureState: 'Target' } },
          },
          edges: [{ source: 'people', target: 'app', relation: 'Relation' }],
        },
      }),
    );

    const shown = await cards();
    const people = shown.find((card) => card.getAttribute('aria-label')?.startsWith(long));
    expect(people?.getAttribute('aria-label')).toBe(`${long}, Stakeholder`);
    expect(people?.getAttribute('title')).toBe(long);
    expect(people?.querySelector('.cname')?.textContent).toBe(long);
    // The rectangle's state badge sits on its top border (cbadge); a circle never has one.
    const app = shown.find((card) => card.getAttribute('aria-label')?.startsWith('App'));
    expect(app?.closest('.card')?.querySelector('.badge.cbadge')?.textContent).toBe('Target');
    expect(people?.closest('.card')?.querySelector('.badge')).toBeNull();
  });

  it('shows a state badge only for states other than Current', async () => {
    open(elementUrl('shop'));

    const shown = await cards();
    const cardOf = (name: string) =>
      shown.find((card) => card.getAttribute('aria-label')?.startsWith(name))?.closest('.card');
    expect(cardOf('Till')?.querySelector('.badge')?.textContent).toBe('Deprecate');
    expect(cardOf('Oven Planner')?.querySelector('.badge')?.textContent).toBe('Target');
    // Web Shop and the server are Current: no badge on the card, but the details panel says it.
    expect(cardOf('Web Shop')?.querySelector('.badge')).toBeNull();
    expect(cardOf('Back Office Server')?.querySelector('.badge')).toBeNull();
    expect(within(details()).getAllByText('Current').length).toBeGreaterThan(0);
  });

  it('draws one edge per relationship type and direction, with words for assistive tech', async () => {
    open(elementUrl('shop'));

    await cards();
    await waitFor(() => {
      expect(canvas().querySelectorAll('.react-flow__edge').length).toBeGreaterThan(0);
    });
    const edges = [...canvas().querySelectorAll('.react-flow__edge')].map((edge) =>
      edge.getAttribute('aria-label'),
    );
    // e3 and e8 are parallel and merged into one edge; a flow and a plain Relation stay apart.
    expect(edges).toHaveLength(8);
    expect(edges).toContain('Web Shop sends information to Oven Planner');
    expect(edges).toContain('Web Shop relates to Oven Planner');
  });

  it('lights the hovered card’s relationships and dims the rest', async () => {
    open(elementUrl('shop'));

    const shown = await cards();
    const till = shown.find((card) => card.getAttribute('aria-label')?.startsWith('Till'));
    fireEvent.mouseEnter(till?.closest('.react-flow__node') as HTMLElement);
    await waitFor(() => {
      expect(canvas().querySelectorAll('.react-flow__node.is-dim').length).toBe(4);
    });
    expect(canvas().querySelectorAll('.react-flow__node.is-lit')).toHaveLength(2);
    expect(canvas().querySelectorAll('.react-flow__edge.is-lit')).toHaveLength(1);
    // Where its type goes is tested in labels.test.ts: jsdom has no layout to place it in.
    fireEvent.mouseLeave(till?.closest('.react-flow__node') as HTMLElement);
    await waitFor(() => {
      expect(canvas().querySelectorAll('.is-dim')).toHaveLength(0);
    });
  });

  it('moves between cards with arrow keys and focuses one with its button', async () => {
    open(elementUrl('shop'));

    const shown = await cards();
    const focused = shown.find((card) => card.tabIndex === 0) as HTMLElement;
    focused.focus();
    fireEvent.keyDown(focused, { key: 'ArrowUp' });
    const moved = document.activeElement as HTMLElement;
    expect(moved).not.toBe(focused);
    expect(moved.classList.contains('card-main')).toBe(true);
    expect(moved.tabIndex).toBe(0);
    // The arrows move the selection; Enter focuses.
    expect(moved.closest('.card')?.classList.contains('is-selected')).toBe(true);
    expect(currentLocation()).toBe(elementUrl('shop'));
    fireEvent.keyDown(moved, { key: 'Enter' });
    expect(currentLocation()).not.toBe(elementUrl('shop'));
    expect(currentLocation()).toMatch(/\/elements\//);
  });

  it('sets depth with the number keys', async () => {
    open(elementUrl('shop'));

    await cards();
    fireEvent.keyDown(canvas(), { key: '3' });
    expect(currentLocation()).toBe(elementUrl('shop', 3));
  });
});

describe('related elements popup', () => {
  async function cardOf(name: string) {
    const shown = await cards();
    const card = shown
      .find((c) => c.getAttribute('aria-label')?.startsWith(name))
      ?.closest('.card');
    expect(card).toBeTruthy();
    return card as HTMLElement;
  }

  async function countButton(name: string, missing: number) {
    return within(await cardOf(name)).getByRole('button', {
      name:
        missing === 1
          ? '1 related element not on the canvas, show it'
          : `${missing} related elements not on the canvas, show them`,
    });
  }

  /** The count on each card that has a relationship button, by card name. */
  function counts(): Record<string, string> {
    return Object.fromEntries(
      [...canvas().querySelectorAll<HTMLElement>('.card')].flatMap((card) => {
        const button = card.querySelector('.cpill');
        const name = card.querySelector('.cname')?.textContent ?? '';
        return button ? [[name, button.textContent]] : [];
      }),
    );
  }

  it('counts related elements not on the canvas, each once, and has no button when none are missing', async () => {
    open(elementUrl('customer'));

    await cards();
    // Web Shop relates to five elements; the customer is on the canvas. The planner has three
    // relationships with the shop (two types) and counts once.
    await waitFor(() => {
      expect(counts()).toEqual({ 'Web Shop': '4' });
    });
    const button = await countButton('Web Shop', 4);
    expect(button.getAttribute('title')).toBe('4 related elements not on the canvas');
    expect(button.getAttribute('aria-haspopup')).toBe('menu');
    expect(button.getAttribute('aria-expanded')).toBe('false');
    // Only the focused card is a Tab stop.
    expect(button.tabIndex).toBe(-1);
    // The customer's only related element is on the canvas: no button.
    expect(within(await cardOf('Customer')).queryByRole('button', { name: /canvas/ })).toBeNull();
  });

  it('lists only the elements not on the canvas, by relationship, and closes on Esc', async () => {
    open(elementUrl('customer'));

    const button = await countButton('Web Shop', 4);
    fireEvent.click(button);
    expect(button.getAttribute('aria-expanded')).toBe('true');
    const menu = screen.getByRole('menu', { name: 'Not on the canvas: related to Web Shop' });
    const groups = within(menu).getAllByRole('group');
    // "Receives information from" (the customer) is left out: the customer is on the canvas.
    expect(
      groups.map((group) => [
        group.getAttribute('aria-label'),
        within(group)
          .getAllByRole('menuitem')
          .map((i) => i.getAttribute('aria-label')),
      ]),
    ).toEqual([
      [
        'Sends information to',
        [
          'Back Office Server, Infrastructure, add to canvas',
          'Order to bake, Business, add to canvas',
          'Oven Planner, Application, add to canvas',
        ],
      ],
      ['Receives information from', ['Till, Application, add to canvas']],
      [
        'Relates to',
        [
          'Back Office Server, Infrastructure, add to canvas',
          'Oven Planner, Application, add to canvas',
        ],
      ],
    ]);
    expect(within(menu).queryByText('on canvas')).toBeNull();
    // Focus starts on the first item; arrows and End move; Esc closes and returns focus.
    const items = within(menu).getAllByRole('menuitem');
    expect(document.activeElement).toBe(items[0]);
    fireEvent.keyDown(items[0] as HTMLElement, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(items[1]);
    fireEvent.keyDown(items[1] as HTMLElement, { key: 'End' });
    expect(document.activeElement).toBe(items[items.length - 1]);
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(button);
    expect(button.getAttribute('aria-expanded')).toBe('false');
    // The count button doesn't focus its element.
    expect(currentLocation()).toBe(elementUrl('customer'));
  });

  it('adds an element to the canvas without changing the focus, and keeps it on a depth change', async () => {
    open(elementUrl('customer'));

    await cards();
    expect(canvas().querySelectorAll('.card')).toHaveLength(2);
    fireEvent.click(await countButton('Web Shop', 4));
    // Oven Planner is in two groups (information flow and integration); either adds it.
    fireEvent.click(
      screen.getAllByRole('menuitem', {
        name: 'Oven Planner, Application, add to canvas',
      })[0] as HTMLElement,
    );

    await waitFor(() => {
      expect(canvas().querySelectorAll('.card')).toHaveLength(3);
    });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(currentLocation()).toBe(elementUrl('customer'));
    expect(screen.getByRole('heading', { level: 2, name: 'Customer' })).toBeTruthy();
    // Connected to the card it came from.
    await waitFor(() => {
      const edges = [...canvas().querySelectorAll('.react-flow__edge')].map((e) =>
        e.getAttribute('aria-label'),
      );
      expect(edges).toContain('Web Shop sends information to Oven Planner');
    });
    // One fewer missing on the shop; the planner misses the server. Focus goes back to the count
    // button it was added from.
    await waitFor(() => {
      expect(counts()).toEqual({ 'Web Shop': '3', 'Oven Planner': '1' });
    });
    await waitFor(() => {
      expect(document.activeElement?.getAttribute('aria-label')).toBe(
        '3 related elements not on the canvas, show them',
      );
    });

    // The added element isn't listed any more.
    fireEvent.click(await countButton('Web Shop', 3));
    expect(screen.queryByRole('menuitem', { name: /^Oven Planner/ })).toBeNull();
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole('menu')).toBeNull();

    // A depth change keeps added elements, and the counts follow the canvas.
    fireEvent.click(screen.getByRole('button', { name: '2' }));
    await waitFor(() => {
      expect(canvas().querySelectorAll('.card')).toHaveLength(6);
    });
    await waitFor(() => {
      expect(counts()).toEqual({});
    });
    fireEvent.click(screen.getByRole('button', { name: '1' }));
    await waitFor(() => {
      expect(canvas().querySelectorAll('.card')).toHaveLength(3);
    });
    await waitFor(() => {
      expect(counts()).toEqual({ 'Web Shop': '3', 'Oven Planner': '1' });
    });
  });

  it('removes the button when the last missing element is added, and focuses the card', async () => {
    const edges = (bakeryModel.graph.edges ?? []).filter((e) =>
      ['e1', 'e2', 'e3'].includes(e.id ?? ''),
    );
    open(elementUrl('customer'), api({ graph: { ...bakeryModel.graph, edges } }));

    fireEvent.click(await countButton('Web Shop', 2));
    fireEvent.click(
      screen.getByRole('menuitem', { name: 'Order to bake, Business, add to canvas' }),
    );
    await waitFor(() => {
      expect(document.activeElement?.getAttribute('aria-label')).toBe(
        '1 related element not on the canvas, show it',
      );
    });

    fireEvent.click(await countButton('Web Shop', 1));
    fireEvent.click(
      screen.getByRole('menuitem', { name: 'Oven Planner, Application, add to canvas' }),
    );
    await waitFor(() => {
      expect(canvas().querySelectorAll('.card')).toHaveLength(4);
    });
    await waitFor(() => {
      expect(counts()).toEqual({});
    });
    // The count button is gone: keyboard focus is on the card's main button, not on <body>.
    await waitFor(() => {
      expect(document.activeElement?.getAttribute('aria-label')).toBe(
        'Web Shop, Application, Current',
      );
    });
    expect(document.activeElement?.classList.contains('card-main')).toBe(true);
  });

  it('keeps keyboard focus on the card when a depth change removes its focused count button', async () => {
    open(elementUrl('customer'));

    const button = await countButton('Web Shop', 4);
    act(() => {
      button.focus();
    });
    fireEvent.keyDown(button, { key: '2' });
    await waitFor(() => {
      expect(canvas().querySelectorAll('.card')).toHaveLength(6);
    });
    await waitFor(() => {
      expect(document.activeElement?.getAttribute('aria-label')).toBe(
        'Web Shop, Application, Current',
      );
    });
  });

  it('has no buttons after the focus moves to an element whose neighbours are all shown', async () => {
    open(elementUrl('customer'));

    await countButton('Web Shop', 4);
    fireEvent.click(screen.getByRole('button', { name: 'Web Shop, Application, Current' }), {
      detail: 2,
    });
    await screen.findByRole('heading', { level: 2, name: 'Web Shop' });
    await waitFor(() => {
      expect(canvas().querySelectorAll('.card')).toHaveLength(6);
    });
    await waitFor(() => {
      expect(counts()).toEqual({});
    });
  });

  it('refuses to add when the canvas is full', async () => {
    const nodes: Record<string, { label: string; metadata: { type: string } }> = {
      hub: { label: 'Hub', metadata: { type: 'Application' } },
      extra: { label: 'Extra', metadata: { type: 'Other' } },
    };
    const edges = [];
    for (let i = 0; i < 160; i++) {
      nodes[`n${i}`] = { label: `Leaf ${i}`, metadata: { type: 'Other' } };
      edges.push({ source: 'hub', target: `n${i}`, relation: 'Relation' });
    }
    edges.push({ source: 'n0', target: 'extra', relation: 'Relation' });
    open(elementUrl('n0'), api({ graph: { nodes, edges } }));

    await screen.findByRole('heading', { level: 2, name: 'Leaf 0' });
    fireEvent.click(screen.getByRole('button', { name: '2' }));
    await waitFor(() => {
      expect(canvas().querySelectorAll('.card')).toHaveLength(150);
    });
    // Leaf 0's hub and extra are both on the canvas: no button.
    expect(within(await cardOf('Leaf 0')).queryByRole('button', { name: /canvas/ })).toBeNull();
    // 147 of the hub's 159 other leaves fit.
    fireEvent.click(await countButton('Hub', 12));
    expect(screen.getByText(/The canvas is full \(150 elements\)/)).toBeTruthy();
    const items = screen.getAllByRole('menuitem');
    expect(items).toHaveLength(12);
    expect(items.every((item) => item.getAttribute('aria-disabled') === 'true')).toBe(true);
    fireEvent.click(items[0] as HTMLElement);
    expect(canvas().querySelectorAll('.card')).toHaveLength(150);
  });

  it('has no serious axe issues with the popup open', async () => {
    open(elementUrl('customer'));

    fireEvent.click(await countButton('Web Shop', 4));
    await expectNoSeriousAxeViolations();
  });
});

describe('panels', () => {
  it('hides and shows the element list and the details, and remembers it', async () => {
    open(elementUrl('shop'));

    await screen.findByRole('complementary', { name: 'Details' });
    fireEvent.click(screen.getByRole('button', { name: 'Hide the details' }));
    expect(screen.queryByRole('complementary', { name: 'Details' })).toBeNull();
    expect(localStorage.getItem('sa-details-open')).toBe('false');
    fireEvent.click(screen.getByRole('button', { name: 'Hide the element list' }));
    expect(screen.queryByRole('complementary', { name: 'Elements' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Show the element list' }));
    expect(screen.getByRole('complementary', { name: 'Elements' })).toBeTruthy();
  });

  it('resizes the element list with the keyboard', async () => {
    open(elementUrl('shop'));

    const handle = await screen.findByRole('separator', { name: 'Resize the element list' });
    expect(handle.getAttribute('aria-valuenow')).toBe('280');
    fireEvent.keyDown(handle, { key: 'ArrowRight' });
    expect(handle.getAttribute('aria-valuenow')).toBe('296');
    expect(localStorage.getItem('sa-tree-width')).toBe('296');
    fireEvent.keyDown(handle, { key: 'Enter' });
    expect(handle.getAttribute('aria-valuenow')).toBe('280');
  });
});

describe('accessibility', () => {
  it('has no serious axe issues with a Stakeholder circle in move mode', async () => {
    open(elementUrl('customer'));

    const shown = await cards();
    const customer = shown.find((card) => card.getAttribute('aria-label')?.startsWith('Customer'));
    act(() => {
      customer?.focus();
    });
    fireEvent.keyDown(customer as HTMLElement, { key: 'm' });
    expect(customer?.closest('.card')?.classList.contains('is-moving')).toBe(true);
    await expectNoSeriousAxeViolations();
    fireEvent.keyDown(customer as HTMLElement, { key: 'Escape' });
  });

  it('has no serious axe issues on the explorer with an element focused', async () => {
    open(elementUrl('shop'));

    await cards();
    await expectNoSeriousAxeViolations();
  });

  it('has no serious axe issues with nothing focused, in dark theme', async () => {
    document.documentElement.setAttribute('data-theme', 'dark');
    open(base);

    await screen.findByRole('heading', { name: 'Choose an element to explore' });
    await expectNoSeriousAxeViolations();
  });
});

describe('Contains: nesting on the canvas', () => {
  // Made up: the server contains the till; a site (2 steps from the shop) contains the customer.
  const withContains: JgfDocument = structuredClone(bakeryModel);
  Object.assign(withContains.graph.nodes ?? {}, {
    site: { label: 'Bakery Site', metadata: { type: 'Other' } },
  });
  withContains.graph.edges?.push(
    { id: 'c1', source: 'server', target: 'till', relation: 'Contains' },
    { id: 'c2', source: 'site', target: 'customer', relation: 'Contains' },
  );

  const cardOf = (name: string) =>
    [...canvas().querySelectorAll<HTMLElement>('.card')].find((card) =>
      card.querySelector('.card-main')?.getAttribute('aria-label')?.startsWith(name),
    );
  const edgeLabels = () =>
    [...canvas().querySelectorAll('.react-flow__edge')].map((edge) =>
      edge.getAttribute('aria-label'),
    );
  const nestSwitch = () => screen.getByRole('switch', { name: 'Nest contained elements' });
  /** A card's node box on the canvas, from React Flow's transform and size. */
  const box = (name: string) => {
    const node = cardOf(name)?.closest<HTMLElement>('.react-flow__node');
    const [x = 0, y = 0] = (
      /translate\(([-\d.]+)px, ?([-\d.]+)px\)/.exec(node?.style.transform ?? '') ?? []
    )
      .slice(1)
      .map(Number);
    return {
      x,
      y,
      width: parseFloat(node?.style.width ?? '0'),
      height: parseFloat(node?.style.height ?? '0'),
    };
  };

  it('draws the container as a box with its element inside, and no Contains line', async () => {
    open(elementUrl('server'), api(withContains));

    await cards();
    await waitFor(() => {
      expect(cardOf('Back Office Server')?.classList.contains('is-container')).toBe(true);
    });
    const server = cardOf('Back Office Server');
    expect(server?.querySelector('.chead .cname')?.textContent).toBe('Back Office Server');
    // The till is drawn inside the server's box, under its 40px header.
    const [outer, inner] = [box('Back Office Server'), box('Till')];
    expect(inner.x).toBeGreaterThanOrEqual(outer.x + 16);
    expect(inner.y).toBeGreaterThanOrEqual(outer.y + 56);
    expect(inner.x + inner.width).toBeLessThanOrEqual(outer.x + outer.width - 16);
    expect(inner.y + inner.height).toBeLessThanOrEqual(outer.y + outer.height - 16);
    expect(edgeLabels()).not.toContain('Back Office Server contains Till');
    // Other relationships still draw.
    expect(edgeLabels()).toContain('Oven Planner sends information to Back Office Server');
    // Legend: the switch is on.
    expect((nestSwitch() as HTMLInputElement).checked).toBe(true);
    // Details panel groups.
    const headings = within(details())
      .getAllByRole('heading', { level: 4 })
      .map((h) => h.textContent);
    expect(headings).toContain('Contains 1');
    await expectNoSeriousAxeViolations(document.body);
  });

  it('puts a container’s name at the top, centred in its header; ordinary cards keep theirs in the middle', async () => {
    open(elementUrl('server'), api(withContains));

    await cards();
    await waitFor(() => {
      expect(cardOf('Back Office Server')?.classList.contains('is-container')).toBe(true);
    });
    const main = cardOf('Back Office Server')?.querySelector('.card-main');
    // The header comes first in the box (above the contained elements): the type mark, then the name.
    expect(main?.firstElementChild?.classList.contains('chead')).toBe(true);
    expect(main?.querySelector('.chead .cname')?.textContent).toBe('Back Office Server');
    // A short name isn't cut, so it has no tooltip. An ordinary card has no header.
    expect(main?.getAttribute('title')).toBeNull();
    expect(cardOf('Till')?.querySelector('.chead')).toBeNull();
    expect(cardOf('Till')?.querySelector('.card-main > .cname')?.textContent).toBe('Till');

    // jsdom has no layout, so check the rules. A button centres its content vertically, which
    // put the header in the middle of the box, under the contained elements.
    const css = readFileSync(join(import.meta.dirname, '../src/styles/explorer.css'), 'utf8');
    const rule = (selector: string) => {
      const start = css.indexOf(`\n${selector} {`);
      expect(start, selector).toBeGreaterThan(-1);
      return css.slice(start, css.indexOf('}', start));
    };
    expect(rule('.card.is-container .card-main')).toMatch(
      /display: flex;\s+flex-direction: column;\s+align-items: stretch;\s+justify-content: flex-start;/,
    );
    expect(rule('.chead')).toMatch(/flex: none;[\s\S]*justify-content: center;/);
    expect(rule('.chead .cname')).toMatch(
      /flex: 0 1 auto;\s+overflow: hidden;[\s\S]*text-align: center;\s+text-overflow: ellipsis;[\s\S]*white-space: nowrap;/,
    );
    // Ordinary cards (and circles): the name stays centred both ways.
    expect(rule('.card')).toMatch(
      /display: flex;\s+align-items: center;\s+justify-content: center;/,
    );
  });

  it('cuts a long Stakeholder container name with an ellipsis, with the full name as its tooltip', async () => {
    const longName = 'Customers of every bakery branch, including the weekend market stalls';
    const model: JgfDocument = structuredClone(bakeryModel);
    Object.assign(model.graph.nodes?.customer ?? {}, { label: longName });
    model.graph.edges?.push({
      id: 'c3',
      source: 'customer',
      target: 'lonely',
      relation: 'Contains',
    });
    open(elementUrl('customer'), api(model));

    await cards();
    await waitFor(() => {
      expect(cardOf(longName)?.classList.contains('is-container')).toBe(true);
    });
    const main = cardOf(longName)?.querySelector('.card-main');
    expect(main?.querySelector('.chead .uicon')).not.toBeNull();
    expect(main?.querySelector('.chead .cname')?.textContent).toBe(longName);
    expect(main?.getAttribute('title')).toBe(longName);
    expect(main?.getAttribute('aria-label')).toContain(longName);
  });

  it('brings a nested element’s container onto the canvas; a Stakeholder label sits on its colour', async () => {
    // The site is 2 steps from the shop: at depth 1 it is only there as the customer's container.
    open(elementUrl('shop'), api(withContains));

    await cards();
    await waitFor(() => {
      expect(cardOf('Bakery Site')?.classList.contains('is-container')).toBe(true);
    });
    const customer = cardOf('Customer');
    expect(customer?.classList.contains('is-circle')).toBe(true);
    expect(customer?.classList.contains('is-nested')).toBe(true);
    expect(customer?.style.getPropertyValue('--container-fill')).toBe('var(--gray-fill)');
  });

  it('draws Contains as lines with a diamond when the switch is off, and remembers it', async () => {
    open(elementUrl('server'), api(withContains));

    await cards();
    await waitFor(() => {
      expect(cardOf('Back Office Server')?.classList.contains('is-container')).toBe(true);
    });
    nestSwitch().focus();
    fireEvent.click(nestSwitch());
    await waitFor(() => {
      expect(edgeLabels()).toContain('Back Office Server contains Till');
    });
    expect(cardOf('Back Office Server')?.classList.contains('is-container')).toBe(false);
    expect(localStorage.getItem('sa-nest-contained')).toBe('false');
    expect(document.activeElement).toBe(nestSwitch());
    const line = [...canvas().querySelectorAll('.react-flow__edge')].find(
      (edge) => edge.getAttribute('aria-label') === 'Back Office Server contains Till',
    );
    const path = line?.querySelector('.react-flow__edge-path');
    expect(path?.getAttribute('marker-start')).toBe('url(#sa-diamond)');
    expect(path?.getAttribute('marker-end')).toBeNull();
  });

  it('moves a nested card with M and arrows only within its container', async () => {
    open(elementUrl('server'), api(withContains));

    await cards();
    await waitFor(() => {
      expect(cardOf('Back Office Server')?.classList.contains('is-container')).toBe(true);
    });
    const outer = box('Back Office Server');
    const till = cardOf('Till')?.querySelector<HTMLElement>('.card-main');
    if (!till) throw new Error('no till');
    till.focus();
    fireEvent.keyDown(till, { key: 'm' });
    for (let i = 0; i < 20; i++) fireEvent.keyDown(till, { key: 'ArrowUp', shiftKey: true });
    fireEvent.keyDown(till, { key: 'Enter' });
    await waitFor(() => {
      expect(box('Till').y).toBe(outer.y + 56);
    });
    expect(box('Back Office Server')).toEqual(outer);
  });

  it('nests, with the switch always available', async () => {
    open(elementUrl('server'), api(withContains));

    await cards();
    await waitFor(() => {
      expect(cardOf('Back Office Server')?.classList.contains('is-container')).toBe(true);
    });
    expect((nestSwitch() as HTMLInputElement).disabled).toBe(false);
  });
});
