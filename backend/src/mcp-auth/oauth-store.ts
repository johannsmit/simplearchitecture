import { roles as knownRoles, type Role } from '@simplearchitecture/shared';
import type { Db, Queryable } from '../db/db.js';
import { neverUsedClientLifetimeMs, unusedClientLifetimeMs } from './rules.js';

/**
 * The OAuth server's tables (migration 008), and nothing else: the rules are in oauth-service.ts.
 * Codes and tokens arrive here already hashed. Every query is parameterised.
 */

export interface StoredClient {
  id: string;
  name: string;
  redirectUris: string[];
}

/** An authorize request waiting for the user's decision. */
export interface HeldRequest {
  clientId: string;
  clientName: string;
  redirectUri: string;
  codeChallenge: string;
  state: string | undefined;
  resource: string;
}

export interface StoredCode {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  resource: string;
  userId: string;
  /** The display name at sign-in (Admin → Connected apps shows it). */
  userName: string;
  roles: Role[];
  expiresAt: number;
}

/** A live connection, as an access token or a refresh shows it. */
export interface StoredConnection {
  id: string;
  clientId: string;
  userId: string;
  roles: Role[];
  resource: string;
  expiresAt: number;
}

/** A connection, for the Connected apps pages (the user's own, and Admin's). */
export interface ConnectionListing {
  id: string;
  userId: string;
  userName: string;
  clientName: string;
  /** Where the browser went back to when the user allowed it. */
  redirectUri: string;
  connectedAt: number;
  lastUsedAt: number | null;
  expiresAt: number;
}

/** What an Admin disconnects: one connection, all of one user's, or all. */
export type AdminScope =
  { kind: 'one'; connectionId: string } | { kind: 'user'; userId: string } | { kind: 'all' };

/** The audit action of each Admin disconnect. */
export const adminActions = {
  one: 'mcp-admin-disconnected',
  user: 'mcp-admin-disconnected-user',
  all: 'mcp-admin-disconnected-all',
} as const;

/** The tokens a new connection or a refresh gives out (hashes only). */
export interface IssuedHashes {
  accessHash: string;
  accessExpiresAt: number;
  refreshHash: string;
}

export type CodeExchange<R> =
  | { kind: 'unknown' }
  /** The code was used before: the connection it started has ended. */
  | { kind: 'reused'; endedConnection: string | null }
  | { kind: 'refused'; reason: R }
  | { kind: 'issued'; connection: StoredConnection };

export type RefreshOutcome =
  | { kind: 'unknown' }
  | { kind: 'wrong-client' }
  | { kind: 'expired' }
  /** The refresh token was used before: its connection has ended. */
  | { kind: 'reused'; endedConnection: string }
  | { kind: 'rotated'; connection: StoredConnection };

function rolesOf(value: unknown): Role[] {
  return Array.isArray(value) ? knownRoles.filter((role) => value.includes(role)) : [];
}

function textList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

interface ConnectionRow {
  id: string;
  client_id: string;
  user_id: string;
  user_roles: unknown;
  resource: string;
  expires_at: Date;
}

function connectionOf(row: ConnectionRow): StoredConnection {
  return {
    id: row.id,
    clientId: row.client_id,
    userId: row.user_id,
    roles: rolesOf(row.user_roles),
    resource: row.resource,
    expiresAt: row.expires_at.getTime(),
  };
}

async function insertTokens(
  tx: Queryable,
  connectionId: string,
  hashes: IssuedHashes,
  connectionEnds: Date,
): Promise<void> {
  await tx.query(
    `insert into mcp_tokens (hash, connection_id, kind, expires_at)
     values ($1, $2, 'access', $3), ($4, $2, 'refresh', $5)`,
    [
      hashes.accessHash,
      connectionId,
      new Date(hashes.accessExpiresAt),
      hashes.refreshHash,
      connectionEnds,
    ],
  );
}

/**
 * A client that got a token: `last_used_at` moves past `created_at` (by at least a millisecond),
 * so a client whose two are still equal never got one.
 */
const usedClient = `update mcp_clients
  set last_used_at = greatest($2, created_at + interval '1 millisecond') where id = $1`;

/** Clients that never got a token and have no connection, oldest first. */
const neverUsed = `cl.last_used_at = cl.created_at
  and not exists (select 1 from mcp_connections c where c.client_id = cl.id)`;

export class OAuthStore {
  constructor(private readonly db: Db) {}

  /**
   * Stores a new client, keeping at most `maxClients`: at the cap, the oldest client that never got
   * a token makes room. False, and nothing stored, when every client kept has had one.
   */
  async insertClient(client: StoredClient, at: number, maxClients: number): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      const [row] = await tx.query<{ count: number }>(
        'select count(*)::int as count from mcp_clients',
      );
      const over = (row?.count ?? 0) - maxClients + 1;
      if (over > 0) {
        const freed = await tx.query<{ id: string }>(
          `delete from mcp_clients where id in (
             select cl.id from mcp_clients cl where ${neverUsed}
             order by cl.created_at, cl.id limit $1
           ) returning id`,
          [over],
        );
        if (freed.length < over) return false;
      }
      await tx.query(
        `insert into mcp_clients (id, name, redirect_uris, created_at, last_used_at)
         values ($1, $2, $3::text::jsonb, $4, $4)`,
        [client.id, client.name, JSON.stringify(client.redirectUris), new Date(at)],
      );
      return true;
    });
  }

  async getClient(id: string): Promise<StoredClient | undefined> {
    const [row] = await this.db.query<{ id: string; name: string; redirect_uris: unknown }>(
      'select id, name, redirect_uris from mcp_clients where id = $1',
      [id],
    );
    return row === undefined
      ? undefined
      : { id: row.id, name: row.name, redirectUris: textList(row.redirect_uris) };
  }

  async holdRequest(hash: string, request: HeldRequest, expiresAt: number): Promise<void> {
    await this.db.query(
      `insert into mcp_authorization_requests (hash, client_id, redirect_uri, code_challenge,
         state, resource, expires_at)
       values ($1, $2, $3, $4, $5, $6, $7)`,
      [
        hash,
        request.clientId,
        request.redirectUri,
        request.codeChallenge,
        request.state ?? null,
        request.resource,
        new Date(expiresAt),
      ],
    );
  }

  /**
   * A held request that hasn't expired, with its client's name, for this user: the first user to
   * open it holds it, and nobody else gets it. `take` uses it up.
   */
  async heldRequest(
    hash: string,
    at: number,
    userId: string,
    take: boolean,
  ): Promise<HeldRequest | undefined> {
    const [row] = await this.db.query<{
      client_id: string;
      name: string;
      redirect_uri: string;
      code_challenge: string;
      state: string | null;
      resource: string;
    }>(
      `with held as (
         ${
           take
             ? 'delete from mcp_authorization_requests'
             : 'update mcp_authorization_requests set user_id = $3'
         }
         where hash = $1 and expires_at > $2 and (user_id is null or user_id = $3)
         returning *
       )
       select t.client_id, c.name, t.redirect_uri, t.code_challenge, t.state, t.resource
       from held t join mcp_clients c on c.id = t.client_id`,
      [hash, new Date(at), userId],
    );
    return row === undefined
      ? undefined
      : {
          clientId: row.client_id,
          clientName: row.name,
          redirectUri: row.redirect_uri,
          codeChallenge: row.code_challenge,
          state: row.state ?? undefined,
          resource: row.resource,
        };
  }

  async insertCode(hash: string, code: StoredCode, at: number): Promise<void> {
    await this.db.query(
      `insert into mcp_codes (hash, client_id, redirect_uri, code_challenge, resource, user_id,
         user_name, user_roles, created_at, expires_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8::text::jsonb, $9, $10)`,
      [
        hash,
        code.clientId,
        code.redirectUri,
        code.codeChallenge,
        code.resource,
        code.userId,
        code.userName,
        JSON.stringify(code.roles),
        new Date(at),
        new Date(code.expiresAt),
      ],
    );
  }

  /**
   * Uses a code once, in one transaction: marks it used, asks `check` whether the request fits
   * it (a reason to refuse, or undefined), and starts the connection with its tokens. The
   * connection ends at `connection.expiresAt` at the latest. A code that was used before ends the
   * connection it started.
   */
  async exchangeCode<R>(
    hash: string,
    at: number,
    check: (code: StoredCode) => R | undefined,
    connection: { id: string; expiresAt: number; hashes: IssuedHashes },
  ): Promise<CodeExchange<R>> {
    return this.db.transaction(async (tx) => {
      const [row] = await tx.query<{
        client_id: string;
        redirect_uri: string;
        code_challenge: string;
        resource: string;
        user_id: string;
        user_name: string;
        user_roles: unknown;
        expires_at: Date;
      }>(
        `update mcp_codes set used_at = $2 where hash = $1 and used_at is null
         returning client_id, redirect_uri, code_challenge, resource, user_id, user_name,
           user_roles, expires_at`,
        [hash, new Date(at)],
      );
      if (row === undefined) {
        const [used] = await tx.query<{ connection_id: string | null }>(
          'select connection_id from mcp_codes where hash = $1',
          [hash],
        );
        if (used === undefined) return { kind: 'unknown' };
        if (used.connection_id !== null) {
          await tx.query('delete from mcp_connections where id = $1', [used.connection_id]);
        }
        return { kind: 'reused', endedConnection: used.connection_id };
      }
      const code: StoredCode = {
        clientId: row.client_id,
        redirectUri: row.redirect_uri,
        codeChallenge: row.code_challenge,
        resource: row.resource,
        userId: row.user_id,
        userName: row.user_name,
        roles: rolesOf(row.user_roles),
        expiresAt: row.expires_at.getTime(),
      };
      const reason = check(code);
      if (reason !== undefined) return { kind: 'refused', reason };

      const ends = new Date(connection.expiresAt);
      await tx.query(
        `insert into mcp_connections (id, client_id, user_id, user_name, user_roles, resource,
           redirect_uri, created_at, expires_at)
         values ($1, $2, $3, $4, $5::text::jsonb, $6, $7, $8, $9)`,
        [
          connection.id,
          code.clientId,
          code.userId,
          code.userName,
          JSON.stringify(code.roles),
          code.resource,
          code.redirectUri,
          new Date(at),
          ends,
        ],
      );
      await insertTokens(tx, connection.id, connection.hashes, ends);
      await tx.query('update mcp_codes set connection_id = $2 where hash = $1', [
        hash,
        connection.id,
      ]);
      await tx.query(usedClient, [code.clientId, new Date(at)]);
      return {
        kind: 'issued',
        connection: {
          id: connection.id,
          clientId: code.clientId,
          userId: code.userId,
          roles: code.roles,
          resource: code.resource,
          expiresAt: connection.expiresAt,
        },
      };
    });
  }

  /**
   * Swaps a refresh token for new tokens, in one transaction. A token used before ends its
   * connection; one presented by another client is refused and stays as it was.
   */
  async rotateRefresh(
    hash: string,
    clientId: string,
    at: number,
    issue: (connection: StoredConnection) => IssuedHashes,
  ): Promise<RefreshOutcome> {
    return this.db.transaction(async (tx) => {
      const [row] = await tx.query<ConnectionRow & { used_at: Date | null }>(
        `select t.used_at, c.id, c.client_id, c.user_id, c.user_roles, c.resource, c.expires_at
         from mcp_tokens t join mcp_connections c on c.id = t.connection_id
         where t.hash = $1 and t.kind = 'refresh'
         for update of t`,
        [hash],
      );
      if (row === undefined) return { kind: 'unknown' };
      if (row.client_id !== clientId) return { kind: 'wrong-client' };
      if (row.used_at !== null) {
        await tx.query('delete from mcp_connections where id = $1', [row.id]);
        return { kind: 'reused', endedConnection: row.id };
      }
      const connection = connectionOf(row);
      if (connection.expiresAt <= at) return { kind: 'expired' };

      await tx.query('update mcp_tokens set used_at = $2 where hash = $1', [hash, new Date(at)]);
      await insertTokens(tx, connection.id, issue(connection), row.expires_at);
      await tx.query('update mcp_connections set last_used_at = $2 where id = $1', [
        connection.id,
        new Date(at),
      ]);
      await tx.query(usedClient, [clientId, new Date(at)]);
      return { kind: 'rotated', connection };
    });
  }

  /** The live connection of a live access token, or undefined. */
  async findByAccessToken(hash: string, at: number): Promise<StoredConnection | undefined> {
    const [row] = await this.db.query<ConnectionRow & { last_used_at: Date | null }>(
      `select c.id, c.client_id, c.user_id, c.user_roles, c.resource, c.expires_at, c.last_used_at
       from mcp_tokens t join mcp_connections c on c.id = t.connection_id
       where t.hash = $1 and t.kind = 'access' and t.expires_at > $2 and c.expires_at > $2`,
      [hash, new Date(at)],
    );
    if (row === undefined) return undefined;
    // "Last used" for the list of connected agents, to the minute: not a write on every call.
    if (row.last_used_at === null || row.last_used_at.getTime() <= at - 60_000) {
      await this.db.query('update mcp_connections set last_used_at = $2 where id = $1', [
        row.id,
        new Date(at),
      ]);
    }
    return connectionOf(row);
  }

  /** Ends the connection a token of this client belongs to. Its id and user, or undefined. */
  async endConnectionOfToken(
    hash: string,
    clientId: string,
  ): Promise<{ id: string; userId: string } | undefined> {
    const [row] = await this.db.query<{ id: string; user_id: string }>(
      `delete from mcp_connections
       where client_id = $2 and id = (select connection_id from mcp_tokens where hash = $1)
       returning id, user_id`,
      [hash, clientId],
    );
    return row === undefined ? undefined : { id: row.id, userId: row.user_id };
  }

  /** A user's live connections (or everyone's, without a user), newest first. */
  async listConnections(userId: string | undefined, at: number): Promise<ConnectionListing[]> {
    const rows = await this.db.query<{
      id: string;
      user_id: string;
      user_name: string;
      name: string;
      redirect_uri: string;
      created_at: Date;
      last_used_at: Date | null;
      expires_at: Date;
    }>(
      `select c.id, c.user_id, c.user_name, cl.name, c.redirect_uri, c.created_at,
         c.last_used_at, c.expires_at
       from mcp_connections c join mcp_clients cl on cl.id = c.client_id
       where ($1::text is null or c.user_id = $1) and c.expires_at > $2
       order by c.created_at desc, c.id`,
      [userId ?? null, new Date(at)],
    );
    return rows.map((row) => ({
      id: row.id,
      userId: row.user_id,
      userName: row.user_name,
      clientName: row.name,
      redirectUri: row.redirect_uri,
      connectedAt: row.created_at.getTime(),
      lastUsedAt: row.last_used_at?.getTime() ?? null,
      expiresAt: row.expires_at.getTime(),
    }));
  }

  /** Ends one of the user's connections (its tokens go with it). Whether there was one. */
  async endConnection(userId: string, connectionId: string): Promise<boolean> {
    const rows = await this.db.query<{ id: string }>(
      'delete from mcp_connections where id = $1 and user_id = $2 returning id',
      [connectionId, userId],
    );
    return rows.length > 0;
  }

  /**
   * An Admin ends live connections: one, all of one user's, or all (those already over are left
   * to the sweep, so the count is what the list showed). In one transaction with the audit row
   * (who, the action, the ids and the count; never client names or tokens). How many ended.
   */
  async endConnectionsAsAdmin(
    scope: AdminScope,
    admin: { id: string; name: string },
    at: number,
  ): Promise<number> {
    return this.db.transaction(async (tx) => {
      const ended =
        scope.kind === 'one'
          ? await tx.query<{ id: string }>(
              'delete from mcp_connections where id = $1 and expires_at > $2 returning id',
              [scope.connectionId, new Date(at)],
            )
          : scope.kind === 'user'
            ? await tx.query<{ id: string }>(
                'delete from mcp_connections where user_id = $1 and expires_at > $2 returning id',
                [scope.userId, new Date(at)],
              )
            : await tx.query<{ id: string }>(
                'delete from mcp_connections where expires_at > $1 returning id',
                [new Date(at)],
              );
      if (ended.length === 0) return 0;
      const details =
        scope.kind === 'one'
          ? { connectionId: scope.connectionId, connections: 1 }
          : scope.kind === 'user'
            ? { targetUserId: scope.userId, connections: ended.length }
            : { connections: ended.length };
      await tx.query(
        `insert into audit (action, user_id, user_name, details)
         values ($1, $2, $3, $4::text::jsonb)`,
        [adminActions[scope.kind], admin.id, admin.name, JSON.stringify(details)],
      );
      return ended.length;
    });
  }

  /**
   * Removes what is over: expired held requests, codes an hour after they expire (a used one is
   * kept that long, so a second use is noticed), expired access tokens, ended connections with
   * their tokens, clients that never got a token an hour after they registered, and other clients
   * with no connection that haven't been used for 30 days.
   */
  async sweep(at: number): Promise<{ connections: number; clients: number }> {
    return this.db.transaction(async (tx) => {
      await tx.query('delete from mcp_authorization_requests where expires_at <= $1', [
        new Date(at),
      ]);
      await tx.query('delete from mcp_codes where expires_at <= $1', [
        new Date(at - 60 * 60 * 1000),
      ]);
      await tx.query("delete from mcp_tokens where kind = 'access' and expires_at <= $1", [
        new Date(at),
      ]);
      const connections = await tx.query<{ id: string }>(
        'delete from mcp_connections where expires_at <= $1 returning id',
        [new Date(at)],
      );
      const clients = await tx.query<{ id: string }>(
        `delete from mcp_clients cl
         where not exists (select 1 from mcp_connections c where c.client_id = cl.id)
           and (cl.last_used_at <= $1 or (${neverUsed} and cl.created_at <= $2))
         returning cl.id`,
        [new Date(at - unusedClientLifetimeMs), new Date(at - neverUsedClientLifetimeMs)],
      );
      return { connections: connections.length, clients: clients.length };
    });
  }
}
