import {
  definedPropertyKinds,
  labelExpressionNames,
  maxPropertyOptions,
  maxUsageValues,
  propertyConflictMessage,
  propertyKeyInUseMessage,
  propertyKeyProblem,
  propertyNameKey,
  propertyNameProblem,
  propertyOptionsProblems,
  type DeletedRelationshipPropertyResult,
  type ElementFieldIssue,
  type ModelAuthor,
  type RelationshipPropertyDefinition,
  type RelationshipPropertyUsage,
} from '@simplearchitecture/shared';
import { z } from 'zod';
import type { Db, Queryable } from '../db/db.js';
import {
  ConflictError,
  NotFoundError,
  parse as parseRequest,
  RejectedError,
  versionSchema,
} from '../editing/common.js';
import {
  auditProperty,
  definitionOfRow,
  insertDefinitions,
  lockPropertyChanges,
  readDefinition,
  readDefinitions,
} from './property-store.js';

/**
 * The relationship properties an Admin defines (Admin → Properties): list, create, change, delete,
 * and how their keys are used in the stored models. The REST routes and the MCP tools both read
 * through here. Needs PostgreSQL: without it there are none, and changes are unavailable.
 *
 * - Names, keys and options follow the shared rules (relationship-properties.ts), checked here
 *   against every other property under the definitions' lock.
 * - A key changes only while no relationship holds a value under it, counted in the same
 *   transaction. Kind and options change freely: values in models never change.
 * - A delete removes the definition and its key from every relationship in every model, in one
 *   transaction: each changed relationship and model gets a new version, and each model an audit row
 *   with the key and the number of relationships changed.
 * - Audit rows hold keys, field names and counts, never names, options or values.
 */

const noun = 'a property';
const parse = <T>(schema: z.ZodType<T>, input: unknown): T => parseRequest(schema, input, noun);

const textSchema = (message: string) => z.string({ error: message });
const optionsSchema = z
  .array(z.string({ error: 'Each option must be text.' }), { error: 'Must be a list of texts.' })
  // Enough room to say "too many": the rule's own message comes from the shared check.
  .max(maxPropertyOptions * 4, { error: `Use ${maxPropertyOptions} options or fewer.` });
const kindSchema = z.enum(definedPropertyKinds, { error: 'Must be text or choice.' });

const newSchema = z.strictObject({
  name: textSchema('Enter a name.'),
  key: textSchema('Enter a key.'),
  kind: kindSchema,
  options: optionsSchema.optional(),
});

const updateSchema = z.strictObject({
  version: versionSchema,
  name: textSchema('Enter a name.').optional(),
  key: textSchema('Enter a key.').optional(),
  kind: kindSchema.optional(),
  options: optionsSchema.optional(),
});

/** The query of a change or delete: the property's key. */
const keySchema = z.strictObject({ key: z.string({ error: 'Name the property by its key.' }) });
const keyOf = (query: unknown): string => parse(keySchema, query).key;

interface UsageRow {
  key: string;
  relations: number;
  contains: number;
  models: number;
}

/** Options trimmed, in order. */
const trimmed = (options: readonly string[]): string[] => options.map((option) => option.trim());

export class PropertyService {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  /** Every defined property, by name. */
  async list(): Promise<RelationshipPropertyDefinition[]> {
    return readDefinitions(this.#db);
  }

  async create(input: unknown, actor: ModelAuthor): Promise<RelationshipPropertyDefinition> {
    const db = this.#db;
    const request = parse(newSchema, input);
    return db.transaction(async (tx) => {
      await lockPropertyChanges(tx);
      const others = await readDefinitions(tx);
      const issues: ElementFieldIssue[] = [];
      const nameProblem = propertyNameProblem(request.name, others);
      if (nameProblem !== undefined) issues.push({ field: 'name', message: nameProblem });
      const keyProblem = propertyKeyProblem(request.key, others);
      if (keyProblem !== undefined) issues.push({ field: 'key', message: keyProblem });
      const options = request.kind === 'choice' ? trimmed(request.options ?? []) : undefined;
      if (options !== undefined) issues.push(...propertyOptionsProblems(options));
      if (issues.length > 0) throw new RejectedError(issues);
      const definition = {
        key: request.key.trim(),
        name: request.name.trim(),
        kind: request.kind,
        ...(options === undefined ? {} : { options }),
        fromModels: false,
      };
      await insertDefinitions(tx, [definition]);
      const fields = ['name', 'key', 'kind', ...(options === undefined ? [] : ['options'])];
      await auditProperty(tx, 'property-added', actor, { key: definition.key, fields });
      return { ...definition, version: 1 };
    });
  }

  /** Changes a property; saving one from models also marks it checked. `query`: `{ key }`. */
  async update(
    query: unknown,
    input: unknown,
    actor: ModelAuthor,
  ): Promise<RelationshipPropertyDefinition> {
    const db = this.#db;
    const key = keyOf(query);
    const request = parse(updateSchema, input);
    return db.transaction(async (tx) => {
      await lockPropertyChanges(tx);
      const current = await readDefinition(tx, key, true);
      if (current === undefined) throw new NotFoundError('property');
      if (current.version !== request.version) {
        throw new ConflictError(current.version, propertyConflictMessage);
      }
      const others = (await readDefinitions(tx)).filter((other) => other.key !== key);
      const issues: ElementFieldIssue[] = [];
      const fields: string[] = [];
      let name = current.name;
      if (request.name !== undefined && request.name.trim() !== current.name) {
        const problem = propertyNameProblem(request.name, others);
        if (problem !== undefined) issues.push({ field: 'name', message: problem });
        name = request.name.trim();
        fields.push('name');
      }
      let newKey = key;
      // The key sent back as it is stands for no change, even one an import left with spaces.
      if (request.key !== undefined && request.key !== key && request.key.trim() !== key) {
        const problem =
          propertyKeyProblem(request.key, others) ??
          ((await valueCount(tx, key)) > 0 ? propertyKeyInUseMessage : undefined);
        if (problem !== undefined) issues.push({ field: 'key', message: problem });
        newKey = request.key.trim();
        fields.push('key');
      }
      const kind = request.kind ?? current.kind;
      if (kind !== current.kind) fields.push('kind');
      let options: string[] | undefined;
      if (kind === 'choice') {
        options = trimmed(request.options ?? current.options ?? []);
        issues.push(...propertyOptionsProblems(options));
        if (JSON.stringify(options) !== JSON.stringify(current.options ?? [])) {
          fields.push('options');
        }
      } else if (current.options !== undefined) {
        fields.push('options');
      }
      if (issues.length > 0) throw new RejectedError(issues);
      // Saving one from models marks it checked, even with nothing else changed.
      if (current.fromModels) fields.push('fromModels');
      if (fields.length === 0) return current;
      const [row] = await tx.query<Parameters<typeof definitionOfRow>[0]>(
        `update relationship_properties set key = $2, name = $3, kind = $4,
           options = $5::text::jsonb, from_models = false, version = version + 1,
           updated_at = now()
         where key = $1
         returning key, name, kind, options, from_models, version`,
        [key, newKey, name, kind, options === undefined ? null : JSON.stringify(options)],
      );
      if (row === undefined) throw new NotFoundError('property');
      await auditProperty(tx, 'property-changed', actor, {
        key: newKey,
        ...(newKey === key ? {} : { previousKey: key }),
        fields,
      });
      return definitionOfRow(row);
    });
  }

  /**
   * Deletes a property and its values from every relationship in every model, in one transaction.
   * `query`: `{ key }`.
   */
  async delete(query: unknown, actor: ModelAuthor): Promise<DeletedRelationshipPropertyResult> {
    const db = this.#db;
    const key = keyOf(query);
    return db.transaction(async (tx) => {
      await lockPropertyChanges(tx);
      if ((await readDefinition(tx, key)) === undefined) throw new NotFoundError('property');
      // The models first, in one order, as a relationship change takes its model and then the
      // definitions it sets: so neither waits for the other in a circle.
      await tx.query(
        `select id from models where id in (
           select model_id from relationships
           where jsonb_typeof(metadata) = 'object' and metadata ? $1)
         order by id for update`,
        [key],
      );
      // A relationship change setting this key waits here, and then finds it gone.
      await tx.query('delete from relationship_properties where key = $1', [key]);
      const changed = await tx.query<{ model_id: string; count: number }>(
        `with changed as (
           update relationships set metadata = metadata - $1, version = version + 1
           where jsonb_typeof(metadata) = 'object' and metadata ? $1
           returning model_id)
         select model_id, count(*)::int as count from changed group by model_id
         order by model_id`,
        [key],
      );
      let values = 0;
      for (const { model_id: modelId, count } of changed) {
        values += count;
        await tx.query('update models set version = version + 1 where id = $1::uuid', [modelId]);
        await auditProperty(
          tx,
          'relationship-property-deleted',
          actor,
          { key, relationships: count },
          modelId,
        );
      }
      await auditProperty(tx, 'property-deleted', actor, {
        key,
        values,
        models: changed.length,
      });
      return { key, values, models: changed.length };
    });
  }

  /**
   * How each property's key is used in the stored models: relationships and models holding a
   * value, the most used values, and the labels using its name. For the Admin page.
   */
  async usage(): Promise<RelationshipPropertyUsage[]> {
    const db = this.#db;
    const definitions = await readDefinitions(db);
    const counts = await db.query<UsageRow>(
      `select d.key,
         (count(*) filter (where r.relation = 'Relation'))::int as relations,
         (count(*) filter (where r.relation is distinct from 'Relation'))::int as contains,
         count(distinct r.model_id)::int as models
       from relationship_properties d
       join relationships r on jsonb_typeof(r.metadata) = 'object' and r.metadata ? d.key
       group by d.key`,
    );
    const values = await db.query<{ key: string; value: string; count: number }>(
      `select key, value, count from (
         select d.key, r.metadata ->> d.key as value, count(*)::int as count,
           row_number() over (partition by d.key
             order by count(*) desc, r.metadata ->> d.key) as n
         from relationship_properties d
         join relationships r on jsonb_typeof(r.metadata) = 'object' and r.metadata ? d.key
         where jsonb_typeof(r.metadata -> d.key) in ('string', 'number', 'boolean')
         group by d.key, r.metadata ->> d.key) as ranked
       where n <= $1
       order by key, count desc, value`,
      [maxUsageValues],
    );
    const labels = await db.query<{ label: string; count: number }>(
      `select label, count(*)::int as count from relationships
       where strpos(label, '{') > 0 group by label`,
    );
    // Per name (as labels compare them): the relationships whose label uses it.
    const labelUses = new Map<string, number>();
    for (const { label, count } of labels) {
      for (const name of new Set(labelExpressionNames(label).map(propertyNameKey))) {
        labelUses.set(name, (labelUses.get(name) ?? 0) + count);
      }
    }
    const countsOf = new Map(counts.map((row) => [row.key, row]));
    return definitions.map((definition) => {
      const row = countsOf.get(definition.key);
      return {
        key: definition.key,
        relations: row?.relations ?? 0,
        contains: row?.contains ?? 0,
        models: row?.models ?? 0,
        values: values
          .filter((entry) => entry.key === definition.key)
          .map(({ value, count }) => ({ value, count })),
        labels: labelUses.get(propertyNameKey(definition.name)) ?? 0,
      };
    });
  }
}

/** How many relationships hold a value under the key, in every model. */
async function valueCount(tx: Queryable, key: string): Promise<number> {
  const [row] = await tx.query<{ count: number }>(
    `select count(*)::int as count from relationships
     where jsonb_typeof(metadata) = 'object' and metadata ? $1`,
    [key],
  );
  return row?.count ?? 0;
}
