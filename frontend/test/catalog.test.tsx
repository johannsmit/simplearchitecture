import { buildModelGraph, type ElementChangeResult } from '@simplearchitecture/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  cellChange,
  cellError,
  cellServerErrors,
  cellText,
  elementOfNode,
} from '../src/modelling/draft';
import { saveCell, versionToSave } from '../src/modelling/save';
import { forgetElementFilters } from '../src/viewing/explorer/ElementTree';
import { explorerSearch, readExplorerView } from '../src/viewing/paths';
import { bakeryId, bakeryModel } from './fixtures';
import { apiError, modeller, requests, stubApi } from './helpers';

// The catalog's foundations (the view in the address, saving one cell). The catalog's
// UI is tested in catalog-ui.test.tsx. Made-up data only.

const graph = buildModelGraph(bakeryModel);
const element = (id: string) => {
  const found = graph.elements.get(id);
  if (!found) throw new Error(id);
  return found;
};

beforeEach(() => {
  forgetElementFilters();
});

describe('the view in the address', () => {
  const read = (search: string) => readExplorerView(new URLSearchParams(search));

  it('defaults to the canvas and All; unknown values are ignored', () => {
    expect(read('')).toEqual({ view: 'canvas', tab: 'all' });
    expect(read('view=catalog&depth=2')).toEqual({ view: 'catalog', tab: 'all' });
    expect(read('view=table').view).toBe('canvas');
    expect(read('view=catalog&type=constructor').tab).toBe('all');
  });

  it('reads the tab from type (and the older tab), in any case', () => {
    expect(read('view=catalog&type=Application').tab).toBe('Application');
    expect(read('view=catalog&type=business').tab).toBe('Business');
    expect(read('view=catalog&tab=other').tab).toBe('Other');
  });

  it('writes the view and type, and keeps the other parameters', () => {
    const params = new URLSearchParams('depth=2&view=catalog&tab=other');
    expect(explorerSearch(params, 'canvas')).toBe('?depth=2');
    expect(explorerSearch(new URLSearchParams(), 'canvas')).toBe('');
    expect(explorerSearch(params, 'catalog')).toBe('?depth=2&view=catalog');
    expect(explorerSearch(params, 'catalog', 'Application')).toBe(
      '?depth=2&view=catalog&type=Application',
    );
  });
});

describe('one cell, as the panel saves it', () => {
  it('starts from the text the panel shows', () => {
    expect(cellText(element('shop'), 'name')).toBe('Web Shop');
    expect(cellText(element('shop'), 'functions')).toBe('Order capture\nPayment');
    expect(cellText(element('customer'), 'description')).toBe('Buys bread.');
    expect(cellText(element('till'), 'owningTeam')).toBe('');
  });

  it('sends only the field, normalised as the panel does', () => {
    const shop = element('shop');
    expect(cellChange(shop, 'name', '  Web Shop 2 ')).toEqual({ name: 'Web Shop 2' });
    expect(cellChange(shop, 'name', 'Web Shop')).toBeUndefined();
    expect(cellChange(shop, 'owningTeam', ' Shop team ')).toEqual({
      metadata: { owningTeam: 'Shop team' },
    });
    expect(cellChange(shop, 'owningTeam', '')).toEqual({ metadata: { owningTeam: null } });
    expect(cellChange(shop, 'supplierHqCountry', 'be')).toEqual({
      metadata: { supplierHqCountry: 'BE' },
    });
    expect(cellChange(shop, 'functions', 'Order capture\n\nRefunds')).toEqual({
      metadata: { functions: ['Order capture', 'Refunds'] },
    });
    expect(cellChange(shop, 'description', ' ')).toEqual({ description: null });
    // A property the type doesn't have changes nothing.
    expect(cellChange(element('customer'), 'sourcing', 'Buy')).toBeUndefined();
  });

  it('checks the cell as the panel does before sending', () => {
    const shop = element('shop');
    expect(cellError(shop, 'name', '  ')).toBe('Enter a name.');
    expect(cellError(shop, 'architectureState', 'Retired')).toBe(
      'Pick one of Deprecate, Current, Target.',
    );
    expect(cellError(shop, 'architectureState', 'Target')).toBeUndefined();
    expect(cellError(shop, 'owningTeam', '')).toBeUndefined();
  });

  it("puts the server's messages for the cell first and keeps the others", () => {
    const issues = [
      { field: '', message: 'General.' },
      { field: 'metadata.sourcing', message: 'Must be one of Build, Buy.' },
      { field: 'name', message: 'Enter a name.' },
    ];
    expect(cellServerErrors('sourcing', issues)).toEqual([
      'Must be one of Build, Buy.',
      'General.',
      'Enter a name.',
    ]);
    expect(cellServerErrors('name', issues)[0]).toBe('Enter a name.');
  });
});

describe('saving one cell', () => {
  const shop = element('shop');
  const elementPath = `/api/models/${bakeryId}/elements/shop`;
  const node = bakeryModel.graph.nodes?.shop;
  if (!node) throw new Error('fixture');
  const result = (version: number, metadata = node.metadata ?? {}): ElementChangeResult => ({
    element: { id: 'shop', version, node: { ...node, metadata } },
    warnings: [],
  });

  it('sends one PATCH with the version and only the field', async () => {
    const bodies: unknown[] = [];
    const fetchMock = stubApi(modeller, ({ url, method, body }) => {
      if (url !== elementPath || method !== 'PATCH') return undefined;
      bodies.push(JSON.parse(String(body)));
      return Response.json(result(4, { ...node.metadata, owningTeam: 'Shop team' }));
    });
    const saved = await saveCell(bakeryId, shop, 3, 'owningTeam', 'Shop team');
    expect(bodies).toEqual([{ version: 3, metadata: { owningTeam: 'Shop team' } }]);
    expect(saved?.element.version).toBe(4);
    expect(requests(fetchMock)).toEqual([`PATCH ${elementPath}`]);

    // Nothing changed: nothing is sent.
    expect(await saveCell(bakeryId, shop, 3, 'owningTeam', 'Web team')).toBeUndefined();
    expect(requests(fetchMock)).toHaveLength(1);
  });

  it('reads the version first when it is not known yet', async () => {
    const fetchMock = stubApi(modeller, ({ url, method }) => {
      if (url !== elementPath) return undefined;
      return Response.json(method === 'GET' ? result(7) : result(8));
    });
    await saveCell(bakeryId, shop, undefined, 'name', 'Web Shop 2');
    expect(requests(fetchMock)).toEqual([`GET ${elementPath}`, `PATCH ${elementPath}`]);
  });

  it('is a conflict when the element changed since it was shown, and nothing is sent', async () => {
    const fetchMock = stubApi(modeller, ({ url, method }) =>
      url === elementPath && method === 'GET'
        ? Response.json(result(7, { ...node.metadata, owningTeam: 'Someone else' }))
        : undefined,
    );
    await expect(versionToSave(bakeryId, shop, undefined)).rejects.toMatchObject({ status: 409 });
    await expect(saveCell(bakeryId, shop, undefined, 'name', 'Mine')).rejects.toMatchObject({
      status: 409,
    });
    expect(requests(fetchMock).filter((r) => r.startsWith('PATCH'))).toEqual([]);
  });

  it("passes the server's refusals on as the panel gets them", async () => {
    stubApi(modeller, ({ url, method }) => {
      if (url !== elementPath || method !== 'PATCH') return undefined;
      return apiError(422, 'Rejected', {
        fields: [{ field: 'metadata.sourcing', message: 'Must be one of Build, Buy.' }],
      });
    });
    const error: unknown = await saveCell(bakeryId, shop, 2, 'sourcing', 'Lease').catch(
      (reason: unknown) => reason,
    );
    expect(error).toMatchObject({ status: 422 });
    const fields = (error as { body: { fields: { field: string; message: string }[] } }).body
      .fields;
    expect(cellServerErrors('sourcing', fields)).toEqual(['Must be one of Build, Buy.']);

    stubApi(modeller, ({ url, method }) =>
      url === elementPath && method === 'PATCH'
        ? apiError(409, 'Conflict', { currentVersion: 5 })
        : undefined,
    );
    await expect(saveCell(bakeryId, shop, 2, 'name', 'Mine')).rejects.toMatchObject({
      status: 409,
    });
  });

  it('reads an element from the server the way the explorer does', () => {
    expect(elementOfNode('shop', node)).toEqual(shop);
  });
});
