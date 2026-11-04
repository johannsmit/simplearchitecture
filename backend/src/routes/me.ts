import { roles, spaces, spacesForRoles, type MeResponse } from '@simplearchitecture/shared';
import type { FastifyPluginAsync } from 'fastify';

const meResponseSchema = {
  type: 'object',
  properties: {
    name: { type: 'string' },
    email: { type: ['string', 'null'] },
    roles: { type: 'array', items: { type: 'string', enum: [...roles] } },
    spaces: { type: 'array', items: { type: 'string', enum: [...spaces] } },
  },
  required: ['name', 'email', 'roles', 'spaces'],
  additionalProperties: false,
} as const;

/** The signed-in user: name, email, roles and the spaces those roles open. */
export const meRoutes: FastifyPluginAsync = async (app) => {
  app.get<{ Reply: MeResponse }>(
    '/api/me',
    { config: { access: 'authenticated' }, schema: { response: { 200: meResponseSchema } } },
    async (request) => {
      // The guard guarantees a session; this keeps the handler safe on its own.
      const user = request.session?.user;
      if (!user) throw new Error('No session on an authenticated route');
      return {
        name: user.name,
        email: user.email,
        roles: user.roles,
        spaces: spacesForRoles(user.roles),
      };
    },
  );
};
