import type { ModelSummary } from '@simplearchitecture/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiRequestError, createModel } from '../src/api';
import { admin, apiError, stubApi } from './helpers';

// createModel: the API call only.

const created: ModelSummary = {
  id: '3f2b8c1e-5d4a-4e6f-8a9b-0c1d2e3f4a5b',
  name: 'Made-up new model',
  createdAt: '2026-10-30T09:00:00.000Z',
  createdBy: { id: 'oid-made-up', name: 'Alex Morgan' },
  nodeCount: 0,
  edgeCount: 0,
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('createModel', () => {
  it('posts the name as JSON and returns the new model', async () => {
    const fetchMock = stubApi(admin, ({ url, method, body, headers }) => {
      if (url !== '/api/models/new' || method !== 'POST') return undefined;
      expect(headers.get('content-type')).toBe('application/json');
      expect(JSON.parse(body as string)).toEqual({ name: 'Made-up new model' });
      return Response.json({ model: created }, { status: 201 });
    });
    await expect(createModel('Made-up new model')).resolves.toEqual(created);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('throws with the field messages of a 422', async () => {
    const fields = [{ field: 'name', message: 'Enter a name.' }];
    stubApi(admin, () => apiError(422, 'The change is not valid. Nothing was saved.', { fields }));
    const error = await createModel(' ').catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiRequestError);
    expect((error as ApiRequestError).status).toBe(422);
    expect((error as ApiRequestError).body).toMatchObject({ fields });
  });

  it('refuses an answer that is not a model', async () => {
    stubApi(admin, () => Response.json({ model: { id: 1 } }, { status: 201 }));
    await expect(createModel('Made-up new model')).rejects.toThrow(
      'The server sent an unexpected model.',
    );
  });
});
