import type {
  AdminConnectedApp,
  AgentRequest,
  ConnectedApp,
  MeResponse,
} from '@simplearchitecture/shared';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { browser } from '../src/agents/browser';
import { allowGuardMs } from '../src/agents/ConsentPage';
import {
  admin,
  apiError,
  expectNoSeriousAxeViolations,
  noRole,
  renderAt,
  requests,
  stubApi,
  viewer,
  type Handler,
} from './helpers';

/** AI agents: the consent page, Connected apps, and Admin → Connected apps. Made-up data only. */

const requestId = 'sa_rq_madeupmadeupmadeupmadeupmadeupmadeupmad';
const hosted: AgentRequest = {
  clientName: 'Made-up agent',
  redirectHost: 'agent.example.test',
  loopback: false,
  connectionEndsAt: '2026-11-10T14:05:00.000Z',
};
const consentUrl = `/agents/connect?request=${requestId}`;
const returnTo = 'https://agent.example.test/oauth/callback?code=sa_ac_made-up&state=s';

let leave: { mockRestore: () => void };
beforeEach(() => {
  leave = vi.spyOn(browser, 'leave').mockImplementation(() => undefined);
});
afterEach(() => {
  leave.mockRestore();
});

function consentApi(request: AgentRequest | Response, decide?: () => Response): Handler {
  return ({ url, method }) => {
    if (url === '/api/branding') return Response.json({ logo: null, colours: null });
    if (url !== `/api/agents/requests/${requestId}`) return undefined;
    if (method === 'GET') return request instanceof Response ? request : Response.json(request);
    if (method === 'POST') return decide?.() ?? Response.json({ location: returnTo });
    return undefined;
  };
}

const wait = (ms: number) =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });

describe('the consent page', () => {
  it('shows who asks and where it goes back to, with focus on the heading', async () => {
    stubApi(viewer, consentApi(hosted));
    renderAt(consentUrl);
    const heading = await screen.findByRole('heading', { name: 'Connect an AI agent?', level: 1 });
    await waitFor(() => {
      expect(document.activeElement).toBe(heading);
    });
    expect(document.title).toBe('Connect an AI agent – SimpleArchitecture');
    // Outside the shell: no header, spaces or user menu.
    expect(screen.queryByRole('navigation', { name: 'Spaces' })).toBeNull();
    const facts = Object.fromEntries(
      screen
        .getAllByRole('term')
        .map((term) => [term.textContent, term.nextElementSibling?.textContent]),
    );
    expect(facts).toEqual({
      'Name it gives': 'Made-up agent',
      'Sends you back': 'agent.example.test',
    });
    const buttons = within(screen.getByRole('main')).getAllByRole('button');
    expect(buttons.map((button) => button.textContent)).toEqual(['Deny', 'Allow']);
    expect(screen.getByRole('main').textContent).toContain('Connected apps');
    expect(screen.getByRole('main').textContent).toContain(`signed in as ${viewer.name}`);
    await expectNoSeriousAxeViolations();
  });

  it('ignores Allow for the first second, then allows and leaves for the agent', async () => {
    const fetchMock = stubApi(viewer, consentApi(hosted));
    renderAt(consentUrl);
    const allow = await screen.findByRole('button', { name: 'Allow' });
    expect(allow.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(allow);
    expect(requests(fetchMock)).not.toContain(`POST /api/agents/requests/${requestId}`);

    await wait(allowGuardMs + 100);
    expect(allow.getAttribute('aria-disabled')).toBeNull();
    fireEvent.click(allow);
    await screen.findByRole('heading', { name: 'Connected' });
    expect(screen.getByRole('status').textContent).toContain('Returning you to agent.example.test');
    expect(leave).toHaveBeenCalledWith(returnTo);
    const post = fetchMock.mock.calls.find(([, init]) => init?.method === 'POST');
    expect(post?.[1]?.body).toBe(JSON.stringify({ allow: true }));
    expect(document.title).toBe('Connected – SimpleArchitecture');
  });

  it('guards Allow again when the tab becomes visible', async () => {
    stubApi(viewer, consentApi(hosted));
    renderAt(consentUrl);
    const allow = await screen.findByRole('button', { name: 'Allow' });
    await wait(allowGuardMs + 100);
    expect(allow.getAttribute('aria-disabled')).toBeNull();
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(allow.getAttribute('aria-disabled')).toBe('true');
  });

  it('guards Allow again when the window gets focus, as when a popup over it closes', async () => {
    const fetchMock = stubApi(viewer, consentApi(hosted));
    renderAt(consentUrl);
    const allow = await screen.findByRole('button', { name: 'Allow' });
    await wait(allowGuardMs + 100);
    expect(allow.getAttribute('aria-disabled')).toBeNull();
    act(() => {
      window.dispatchEvent(new Event('focus'));
    });
    expect(allow.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(allow);
    expect(requests(fetchMock)).not.toContain(`POST /api/agents/requests/${requestId}`);
    await wait(allowGuardMs + 100);
    expect(allow.getAttribute('aria-disabled')).toBeNull();
  });

  it('denies at once, and the agent hears no', async () => {
    const fetchMock = stubApi(
      viewer,
      consentApi(hosted, () =>
        Response.json({ location: 'https://agent.example.test/cb?error=access_denied' }),
      ),
    );
    renderAt(consentUrl);
    fireEvent.click(await screen.findByRole('button', { name: 'Deny' }));
    await screen.findByRole('heading', { name: 'Not connected' });
    const post = fetchMock.mock.calls.find(([, init]) => init?.method === 'POST');
    expect(post?.[1]?.body).toBe(JSON.stringify({ allow: false }));
    expect(leave).toHaveBeenCalledWith('https://agent.example.test/cb?error=access_denied');
  });

  it('shows the name as text only, or none given, and a loopback host as this computer', async () => {
    stubApi(
      viewer,
      consentApi({
        ...hosted,
        clientName: '<b>Admin</b>',
        redirectHost: 'localhost:53682',
        loopback: true,
      }),
    );
    renderAt(consentUrl);
    await screen.findByRole('heading', { name: 'Connect an AI agent?' });
    const name = document.querySelector('bdi.agent-name');
    expect(name?.textContent).toBe('<b>Admin</b>');
    expect(name?.querySelector('b')).toBeNull();
    expect(screen.getByText('An app on this computer (localhost:53682)')).toBeTruthy();
    expect(document.title).not.toContain('Admin');
  });

  it('says none given when the agent gave no name', async () => {
    stubApi(viewer, consentApi({ ...hosted, clientName: null }));
    renderAt(consentUrl);
    expect(await screen.findByText('None given')).toBeTruthy();
  });

  it('tells a user without a role, with only a way back that says no', async () => {
    const fetchMock = stubApi(noRole, consentApi(hosted));
    renderAt(consentUrl);
    await screen.findByRole('heading', { name: "You can't connect an AI agent yet" });
    expect(screen.queryByRole('button', { name: 'Allow' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Go back to agent.example.test' }));
    await screen.findByRole('heading', { name: 'Not connected' });
    const post = fetchMock.mock.calls.find(([, init]) => init?.method === 'POST');
    expect(post?.[1]?.body).toBe(JSON.stringify({ allow: false }));
  });

  it.each([
    ['an error from the server', '/agents/connect?error=invalid', consentApi(hosted)],
    ['no request', '/agents/connect', consentApi(hosted)],
    ['an unknown or used request', consentUrl, consentApi(apiError(404, 'not valid'))],
  ])('says the request is not valid for %s, and never leaves', async (_case, url, handler) => {
    stubApi(viewer, handler);
    renderAt(url);
    await screen.findByRole('heading', { name: "This request isn't valid" });
    expect(
      screen.getByRole('link', { name: 'Go to SimpleArchitecture' }).getAttribute('href'),
    ).toBe('/');
    expect(screen.queryByRole('button')).toBeNull();
    expect(leave).not.toHaveBeenCalled();
  });

  it('says so when the decision fails, and the buttons work again', async () => {
    stubApi(
      viewer,
      consentApi(hosted, () => apiError(500, 'made-up failure')),
    );
    renderAt(consentUrl);
    fireEvent.click(await screen.findByRole('button', { name: 'Deny' }));
    expect((await screen.findByRole('alert')).textContent).toBe('Something went wrong. Try again.');
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Deny' }).disabled).toBe(false);
    expect(leave).not.toHaveBeenCalled();
  });
});

const apps: ConnectedApp[] = [
  {
    id: '11111111-1111-4111-8111-111111111111',
    clientName: 'Made-up agent',
    redirectHost: 'agent.example.test',
    loopback: false,
    connectedAt: '2026-11-03T14:05:00.000Z',
    lastUsedAt: '2026-11-03T16:40:00.000Z',
    expiresAt: '2026-11-10T14:05:00.000Z',
  },
  {
    id: '22222222-2222-4222-8222-222222222222',
    clientName: null,
    redirectHost: 'localhost:3118',
    loopback: true,
    connectedAt: '2026-11-02T09:12:00.000Z',
    lastUsedAt: null,
    expiresAt: '2026-11-09T09:12:00.000Z',
  },
];

function appsApi(
  list: ConnectedApp[],
  remove: () => Response = () => new Response(null, { status: 204 }),
): Handler {
  return ({ url, method }) => {
    if (url === '/api/models') return Response.json({ models: [], editable: true });
    if (url === '/api/branding') return Response.json({ logo: null, colours: null });
    if (url === '/api/agents' && method === 'GET') return Response.json({ apps: list });
    if (url.startsWith('/api/agents/') && method === 'DELETE') return remove();
    return undefined;
  };
}

describe('Connected apps', () => {
  it('lists the apps with their dates, says signing out leaves them, and shows the address', async () => {
    stubApi(viewer, appsApi(apps));
    renderAt('/agents');
    await screen.findByRole('heading', { name: 'Connected apps', level: 1 });
    expect(screen.getByRole('main').textContent).toContain(
      "Signing out of this browser doesn't disconnect them.",
    );
    const address = screen.getByRole('textbox', { name: 'Address for your AI agent' });
    expect((address as HTMLInputElement).value).toBe(`${window.location.origin}/mcp`);
    const rows = within(
      await screen.findByRole('list', { name: 'Your connected apps' }),
    ).getAllByRole('listitem');
    expect(rows).toHaveLength(2);
    expect(rows[0]?.textContent).toContain('Sends you back to agent.example.test');
    expect(rows[0]?.textContent).toContain('Last used');
    expect(rows[1]?.textContent).toContain('No name given');
    expect(rows[1]?.textContent).toContain('an app on this computer');
    expect(rows[1]?.textContent).toContain('Not used yet');
    expect(rows[1]?.textContent).toContain('Ends');
    await expectNoSeriousAxeViolations();
  });

  it('disconnects with no confirmation, announces it and moves focus on', async () => {
    const fetchMock = stubApi(viewer, appsApi(apps));
    renderAt('/agents');
    const buttons = await screen.findAllByRole('button', { name: 'Disconnect' });
    expect(buttons[0]?.getAttribute('aria-describedby')).toBe(`app-${apps[0]?.id ?? ''}`);
    fireEvent.click(buttons[0] as HTMLElement);
    await waitFor(() => {
      expect(
        within(screen.getByRole('list', { name: 'Your connected apps' })).getAllByRole('listitem'),
      ).toHaveLength(1);
    });
    expect(requests(fetchMock)).toContain(`DELETE /api/agents/${apps[0]?.id ?? ''}`);
    expect(screen.getByText('Made-up agent is disconnected.')).toBeTruthy();
    await waitFor(() => {
      expect(document.activeElement?.id).toBe(`disconnect-${apps[1]?.id ?? ''}`);
    });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('keeps the row and says so when disconnecting fails', async () => {
    stubApi(
      viewer,
      appsApi(apps, () => apiError(500, 'made-up failure')),
    );
    renderAt('/agents');
    fireEvent.click(
      (await screen.findAllByRole('button', { name: 'Disconnect' }))[0] as HTMLElement,
    );
    expect((await screen.findByRole('alert')).textContent).toBe("Couldn't disconnect. Try again.");
    expect(
      within(screen.getByRole('list', { name: 'Your connected apps' })).getAllByRole('listitem'),
    ).toHaveLength(2);
  });

  it.each([
    [viewer, 'add the address above', true],
    [noRole, 'you need the Viewer role or higher', false],
  ] as [MeResponse, string, boolean][])('shows the empty state', async (me, text, address) => {
    stubApi(me, appsApi([]));
    renderAt('/agents');
    await screen.findByText('No apps are connected.');
    expect(screen.getByRole('main').textContent).toContain(text);
    expect(screen.queryByRole('textbox', { name: 'Address for your AI agent' }) !== null).toBe(
      address,
    );
  });

  it('is in the user menu, for everyone signed in', async () => {
    stubApi(noRole, appsApi([]));
    renderAt('/');
    fireEvent.click(await screen.findByRole('button', { name: /account menu/ }));
    const link = await screen.findByRole('link', { name: 'Connected apps' });
    expect(link.getAttribute('href')).toBe('/agents');
    fireEvent.click(link);
    await screen.findByRole('heading', { name: 'Connected apps', level: 1 });
  });
});

const everyone: AdminConnectedApp[] = [
  { ...(apps[0] as ConnectedApp), userId: 'made-up-user-a', userName: 'Made-up User A' },
  { ...(apps[1] as ConnectedApp), userId: 'made-up-user-a', userName: 'Made-up User A' },
  {
    ...(apps[0] as ConnectedApp),
    id: '33333333-3333-4333-8333-333333333333',
    userId: 'made-up-user-b',
    userName: 'Made-up User B',
  },
];

function adminApi(list: AdminConnectedApp[]): Handler {
  return ({ url, method }) => {
    if (url === '/api/models') return Response.json({ models: [], editable: true });
    if (url === '/api/admin/models/damaged') return Response.json({ models: [] });
    if (url === '/api/branding') return Response.json({ logo: null, colours: null });
    if (url === '/api/admin/agents' && method === 'GET') return Response.json({ apps: list });
    if (url === '/api/admin/agents' && method === 'DELETE') {
      return Response.json({ disconnected: list.length });
    }
    if (url.startsWith('/api/admin/agents/users/') && method === 'DELETE') {
      return Response.json({ disconnected: 2 });
    }
    if (url.startsWith('/api/admin/agents/') && method === 'DELETE') {
      return new Response(null, { status: 204 });
    }
    return undefined;
  };
}

describe('Admin → Connected apps', () => {
  it("lists every user's apps by user, and disconnects one with no confirmation", async () => {
    const fetchMock = stubApi(admin, adminApi(everyone));
    renderAt('/admin/apps');
    await screen.findByRole('heading', { name: 'Connected apps', level: 1 });
    const groups = await screen.findAllByRole('region');
    expect(groups.map((group) => within(group).getAllByRole('heading')[0]?.textContent)).toEqual([
      'Made-up User A made-up-user-a',
      'Made-up User B made-up-user-b',
    ]);
    fireEvent.click(within(groups[1] as HTMLElement).getByRole('button', { name: 'Disconnect' }));
    await waitFor(() => {
      expect(screen.getAllByRole('region')).toHaveLength(1);
    });
    expect(requests(fetchMock)).toContain(
      'DELETE /api/admin/agents/33333333-3333-4333-8333-333333333333',
    );
    await expectNoSeriousAxeViolations();
  });

  it('asks before disconnecting all of a user, saying how many', async () => {
    const fetchMock = stubApi(admin, adminApi(everyone));
    renderAt('/admin/apps');
    const groups = await screen.findAllByRole('region');
    fireEvent.click(
      within(groups[0] as HTMLElement).getByRole('button', {
        name: 'Disconnect all for this user',
      }),
    );
    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toContain('This ends 2 connections at once.');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(requests(fetchMock).filter((call) => call.startsWith('DELETE'))).toEqual([]);

    fireEvent.click(
      within(groups[0] as HTMLElement).getByRole('button', {
        name: 'Disconnect all for this user',
      }),
    );
    fireEvent.click(
      within(await screen.findByRole('dialog')).getByRole('button', {
        name: 'Disconnect 2 connections',
      }),
    );
    await waitFor(() => {
      expect(requests(fetchMock)).toContain('DELETE /api/admin/agents/users/made-up-user-a');
    });
  });

  it('asks before disconnecting all, saying how many', async () => {
    const fetchMock = stubApi(admin, adminApi(everyone));
    renderAt('/admin/apps');
    fireEvent.click(await screen.findByRole('button', { name: 'Disconnect all' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toContain('This ends 3 connections at once.');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Disconnect 3 connections' }));
    await waitFor(() => {
      expect(requests(fetchMock)).toContain('DELETE /api/admin/agents');
    });
    await screen.findByText('3 connections ended.');
  });

  it('is not open to a Viewer', async () => {
    const fetchMock = stubApi(viewer, adminApi(everyone));
    renderAt('/admin/apps');
    await screen.findByRole('heading', { name: "You don't have access to Admin" });
    expect(requests(fetchMock)).not.toContain('GET /api/admin/agents');
  });
});
