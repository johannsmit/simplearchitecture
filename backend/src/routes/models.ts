import type {
  ApiError,
  DamagedModelListResponse,
  ImportOefModelResult,
  JgfDocument,
  JgfValidationResult,
  ModelListResponse,
  ElementRejected,
  ModelRejected,
  ModelSummary,
  NewModelResult,
  OefMappingReport,
  SaveModelResult,
} from '@simplearchitecture/shared';
import type {
  FastifyPluginAsync,
  FastifyReply,
  FastifyRequest,
  onRequestAsyncHookHandler,
} from 'fastify';
import { RejectedError } from '../editing/common.js';
import { errorBody } from '../errors.js';
import { validateImported } from '../jgf/older-types.js';
import { newModelBodyLimit } from '../limits.js';
import type { ModelService } from '../models/model-service.js';
import type { OefMapping } from '../oef/mapping-config.js';
import {
  isModelId,
  ModelNotDeletableError,
  ModelNotStorableError,
  ModelStoreFullError,
  ModelTooLargeError,
  ModelUnreadableError,
  type DeletedModel,
  type ModelStore,
} from '../storage/model-store.js';
import {
  jgfBodyLimit,
  jgfMediaTypeMessage,
  jgfMediaTypes,
  jgfTooLarge,
  oefBodyLimit,
  oefMediaTypeMessage,
  oefMediaTypes,
  registerModelBodyParsers,
  requireMediaType,
} from './body.js';
import { convertOefBody } from './exchange.js';

const viewing = { access: { space: 'viewing' } } as const;
// Saving, importing and deleting stored models is model management: Admin only.
const admin = { access: { space: 'admin' } } as const;

export const invalidModelIdMessage = 'The model id must be a UUID.';
export const modelNotFoundMessage = 'Model not found';

interface IdParams {
  id: string;
}

/** The signed-in user. The access guard has already refused requests without a session. */
function author(request: FastifyRequest): { id: string; name: string } {
  const user = request.session?.user;
  if (!user) throw new Error('model route reached without a session');
  return { id: user.id, name: user.name };
}

function rejected(
  reply: FastifyReply,
  validation: JgfValidationResult,
  report?: OefMappingReport,
): FastifyReply {
  const count = validation.errorCount;
  const body: ModelRejected = {
    ...errorBody(
      422,
      `The model is not valid (${count} ${count === 1 ? 'error' : 'errors'}). Nothing was saved.`,
    ),
    validation,
    ...(report === undefined ? {} : { report }),
  };
  return reply.code(422).send(body);
}

/**
 * The answer when the store refuses a model (full, too large, not storable), or undefined for any
 * other error.
 */
function storeRefused(
  request: FastifyRequest,
  reply: FastifyReply,
  error: unknown,
): FastifyReply | undefined {
  if (error instanceof ModelStoreFullError) {
    request.log.info({ maxModels: error.maxModels }, 'model store full');
    return reply.code(409).send(errorBody(409, error.message));
  }
  if (error instanceof ModelTooLargeError) {
    request.log.info({ maxBytes: error.maxBytes }, 'model too large to store');
    return reply.code(413).send(errorBody(413, error.message));
  }
  if (error instanceof ModelNotStorableError) {
    request.log.info('model not storable');
    return reply.code(422).send(errorBody(422, error.message));
  }
  return undefined;
}

/**
 * Saves a validated model and writes the audit line (ids and counts only, never names or
 * content). Answers 409 itself when the store is full and returns undefined.
 */
async function saveModel(
  request: FastifyRequest,
  reply: FastifyReply,
  store: ModelStore,
  document: JgfDocument,
  audit: 'model-saved' | 'model-imported',
): Promise<ModelSummary | undefined> {
  const user = author(request);
  let model: ModelSummary;
  try {
    model = await store.save(document, user);
  } catch (error) {
    if (storeRefused(request, reply, error) !== undefined) return undefined;
    throw error;
  }
  request.log.info(
    {
      audit,
      userId: user.id,
      modelId: model.id,
      nodes: model.nodeCount,
      edges: model.edgeCount,
    },
    audit === 'model-saved' ? 'model saved' : 'model imported and saved',
  );
  void reply.code(201).header('location', `/api/models/${model.id}`);
  return model;
}

export interface ModelRouteOptions {
  store: ModelStore;
  service: ModelService;
  mapping: OefMapping;
  /** The upload budget shared by every upload route. */
  uploadLimit: onRequestAsyncHookHandler;
  /** New models per user (see rate-limit.ts). */
  newModelLimit: onRequestAsyncHookHandler;
}

/**
 * Stored models. Viewing lists and reads them; only Admin creates, saves, imports and deletes
 * them. The `:id` is checked to be a UUID before the store sees it, so it can never name another
 * file.
 *
 * Model errors (the JGF is well-formed but breaks the metamodel) get 422 with the validation
 * result: the client can show the issue list. A body that can't be parsed gets 400, a body over
 * the caps 413, and an unsupported media type 415, as on the import routes. A refused new model
 * name gets 422 with `fields`, as on the element routes.
 */
export function modelRoutes({
  store,
  service,
  mapping,
  uploadLimit,
  newModelLimit,
}: ModelRouteOptions): FastifyPluginAsync {
  return async (app) => {
    registerModelBodyParsers(app);

    app.get<{ Reply: ModelListResponse }>('/api/models', { config: viewing }, async () => ({
      models: await store.list(),
      // Editing needs PostgreSQL. Only the yes or no: never any connection details.
      editable: store.elements !== undefined,
    }));

    // Damaged or unreadable model files: ids only, for Admins, so they can be deleted.
    app.get<{ Reply: DamagedModelListResponse }>(
      '/api/admin/models/damaged',
      { config: admin },
      async () => ({ models: (await store.listDamaged()).map((id) => ({ id })) }),
    );

    app.get<{ Params: IdParams; Reply: JgfDocument | ApiError }>(
      '/api/models/:id',
      { config: viewing },
      async (request, reply) => {
        const { id } = request.params;
        if (!isModelId(id)) return reply.code(400).send(errorBody(400, invalidModelIdMessage));
        let document: JgfDocument | undefined;
        try {
          document = await store.get(id);
        } catch (error) {
          if (error instanceof ModelUnreadableError) {
            // The store has logged the file name and the reason. The message is user-safe.
            return reply.code(500).send(errorBody(500, error.message));
          }
          throw error;
        }
        if (document === undefined) {
          return reply.code(404).send(errorBody(404, modelNotFoundMessage));
        }
        return document;
      },
    );

    app.post<{ Reply: SaveModelResult | ModelRejected | ApiError }>(
      '/api/models',
      {
        config: admin,
        bodyLimit: jgfBodyLimit,
        onRequest: [uploadLimit, requireMediaType(jgfMediaTypes, jgfMediaTypeMessage)],
      },
      async (request, reply) => {
        const tooLarge = jgfTooLarge(request);
        if (tooLarge !== undefined) return reply.code(413).send(errorBody(413, tooLarge));
        const { document, validation } = validateImported(request.body);
        if (!validation.valid) {
          request.log.info(
            { errors: validation.errorCount, warnings: validation.warningCount },
            'model not saved: validation errors',
          );
          return rejected(reply, validation);
        }
        // Valid, so the body has the JGF shape.
        const model = await saveModel(
          request,
          reply,
          store,
          document as JgfDocument,
          'model-saved',
        );
        return model === undefined ? reply : { model, validation };
      },
    );

    // A new, empty model. Not under `:id`, and POST /api/models takes a whole JGF document.
    app.post<{ Reply: NewModelResult | ElementRejected | ApiError }>(
      '/api/models/new',
      {
        config: admin,
        bodyLimit: newModelBodyLimit,
        onRequest: [
          newModelLimit,
          requireMediaType(jgfMediaTypes, 'Send the new model as application/json'),
        ],
      },
      async (request, reply) => {
        const user = author(request);
        let model: ModelSummary;
        try {
          model = await service.createModel(request.body, user);
        } catch (error) {
          if (error instanceof RejectedError) {
            const body: ElementRejected = {
              ...errorBody(422, error.message),
              fields: error.fields,
            };
            return reply.code(422).send(body);
          }
          const answered = storeRefused(request, reply, error);
          if (answered !== undefined) return answered;
          throw error;
        }
        // Ids only: the name is model content.
        request.log.info(
          { audit: 'model-created', userId: user.id, modelId: model.id },
          'model created',
        );
        return reply.code(201).header('location', `/api/models/${model.id}`).send({ model });
      },
    );

    app.post<{ Reply: ImportOefModelResult | ModelRejected | ApiError }>(
      '/api/models/import/oef',
      {
        config: admin,
        bodyLimit: oefBodyLimit,
        onRequest: [uploadLimit, requireMediaType(oefMediaTypes, oefMediaTypeMessage)],
      },
      async (request, reply) => {
        const conversion = convertOefBody(request, reply, mapping);
        if (conversion === undefined) return reply;
        const { jgf, report, validation } = conversion;
        if (!validation.valid) {
          request.log.info(
            { errors: validation.errorCount, warnings: validation.warningCount },
            'OEF model not saved: validation errors',
          );
          return rejected(reply, validation, report);
        }
        const model = await saveModel(request, reply, store, jgf, 'model-imported');
        return model === undefined ? reply : { model, report, validation };
      },
    );

    app.delete<{ Params: IdParams }>(
      '/api/models/:id',
      { config: admin },
      async (request, reply) => {
        const { id } = request.params;
        if (!isModelId(id)) return reply.code(400).send(errorBody(400, invalidModelIdMessage));
        let deleted: DeletedModel | undefined;
        try {
          deleted = await store.delete(id);
        } catch (error) {
          if (error instanceof ModelNotDeletableError) {
            // The store has logged the file name and the reason. The message is user-safe.
            return reply.code(409).send(errorBody(409, error.message));
          }
          throw error;
        }
        if (deleted === undefined) {
          return reply.code(404).send(errorBody(404, modelNotFoundMessage));
        }
        request.log.info(
          {
            audit: 'model-deleted',
            userId: author(request).id,
            modelId: deleted.id,
            ...(deleted.summary === undefined
              ? {}
              : { nodes: deleted.summary.nodeCount, edges: deleted.summary.edgeCount }),
          },
          'model deleted',
        );
        return reply.code(204).send();
      },
    );
  };
}
