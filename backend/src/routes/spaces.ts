import { spaces, type SpacePingResponse } from '@simplearchitecture/shared';
import type { FastifyPluginAsync } from 'fastify';

/** Placeholder endpoints, one per space, so access control can be tested end to end. */
export const spaceRoutes: FastifyPluginAsync = async (app) => {
  for (const space of spaces) {
    app.get<{ Reply: SpacePingResponse }>(
      `/api/${space}/ping`,
      { config: { access: { space } } },
      async () => ({ status: 'ok', space }),
    );
  }
};
