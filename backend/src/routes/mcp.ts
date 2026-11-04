import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/server';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { buildMcpServer } from '../mcp/mcp-server.js';
import type { McpReadService } from '../mcp/read-service.js';
import { rateLimit, RateLimiter } from '../rate-limit.js';

/** MCP requests per user per minute, and the largest request body (tool arguments are small). */
export const mcpCallsPerMinute = 120;
export const mcpBodyLimit = 256 * 1024;

export interface McpRouteOptions {
  service: McpReadService;
  /** The endpoint's own address (`<app>/mcp`), for the request the SDK sees. */
  resource: string;
  now: () => number;
}

/** The request's headers for the SDK, without credentials: it never needs them. */
function sdkHeaders(request: FastifyRequest): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (name === 'authorization' || name === 'cookie' || value === undefined) continue;
    for (const item of [value].flat()) headers.append(name, item);
  }
  return headers;
}

/**
 * The MCP endpoint (Streamable HTTP, stateless): a new server and transport per request, JSON
 * answers, no server-side session. The access guard (mcp-auth/guard.ts) has checked the token.
 * There is no event stream to open, so GET and DELETE get 405.
 */
export function mcpRoutes({ service, resource, now }: McpRouteOptions): FastifyPluginAsync {
  const perUser = rateLimit(
    new RateLimiter(mcpCallsPerMinute, 60_000, now),
    (request) => request.mcpAuth?.userId,
    { message: 'Too many requests. Wait a minute and try again.' },
  );

  return async (app) => {
    app.post(
      '/mcp',
      { config: { access: 'mcp' }, bodyLimit: mcpBodyLimit, onRequest: perUser },
      async (request, reply) => {
        const auth = request.mcpAuth;
        if (auth === null) throw new Error('MCP route reached without a token');
        const server = buildMcpServer(service, auth, request.log);
        const transport = new WebStandardStreamableHTTPServerTransport({
          sessionIdGenerator: undefined,
          enableJsonResponse: true,
        });
        try {
          await server.connect(transport);
          const response = await transport.handleRequest(
            new Request(resource, { method: 'POST', headers: sdkHeaders(request) }),
            { parsedBody: request.body },
          );
          const contentType = response.headers.get('content-type');
          if (contentType !== null) void reply.type(contentType);
          return await reply.code(response.status).send(await response.text());
        } finally {
          await server.close();
        }
      },
    );

    for (const method of ['GET', 'DELETE'] as const) {
      app.route({
        method,
        url: '/mcp',
        config: { access: 'mcp' },
        handler: async (_request, reply) =>
          reply.code(405).header('allow', 'POST').send({ error: 'method_not_allowed' }),
      });
    }
  };
}
