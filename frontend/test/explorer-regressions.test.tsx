import type { JgfDocument, ModelSummary } from '@simplearchitecture/shared';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { bakeryId, bakeryModel, bakerySummary } from './fixtures';
import {
  admin,
  apiError,
  currentLocation,
  renderAt,
  stubApi,
  viewer,
  type Handler,
} from './helpers';

/**
 * Gaps found while checking the explorer and the Models page, and problems found in a real browser
 * (headless Chromium), reproduced here where jsdom allows. Made-up data only.
 */

const craftedId = '44444444-4444-4444-8444-444444444444';
const quoteModelId = '55555555-5555-4555-8555-555555555555';
const img = (where: string) => `<img src=x onerror="window.__xss='${where}'">`;

/** Model content that would run script if it were ever rendered as HTML. */
const crafted: JgfDocument = {
  graph: {
    id: craftedId,
    label: `${img('model')}<script>window.__xss='model'</script>Crafted`,
    directed: true,
    nodes: {
      evil: {
        label: `${img('name')}<b>Bold</b> & <i>co</i>`,
        metadata: {
          type: 'Application',
          architectureState: 'Target',
          description: [
            "<script>window.__xss='desc'</script>",
            'javascript:window.__xss="js" and JAVASCRIPT:alert(1)',
            '[click](javascript:alert(2)) data:text/html,<script>alert(3)</script>',
            'Docs: https://docs.example.com/page?a=1&b=<b>2</b>. Next.',
            'Odd: https://"onmouseover="alert(4) and http://example.com/x"><img src=x>',
          ].join('\n'),
          functions: [img('fn'), '<a href="javascript:alert(5)">fn link</a>'],
          owningTeam: img('prop'),
          sourcing: 'Buy',
          customHtml: '<iframe src="javascript:alert(6)"></iframe>',
          customLink: 'javascript:alert(7)',
          customObject: { html: img('object'), list: [img('list')] },
          '<b>key</b>': 'html in a key',
        },
      },
      [`<img src=x onerror=alert('id')>`]: {
        label: 'Id with HTML',
        metadata: { type: 'Business' },
      },
      plain: { label: '<svg onload="alert(8)">', metadata: { type: 'Stakeholder' } },
      // Two steps from evil: listed in a card's related elements (not on the canvas).
      far: { label: img('related'), metadata: { type: 'Other' } },
    },
    edges: [
      {
        id: 'c1',
        source: 'evil',
        target: `<img src=x onerror=alert('id')>`,
        relation: 'Relation',
        metadata: { informationFlow: true },
        label: img('edge'),
      },
      {
        id: 'c2',
        source: 'plain',
        target: 'evil',
        relation: 'Relation',
        metadata: { informationFlow: true },
        label: '<b>bold</b>',
      },
      {
        id: 'c3',
        source: `<img src=x onerror=alert('id')>`,
        target: 'far',
        relation: 'Relation',
        metadata: { informationFlow: true },
      },
    ],
  },
};

const craftedSummary: ModelSummary = {
  id: craftedId,
  name: crafted.graph.label ?? '',
  createdAt: '2026-10-27T08:00:00.000Z',
  createdBy: { id: 'u1', name: '<b>Alex</b>' },
  nodeCount: 4,
  edgeCount: 3,
};

/** Two elements, one whose id holds a double quote (any character is allowed in an id). */
const quoteModel: JgfDocument = {
  graph: {
    id: quoteModelId,
    label: 'Quote ids',
    directed: true,
    nodes: {
      plain: { label: 'Plain', metadata: { type: 'Application' } },
      'say "hi"': { label: 'Quoted id', metadata: { type: 'Application' } },
    },
    edges: [{ id: 'q1', source: 'plain', target: 'say "hi"', relation: 'Relation' }],
  },
};

function modelApi(models: [ModelSummary, JgfDocument][]): Handler {
  return ({ url, method }) => {
    if (method !== 'GET') return undefined;
    if (url === '/api/models') return Response.json({ models: models.map(([s]) => s) });
    const found = models.find(([summary]) => url === `/api/models/${summary.id}`);
    return found ? Response.json(found[1]) : undefined;
  };
}

const elementUrl = (modelId: string, id: string, depth = 1) =>
  `/viewing/models/${modelId}/elements/${encodeURIComponent(id)}?depth=${depth}`;

const canvas = () => screen.getByRole('region', { name: /^Diagram:/ });

async function cardCount(count: number) {
  await waitFor(() => {
    expect(canvas().querySelectorAll('.card')).toHaveLength(count);
  });
}

describe('model content is always text', () => {
  it('renders HTML, script and javascript: URLs in names, descriptions, functions, metadata and labels as text', async () => {
    stubApi(viewer, modelApi([[craftedSummary, crafted]]));
    renderAt(elementUrl(craftedId, 'evil'));
    await cardCount(3);

    // Light the focused card's relationships (their labels), and open the related elements of
    // the card that has some not on the canvas.
    const card = canvas().querySelector<HTMLElement>('.card.is-focus .card-main');
    act(() => {
      card?.focus();
    });
    const withMissing = canvas().querySelector<HTMLElement>('.cpill')?.closest('.card');
    fireEvent.click(
      within(withMissing as HTMLElement).getByRole('button', { name: /not on the canvas/ }),
    );
    expect(screen.getByRole('menu', { name: /^Not on the canvas: related to / })).toBeTruthy();
    // The model name shows in the picker.
    fireEvent.click(screen.getByRole('button', { name: /^Model:/ }));
    await screen.findByRole('list', { name: 'Models' });

    // Nothing from the model became an element or an event handler.
    expect(document.querySelectorAll('img, script, iframe, svg[onload]')).toHaveLength(0);
    expect(document.querySelectorAll('[onerror], [onload], [onmouseover]')).toHaveLength(0);
    // Every link goes to the app or to an http(s) address.
    const hrefs = [...document.querySelectorAll('a[href]')].map((a) => a.getAttribute('href'));
    expect(hrefs.filter((href) => !/^(\/|#|https?:\/\/)/.test(href ?? ''))).toEqual([]);
    // Only the three http(s) addresses in the description are links, each to a new tab.
    const details = screen.getByRole('complementary', { name: 'Details' });
    const links = within(
      within(details).getByRole('region', { name: 'Description' }),
    ).queryAllByRole('link');
    expect(
      links.map((a) => [a.getAttribute('href'), a.getAttribute('target'), a.getAttribute('rel')]),
    ).toEqual([
      ['https://docs.example.com/page?a=1&b=', '_blank', 'noopener noreferrer'],
      ['http://example.com/x', '_blank', 'noopener noreferrer'],
    ]);
    // The raw text is shown as it is.
    const text = document.body.textContent;
    for (const raw of [
      img('name'),
      "<script>window.__xss='desc'</script>",
      img('fn'),
      img('prop'),
      '<iframe src="javascript:alert(6)"></iframe>',
      'javascript:alert(7)',
      '<b>key</b>',
      '<svg onload="alert(8)">',
      img('related'),
    ]) {
      expect(text, raw).toContain(raw);
    }
    expect(document.title).toContain(img('name'));
    expect((window as { __xss?: unknown }).__xss).toBeUndefined();
  });
});

describe('explorer keyboard basics', () => {
  it('has Skip to canvas first, which moves focus to the canvas', async () => {
    stubApi(viewer, modelApi([[bakerySummary, bakeryModel]]));
    renderAt(elementUrl(bakeryId, 'shop'));
    await cardCount(6);

    const skip = screen.getByRole('link', { name: 'Skip to canvas' });
    expect(document.querySelectorAll('a, button, [tabindex="0"], input')[0]).toBe(skip);
    act(() => {
      fireEvent.click(skip);
    });
    expect(document.activeElement).toBe(canvas());
  });

  it('keeps only UI preferences in local storage', async () => {
    stubApi(viewer, modelApi([[bakerySummary, bakeryModel]]));
    renderAt(elementUrl(bakeryId, 'shop'));
    await cardCount(6);
    fireEvent.click(screen.getByRole('button', { name: '2' }));
    fireEvent.keyDown(screen.getByRole('separator', { name: 'Resize the details' }), {
      key: 'ArrowLeft',
    });
    fireEvent.click(screen.getByRole('button', { name: 'Hide the element list' }));
    fireEvent.click(screen.getByRole('button', { name: /^Theme:/ }));
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Dark' }));

    const stored = Object.fromEntries(Object.entries(localStorage));
    // Every key is a known preference; the ones just changed are there.
    const preferences = [
      'sa-depth',
      'sa-details-open',
      'sa-details-width',
      'sa-legend-open',
      'sa-theme',
      'sa-tree-open',
      'sa-tree-width',
    ];
    expect(Object.keys(stored).filter((key) => !preferences.includes(key))).toEqual([]);
    expect(stored).toMatchObject({
      'sa-depth': '2',
      'sa-theme': 'dark',
      'sa-tree-open': 'false',
    });
    const values = Object.values(stored).join('|');
    for (const leak of [bakeryId, 'shop', 'Web Shop', 'Bakery', 'Alex']) {
      expect(values).not.toContain(leak);
    }
  });
});

describe('regressions', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // Model management is Admin-only, so a 403 must say Admin, not Modeller.
  it('a refused import names the Admin role', async () => {
    stubApi(admin, modelApi([[bakerySummary, bakeryModel]]), ({ url, method }) =>
      url === '/api/models/import/oef' && method === 'POST'
        ? apiError(403, 'You do not have access to this resource')
        : undefined,
    );
    renderAt('/admin/models');
    await screen.findByRole('link', { name: 'Bakery landscape' });
    const input = document.querySelector<HTMLInputElement>('input[type="file"]');
    fireEvent.change(input as HTMLInputElement, {
      target: { files: [new File(['<model/>'], 'a.xml', { type: 'application/xml' })] },
    });
    const heading = await screen.findByRole('heading', { level: 2, name: /role/ });
    expect(heading.textContent).toContain('Admin');
    expect(heading.textContent).not.toContain('Modeller');
  });

  // In a browser, everything outside an open modal <dialog> is inert, so the trash button
  // can't take focus until the dialog is gone. jsdom has neither showModal nor inertness, so this
  // test adds both, as browsers behave.
  it('Esc and Cancel in the delete dialog return focus to the trash button (modal dialog)', async () => {
    const modal = new Set<HTMLDialogElement>();
    const proto = HTMLDialogElement.prototype as HTMLDialogElement & {
      showModal: () => void;
      close: () => void;
    };
    proto.showModal = function showModal(this: HTMLDialogElement) {
      this.setAttribute('open', '');
      modal.add(this);
    };
    proto.close = function close(this: HTMLDialogElement) {
      this.removeAttribute('open');
      modal.delete(this);
    };
    // eslint-disable-next-line @typescript-eslint/unbound-method -- called with .call(this) below
    const focus = HTMLElement.prototype.focus;
    vi.spyOn(HTMLElement.prototype, 'focus').mockImplementation(function (this: HTMLElement) {
      const inert = [...modal].some((dialog) => dialog.isConnected && !dialog.contains(this));
      if (!inert) focus.call(this);
    });
    try {
      stubApi(admin, modelApi([[bakerySummary, bakeryModel]]));
      renderAt('/admin/models');
      const trash = await screen.findByRole('button', { name: 'Delete Bakery landscape' });
      for (const close of ['Escape', 'Cancel'] as const) {
        act(() => {
          trash.focus();
        });
        fireEvent.click(trash);
        const dialog = await screen.findByRole('dialog');
        if (close === 'Escape') fireEvent.keyDown(dialog, { key: 'Escape' });
        else fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
        await waitFor(() => {
          expect(screen.queryByRole('dialog')).toBeNull();
        });
        expect(document.activeElement, close).toBe(trash);
      }
    } finally {
      delete (proto as Partial<typeof proto>).showModal;
      delete (proto as Partial<typeof proto>).close;
    }
  });

  // React Flow builds a CSS selector from the node id (useUpdateNodeInternals), so an id
  // with a double quote throws, and the whole app unmounts (a blank page in the browser).
  it('an element id with a double quote still draws the canvas', async () => {
    stubApi(
      viewer,
      modelApi([[{ ...bakerySummary, id: quoteModelId, name: 'Quote ids' }, quoteModel]]),
    );
    renderAt(elementUrl(quoteModelId, 'plain'));
    await cardCount(2);
    expect(screen.getByRole('banner')).toBeTruthy();
  });

  // WCAG 2.5.3 (axe label-content-name-mismatch, serious, in Chromium): the visible text of
  // a control must be part of its accessible name. Adjacent spans with no space between them read
  // as one word ("Web Shop7", "Order to bakeBusiness"), which isn't in the name.
  it('visible text is part of the accessible name (tree rows, relationships, related elements, model picker)', async () => {
    stubApi(viewer, modelApi([[bakerySummary, bakeryModel]]));
    renderAt(elementUrl(bakeryId, 'customer'));
    await cardCount(2);
    const shop = canvas().querySelector('.card[data-element-id="shop"]') as HTMLElement;
    fireEvent.click(within(shop).getByRole('button', { name: /not on the canvas/ }));

    // As axe reads it: text nodes joined as they are, then case and punctuation ignored.
    const normalise = (text: string) =>
      text
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, ' ')
        .trim();
    const controls = [
      ...document.querySelectorAll<HTMLElement>(
        '[role="treeitem"][aria-selected], button.rel, [role="menuitem"], #model-button',
      ),
    ];
    // Tree rows, the customer's relationship, the shop's 6 related items (only those not on the
    // canvas) and the model picker.
    expect(controls.length).toBeGreaterThanOrEqual(8);
    expect(controls.filter((el) => el.getAttribute('role') === 'menuitem')).toHaveLength(6);
    const mismatches = controls
      .map((el) => [normalise(el.textContent), normalise(el.getAttribute('aria-label') ?? '')])
      .filter(([visible, name]) => visible !== '' && !name?.includes(visible ?? ''));
    expect(mismatches).toEqual([]);
  });

  // In Chromium, scrollIntoView() moves the sequential focus starting point. The tree scrolls
  // the focused element's row into view on every load and focus change, so the first Tab on a
  // deep link lands after the tree (on its resize handle) instead of on Skip to canvas.
  it('opening a deep link does not move the Tab starting point into the tree', async () => {
    const scroll = vi.spyOn(Element.prototype, 'scrollIntoView');
    stubApi(viewer, modelApi([[bakerySummary, bakeryModel]]));
    renderAt(elementUrl(bakeryId, 'shop'));
    await cardCount(6);
    await new Promise((resolve) => requestAnimationFrame(resolve));
    expect(scroll).not.toHaveBeenCalled();
  });

  // Following a relationship from the details panel re-creates the panel, so keyboard focus
  // falls back to the page and the next Tab starts from the top.
  it('keyboard focus stays in the details panel after following a relationship', async () => {
    stubApi(viewer, modelApi([[bakerySummary, bakeryModel]]));
    renderAt(elementUrl(bakeryId, 'shop'));
    const details = await screen.findByRole('complementary', { name: 'Details' });
    const till = within(details).getByRole('button', {
      name: 'Receives information from Till, Application',
    });
    act(() => {
      till.focus();
    });
    fireEvent.click(till);
    expect(currentLocation()).toBe(elementUrl(bakeryId, 'till'));
    await screen.findByRole('heading', { level: 2, name: 'Till' });
    expect(document.activeElement).not.toBe(document.body);
    expect(
      screen.getByRole('complementary', { name: 'Details' }).contains(document.activeElement),
    ).toBe(true);
  });

  // Axe scrollable-region-focusable (serious, in Chromium): a long JSON value in Custom
  // metadata scrolls sideways in a <pre> that the keyboard can't reach.
  it('a JSON value in Custom metadata can be scrolled with the keyboard', async () => {
    stubApi(viewer, modelApi([[craftedSummary, crafted]]));
    renderAt(elementUrl(craftedId, 'evil'));
    const details = await screen.findByRole('complementary', { name: 'Details' });
    const pre = details.querySelector('pre');
    expect(pre).not.toBeNull();
    expect(pre?.tabIndex).toBe(0);
  });

  // A model the client can't read (e.g. a damaged stored file, which the API still
  // served) showed the browser's JavaScript error text on the page instead of a plain message.
  // The API now validates stored models on read, and the client checks the shape.
  it('a malformed model shows no JavaScript error text', async () => {
    const malformed = { graph: { label: 'Broken', nodes: { a: { label: 'A' } }, edges: 5 } };
    stubApi(viewer, ({ url, method }) =>
      method !== 'GET'
        ? undefined
        : url === '/api/models'
          ? Response.json({ models: [bakerySummary] })
          : url === `/api/models/${bakeryId}`
            ? Response.json(malformed)
            : undefined,
    );
    renderAt(`/viewing/models/${bakeryId}`);
    const main = await screen.findByRole('heading', { name: "The model couldn't be loaded." });
    const text = main.closest('main')?.textContent ?? '';
    expect(text).not.toMatch(/is not a function|undefined|TypeError/);
  });
});
