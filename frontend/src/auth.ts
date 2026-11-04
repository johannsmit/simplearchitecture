import {
  isRole,
  knownRoles,
  spaces,
  type MeResponse,
  type Space,
} from '@simplearchitecture/shared';
import { createContext, use, useEffect, useState } from 'react';

export type AuthState =
  | { state: 'loading' }
  | { state: 'signed-in'; me: MeResponse }
  | { state: 'signed-out' }
  | { state: 'error' };

export const spaceLabels: Record<Space, string> = {
  viewing: 'Viewing',
  modelling: 'Modelling',
  admin: 'Admin',
};

function isSpace(value: unknown): value is Space {
  return typeof value === 'string' && (spaces as readonly string[]).includes(value);
}

function isMeResponse(value: unknown): value is MeResponse {
  if (typeof value !== 'object' || value === null) return false;
  const me = value as Partial<Record<keyof MeResponse, unknown>>;
  return (
    typeof me.name === 'string' &&
    (typeof me.email === 'string' || me.email === null) &&
    Array.isArray(me.roles) &&
    me.roles.every(isRole) &&
    Array.isArray(me.spaces) &&
    me.spaces.every(isSpace)
  );
}

/** Asks the API who is signed in (GET /api/me). The session cookie is httpOnly; JS never sees it. */
export function useAuth(): AuthState {
  const [auth, setAuth] = useState<AuthState>({ state: 'loading' });

  useEffect(() => {
    const controller = new AbortController();
    fetch('/api/me', { signal: controller.signal, headers: { Accept: 'application/json' } })
      .then(async (res) => {
        if (res.status === 401) {
          setAuth({ state: 'signed-out' });
          return;
        }
        const body: unknown = res.ok ? await res.json() : undefined;
        setAuth(isMeResponse(body) ? { state: 'signed-in', me: body } : { state: 'error' });
      })
      .catch(() => {
        if (!controller.signal.aborted) setAuth({ state: 'error' });
      });
    return () => {
      controller.abort();
    };
  }, []);

  return auth;
}

export const MeContext = createContext<MeResponse | null>(null);

/** The signed-in user. Only use below the signed-in part of the app. */
export function useMe(): MeResponse {
  const me = use(MeContext);
  if (!me) throw new Error('useMe used outside a signed-in context');
  return me;
}

/** All of the user's known roles, highest first, e.g. "Admin · Modeller". Display only. */
export function roleLabel(me: MeResponse): string {
  const known = knownRoles(me.roles);
  return known.length > 0 ? known.join(' · ') : 'No role';
}
