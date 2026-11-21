import {
  definedPropertyKinds,
  elementPropertyKeyProblem,
  elementPropertyKinds,
  elementPropertyNameProblem,
  labelExpressionNames,
  maxPropertyOptions,
  maxUsageValues,
  propertyConflictMessage,
  propertyKeyInUseMessage,
  propertyKeyProblem,
  propertyLists,
  propertyNameKey,
  propertyNameProblem,
  propertyOptionsProblems,
  referenceKey,
  type DeletedElementPropertyResult,
  type DeletedRelationshipPropertyResult,
  type ElementFieldIssue,
  type ElementPropertyDefinition,
  type ElementPropertyUsage,
  type ModelAuthor,
  type PropertyList,
  type PropertyValueCount,
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
  elementDefinitionOfRow,
  insertDefinitions,
  insertElementDefinitions,
  lockPropertyChanges,
  readDefinition,
  readDefinitions,
  readElementDefinition,
  readElementDefinitions,
} from './property-store.js';

/**
 * The properties an Admin defines (Admin → Properties), in two lists: for relationships (Relation)
 * and for elements (every type). List, create, change, delete, and how their keys are used in the
 * stored models. The REST routes and the MCP tools both read through here.
 *
 * - A change names its list in the query's `for` (`relationship`, the default, or `element`).
 * - Names, keys and options follow the shared rules (relationship-properties.ts and
 *   element-properties.ts), checked here against every other property of the same list under the
 *   definitions' lock.
 * - A key changes only while nothing holds a value under it, counted in the same transaction. Kind
 *   and options change freely: values in models never change.
 * - A delete removes the definition and its key from every relationship (or element) in every
 *   model, in one transaction: each changed item and model gets a new version, and each model an
 *   audit row with the key and the number of items changed.
 * - Audit rows hold keys, field names and counts, never names, options or values.
 */

const noun = 'a property';
const parse = <T>(schema: z.ZodType<T>, input: unknown): T => parseRequest(schema, input, noun);

type AnyDefinition = RelationshipPropertyDefinition | ElementPropertyDefinition;
type Kind = AnyDefinition['kind'];

/** What differs between the two lists. Table names are fixed here, never taken from input. */
interface ListRules<D extends AnyDefinition> {
  table: 'relationship_properties' | 'element_properties';
  /** Where the values are: the items' table. */
  items: 'relationships' | 'elements';
  kindSchema: z.ZodType<D['kind']>;
  nameProblem: (name: string, others: readonly D[]) => string | undefined;
  keyProblem: (key: string, others: readonly D[]) => string | undefined;
  read: (q: Queryable) => Promise<D[]>;
  readOne: (q: Queryable, key: string, lock?: boolean) => Promise<D | undefined>;
  insert: (q: Queryable, definitions: readonly Omit<D, 'version'>[]) => Promise<void>;
  ofRow: (row: never) => D;
  audit: { added: string; changed: string; deleted: string; valuesDeleted: string; items: string };
}

const relationshipRules: ListRules<RelationshipPropertyDefinition> = {
  table: 'relationship_properties',
  items: 'relationships',
  kindSchema: z.enum(definedPropertyKinds, { error: 'Must be text or choice.' }),
  nameProblem: propertyNameProblem,
  keyProblem: propertyKeyProblem,
  read: readDefinitions,
  readOne: readDefinition,
  insert: insertDefinitions,
  ofRow: definitionOfRow,
  audit: {
    added: 'property-added',
    changed: 'property-changed',
    deleted: 'property-deleted',
    valuesDeleted: 'relationship-property-deleted',
    items: 'relationships',
  },
};

const elementRules: ListRules<ElementPropertyDefinition> = {
  table: 'element_properties',
  items: 'elements',
  kindSchema: z.enum(elementPropertyKinds, { error: 'Must be text, choice or reference.' }),
  nameProblem: elementPropertyNameProblem,
  keyProblem: elementPropertyKeyProblem,
  read: readElementDefinitions,
  readOne: readElementDefinition,
  insert: insertElementDefinitions,
  ofRow: elementDefinitionOfRow,
  audit: {
    added: 'element-property-added',
    changed: 'element-property-changed',
    deleted: 'element-property-deleted',
    valuesDeleted: 'element-property-values-deleted',
    items: 'elements',
  },
};

const textSchema = (message: string) => z.string({ error: message });
const optionsSchema = z
  .array(z.string({ error: 'Each option must be text.' }), { error: 'Must be a list of texts.' })
  // Enough room to say "too many": the rule's own message comes from the shared check.
  .max(maxPropertyOptions * 4, { error: `Use ${maxPropertyOptions} options or fewer.` });

const newSchema = <K extends Kind>(kindSchema: z.ZodType<K>) =>
  z.strictObject({
    name: textSchema('Enter a name.'),
    key: textSchema('Enter a key.'),
    kind: kindSchema,
    options: optionsSchema.optional(),
  });

const updateSchema = <K extends Kind>(kindSchema: z.ZodType<K>) =>
  z.strictObject({
    version: versionSchema,
    name: textSchema('Enter a name.').optional(),
    key: textSchema('Enter a key.').optional(),
    kind: kindSchema.optional(),
    options: optionsSchema.optional(),
  });

const listSchema = z.enum(propertyLists, { error: 'Must be relationship or element.' });

/** The query of a create: the list, if not relationships. */
const createQuerySchema = z.strictObject({ for: listSchema.optional() });
/** The query of a change or delete: the property's key, and its list if not relationships. */
const keySchema = z.strictObject({
  key: z.string({ error: 'Name the property by its key.' }),
  for: listSchema.optional(),
});

/** The list a query names: relationships unless `for=element`. */
const listOf = (value: PropertyList | undefined): PropertyList => value ?? 'relationship';

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

  /** Every relationship property, by name. */
  async list(): Promise<RelationshipPropertyDefinition[]> {
    return readDefinitions(this.#db);
  }

  /** Every element property, by name. */
  async listElements(): Promise<ElementPropertyDefinition[]> {
    return readElementDefinitions(this.#db);
  }

  /** Adds a property to the list `query` names (`{ for? }`; relationships by default). */
  async create(input: unknown, actor: ModelAuthor, query: unknown = {}): Promise<AnyDefinition> {
    const list = listOf(parse(createQuerySchema, query).for);
    return list === 'element'
      ? this.#create(elementRules, input, actor)
      : this.#create(relationshipRules, input, actor);
  }

  /**
   * Changes a property; saving one from models also marks it checked. `query`: `{ key, for? }`.
   */
  async update(query: unknown, input: unknown, actor: ModelAuthor): Promise<AnyDefinition> {
    const { key, for: list } = parse(keySchema, query);
    return listOf(list) === 'element'
      ? this.#update(elementRules, key, input, actor)
      : this.#update(relationshipRules, key, input, actor);
  }

  /**
   * Deletes a property and its values from every relationship (or element) in every model, in one
   * transaction. `query`: `{ key, for? }`.
   */
  async delete(
    query: unknown,
    actor: ModelAuthor,
  ): Promise<DeletedRelationshipPropertyResult | DeletedElementPropertyResult> {
    const { key, for: list } = parse(keySchema, query);
    return listOf(list) === 'element'
      ? this.#delete(elementRules, key, actor)
      : this.#delete(relationshipRules, key, actor);
  }

  async #create<D extends AnyDefinition>(
    rules: ListRules<D>,
    input: unknown,
    actor: ModelAuthor,
  ): Promise<D> {
    const request = parse(newSchema(rules.kindSchema), input);
    return this.#db.transaction(async (tx) => {
      await lockPropertyChanges(tx);
      const others = await rules.read(tx);
      const issues: ElementFieldIssue[] = [];
      const nameProblem = rules.nameProblem(request.name, others);
      if (nameProblem !== undefined) issues.push({ field: 'name', message: nameProblem });
      const keyProblem = rules.keyProblem(request.key, others);
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
      } as Omit<D, 'version'>;
      await rules.insert(tx, [definition]);
      const fields = ['name', 'key', 'kind', ...(options === undefined ? [] : ['options'])];
      await auditProperty(tx, rules.audit.added, actor, { key: definition.key, fields });
      return { ...definition, version: 1 } as D;
    });
  }

  async #update<D extends AnyDefinition>(
    rules: ListRules<D>,
    key: string,
    input: unknown,
    actor: ModelAuthor,
  ): Promise<D> {
    const request = parse(updateSchema(rules.kindSchema), input);
    return this.#db.transaction(async (tx) => {
      await lockPropertyChanges(tx);
      const current = await rules.readOne(tx, key, true);
      if (current === undefined) throw new NotFoundError('property');
      if (current.version !== request.version) {
        throw new ConflictError(current.version, propertyConflictMessage);
      }
      const others = (await rules.read(tx)).filter((other) => other.key !== key);
      const issues: ElementFieldIssue[] = [];
      const fields: string[] = [];
      let name = current.name;
      if (request.name !== undefined && request.name.trim() !== current.name) {
        const problem = rules.nameProblem(request.name, others);
        if (problem !== undefined) issues.push({ field: 'name', message: problem });
        name = request.name.trim();
        fields.push('name');
      }
      let newKey = key;
      // The key sent back as it is stands for no change, even one an import left with spaces.
      if (request.key !== undefined && request.key !== key && request.key.trim() !== key) {
        const problem =
          rules.keyProblem(request.key, others) ??
          ((await valueCount(tx, rules.items, key)) > 0 ? propertyKeyInUseMessage : undefined);
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
      const [row] = await tx.query<Record<string, unknown>>(
        `update ${rules.table} set key = $2, name = $3, kind = $4,
           options = $5::text::jsonb, from_models = false, version = version + 1,
           updated_at = now()
         where key = $1
         returning key, name, kind, options, from_models, version`,
        [key, newKey, name, kind, options === undefined ? null : JSON.stringify(options)],
      );
      if (row === undefined) throw new NotFoundError('property');
      await auditProperty(tx, rules.audit.changed, actor, {
        key: newKey,
        ...(newKey === key ? {} : { previousKey: key }),
        fields,
      });
      // The row has the list's own columns, as its reader takes them.
      return rules.ofRow(row as never);
    });
  }

  async #delete<D extends AnyDefinition>(
    rules: ListRules<D>,
    key: string,
    actor: ModelAuthor,
  ): Promise<DeletedRelationshipPropertyResult> {
    const { items } = rules;
    return this.#db.transaction(async (tx) => {
      await lockPropertyChanges(tx);
      if ((await rules.readOne(tx, key)) === undefined) throw new NotFoundError('property');
      // The models first, in one order, as an item change takes its model and then the
      // definitions it sets: so neither waits for the other in a circle.
      await tx.query(
        `select id from models where id in (
           select model_id from ${items}
           where jsonb_typeof(metadata) = 'object' and metadata ? $1)
         order by id for update`,
        [key],
      );
      // An item change setting this key waits here, and then finds it gone.
      await tx.query(`delete from ${rules.table} where key = $1`, [key]);
      const changed = await tx.query<{ model_id: string; count: number }>(
        `with changed as (
           update ${items} set metadata = metadata - $1, version = version + 1
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
          rules.audit.valuesDeleted,
          actor,
          { key, [rules.audit.items]: count },
          modelId,
        );
      }
      await auditProperty(tx, rules.audit.deleted, actor, {
        key,
        values,
        models: changed.length,
      });
      return { key, values, models: changed.length };
    });
  }

  /**
   * How each relationship property's key is used in the stored models: relationships and models
   * holding a value, the most used values, and the labels using its name. For the Admin page.
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
    const values = await topValues(db, relationshipRules);
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
        values: values.get(definition.key) ?? [],
        labels: labelUses.get(propertyNameKey(definition.name)) ?? 0,
      };
    });
  }

  /**
   * How each element property's key is used in the stored models: elements and models holding a
   * value (what a delete removes, for its dialog) and the most used values. For the Admin page.
   */
  async elementUsage(): Promise<ElementPropertyUsage[]> {
    const db = this.#db;
    const definitions = await readElementDefinitions(db);
    const counts = await db.query<{
      key: string;
      elements: number;
      models: number;
      text: number;
      reference: number;
    }>(
      `select d.key, count(*)::int as elements, count(distinct e.model_id)::int as models,
         (count(*) filter (where jsonb_typeof(e.metadata -> d.key)
           in ('string', 'number', 'boolean')))::int as text,
         -- A Reference (isReference): an object whose one key is the reference key, holding a list.
         (count(*) filter (where case when jsonb_typeof(e.metadata -> d.key) = 'object'
           then (e.metadata -> d.key) - $1::text = '{}'::jsonb
             and coalesce(jsonb_typeof(e.metadata -> d.key -> $1::text) = 'array', false)
           else false end))::int as reference
       from element_properties d
       join elements e on jsonb_typeof(e.metadata) = 'object' and e.metadata ? d.key
       group by d.key`,
      [referenceKey],
    );
    const values = await topValues(db, elementRules);
    const countsOf = new Map(counts.map((row) => [row.key, row]));
    return definitions.map((definition) => {
      const row = countsOf.get(definition.key);
      const elements = row?.elements ?? 0;
      const text = row?.text ?? 0;
      const reference = row?.reference ?? 0;
      return {
        key: definition.key,
        elements,
        models: row?.models ?? 0,
        shapes: { text, reference, other: elements - text - reference },
        values: values.get(definition.key) ?? [],
      };
    });
  }
}

/** Per defined key of a list, its most used plain values (up to `maxUsageValues`), most used first. */
async function topValues(
  q: Queryable,
  rules: Pick<ListRules<AnyDefinition>, 'table' | 'items'>,
): Promise<Map<string, PropertyValueCount[]>> {
  const rows = await q.query<{ key: string; value: string; count: number }>(
    `select key, value, count from (
       select d.key, r.metadata ->> d.key as value, count(*)::int as count,
         row_number() over (partition by d.key
           order by count(*) desc, r.metadata ->> d.key) as n
       from ${rules.table} d
       join ${rules.items} r on jsonb_typeof(r.metadata) = 'object' and r.metadata ? d.key
       where jsonb_typeof(r.metadata -> d.key) in ('string', 'number', 'boolean')
       group by d.key, r.metadata ->> d.key) as ranked
     where n <= $1
     order by key, count desc, value`,
    [maxUsageValues],
  );
  const byKey = new Map<string, PropertyValueCount[]>();
  for (const { key, value, count } of rows) {
    const list = byKey.get(key);
    if (list) list.push({ value, count });
    else byKey.set(key, [{ value, count }]);
  }
  return byKey;
}

/** How many items (relationships or elements) hold a value under the key, in every model. */
async function valueCount(
  tx: Queryable,
  items: ListRules<AnyDefinition>['items'],
  key: string,
): Promise<number> {
  const [row] = await tx.query<{ count: number }>(
    `select count(*)::int as count from ${items}
     where jsonb_typeof(metadata) = 'object' and metadata ? $1`,
    [key],
  );
  return row?.count ?? 0;
}
