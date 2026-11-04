import type { JgfDocument, ModelAuthor, ModelSummary } from '@simplearchitecture/shared';
import { z } from 'zod';
import { parse } from '../editing/common.js';
import { validateJgf } from '../jgf/validate.js';
import { maxModelNameLength } from '../limits.js';
import type { ModelStore } from '../storage/model-store.js';

/**
 * Managing whole models: the rules live here, so the REST routes and a future MCP server behave
 * the same. Input is `unknown` and checked here. Who may call it (Admin) is the caller's check.
 */

// The same rules and messages as an element's name.
const newModelSchema = z.strictObject({
  name: z
    .string({ error: 'Enter a name.' })
    .trim()
    .min(1, { error: 'Enter a name.' })
    .max(maxModelNameLength, { error: `Must be at most ${maxModelNameLength} characters.` }),
});

/** A new model: no elements, no relationships, the name as its label. */
export function emptyModel(name: string): JgfDocument {
  return { graph: { label: name, directed: true, nodes: {}, edges: [] } };
}

export class ModelService {
  constructor(private readonly store: ModelStore) {}

  /**
   * Creates an empty model named `input.name`. Throws RejectedError (with field messages) for a
   * bad request, and what `ModelStore.save` throws (e.g. ModelStoreFullError).
   */
  async createModel(input: unknown, actor: ModelAuthor): Promise<ModelSummary> {
    const { name } = parse(newModelSchema, input, 'a model');
    const document = emptyModel(name);
    // Never expected: the store must only ever hold valid models.
    if (!validateJgf(document).valid) throw new Error('an empty model is not valid');
    return this.store.save(document, { id: actor.id, name: actor.name });
  }
}
