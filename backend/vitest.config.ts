import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Resolves @simplearchitecture/shared to its source via tsconfig.json paths.
  resolve: { tsconfigPaths: true },
  test: {
    name: 'backend',
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // Some tests write hundreds of files or many keys: slow when the machine is busy.
    testTimeout: 30_000,
    // Starting PGlite (PostgreSQL in WebAssembly) in a `beforeAll` takes seconds of CPU, more on a
    // busy or small machine: over the default 10 s at times.
    hookTimeout: 60_000,
  },
});
