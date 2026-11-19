import type * as Labels from '../src/viewing/explorer/canvas/labels';
import type { JgfDocument, JgfEdge } from '@simplearchitecture/shared';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { dataArrow } from '../src/viewing/explorer/canvas/dataArrows';
import { bakeryId, bakeryModel, bakerySummary } from './fixtures';
import { modeller, renderAt, stubApi, viewer, type Handler } from './helpers';

// The two lists of data named after the relationship's ends ("Web Shop to Back Office Server"), on
// the form, in the details panel and on the canvas, with arrows that point the way the data flows.
// Made-up data.

// jsdom has no layout, so no spot is ever free for a label: place every label at the origin.
vi.mock('../src/viewing/explorer/canvas/labels', async (importOriginal) => ({
  ...(await importOriginal<typeof Labels>()),
  placeLabel: () => ({ x: 0, y: 0 }),
}));

const longName = 'Customer relationship management platform';

interface Change {
  /** Metadata of the opened relationship (Web Shop to Back Office Server). */
  opened?: Record<string, unknown>;
  /** The server's name. */
  serverName?: string;
  twoWay?: boolean;
  /** The Customer's line (Customer to Web Shop). */
  customer?: Record<string, unknown>;
}

const model = ({ opened = {}, serverName, twoWay, customer }: Change): JgfDocument => {
  const nodes = { ...bakeryModel.graph.nodes };
  const server = nodes.server;
  if (serverName !== undefined && server) nodes.server = { ...server, label: serverName };
  return {
    graph: {
      ...bakeryModel.graph,
      nodes,
      edges: (bakeryModel.graph.edges ?? []).map((edge): JgfEdge => {
        if (edge.id === 'e7') {
          return { ...edge, metadata: opened, ...(twoWay ? { directed: false } : {}) };
        }
        if (edge.source === 'customer' && customer !== undefined) {
          return { ...edge, metadata: { ...edge.metadata, ...customer } };
        }
        return edge;
      }),
    },
  };
};

function api(change: Change) {
  const document = model(change);
  const sent: Record<string, unknown>[] = [];
  const handler: Handler = (request) => {
    if (request.url === '/api/models') {
      return Response.json({ models: [bakerySummary], editable: true });
    }
    if (request.url === `/api/models/${bakeryId}`) return Response.json(document);
    const element = /\/elements\/([^/?]+)/.exec(request.url);
    if (element) {
      const id = decodeURIComponent(element[1] ?? '');
      return Response.json({
        element: { id, version: 1, node: document.graph.nodes?.[id] },
        warnings: [],
      });
    }
    const relationship = /\/relationships\/([^/?]+)/.exec(request.url);
    if (relationship) {
      const id = decodeURIComponent(relationship[1] ?? '');
      const edge = (document.graph.edges ?? []).find((candidate) => candidate.id === id);
      if (request.method === 'PATCH' && typeof request.body === 'string') {
        sent.push(JSON.parse(request.body) as Record<string, unknown>);
      }
      return Response.json({
        relationship: { id, version: 1, edge },
        warnings: [],
        nestingChanges: [],
      });
    }
    return undefined;
  };
  return { handler, sent };
}

const details = () => screen.getByRole('complementary', { name: 'Details' });

async function openHostedOn(space: 'modelling' | 'viewing', change: Change = {}) {
  const { handler, sent } = api(change);
  stubApi(space === 'modelling' ? modeller : viewer, handler);
  renderAt(`/${space}/models/${bakeryId}/elements/shop?depth=1`);
  await screen.findByRole('heading', { level: 2, name: 'Web Shop' });
  // The relationship from Web Shop to the server, whatever the server is called.
  const server = (change.serverName ?? 'Back Office Server').trim().split(/\s+/).join('\\s+');
  fireEvent.click(
    within(details()).getAllByRole('button', {
      name: new RegExp(
        `^Open relationship: ${change.twoWay ? 'relates both ways to ' : '.*'}${server}`,
        'i',
      ),
    })[0] as HTMLElement,
  );
  return { sent };
}

async function openForm(change: Change = {}) {
  const { sent } = await openHostedOn('modelling', change);
  const form = await screen.findByRole('form', { name: /^Relationship / });
  return { form, sent };
}

const shopToServer = 'Web Shop to Back Office Server';
const serverToShop = 'Back Office Server to Web Shop';

/** The data fields in the form's order: each label's full name, and its chips. */
const dataFields = (form: HTMLElement) => {
  const group = within(form).getByRole('group', { name: 'Data' });
  return within(group)
    .getAllByRole('combobox')
    .map((box) => {
      const name = labelOf(box);
      const chips = within(group)
        .queryByRole('list', { name: new RegExp(`^${escape(name)}: `) })
        ?.querySelectorAll('.chip-text');
      return [name, [...(chips ?? [])].map((chip) => chip.textContent)];
    });
};
/** A field's name as screen readers get it: the full name, also when it shows cut. */
const labelOf = (box: HTMLElement): string => {
  const label = document.querySelector(`label[for="${box.id}"]`);
  return (label?.querySelector('.vh') ?? label)?.textContent.trim() ?? '';
};
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

describe('on the relationship form', () => {
  it('names the lists after the ends in a Data group, source to target first', async () => {
    const { form } = await openForm({
      opened: { sourceToTargetData: ['Orders'], targetToSourceData: ['Order ids'] },
    });
    expect(dataFields(form)).toEqual([
      [shopToServer, ['Orders']],
      [serverToShop, ['Order ids']],
    ]);
    expect(within(form).getByRole('combobox', { name: shopToServer })).toBeTruthy();
    expect(
      within(form).getByRole<HTMLInputElement>('combobox', { name: serverToShop }).placeholder,
    ).toBe('Add data');
    expect(within(form).queryByText('Source to target data')).toBeNull();
  });

  it('cuts a long name, with the full name on hover and for screen readers', async () => {
    const { form } = await openForm({ serverName: longName });
    const label = form.querySelector('label[for="rf-sourceToTargetData"]') as HTMLElement;
    expect(label.querySelector('[aria-hidden="true"]')?.textContent).toBe(
      'Web Shop to Customer relationship…',
    );
    expect(label.querySelector('[title]')?.getAttribute('title')).toBe(`Web Shop to ${longName}`);
    expect(within(form).getByRole('combobox', { name: `${longName} to Web Shop` })).toBeTruthy();
  });

  it('gives a name with nothing cut no title', async () => {
    const { form } = await openForm();
    const label = form.querySelector('label[for="rf-sourceToTargetData"]') as HTMLElement;
    expect(label.querySelector('[title]')).toBeNull();
  });

  it('gives the fixed names when both ends have the same name', async () => {
    const { form } = await openForm({ serverName: 'web  SHOP' });
    expect(dataFields(form).map(([name]) => name)).toEqual([
      'Source to target data',
      'Target to source data',
    ]);
  });

  it('follows Reverse and a new To at once, keeping each list with its direction', async () => {
    const { form } = await openForm({
      opened: { sourceToTargetData: ['Orders'], targetToSourceData: ['Order ids'] },
    });
    fireEvent.click(within(details()).getByRole('button', { name: 'Reverse direction' }));
    expect(dataFields(form)).toEqual([
      [serverToShop, ['Order ids']],
      [shopToServer, ['Orders']],
    ]);
    expect(screen.getByText('Reversed. The data lists follow their ends.')).toBeTruthy();
    fireEvent.click(within(details()).getByRole('button', { name: 'Reverse direction' }));
    expect(screen.getByText('Reverse undone.')).toBeTruthy();
    fireEvent.click(within(details()).getByRole('button', { name: /^To: Back Office/ }));
    fireEvent.click(
      within(within(details()).getByRole('listbox')).getByRole('option', { name: /^Till/ }),
    );
    expect(dataFields(form)).toEqual([
      ['Web Shop to Till', ['Orders']],
      ['Till to Web Shop', ['Order ids']],
    ]);
  });

  it('names a two-way relationship with its first end as the source', async () => {
    const { form } = await openForm({ twoWay: true, opened: { targetToSourceData: ['Stock'] } });
    expect(dataFields(form)).toEqual([
      [shopToServer, []],
      [serverToShop, ['Stock']],
    ]);
  });

  it('says what an older name in the label is now', async () => {
    const { form } = await openForm();
    const label = within(form).getByRole<HTMLInputElement>('combobox', { name: 'Label' });
    fireEvent.change(label, { target: { value: '{Request Data} and {response data}' } });
    expect(
      within(form).getByText(
        'No property called “Request Data”. It is now {Source to Target Data}. ' +
          'No property called “response data”. It is now {Target to Source Data}.',
      ),
    ).toBeTruthy();
  });

  it('keeps several sentences about unknown names as one running text', async () => {
    const { form } = await openForm();
    const label = within(form).getByRole<HTMLInputElement>('combobox', { name: 'Label' });
    fireEvent.change(label, { target: { value: 'Posts {Foo} {Request Data} {response  data}' } });
    const warning = form.querySelector('.warn-note') as HTMLElement;
    // The note lays out its children side by side, so the sentences share one child after the
    // icon and wrap as text.
    const texts = [...warning.children].filter((child) => !child.classList.contains('ico'));
    expect(texts.map((child) => child.textContent)).toEqual([
      'No property called “Foo”. ' +
        'No property called “Request Data”. It is now {Source to Target Data}. ' +
        'No property called “response  data”. It is now {Target to Source Data}.',
    ]);
  });
});

describe('in the details panel', () => {
  it('shows one Data row, each list under its name', async () => {
    await openHostedOn('viewing', { opened: { targetToSourceData: ['Order ids'] } });
    const panel = details();
    const row = within(panel)
      .getAllByRole('term')
      .find((term) => term.textContent === 'Data');
    expect(row).toBeTruthy();
    const inside = row?.nextElementSibling as HTMLElement;
    expect([...inside.querySelectorAll('dt')].map((term) => term.textContent)).toEqual([
      shopToServer,
      serverToShop,
    ]);
    expect([...inside.querySelectorAll('dd')].map((value) => value.textContent)).toEqual([
      'Not set',
      'Order ids',
    ]);
    expect(within(inside).getByRole('list', { name: serverToShop })).toBeTruthy();
    expect(within(panel).queryByText('Source to target data')).toBeNull();
  });
});

describe('on the canvas', () => {
  it('starts each list with an arrow, names it for screen readers and in the tooltip', async () => {
    stubApi(viewer, api({ customer: { targetToSourceData: ['Receipts'] } }).handler);
    renderAt(`/viewing/models/${bakeryId}/elements/shop?depth=1&show=data`);
    const label = await waitFor(() => {
      const found = [...document.querySelectorAll('.edge-label')].find((candidate) =>
        candidate.textContent.includes('Receipts'),
      );
      expect(found).toBeTruthy();
      return found as HTMLElement;
    });
    const parts = [...label.querySelectorAll('.t')];
    // The arrows follow the line as drawn: always two opposite ones.
    const arrows = parts.map((part) => part.querySelector('[aria-hidden="true"]')?.textContent);
    expect([
      ['→', '←'],
      ['←', '→'],
      ['↓', '↑'],
      ['↑', '↓'],
    ]).toContainEqual(arrows);
    expect(parts.map((part) => part.querySelector('.vh')?.textContent)).toEqual([
      'Customer to Web Shop: ',
      'Web Shop to Customer: ',
    ]);
    expect(label.getAttribute('title')).toBe(
      'Customer to Web Shop: Places orders\nWeb Shop to Customer: Receipts',
    );
    expect(label.textContent).not.toContain('Req');
  });

  it('explains the arrows in the legend while Data is shown', async () => {
    stubApi(viewer, api({}).handler);
    renderAt(`/viewing/models/${bakeryId}/elements/shop?depth=1&show=data`);
    expect(await screen.findByRole('heading', { name: 'Data on lines' })).toBeTruthy();
    expect(screen.getByText('Points the way the data flows')).toBeTruthy();
  });

  it('has no Data block in the legend while Data is not shown', async () => {
    stubApi(viewer, api({}).handler);
    renderAt(`/viewing/models/${bakeryId}/elements/shop?depth=1`);
    await screen.findByRole('heading', { name: 'Relationship state' });
    expect(screen.queryByRole('heading', { name: 'Data on lines' })).toBeNull();
  });
});

describe('the arrow', () => {
  const p = (x: number, y: number) => ({ x, y });

  it('points the way the line runs from the source, the other list the other way', () => {
    expect(dataArrow([p(0, 0), p(0, 50), p(10, 100)], 'sourceToTargetData')).toBe('↓');
    expect(dataArrow([p(0, 0), p(0, 50), p(10, 100)], 'targetToSourceData')).toBe('↑');
    expect(dataArrow([p(0, 100), p(5, 0)], 'sourceToTargetData')).toBe('↑');
    expect(dataArrow([p(0, 0), p(100, 20)], 'sourceToTargetData')).toBe('→');
    expect(dataArrow([p(100, 0), p(0, 20)], 'sourceToTargetData')).toBe('←');
    expect(dataArrow([p(100, 0), p(0, 20)], 'targetToSourceData')).toBe('→');
    // As far across as down: across.
    expect(dataArrow([p(0, 0), p(50, 50)], 'sourceToTargetData')).toBe('→');
  });

  it('is fixed for an element to itself or a line with no length', () => {
    expect(dataArrow([p(0, 0), p(0, 100)], 'sourceToTargetData', true)).toBe('→');
    expect(dataArrow([p(0, 0), p(0, 100)], 'targetToSourceData', true)).toBe('←');
    expect(dataArrow([p(5, 5), p(5, 5)], 'sourceToTargetData')).toBe('→');
    expect(dataArrow([], 'targetToSourceData')).toBe('←');
  });
});
