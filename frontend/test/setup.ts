import { act, cleanup, configure, getConfig } from '@testing-library/react';
import { afterEach, vi } from 'vitest';

// The default 1 s wait for findBy and waitFor is too short when the whole suite runs in parallel on
// a busy machine: tests failed at random.
configure({ asyncUtilTimeout: 5000 });

// A `findBy` or `waitFor` ends as soon as the DOM shows the result, and React may not have run that
// commit's effects yet: it schedules them, and on a busy machine they run late. What a test does
// next then comes too soon: a key press before the listener is there is lost for good, and focus
// moved in an effect isn't there yet. So every wait also lets what was scheduled finish. The
// app has no such gap for a person: effects run long before the next key press can arrive.
const realSetImmediate = setImmediate;
const defaults = getConfig();
configure({
  asyncWrapper: async (callback) => {
    const result: unknown = await defaults.asyncWrapper(callback);
    await act(async () => {
      await new Promise((resolve) => realSetImmediate(resolve));
    });
    return result;
  },
});

// The canvas runs ELK in a web worker in the browser; tests run the same ELK in-process.
vi.mock('../src/viewing/explorer/canvas/elkEngine', async () => {
  const { default: ELK } = await import('elkjs/lib/elk.bundled.js');
  const elk = new ELK();
  return { getElk: () => elk };
});

// What React Flow needs from a browser that jsdom doesn't have (see React Flow's testing guide).
class ResizeObserverStub {
  constructor(private readonly callback: ResizeObserverCallback) {}
  observe(target: Element) {
    const contentRect = { x: 0, y: 0, width: 1000, height: 700 } as DOMRectReadOnly;
    this.callback([{ target, contentRect } as ResizeObserverEntry], this);
  }
  unobserve() {}
  disconnect() {}
}

class DOMMatrixReadOnlyStub {
  m22: number;
  constructor(transform?: string) {
    const scale = transform?.match(/scale\(([\d.]+)\)/)?.[1];
    this.m22 = scale === undefined ? 1 : Number(scale);
  }
}

vi.stubGlobal('ResizeObserver', ResizeObserverStub);
vi.stubGlobal('DOMMatrixReadOnly', DOMMatrixReadOnlyStub);
Object.defineProperties(HTMLElement.prototype, {
  offsetWidth: {
    configurable: true,
    get(this: HTMLElement) {
      return parseFloat(this.style.width) || 1;
    },
  },
  offsetHeight: {
    configurable: true,
    get(this: HTMLElement) {
      return parseFloat(this.style.height) || 1;
    },
  },
});
Element.prototype.scrollIntoView = function scrollIntoView() {};
(SVGElement.prototype as unknown as { getBBox: () => DOMRect }).getBBox = () =>
  ({ x: 0, y: 0, width: 0, height: 0 }) as DOMRect;

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.stubGlobal('ResizeObserver', ResizeObserverStub);
  vi.stubGlobal('DOMMatrixReadOnly', DOMMatrixReadOnlyStub);
  localStorage.clear();
  document.documentElement.removeAttribute('data-theme');
});
