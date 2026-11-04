import type {
  ImportOefModelResult,
  JgfValidationResult,
  ModelRejected,
  ModelSummary,
  OefMappingReport,
} from '@simplearchitecture/shared';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { exportFileName } from '../src/viewing/models/exportModel';
import { bakerySummary, pilotSummary } from './fixtures';
import {
  apiError,
  currentLocation,
  expectNoSeriousAxeViolations,
  admin,
  modeller,
  renderAt,
  requests,
  stubApi,
  viewer,
  type Handler,
} from './helpers';

/** Made-up import results. */
const importedSummary: ModelSummary = {
  id: '33333333-3333-4333-8333-333333333333',
  name: 'Imported landscape',
  createdAt: '2026-10-27T10:00:00.000Z',
  createdBy: { id: 'u1', name: 'Alex Morgan' },
  nodeCount: 12,
  edgeCount: 9,
};

const report: OefMappingReport = {
  elements: {
    total: 20,
    mapped: { Stakeholder: 1, Business: 2, Application: 6, Infrastructure: 2, Other: 1 },
    mappedByElementType: { ApplicationComponent: 5, BusinessProcess: 2, Node: 2 },
    folded: { ApplicationFunction: 4 },
    skipped: { 'skipped-by-config': { Grouping: 2 }, 'mystery-reason': { Junction: 1 } },
  },
  functions: {
    folded: 4,
    hosts: 2,
    foldedWithDetailsNotCarried: 1,
    duplicateEntries: 0,
    entriesTruncated: 0,
    entriesNotAdded: 0,
    keptAsNodes: [{ id: 'fn-9', name: 'Rate calculation' }],
  },
  relationships: {
    total: 16,
    mapped: { Relation: 9, Contains: 2 },
    skipped: { 'no-matching-rule': { Association: 3 }, 'source-folded': { Flow: 2 } },
    foldedEnds: {
      count: 3,
      listed: [
        { id: 'rel-17', type: 'Flow', reason: 'source-folded', end: 'source' },
        { id: 'rel-18', type: 'Flow', reason: 'source-folded', end: 'both' },
      ],
      truncated: true,
    },
  },
  properties: {
    mapped: { owningTeam: 4 },
    keptAsCustom: { hostingModel: 2 },
    valuesTranslated: 3,
    valuesNotTranslated: { architectureState: 1 },
    defaultsApplied: {},
    onRelationships: { mapped: {}, defaultsApplied: {} },
    renamedKeys: 0,
    unknownDefinitions: 0,
  },
  viewsSkipped: 4,
  organizationItemsSkipped: 6,
};

const validation: JgfValidationResult = {
  valid: true,
  summary: {
    nodes: {
      total: 12,
      byType: { Stakeholder: 1, Business: 2, Application: 6, Infrastructure: 2, Other: 1 },
    },
    edges: { total: 11, byRelation: { Relation: 9, Contains: 2 } },
  },
  errorCount: 0,
  warningCount: 2,
  errors: [],
  warnings: [
    {
      severity: 'warning',
      code: 'non-iso-country',
      message: 'Node "n-4" metadata.supplierHqCountry should be an ISO code (got "Holland")',
      nodeId: 'n-4',
      field: 'metadata.supplierHqCountry',
    },
    {
      severity: 'warning',
      code: 'odd-code',
      message: 'Something <b>odd</b> happened',
      field: '',
    },
  ],
  truncated: false,
};

const imported: ImportOefModelResult = { model: importedSummary, report, validation };

const rejected: ModelRejected = {
  statusCode: 422,
  error: 'Unprocessable Entity',
  message: 'The model is not valid (2 errors). Nothing was saved.',
  validation: {
    ...validation,
    valid: false,
    errorCount: 2,
    warningCount: 0,
    warnings: [],
    errors: [
      {
        severity: 'error',
        code: 'unknown-node-type',
        message: 'Node "n-1" has an unknown type',
        nodeId: 'n-1',
        field: 'metadata.type',
      },
      {
        severity: 'error',
        code: 'unknown-node-type',
        message: 'Node "n-2" has an unknown type',
        nodeId: 'n-2',
        field: 'metadata.type',
      },
    ],
  },
  report,
};

/** GET /api/models from a list that later handlers can change. */
function modelsApi(models: ModelSummary[]): Handler {
  return ({ url, method }) =>
    url === '/api/models' && method === 'GET' ? Response.json({ models: [...models] }) : undefined;
}

function importApi(answer: () => Response | Promise<Response>): Handler {
  return ({ url, method }) =>
    url === '/api/models/import/oef' && method === 'POST' ? answer() : undefined;
}

function xmlFile(name = 'landscape.xml', size?: number): File {
  const file = new File(['<model/>'], name, { type: 'application/xml' });
  if (size !== undefined) Object.defineProperty(file, 'size', { value: size });
  return file;
}

function fileInput(): HTMLInputElement {
  const input = document.querySelector<HTMLInputElement>('input[type="file"]');
  if (!input) throw new Error('no file input');
  return input;
}

function chooseFiles(files: File[]) {
  fireEvent.change(fileInput(), { target: { files } });
}

function rowNames(): string[] {
  const table = screen.getByRole('table', { name: 'Stored models' });
  return [...table.querySelectorAll('td.name-cell a')].map((link) => link.textContent);
}

async function openPicker() {
  fireEvent.click(screen.getByRole('button', { name: /^Model:/ }));
  return screen.findByRole('list', { name: 'Models' });
}

describe('Models page: list', () => {
  it.each([
    ['Viewer', viewer],
    ['Modeller', modeller],
    ['Admin', admin],
  ] as const)(
    'shows a %s a read-only list in Viewing, each model one click away',
    async (_name, me) => {
      const fetchMock = stubApi(me, modelsApi([bakerySummary, pilotSummary]));
      renderAt('/viewing');

      expect(await screen.findByRole('link', { name: 'Bakery landscape' })).toBeTruthy();
      expect(
        screen.getByText('Architecture models you can explore. Open one to browse it.'),
      ).toBeTruthy();
      expect(screen.queryByRole('button', { name: /Import file/ })).toBeNull();
      expect(screen.queryByRole('button', { name: /Drop a model file/ })).toBeNull();
      expect(screen.queryByRole('button', { name: /^Delete / })).toBeNull();
      expect(document.querySelector('input[type="file"]')).toBeNull();
      // Both the name and an Open button lead to the explorer.
      expect(screen.getByRole('link', { name: 'Bakery landscape' }).getAttribute('href')).toBe(
        `/viewing/models/${bakerySummary.id}`,
      );
      const open = screen.getByRole('link', { name: 'Open Bakery landscape in the explorer' });
      fireEvent.click(open);
      expect(currentLocation()).toBe(`/viewing/models/${bakerySummary.id}`);
      expect(requests(fetchMock).filter((r) => !r.startsWith('GET'))).toEqual([]);
    },
  );

  it('shows no drop overlay in Viewing, even for an Admin', async () => {
    stubApi(admin, modelsApi([bakerySummary]));
    renderAt('/viewing');
    await screen.findByRole('link', { name: 'Bakery landscape' });

    fireEvent.dragOver(window, { dataTransfer: { types: ['Files'], files: [] } });
    expect(screen.queryByText('Drop to import')).toBeNull();
    expect(
      screen
        .getByRole('link', { name: 'Create, import, export or delete models in Admin' })
        .getAttribute('href'),
    ).toBe('/admin/models');
  });

  it('shows an Admin the list with import and delete controls in Admin → Models', async () => {
    stubApi(admin, modelsApi([bakerySummary, pilotSummary]));
    renderAt('/admin');

    expect(await screen.findByRole('link', { name: 'Payments pilot' })).toBeTruthy();
    expect(currentLocation()).toBe('/admin/models');
    expect(
      screen.getByText(
        'Create, import, export and delete the architecture models stored in SimpleArchitecture.',
      ),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: /Import file/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Drop a model file/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Delete Bakery landscape' })).toBeTruthy();
    const row = screen.getByRole('link', { name: 'Bakery landscape' }).closest('tr');
    expect(row?.textContent).toContain('Alex Morgan');
    expect(row?.querySelector('[title="2026-10-26T14:05:00.000Z"]')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Bakery landscape' }).getAttribute('href')).toBe(
      `/viewing/models/${bakerySummary.id}`,
    );
  });

  it('keeps a Modeller out of Admin → Models', async () => {
    const fetchMock = stubApi(modeller, modelsApi([bakerySummary]));
    renderAt('/admin/models');

    expect(
      await screen.findByRole('heading', { level: 1, name: "You don't have access to Admin" }),
    ).toBeTruthy();
    expect(requests(fetchMock)).toEqual(['GET /api/me']);
  });

  it('shows skeleton rows while loading', async () => {
    stubApi(viewer, ({ url }) =>
      url === '/api/models' ? new Promise<Response>(() => undefined) : undefined,
    );
    renderAt('/viewing');

    const table = await screen.findByRole('table', { name: 'Stored models' });
    expect(table.getAttribute('aria-busy')).toBe('true');
    expect(table.querySelectorAll('tbody tr')).toHaveLength(3);
  });

  it('offers an Admin a large drop zone when there are no models', async () => {
    stubApi(admin, modelsApi([]));
    renderAt('/admin/models');

    expect(await screen.findByRole('button', { name: /Import your first model/ })).toBeTruthy();
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('tells everyone in Viewing there are no models yet', async () => {
    stubApi(admin, modelsApi([]));
    renderAt('/viewing');

    expect(
      await screen.findByText('No models yet. An admin can create or import one.'),
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Import your first model/ })).toBeNull();
  });

  it('says when the list could not be loaded, and tries again', async () => {
    let fail = true;
    stubApi(viewer, ({ url }) => {
      if (url !== '/api/models') return undefined;
      return fail
        ? apiError(500, 'The store is unreadable.')
        : Response.json({ models: [pilotSummary] });
    });
    renderAt('/viewing');

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain("The models couldn't be loaded.");
    expect(alert.textContent).toContain('The store is unreadable.');
    fail = false;
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('link', { name: 'Payments pilot' })).toBeTruthy();
  });

  it('sorts by column, sets aria-sort and keeps the sort in the URL', async () => {
    stubApi(viewer, modelsApi([bakerySummary, pilotSummary]));
    renderAt('/viewing');
    await screen.findByRole('link', { name: 'Bakery landscape' });

    const header = (name: string) => screen.getByRole('button', { name }).closest('th');
    expect(header('Created on')?.getAttribute('aria-sort')).toBe('descending');
    expect(rowNames()).toEqual(['Bakery landscape', 'Payments pilot']);

    fireEvent.click(screen.getByRole('button', { name: 'Elements' }));
    expect(header('Elements')?.getAttribute('aria-sort')).toBe('descending');
    expect(header('Created on')?.getAttribute('aria-sort')).toBeNull();
    expect(rowNames()).toEqual(['Payments pilot', 'Bakery landscape']);
    expect(currentLocation()).toBe('/viewing?sort=elements&dir=desc');

    fireEvent.click(screen.getByRole('button', { name: 'Name' }));
    expect(header('Name')?.getAttribute('aria-sort')).toBe('ascending');
    expect(currentLocation()).toBe('/viewing?sort=name&dir=asc');
    fireEvent.click(screen.getByRole('button', { name: 'Name' }));
    expect(header('Name')?.getAttribute('aria-sort')).toBe('descending');
    expect(rowNames()).toEqual(['Payments pilot', 'Bakery landscape']);
  });

  it('reads the sort from the URL', async () => {
    stubApi(viewer, modelsApi([bakerySummary, pilotSummary]));
    renderAt('/viewing?sort=relationships&dir=asc');
    await screen.findByRole('link', { name: 'Bakery landscape' });

    expect(rowNames()).toEqual(['Bakery landscape', 'Payments pilot']);
    expect(
      screen
        .getByRole('button', { name: 'Relationships' })
        .closest('th')
        ?.getAttribute('aria-sort'),
    ).toBe('ascending');
  });
});

describe('Models page: import', () => {
  it.each([
    [
      'a file that is neither .xml nor .json',
      () => {
        chooseFiles([xmlFile('model.txt')]);
      },
      'Choose a JGF file (.json) or an ArchiMate OEF file (.xml).',
    ],
    [
      'a file over 10 MB',
      () => {
        chooseFiles([xmlFile('big.xml', 14.2 * 1024 * 1024)]);
      },
      'This file is 14.2 MB. The limit for this type of file is 10 MB.',
    ],
    [
      'a JGF file over 5 MB',
      () => {
        chooseFiles([xmlFile('big.json', 5.5 * 1024 * 1024)]);
      },
      'This file is 5.5 MB. The limit for this type of file is 5 MB.',
    ],
    [
      'two dropped files',
      () =>
        fireEvent.drop(screen.getByRole('button', { name: /Drop a model file/ }), {
          dataTransfer: { files: [xmlFile('a.xml'), xmlFile('b.xml')], types: ['Files'] },
        }),
      'Drop one file at a time.',
    ],
  ])('refuses %s before uploading', async (_name, act, message) => {
    const fetchMock = stubApi(admin, modelsApi([bakerySummary]));
    renderAt('/admin/models');
    await screen.findByRole('link', { name: 'Bakery landscape' });

    act();
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain(message);
    expect(requests(fetchMock).some((r) => r.startsWith('POST'))).toBe(false);

    fireEvent.click(within(alert).getByRole('button', { name: /Dismiss/ }));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('imports a file, shows the report and adds the model to the list and the picker', async () => {
    const models = [bakerySummary];
    let finish: (response: Response) => void = () => undefined;
    const answer = new Promise<Response>((resolve) => {
      finish = resolve;
    });
    const fetchMock = stubApi(
      admin,
      modelsApi(models),
      importApi(() => answer),
    );
    renderAt('/admin/models');
    await screen.findByRole('link', { name: 'Bakery landscape' });

    chooseFiles([xmlFile('landscape.xml')]);
    const progress = await screen.findByRole('status', { name: 'Import in progress' });
    expect(progress.textContent).toContain('Importing landscape.xml');
    expect(screen.getByRole<HTMLButtonElement>('button', { name: /Import file/ }).disabled).toBe(
      true,
    );

    await act(async () => {
      finish(Response.json(imported, { status: 201 }));
      await Promise.resolve();
    });

    const heading = await screen.findByRole('heading', { name: 'Imported “Imported landscape”' });
    await waitFor(() => {
      expect(document.activeElement).toBe(heading);
    });
    const panel = heading.closest('section');
    if (!panel) throw new Error('no panel');
    expect(panel.textContent).toContain('landscape.xml · 12 elements · 9 relationships');
    expect(within(panel).getByRole('link', { name: 'Open in explorer' }).getAttribute('href')).toBe(
      `/viewing/models/${importedSummary.id}`,
    );

    // Chips for the non-zero parts only.
    for (const chip of [
      '2 warnings',
      '3 elements skipped',
      '5 relationships skipped',
      '4 functions folded into 2 elements',
      '3 relationships lost to folded ends',
    ]) {
      expect(within(panel).getByRole('button', { name: chip })).toBeTruthy();
    }

    // Sections: warnings open by default, the rest closed; a chip opens its section.
    const section = (name: string) =>
      [...panel.querySelectorAll('details.sec')].find(
        (details) => details.querySelector('summary b')?.textContent === name,
      ) as HTMLDetailsElement;
    expect(section('Warnings').open).toBe(true);
    expect(section('Skipped').open).toBe(false);
    fireEvent.click(within(panel).getByRole('button', { name: '3 elements skipped' }));
    expect(section('Skipped').open).toBe(true);

    // Reason codes in words; unknown codes as they are.
    expect(section('Skipped').textContent).toContain('Skipped by the mapping settings');
    expect(section('Skipped').textContent).toContain('No relationship rule matches');
    expect(section('Skipped').textContent).toContain('Source was folded into an element');
    expect(section('Skipped').textContent).toContain('mystery-reason');
    expect(section('Folded ends').textContent).toContain('Showing the first 2 of 3.');
    expect(section('Functions').textContent).toContain('Rate calculation');
    expect(section('Properties').textContent).toContain('Values not translated: architectureState');
    expect(section('Not imported').textContent).toContain('4 diagrams and 6 folders');
    expect(section('Elements').textContent).toContain('ApplicationComponent');
    // Contains is counted like the other relationship types.
    expect(section('Relationships').querySelector('summary')?.textContent).toContain(
      'Relation 9 · Contains 2',
    );

    // Warnings grouped in words, as text (never HTML), with a link to the element.
    const warnings = section('Warnings');
    expect(warnings.textContent).toContain('Country is not an ISO code');
    expect(warnings.textContent).toContain('odd-code');
    expect(warnings.textContent).toContain('Something <b>odd</b> happened');
    expect(warnings.querySelector('b b')).toBeNull();
    expect(within(warnings).getByRole('link', { name: 'Open' }).getAttribute('href')).toBe(
      `/viewing/models/${importedSummary.id}/elements/n-4`,
    );

    // The new model is in the list (highlighted) and in the header picker, without a reload.
    const newRow = screen.getByRole('link', { name: 'Imported landscape' }).closest('tr');
    expect(newRow?.className).toContain('is-new');
    // The import report opens the model in the Viewing explorer.
    expect(within(panel).getByRole('link', { name: 'Open in explorer' }).getAttribute('href')).toBe(
      `/viewing/models/${importedSummary.id}`,
    );

    // The upload is the file as application/xml.
    const post = fetchMock.mock.calls.find(([, init]) => init?.method === 'POST');
    expect(new Headers(post?.[1]?.headers).get('content-type')).toBe('application/xml');
    expect(post?.[1]?.body).toBeInstanceOf(File);

    // Dismiss removes the panel.
    fireEvent.click(within(panel).getByRole('button', { name: 'Dismiss import result' }));
    expect(screen.queryByRole('heading', { name: /^Imported/ })).toBeNull();

    // Over in Viewing, the list and the header picker have it too, without another request.
    fireEvent.click(
      within(screen.getByRole('navigation', { name: 'Spaces' })).getByRole('link', {
        name: 'Viewing',
      }),
    );
    expect(await screen.findByRole('link', { name: 'Imported landscape' })).toBeTruthy();
    const picker = await openPicker();
    expect(within(picker).getByRole('link', { name: /Imported landscape/ })).toBeTruthy();
    expect(requests(fetchMock).filter((r) => r === 'GET /api/models')).toHaveLength(1);
  });

  it('imports a file dropped anywhere on the page', async () => {
    stubApi(
      admin,
      modelsApi([bakerySummary]),
      importApi(() => Response.json(imported, { status: 201 })),
    );
    renderAt('/admin/models');
    await screen.findByRole('link', { name: 'Bakery landscape' });

    fireEvent.dragOver(window, { dataTransfer: { types: ['Files'], files: [] } });
    expect(screen.getByText('Drop to import')).toBeTruthy();
    fireEvent.drop(screen.getByRole('heading', { level: 1, name: 'Models' }), {
      dataTransfer: { types: ['Files'], files: [xmlFile()] },
    });
    expect(screen.queryByText('Drop to import')).toBeNull();
    expect(
      await screen.findByRole('heading', { name: 'Imported “Imported landscape”' }),
    ).toBeTruthy();
  });

  it('says nothing was saved and lists the errors on a 422', async () => {
    stubApi(
      admin,
      modelsApi([bakerySummary]),
      importApi(() => Response.json(rejected, { status: 422 })),
    );
    renderAt('/admin/models');
    await screen.findByRole('link', { name: 'Bakery landscape' });

    chooseFiles([xmlFile('broken.xml')]);
    const heading = await screen.findByRole('heading', {
      name: 'Not imported: the model has 2 errors',
    });
    const panel = heading.closest('section');
    if (!panel) throw new Error('no panel');
    expect(panel.textContent).toContain(
      'Nothing was saved. Fix the errors in the source model and import again.',
    );
    const errors = panel.querySelector<HTMLDetailsElement>('details.sec');
    expect(errors?.querySelector('summary b')?.textContent).toBe('Errors');
    expect(errors?.open).toBe(true);
    expect(errors?.textContent).toContain('Node "n-1" has an unknown type');
    expect(errors?.textContent).toContain('unknown-node-type');
    // Nothing was saved, so there is nothing to open.
    expect(within(panel).queryByRole('link', { name: 'Open' })).toBeNull();
    // The report sections follow.
    expect(panel.textContent).toContain('Folded ends');
    expect(rowNames()).toEqual(['Bakery landscape']);
  });

  it('says the file or model is too large on a 413', async () => {
    stubApi(
      admin,
      modelsApi([bakerySummary]),
      importApi(() => apiError(413, 'The model has more than 20000 nodes.')),
    );
    renderAt('/admin/models');
    await screen.findByRole('link', { name: 'Bakery landscape' });

    chooseFiles([xmlFile('huge.xml')]);
    const heading = await screen.findByRole('heading', { name: 'The file or model is too large' });
    expect(heading.closest('section')?.textContent).toContain(
      'The model has more than 20000 nodes.',
    );
    expect(screen.getByRole('button', { name: 'Choose another file' })).toBeTruthy();
  });

  it.each([
    [400, "This file isn't a valid OEF file"],
    [415, 'Choose a JGF file (.json) or an ArchiMate OEF file (.xml).'],
    [409, 'The store is full (500 models). Delete a model to import another.'],
    [401, 'Your session ended. Sign in again, then import the file again.'],
    [403, 'Importing needs the Admin role.'],
    [500, "The import didn't finish. Try again in a moment."],
    [0, "The import didn't finish. Try again in a moment."],
  ])('shows its own message for status %i', async (status, heading) => {
    stubApi(
      admin,
      modelsApi([bakerySummary]),
      importApi(() =>
        status === 0
          ? Promise.reject(new TypeError('Failed to fetch'))
          : apiError(status, 'Details'),
      ),
    );
    renderAt('/admin/models');
    await screen.findByRole('link', { name: 'Bakery landscape' });

    chooseFiles([xmlFile()]);
    expect(await screen.findByRole('heading', { name: heading })).toBeTruthy();
    if (status === 401) {
      expect(screen.getByRole('link', { name: 'Sign in' }).getAttribute('href')).toBe(
        '/auth/login',
      );
      // The page stays; only the import panel asks to sign in again.
      expect(screen.getByRole('link', { name: 'Bakery landscape' })).toBeTruthy();
    } else {
      expect(screen.getByRole('button', { name: 'Choose another file' })).toBeTruthy();
    }
  });

  it('has no serious accessibility issues with an import result open', async () => {
    stubApi(
      admin,
      modelsApi([bakerySummary]),
      importApi(() => Response.json(imported, { status: 201 })),
    );
    renderAt('/admin/models');
    await screen.findByRole('link', { name: 'Bakery landscape' });
    chooseFiles([xmlFile()]);
    await screen.findByRole('heading', { name: 'Imported “Imported landscape”' });

    await expectNoSeriousAxeViolations();
  });
});

describe('Models page: import of a JGF file', () => {
  function jgfApi(answer: () => Response | Promise<Response>): Handler {
    return (request) =>
      request.method === 'POST' && request.url === '/api/models' ? answer() : undefined;
  }
  const jsonFile = () => new File(['{"graph":{}}'], 'landscape.json', { type: 'application/json' });

  it('sends a .json file to the JGF route and shows the result, without an OEF report', async () => {
    const fetchMock = stubApi(
      admin,
      modelsApi([bakerySummary]),
      jgfApi(() =>
        Response.json(
          {
            model: pilotSummary,
            validation: { valid: true, errorCount: 0, warningCount: 0, errors: [], warnings: [] },
          },
          { status: 201 },
        ),
      ),
    );
    renderAt('/admin/models');
    await screen.findByRole('link', { name: 'Bakery landscape' });

    chooseFiles([jsonFile()]);
    expect(
      await screen.findByRole('heading', { name: `Imported “${pilotSummary.name}”` }),
    ).toBeTruthy();
    const posts = fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST');
    expect(posts).toHaveLength(1);
    expect(requests(fetchMock)).toContain('POST /api/models');
    expect(new Headers(posts[0]?.[1]?.headers).get('content-type')).toBe('application/json');
    expect(screen.getByRole('link', { name: 'Open in explorer' })).toBeTruthy();
  });

  it('shows the errors of a refused model, with nothing saved', async () => {
    stubApi(
      admin,
      modelsApi([bakerySummary]),
      jgfApi(() =>
        Response.json(
          {
            statusCode: 422,
            error: 'Unprocessable Entity',
            message: 'The model is not valid (1 error). Nothing was saved.',
            validation: {
              valid: false,
              errorCount: 1,
              warningCount: 0,
              errors: [{ severity: 'error', code: 'made-up', message: 'Made-up problem' }],
              warnings: [],
            },
          },
          { status: 422 },
        ),
      ),
    );
    renderAt('/admin/models');
    await screen.findByRole('link', { name: 'Bakery landscape' });

    chooseFiles([jsonFile()]);
    expect(
      await screen.findByRole('heading', { name: 'Not imported: the model has 1 error' }),
    ).toBeTruthy();
  });

  it('says a file that does not parse is not a valid JGF file', async () => {
    stubApi(
      admin,
      modelsApi([bakerySummary]),
      jgfApi(() => apiError(400, 'The file is not valid JSON.')),
    );
    renderAt('/admin/models');
    await screen.findByRole('link', { name: 'Bakery landscape' });

    chooseFiles([jsonFile()]);
    expect(
      await screen.findByRole('heading', { name: "This file isn't a valid JGF file" }),
    ).toBeTruthy();
  });
});

describe('Models page: delete', () => {
  function deleteApi(answer: () => Response | Promise<Response>): Handler {
    return ({ url, method }) =>
      method === 'DELETE' && url.startsWith('/api/models/') ? answer() : undefined;
  }

  it('asks for confirmation, deletes, announces it and moves focus to the next row', async () => {
    let finish: (response: Response) => void = () => undefined;
    const answer = new Promise<Response>((resolve) => {
      finish = resolve;
    });
    const fetchMock = stubApi(
      admin,
      modelsApi([bakerySummary, pilotSummary]),
      deleteApi(() => answer),
    );
    renderAt('/admin/models');
    await screen.findByRole('link', { name: 'Bakery landscape' });

    // Esc closes and returns focus to the trash button.
    const trash = screen.getByRole('button', { name: 'Delete Bakery landscape' });
    trash.focus();
    fireEvent.click(trash);
    let dialog = await screen.findByRole('dialog', { name: 'Delete “Bakery landscape”?' });
    expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Cancel' }));
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(trash);

    fireEvent.click(trash);
    dialog = await screen.findByRole('dialog', { name: 'Delete “Bakery landscape”?' });
    expect(dialog.textContent).toContain(
      'This deletes the model, its 7 elements and 8 relationships for everyone.',
    );
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete model' }));
    const deleting = within(dialog).getByRole<HTMLButtonElement>('button', { name: 'Deleting…' });
    expect(deleting.disabled).toBe(true);
    expect(within(dialog).getByRole<HTMLButtonElement>('button', { name: 'Cancel' }).disabled).toBe(
      true,
    );

    await act(async () => {
      finish(new Response(null, { status: 204 }));
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    expect(rowNames()).toEqual(['Payments pilot']);
    expect(screen.getByText('Deleted “Bakery landscape”.').getAttribute('role')).toBe('status');
    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByRole('link', { name: 'Payments pilot' }));
    });
    expect(requests(fetchMock)).toContain(`DELETE /api/models/${bakerySummary.id}`);

    // Over in Viewing, the header picker no longer lists it.
    fireEvent.click(
      within(screen.getByRole('navigation', { name: 'Spaces' })).getByRole('link', {
        name: 'Viewing',
      }),
    );
    const picker = await openPicker();
    expect(within(picker).queryByRole('link', { name: /Bakery landscape/ })).toBeNull();
  });

  it('removes the row when the model was already deleted', async () => {
    stubApi(
      admin,
      modelsApi([bakerySummary, pilotSummary]),
      deleteApi(() => apiError(404, 'Model not found')),
    );
    renderAt('/admin/models');
    fireEvent.click(await screen.findByRole('button', { name: 'Delete Payments pilot' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete model' }));

    expect(await screen.findByText('This model was already deleted.')).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(rowNames()).toEqual(['Bakery landscape']);
  });

  it('shows other errors in the dialog and lets the user try again', async () => {
    stubApi(
      admin,
      modelsApi([bakerySummary]),
      deleteApi(() => apiError(409, "The model file couldn't be removed.")),
    );
    renderAt('/admin/models');
    fireEvent.click(await screen.findByRole('button', { name: 'Delete Bakery landscape' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete model' }));

    const alert = await within(dialog).findByRole('alert');
    expect(alert.textContent).toContain("The model file couldn't be removed.");
    const retry = within(dialog).getByRole<HTMLButtonElement>('button', { name: 'Delete model' });
    expect(retry.disabled).toBe(false);
    expect(rowNames()).toEqual(['Bakery landscape']);
  });

  it('has no serious accessibility issues with the delete dialog open', async () => {
    stubApi(admin, modelsApi([bakerySummary, pilotSummary]));
    renderAt('/admin/models');
    fireEvent.click(await screen.findByRole('button', { name: 'Delete Bakery landscape' }));
    await screen.findByRole('dialog');

    await expectNoSeriousAxeViolations();
  });
});

describe('exporting a model from Admin → Models', () => {
  const document_ = { graph: { label: 'Bakery landscape', nodes: {}, edges: [] } };
  const modelUrl = `/api/models/${bakerySummary.id}`;
  const exportName = 'Export Bakery landscape';

  /** Records what the browser is handed to save. */
  function catchDownloads() {
    const saved: { name: string; blob: Blob }[] = [];
    let last: Blob | undefined;
    vi.stubGlobal(
      'URL',
      Object.assign(URL, {
        createObjectURL: (blob: Blob) => {
          last = blob;
          return 'blob:made-up';
        },
        revokeObjectURL: () => undefined,
      }),
    );
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      if (last) saved.push({ name: this.download, blob: last });
    });
    return saved;
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('saves the JGF file the API sends, named after the model, and says so', async () => {
    const saved = catchDownloads();
    const fetchMock = stubApi(admin, (request) =>
      request.url === modelUrl && request.method === 'GET'
        ? Response.json(document_)
        : modelsApi([bakerySummary])(request),
    );
    renderAt('/admin/models');

    const button = await screen.findByRole('button', { name: exportName });
    button.focus();
    fireEvent.click(button);

    await screen.findByText('Exported “Bakery landscape”.');
    expect(saved).toHaveLength(1);
    expect(saved[0]?.name).toBe('Bakery landscape.json');
    expect(saved[0]?.blob.type).toBe('application/json');
    expect(JSON.parse(await (saved[0]?.blob as Blob).text())).toEqual(document_);
    expect(requests(fetchMock)).toContain(`GET ${modelUrl}`);
    expect(document.activeElement).toBe(button);
    await expectNoSeriousAxeViolations();
  });

  it('sends one request for repeated clicks, and keeps the button focusable meanwhile', async () => {
    catchDownloads();
    const fetchMock = stubApi(admin, (request) =>
      request.url === modelUrl
        ? new Promise<Response>(() => undefined)
        : modelsApi([bakerySummary])(request),
    );
    renderAt('/admin/models');

    const button = await screen.findByRole('button', { name: exportName });
    fireEvent.click(button);
    await waitFor(() => {
      expect(button.getAttribute('aria-disabled')).toBe('true');
    });
    fireEvent.click(button);
    expect(requests(fetchMock).filter((call) => call === `GET ${modelUrl}`)).toHaveLength(1);
    expect((button as HTMLButtonElement).disabled).toBe(false);
  });

  it('says so when the export fails, saves nothing, and allows another try', async () => {
    const saved = catchDownloads();
    stubApi(admin, (request) =>
      request.url === modelUrl
        ? apiError(404, 'Model not found')
        : modelsApi([bakerySummary])(request),
    );
    renderAt('/admin/models');

    const button = await screen.findByRole('button', { name: exportName });
    fireEvent.click(button);

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe("“Bakery landscape” wasn't exported. Model not found");
    expect(saved).toHaveLength(0);
    await waitFor(() => {
      expect(button.getAttribute('aria-disabled')).toBeNull();
    });
  });

  it.each([
    ['Viewing', viewer, '/viewing'],
    ['Viewing as an Admin', admin, '/viewing'],
    ['Modelling', modeller, '/modelling'],
    ['Modelling as an Admin', admin, '/modelling'],
  ])('offers no Export on %s', async (_name, me, path) => {
    stubApi(me, modelsApi([bakerySummary]));
    renderAt(path);

    await screen.findByRole('link', { name: 'Bakery landscape' });
    expect(screen.queryByRole('button', { name: /^Export / })).toBeNull();
  });

  it.each([
    ['Bakery landscape', 'Bakery landscape.json'],
    ['../../etc/passwd', 'etc passwd.json'],
    ['a\\b:c*d?"e<f>g|h', 'a b c d e f g h.json'],
    ['line\nbreak‮gnp', 'line break gnp.json'],
    ['...', 'model.json'],
    ['   ', 'model.json'],
    ['x'.repeat(300), `${'x'.repeat(100)}.json`],
  ])('names the file for %j safely', (name, expected) => {
    expect(exportFileName(name)).toBe(expected);
  });
});
