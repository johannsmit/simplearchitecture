import type { JgfDocument } from '@simplearchitecture/shared';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { bakeryId, bakeryModel, bakerySummary } from './fixtures';
import { renderAt, stubApi, viewer } from './helpers';

// A relationship's text is shown as text, never as markup.

const payload = '<img src=x onerror="document.title=\'pwned\'"><b>bold</b>';

const model: JgfDocument = {
  graph: {
    ...bakeryModel.graph,
    edges: (bakeryModel.graph.edges ?? []).map((edge) =>
      edge.id === 'e1'
        ? { ...edge, label: payload, metadata: { description: payload, note: payload } }
        : edge,
    ),
  },
};

describe('relationship panel renders text as text', () => {
  it('shows markup in the label, description and metadata literally', async () => {
    stubApi(viewer, ({ url, method }) => {
      if (method !== 'GET') return undefined;
      if (url === '/api/models') return Response.json({ models: [bakerySummary], editable: false });
      if (url === `/api/models/${bakeryId}`) return Response.json(model);
      return undefined;
    });
    renderAt(`/viewing/models/${bakeryId}/elements/shop?depth=1`);
    const details = await screen.findByRole('complementary', { name: 'Details' });
    fireEvent.click(
      await within(details).findByRole('button', { name: /^Open relationship: .*Customer/ }),
    );
    await within(details).findByRole('heading', { level: 2, name: /^Customer / });
    await waitFor(() => {
      expect(details.textContent).toContain(payload);
    });
    expect(details.querySelector('img, b')).toBeNull();
    expect(document.title).not.toBe('pwned');
  });
});
