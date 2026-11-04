import type { MeResponse } from '@simplearchitecture/shared';
import { render } from '@testing-library/react';
import axe from 'axe-core';
import { StrictMode } from 'react';
import { MemoryRouter, useLocation } from 'react-router';
import { expect, vi } from 'vitest';
import { App } from '../src/App';

export const admin: MeResponse = {
  name: 'Alex Morgan',
  email: 'alex@example.com',
  roles: ['Admin'],
  spaces: ['viewing', 'modelling', 'admin'],
};
export const modeller: MeResponse = {
  ...admin,
  roles: ['Modeller'],
  spaces: ['viewing', 'modelling'],
};
export const viewer: MeResponse = { ...admin, roles: ['Viewer'], spaces: ['viewing'] };
export const noRole: MeResponse = { ...admin, roles: [], spaces: [] };

/** One stubbed API route: answers matching requests. */
export type Handler = (request: {
  url: string;
  method: string;
  body: unknown;
  headers: Headers;
}) => Response | Promise<Response> | undefined;

export function urlOf(input: RequestInfo | URL): string {
  return typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
}

export function apiError(status: number, message: string, extra: object = {}): Response {
  return Response.json({ statusCode: status, error: 'Error', message, ...extra }, { status });
}

/**
 * Stubs fetch. /api/me answers as `me` (a body, or a Response for errors); other requests go to
 * the handlers in order (first answer wins). Anything unhandled fails the request.
 */
export function stubApi(
  me: MeResponse | (() => Response | Promise<Response>),
  ...handlers: Handler[]
) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = urlOf(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    if (url === '/api/me') {
      return typeof me === 'function' ? me() : Response.json(me);
    }
    for (const handler of handlers) {
      const answer = await handler({
        url,
        method,
        body: init?.body,
        headers: new Headers(init?.headers),
      });
      if (answer) return answer;
    }
    throw new Error(`unexpected fetch: ${method} ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

/**
 * The requests made, leaving out those the app cancelled: under StrictMode (as in development)
 * React mounts effects twice, and the first mount's request is aborted.
 */
export function requests(fetchMock: ReturnType<typeof stubApi>): string[] {
  return fetchMock.mock.calls
    .filter(([, init]) => init?.signal?.aborted !== true)
    .map(([input, init]) => `${(init?.method ?? 'GET').toUpperCase()} ${urlOf(input)}`);
}

/** Shows the router's current location, so tests can check navigation. */
function LocationProbe() {
  const location = useLocation();
  return (
    <output data-testid="location" hidden>
      {location.pathname + location.search}
    </output>
  );
}

export function currentLocation(): string {
  return document.querySelector('[data-testid="location"]')?.textContent ?? '';
}

/** Renders the app at a path, in StrictMode as main.tsx does, so dev-only effect bugs show. */
export function renderAt(path: string) {
  return render(
    <StrictMode>
      <MemoryRouter initialEntries={[path]}>
        <App />
        <LocationProbe />
      </MemoryRouter>
    </StrictMode>,
  );
}

/**
 * Runs axe-core and fails on serious or critical issues. Colour contrast can't be computed in
 * jsdom (no layout or cascade of custom properties); contrast.test.ts checks the token contrast table.
 */
export async function expectNoSeriousAxeViolations(root: Element = document.body): Promise<void> {
  const results = await axe.run(root, {
    rules: { 'color-contrast': { enabled: false } },
    resultTypes: ['violations'],
  });
  const serious = results.violations
    .filter((violation) => violation.impact === 'serious' || violation.impact === 'critical')
    .map((violation) => ({
      id: violation.id,
      help: violation.help,
      nodes: violation.nodes.map((node) => node.html.slice(0, 160)),
    }));
  expect(serious).toEqual([]);
}

/**
 * CPU time used by this process so far, in milliseconds. For a budget that matters to a person, such
 * as "a key press has no visible delay": waiting for a CPU doesn't count, so a busy machine doesn't
 * fail it, while real work does.
 */
export const cpuMs = (): number => {
  const { user, system } = process.cpuUsage();
  return (user + system) / 1000;
};
