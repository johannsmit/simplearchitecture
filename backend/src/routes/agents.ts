import type {
  AdminConnectedAppList,
  AdminDisconnectResult,
  AgentDecisionResult,
  AgentRequest,
  ApiError,
  ConnectedAppList,
} from '@simplearchitecture/shared';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { errorBody } from '../errors.js';
import type { OAuthService } from '../mcp-auth/oauth-service.js';
import type { ConnectionListing } from '../mcp-auth/oauth-store.js';
import { requireMediaType } from './body.js';

/**
 * The web app's side of connecting AI agents: the consent page reads a held authorize request and
 * posts the user's decision; the Connected apps page lists the user's own connections and
 * disconnects one. Any signed-in user may call these (someone who lost their role can still
 * disconnect); only Viewer or higher can allow. The rules are in mcp-auth/oauth-service.ts.
 */

const signedIn = { access: 'authenticated' } as const;
const admin = { access: { space: 'admin' } } as const;
export const requestNotValidMessage = 'This request is not valid. Connect again from your agent.';
const decisionSchema = z.strictObject({ allow: z.boolean() });

interface IdParams {
  id: string;
}

function userOf(request: FastifyRequest) {
  const user = request.session?.user;
  if (!user) throw new Error('agents route reached without a session');
  return user;
}

function isLoopback(redirectUri: string): boolean {
  return new URL(redirectUri).protocol === 'http:';
}

function appOf(connection: ConnectionListing) {
  return {
    id: connection.id,
    clientName: connection.clientName === '' ? null : connection.clientName,
    redirectHost: new URL(connection.redirectUri).host,
    loopback: isLoopback(connection.redirectUri),
    connectedAt: new Date(connection.connectedAt).toISOString(),
    lastUsedAt:
      connection.lastUsedAt === null ? null : new Date(connection.lastUsedAt).toISOString(),
    expiresAt: new Date(connection.expiresAt).toISOString(),
  };
}

export function agentRoutes(service: OAuthService): FastifyPluginAsync {
  return async (app) => {
    app.get<{ Params: IdParams; Reply: AgentRequest | ApiError }>(
      '/api/agents/requests/:id',
      { config: signedIn },
      async (request, reply) => {
        const held = await service.heldAuthorization(request.params.id, userOf(request).id);
        if (held === undefined) return reply.code(404).send(errorBody(404, requestNotValidMessage));
        return {
          clientName: held.clientName,
          redirectHost: held.redirectHost,
          loopback: held.loopback,
          connectionEndsAt: new Date(held.connectionEndsAt).toISOString(),
        };
      },
    );

    app.post<{ Params: IdParams; Reply: AgentDecisionResult | ApiError }>(
      '/api/agents/requests/:id',
      {
        config: signedIn,
        bodyLimit: 1024,
        onRequest: requireMediaType(['application/json'], 'Send the decision as application/json'),
      },
      async (request, reply) => {
        const decision = decisionSchema.safeParse(request.body);
        if (!decision.success) {
          return reply.code(400).send(errorBody(400, 'Send {"allow": true} or {"allow": false}.'));
        }
        const user = userOf(request);
        const result = await service.decide(request.params.id, user, decision.data.allow);
        if (result === undefined) {
          return reply.code(404).send(errorBody(404, requestNotValidMessage));
        }
        if (result.kind === 'not-allowed') {
          return reply
            .code(403)
            .send(errorBody(403, 'You need the Viewer role or higher to connect an agent.'));
        }
        return { location: result.location };
      },
    );

    app.get<{ Reply: ConnectedAppList }>('/api/agents', { config: signedIn }, async (request) => ({
      apps: (await service.listConnections(userOf(request).id)).map(appOf),
    }));

    app.delete<{ Params: IdParams }>(
      '/api/agents/:id',
      { config: signedIn },
      async (request, reply) => {
        const ended = await service.disconnect(userOf(request).id, request.params.id);
        if (!ended) return reply.code(404).send(errorBody(404, 'No such connection.'));
        return reply.code(204).send();
      },
    );

    // Admin → Connected apps: every user's connections. Each disconnect is audited.
    app.get<{ Reply: AdminConnectedAppList }>('/api/admin/agents', { config: admin }, async () => ({
      apps: (await service.listAllConnections()).map((connection) => ({
        ...appOf(connection),
        userId: connection.userId,
        userName: connection.userName,
      })),
    }));

    app.delete<{ Params: IdParams }>(
      '/api/admin/agents/:id',
      { config: admin },
      async (request, reply) => {
        const ended = await service.disconnectAny(userOf(request), request.params.id);
        if (!ended) return reply.code(404).send(errorBody(404, 'No such connection.'));
        return reply.code(204).send();
      },
    );

    app.delete<{ Params: { userId: string }; Reply: AdminDisconnectResult }>(
      '/api/admin/agents/users/:userId',
      { config: admin },
      async (request) => ({
        disconnected: await service.disconnectAllForUser(userOf(request), request.params.userId),
      }),
    );

    app.delete<{ Reply: AdminDisconnectResult }>(
      '/api/admin/agents',
      { config: admin },
      async (request) => ({ disconnected: await service.disconnectAll(userOf(request)) }),
    );
  };
}
