/** The app's roles, read from the ID token claim named by OIDC_ROLES_CLAIM. */
export const roles = ['Admin', 'Modeller', 'Viewer'] as const;
export type Role = (typeof roles)[number];

/** The three spaces of the app, in navigation order. */
export const spaces = ['viewing', 'modelling', 'admin'] as const;
export type Space = (typeof spaces)[number];

/**
 * Roles are cumulative: Admin reaches every space, Modeller reaches Modelling and Viewing,
 * Viewer reaches Viewing. Several roles give the union. No role gives no access.
 */
const spacesByRole: Record<Role, readonly Space[]> = {
  Admin: ['viewing', 'modelling', 'admin'],
  Modeller: ['viewing', 'modelling'],
  Viewer: ['viewing'],
};

/** The lowest role that opens each space. */
export const requiredRoleForSpace: Record<Space, Role> = {
  viewing: 'Viewer',
  modelling: 'Modeller',
  admin: 'Admin',
};

export function isRole(value: unknown): value is Role {
  return typeof value === 'string' && (roles as readonly string[]).includes(value);
}

/** Spaces the given roles may use, in navigation order. Unknown roles are ignored. */
export function spacesForRoles(userRoles: readonly string[]): Space[] {
  const allowed = new Set(userRoles.filter(isRole).flatMap((role) => spacesByRole[role]));
  return spaces.filter((space) => allowed.has(space));
}

/** The user's known roles, highest first, for display. Empty when the user has no known role. */
export function knownRoles(userRoles: readonly string[]): Role[] {
  return roles.filter((role) => userRoles.includes(role));
}

/** Response body of `GET /api/me`. Never contains tokens. */
export interface MeResponse {
  name: string;
  /** Email or user principal name; `null` if the provider sent neither. */
  email: string | null;
  /** Known app roles only, in the order of `roles`. */
  roles: Role[];
  /** Spaces the user may use, derived from `roles`. */
  spaces: Space[];
}

/** Response body of the placeholder `GET /api/<space>/ping` endpoints. */
export interface SpacePingResponse {
  status: 'ok';
  space: Space;
}
