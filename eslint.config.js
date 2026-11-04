import js from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default defineConfig(
  globalIgnores(['**/dist/', '**/dev-dist/', '**/coverage/', 'scripts/']),

  js.configs.recommended,
  tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        // Each workspace's tsconfig.json covers its own files; root config files use a default project.
        projectService: { allowDefaultProject: ['eslint.config.js', 'vitest.config.ts'] },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
      // Fastify plugins and handlers are idiomatically async even without an await.
      '@typescript-eslint/require-await': 'off',
    },
  },

  {
    files: ['eslint.config.js'],
    extends: [tseslint.configs.disableTypeChecked],
  },

  {
    // Plain browser scripts served as is (no build step), e.g. the theme script that runs before paint.
    files: ['frontend/public/**/*.js'],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: { globals: globals.browser, sourceType: 'script' },
  },

  {
    files: ['backend/**/*.ts', 'shared/**/*.ts', '*.config.{js,ts}'],
    languageOptions: { globals: globals.node },
  },

  {
    files: ['frontend/**/*.{ts,tsx}'],
    extends: [reactHooks.configs.flat.recommended],
    languageOptions: { globals: globals.browser },
  },
);
