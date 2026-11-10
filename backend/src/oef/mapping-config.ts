import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  checkStandardProperty,
  edgeTypes,
  hasStandardEdgeProperty,
  isRelationDataProperty,
  isStandardPropertyKey,
  isStandardPropertyOf,
  nodeTypeKey,
  nodeTypes,
  standardProperties,
} from '@simplearchitecture/shared';
import { z } from 'zod';
import { repoRoot, resolveFromRepoRoot } from '../paths.js';
import { allArchimateElementTypes, archimateRelationshipTypes } from './archimate.js';

export { repoRoot };
/** `config/oef-mapping.json` at the repo root. */
export const defaultOefMappingPath = join(repoRoot, 'config', 'oef-mapping.json');

/**
 * Where OEF_MAPPING_PATH points. A relative path is resolved against the repo root, not the
 * working directory (which differs between `npm run dev`, `npm start` and tests).
 */
export function resolveOefMappingPath(path?: string): string {
  return path === undefined ? defaultOefMappingPath : resolveFromRepoRoot(path);
}

const comment = z.union([z.string(), z.array(z.string())]).optional();
const name = z.string().trim().min(1, 'must not be empty');
// Type names are checked against ArchiMate 3.1, so a typo is an error rather than a rule that
// silently never matches.
const elementType = z
  .string()
  .refine(
    (type) => allArchimateElementTypes.includes(type),
    'is not an ArchiMate 3.1 element type',
  );
const elementTypes = z.array(elementType).min(1, 'must list at least one type');
const relationshipType = z.enum(archimateRelationshipTypes, {
  error: 'is not an ArchiMate 3.1 relationship type',
});
const nodeType = z.enum(nodeTypes, { error: `must be one of ${nodeTypes.join(', ')}` });
const edgeType = z.enum(edgeTypes, { error: `must be one of ${edgeTypes.join(', ')}` });
const flag = z.boolean({ error: 'must be true or false' });
// A metadata key: a JavaScript-style identifier, never the node type key.
const metadataKey = z
  .string()
  .regex(/^[A-Za-z][A-Za-z0-9]*$/, 'must be a camelCase key, e.g. owningTeam')
  .refine((key) => key !== nodeTypeKey, `must not be "${nodeTypeKey}" (that holds the node type)`);
// List-typed standard properties of elements (functions) are filled by function folding, which
// would replace the text from the OEF file without a trace. So they never hold documentation or a
// property. A Relation's lists (Request Data, Response Data) take a mapped text as one value.
const listKeys: readonly string[] = Object.entries(standardProperties)
  .filter(
    ([key, definition]) =>
      definition.value.kind === 'text-list' &&
      nodeTypes.some((type) => isStandardPropertyOf(type, key)),
  )
  .map(([key]) => key);
const textKey = metadataKey.refine(
  (key) => !listKeys.includes(key),
  `must not be a list property (${listKeys.join(', ')}): function folding fills it`,
);

const foldRule = z.strictObject({
  $comment: comment,
  relationshipTypes: z.array(relationshipType).min(1, 'must list at least one type'),
  sourceTypes: elementTypes,
  targetTypes: elementTypes,
  /** Which end of the relationship is the function; the other end is the component. */
  fold: z.enum(['source', 'target'], { error: 'must be "source" or "target"' }),
});

const relationshipRule = z
  .strictObject({
    $comment: comment,
    /** ArchiMate relationship type, e.g. Flow. */
    type: relationshipType,
    /** Optional: our node type of the source and target (after mapping). */
    sourceNodeTypes: z.array(nodeType).min(1).optional(),
    targetNodeTypes: z.array(nodeType).min(1).optional(),
    /** Optional: every listed property must be present (and, with `values`, have one of them). */
    properties: z
      .array(z.strictObject({ name, values: z.array(z.string()).min(1).optional() }))
      .min(1)
      .optional(),
    relation: edgeType,
    /**
     * Optional, Relation only: the imported relationship's name (its label) also becomes its
     * Request Data, where Information flow once was set. It keeps its older name, so existing
     * mapping files still load.
     */
    informationFlow: flag.optional(),
    /** Optional: swap source and target on import (the rule still matches the OEF direction). */
    reverse: flag.optional(),
  })
  .refine(
    (rule) =>
      rule.informationFlow !== true || hasStandardEdgeProperty('requestData', rule.relation),
    {
      path: ['informationFlow'],
      message: 'only applies to a type that can have it (Relation)',
    },
  );

const propertyMapping = z
  .strictObject({
    $comment: comment,
    /** The OEF property name (the property definition's name). */
    name,
    /** Our metadata key. */
    key: textKey,
    /** Optional value translations; values not listed are kept as they are. */
    values: z.record(z.string(), z.string()).optional(),
  })
  .superRefine((mapping, ctx) => {
    // A text set as Request Data or Response Data becomes one value of the list.
    if (!isStandardPropertyKey(mapping.key) || isRelationDataProperty(mapping.key)) return;
    for (const [from, to] of Object.entries(mapping.values ?? {})) {
      const check = checkStandardProperty(mapping.key, to);
      if (!check.ok && check.severity === 'error') {
        ctx.addIssue({
          code: 'custom',
          path: ['values', from],
          message: `${mapping.key} ${check.problem}`,
        });
      }
    }
  });

const propertyDefault = z
  .strictObject({
    $comment: comment,
    key: metadataKey,
    value: z.string(),
    /** Node types that get the default when the value is empty or missing. */
    nodeTypes: z.array(nodeType).min(1).optional(),
    /** Edge types (relations) that get the default when the value is empty or missing. */
    relations: z.array(edgeType).min(1).optional(),
  })
  .superRefine((entry, ctx) => {
    if (entry.nodeTypes === undefined && entry.relations === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: [],
        message: 'must list nodeTypes, relations or both (a default must apply to something)',
      });
    }
    if (!isStandardPropertyKey(entry.key) || isRelationDataProperty(entry.key)) return;
    const check = checkStandardProperty(entry.key, entry.value);
    if (!check.ok && check.severity === 'error') {
      ctx.addIssue({ code: 'custom', path: ['value'], message: `${entry.key} ${check.problem}` });
    }
  });

const mappingSchema = z.strictObject({
  $comment: comment,
  version: z.literal(1, { error: 'must be 1' }),
  /** ArchiMate element type (OEF xsi:type) → our node type, or "skip". */
  elements: z
    .record(
      z.string(),
      z.union([nodeType, z.literal('skip')], {
        error: `must be one of ${nodeTypes.join(', ')} or "skip"`,
      }),
    )
    .superRefine((elements, ctx) => {
      // Checked here rather than as the record's key schema, so the message names the type.
      for (const type of Object.keys(elements)) {
        if (!allArchimateElementTypes.includes(type)) {
          ctx.addIssue({
            code: 'custom',
            path: [type],
            message: 'is not an ArchiMate 3.1 element type',
          });
        }
      }
    }),
  functionFolding: z.strictObject({ $comment: comment, rules: z.array(foldRule) }),
  /** First matching rule wins. Relationships matching no rule are skipped and reported. */
  relationships: z.strictObject({ $comment: comment, rules: z.array(relationshipRule) }),
  properties: z
    .strictObject({
      $comment: comment,
      /** Metadata key for an element's or relationship's documentation. */
      documentation: textKey,
      /** Optional: metadata key that keeps each node's and edge's ArchiMate type (OEF xsi:type). */
      archimateTypeKey: textKey
        .refine((key) => !isStandardPropertyKey(key), 'must not be a standard property key')
        .optional(),
      mappings: z.array(propertyMapping).superRefine((mappings, ctx) => {
        const seen = new Set<string>();
        mappings.forEach((mapping, index) => {
          if (seen.has(mapping.name)) {
            ctx.addIssue({
              code: 'custom',
              path: [index, 'name'],
              message: `"${mapping.name}" is mapped twice`,
            });
          }
          seen.add(mapping.name);
        });
      }),
      defaults: z.array(propertyDefault),
    })
    .superRefine((properties, ctx) => {
      // The ArchiMate type gets its own key: never the documentation's or a mapped property's.
      const typeKey = properties.archimateTypeKey;
      if (typeKey === undefined) return;
      if (typeKey === properties.documentation) {
        ctx.addIssue({
          code: 'custom',
          path: ['archimateTypeKey'],
          message: 'must differ from documentation',
        });
      }
      properties.mappings.forEach((mapping, index) => {
        if (mapping.key === typeKey) {
          ctx.addIssue({
            code: 'custom',
            path: ['mappings', index, 'key'],
            message: `must differ from archimateTypeKey ("${typeKey}")`,
          });
        }
      });
    }),
});

export type OefMapping = z.infer<typeof mappingSchema>;
export type FoldRule = z.infer<typeof foldRule>;
export type RelationshipRule = z.infer<typeof relationshipRule>;
export type PropertyMapping = z.infer<typeof propertyMapping>;

export class OefMappingError extends Error {
  override name = 'OefMappingError';
}

/** Validates a parsed mapping config. Throws an OefMappingError naming every bad entry. */
/** Paths of every `__proto__` key: JSON.parse keeps it, but parsing would silently drop it. */
function protoKeyPaths(value: unknown, path: string, found: string[]): string[] {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => protoKeyPaths(entry, `${path}[${index}]`, found));
  } else if (typeof value === 'object' && value !== null) {
    for (const [key, entry] of Object.entries(value)) {
      const at = path === '' ? key : `${path}.${key}`;
      if (key === '__proto__') found.push(at);
      else protoKeyPaths(entry, at, found);
    }
  }
  return found;
}

export function parseOefMapping(input: unknown, source = 'OEF mapping config'): OefMapping {
  const protoKeys = protoKeyPaths(input, '', []);
  if (protoKeys.length > 0) {
    throw new OefMappingError(
      `Invalid ${source}:\n${protoKeys.map((at) => `✖ "__proto__" is not allowed as a key\n  → at ${at}`).join('\n')}`,
    );
  }
  const result = mappingSchema.safeParse(input);
  if (!result.success) {
    throw new OefMappingError(`Invalid ${source}:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}

/**
 * Loads and validates the mapping config. `path` (OEF_MAPPING_PATH) is resolved against the
 * repo root; without it, the repo's config/oef-mapping.json is used.
 */
export function loadOefMapping(path?: string): OefMapping {
  const file = resolveOefMappingPath(path);
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    const reason = typeof code === 'string' ? code : 'read error';
    throw new OefMappingError(`Cannot read OEF mapping config ${file} (${reason})`);
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    throw new OefMappingError(
      `OEF mapping config ${file} is not valid JSON: ${error instanceof Error ? error.message : ''}`,
    );
  }
  return parseOefMapping(json, `OEF mapping config ${file}`);
}
