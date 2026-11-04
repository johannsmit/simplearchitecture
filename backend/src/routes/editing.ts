import type { ApiError, ElementConflict, RelationshipRejected } from '@simplearchitecture/shared';
import type { FastifyReply, FastifyRequest } from 'fastify';
import {
  ConflictError,
  EditingUnavailableError,
  NotFoundError,
  RejectedError,
  rejectedMessage,
  type Missing,
} from '../editing/common.js';
import { errorBody } from '../errors.js';
import {
  isModelId,
  ModelNotStorableError,
  ModelTooLargeError,
  ModelUnreadableError,
} from '../storage/model-store.js';
import { invalidModelIdMessage } from './models.js';

/** What the element and relationship routes share: the actor, the answers to refusals, logging. */

// Editing is modelling: Modeller and Admin.
export const modelling = { access: { space: 'modelling' } } as const;

export function actor(request: FastifyRequest): { id: string; name: string } {
  const user = request.session?.user;
  if (!user) throw new Error('editing route reached without a session');
  return { id: user.id, name: user.name };
}

/** 400 for a model id that can't be one, else undefined. */
export function badModelId(reply: FastifyReply, id: string): FastifyReply | undefined {
  return isModelId(id) ? undefined : reply.code(400).send(errorBody(400, invalidModelIdMessage));
}

/** The answer to a refused change, with a fixed message; anything else is rethrown (500). */
export function refused(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof RejectedError) {
    const body: RelationshipRejected = {
      ...errorBody(422, error.message),
      fields: error.fields,
      ...(error.duplicateOf === undefined ? {} : { duplicateOf: error.duplicateOf }),
    };
    return reply.code(422).send(body);
  }
  if (error instanceof ConflictError) {
    const body: ElementConflict = {
      ...errorBody(409, error.message),
      currentVersion: error.currentVersion,
    };
    return reply.code(409).send(body);
  }
  if (error instanceof NotFoundError) {
    // ElementNotFound or RelationshipNotFound: `missing` says which.
    const body: ApiError & { missing: Missing } = {
      ...errorBody(404, error.message),
      missing: error.what,
    };
    return reply.code(404).send(body);
  }
  if (error instanceof EditingUnavailableError) {
    return reply.code(501).send(errorBody(501, error.message));
  }
  if (error instanceof ModelNotStorableError) {
    const body: RelationshipRejected = {
      ...errorBody(422, rejectedMessage),
      fields: [{ field: '', message: error.message }],
    };
    return reply.code(422).send(body);
  }
  if (error instanceof ModelTooLargeError) {
    return reply.code(413).send(errorBody(413, error.message));
  }
  if (error instanceof ModelUnreadableError) {
    // The store has logged the reason. The message is user-safe.
    return reply.code(500).send(errorBody(500, error.message));
  }
  throw error;
}

/** Ids and the action only: field names and values can be model content. */
export function auditLog(
  request: FastifyRequest,
  audit: string,
  ids: { modelId: string; elementId?: string; relationshipId?: string },
  extra: object = {},
): void {
  request.log.info({ audit, userId: actor(request).id, ...ids, ...extra }, audit.replace('-', ' '));
}
