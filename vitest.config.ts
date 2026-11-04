import { defineConfig } from 'vitest/config';

// Each workspace has its own Vitest config; this runs them together from the repo root.
export default defineConfig({
  test: {
    projects: ['backend', 'frontend'],
  },
});
