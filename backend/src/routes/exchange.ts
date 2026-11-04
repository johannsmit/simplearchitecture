import type { JgfDocument, JgfValidationResult, OefImportResult } from '@simplearchitecture/shared';
import type {
  FastifyPluginAsync,
  FastifyReply,
  FastifyRequest,
  onRequestAsyncHookHandler,
} from 'fastify';
import { errorBody } from '../errors.js';
import { sampleModel } from '../jgf/sample.js';
import { validateImported } from '../jgf/older-types.js';
import { validateJgf } from '../jgf/validate.js';
import { ImportTooLargeError } from '../limits.js';
import { convertOef, OefFormatError } from '../oef/mapper.js';
import type { OefMapping } from '../oef/mapping-config.js';
import { XmlRejectedError } from '../oef/xml.js';
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

const modelling = { access: { space: 'modelling' } } as const;

/**
 * Converts the OEF body and validates the result. On a refused file it answers 400 or 413 itself
 * and returns undefined. Shared by the convert-only route and the import-and-save route.
 */
export function convertOefBody(
  request: FastifyRequest,
  reply: FastifyReply,
  mapping: OefMapping,
): OefImportResult | undefined {
  if (typeof request.body !== 'string') {
    void reply.code(415).send(errorBody(415, oefMediaTypeMessage));
    return undefined;
  }
  try {
    const { jgf, report } = convertOef(request.body, mapping);
    const validation = validateJgf(jgf);
    request.log.info(
      {
        elements: report.elements.total,
        relationships: report.relationships.total,
        errors: validation.errorCount,
        warnings: validation.warningCount,
      },
      'OEF import converted',
    );
    return { jgf, report, validation };
  } catch (error) {
    if (error instanceof ImportTooLargeError) {
      request.log.info({ reason: error.message }, 'OEF import too large');
      void reply.code(413).send(errorBody(413, error.message));
      return undefined;
    }
    if (error instanceof XmlRejectedError || error instanceof OefFormatError) {
      // Messages are bounded: names from the input are cut short (see xml.ts).
      request.log.info({ reason: error.message }, 'OEF import rejected');
      void reply.code(400).send(errorBody(400, error.message));
      return undefined;
    }
    throw error;
  }
}

/**
 * Model exchange: JGF import (validate only) and export, and ArchiMate OEF import.
 * Nothing is stored yet. Modelling space only (Modeller and Admin).
 */
export function exchangeRoutes(
  mapping: OefMapping,
  uploadLimit: onRequestAsyncHookHandler,
): FastifyPluginAsync {
  return async (app) => {
    registerModelBodyParsers(app);

    app.post<{ Reply: JgfValidationResult | ReturnType<typeof errorBody> }>(
      '/api/import/jgf',
      {
        config: modelling,
        bodyLimit: jgfBodyLimit,
        onRequest: [uploadLimit, requireMediaType(jgfMediaTypes, jgfMediaTypeMessage)],
      },
      async (request, reply) => {
        const tooLarge = jgfTooLarge(request);
        if (tooLarge !== undefined) return reply.code(413).send(errorBody(413, tooLarge));
        const { validation: result } = validateImported(request.body);
        request.log.info(
          { errors: result.errorCount, warnings: result.warningCount },
          'JGF import validated',
        );
        return result;
      },
    );

    app.post<{ Reply: OefImportResult | ReturnType<typeof errorBody> }>(
      '/api/import/oef',
      {
        config: modelling,
        bodyLimit: oefBodyLimit,
        onRequest: [uploadLimit, requireMediaType(oefMediaTypes, oefMediaTypeMessage)],
      },
      async (request, reply) => convertOefBody(request, reply, mapping) ?? reply,
    );

    app.get<{ Reply: JgfDocument }>(
      '/api/export/jgf',
      { config: modelling },
      async () => sampleModel,
    );
  };
}
