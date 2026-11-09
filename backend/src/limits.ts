/**
 * Caps per import, so one upload can't tie up the API for long. A real model is far below them
 * (usually a few hundred elements). Larger imports get 413.
 */
export const maxImportNodes = 50_000;
export const maxImportEdges = 200_000;

/** The model has more nodes or edges than an import allows. The message is user-safe. */
export class ImportTooLargeError extends Error {
  override name = 'ImportTooLargeError';
}

/**
 * Deepest nesting of objects and arrays accepted in a JGF body (the document itself is level 1).
 * Custom metadata in a real model is a level or two deep; JSON.stringify fails somewhere past
 * 10,000 levels, so a stored model must stay far below that.
 */
export const maxJsonDepth = 100;

/** Most models the store holds. A save beyond it gets 409 until a model is deleted. */
export const maxStoredModels = 500;

/**
 * A stored model's name (from `graph.label`) is cut to this length in its metadata; a new model's
 * name may be at most this long.
 */
export { maxModelNameLength } from '@simplearchitecture/shared';

/** Largest body of a new model request (bytes): a name only. */
export const newModelBodyLimit = 16 * 1024;

/** A client's own `graph.id`, kept as `sourceId` in a stored model's metadata, is cut to this length. */
export const maxSourceIdLength = 200;

/** Largest JGF body (bytes). Larger requests get 413. */
export const jgfBodyLimit = 5 * 1024 * 1024;

/**
 * Largest model file the store writes or reads (bytes): twice the JGF body limit, so a model
 * imported from a large OEF file still fits. A larger file is never read into memory.
 */
export const maxModelFileBytes = 2 * jgfBodyLimit;

/** How many model files the store reads at once (at startup and when listing). */
export const modelReadConcurrency = 4;

/**
 * Caps on one element change (Modelling), checked before anything is stored. Imported models may
 * hold longer values; a change only checks what it sends.
 */
export const maxElementNameLength = 200;
export const maxElementDescriptionLength = 10_000;
/** A standard text property or a custom metadata value. */
export const maxPropertyValueLength = 2_000;
export const maxMetadataKeyLength = 100;
/** Custom metadata entries in one request, and standard property values in a list (Functions). */
export const maxMetadataEntries = 100;
export const maxListEntries = 100;

/** Largest body of an element change (bytes), well above what the caps above allow. */
export const elementBodyLimit = 1024 * 1024;

/** Caps on one relationship change (Modelling). An end is an element id, as stored. */
export const maxRelationshipDescriptionLength = 10_000;
/** A relationship's label: the short text on its line. */
export const maxRelationshipLabelLength = 200;
export const maxElementIdLength = 1_000;

/** Largest body of a relationship change (bytes), well above what the caps above allow. */
export const relationshipBodyLimit = 64 * 1024;

/**
 * Caps on views: names, contents, layouts and how many a model may have (shared with the web app).
 */
export {
  maxViewCardCoordinate,
  maxViewCardWidth,
  maxViewElements,
  maxViewNameLength,
  maxViewRelationships,
  maxViewsPerModel,
  minViewCardWidth,
} from '@simplearchitecture/shared';

/**
 * Largest body of a view request (bytes): room for a view at its caps with ids of about 200
 * characters (UUIDs and imported ids are far shorter). Larger requests get 413.
 */
export const viewBodyLimit = 1024 * 1024;
