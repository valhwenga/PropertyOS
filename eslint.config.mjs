// Flat config. `pnpm lint` previously called a globally installed eslint with no
// config at all and exited 2 on every run, so nothing in this repository has
// ever been linted.
//
// Deliberately narrow: type-aware rules need a project per package and would
// turn one command into eight. What is here catches the mistakes that have
// actually cost time in this codebase — an unused import left behind after a
// refactor, a floating promise in a server action, a `catch` that swallows an
// error — and `pnpm typecheck` already covers types.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.next/**',
      '**/coverage/**',
      'tests/test-results/**',
      'tests/playwright-report/**',
      '**/*.d.ts',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx,mts,cts}'],
    languageOptions: {
      parserOptions: { ecmaVersion: 2023, sourceType: 'module' },
    },
    rules: {
      // Money is bigint minor units throughout. `==` between a bigint and a
      // number is true for 1n == 1, which is exactly the comparison that must
      // never silently pass.
      eqeqeq: ['error', 'always'],

      // An unused import is usually the residue of a refactor, and an unused
      // variable is usually a bug. A leading underscore marks one as deliberate.
      '@typescript-eslint/no-unused-vars': ['error', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
      }],

      // `any` defeats the point of the money and date types. Loud, not fatal.
      '@typescript-eslint/no-explicit-any': 'warn',

      // An empty catch hides the failure the user needed to hear about. A
      // comment in the block is accepted, because some are genuinely deliberate.
      'no-empty': ['error', { allowEmptyCatch: false }],

      // Narrows a class of real bugs in SQL template building.
      'no-template-curly-in-string': 'warn',

      // An invisible character in code is a trap, so these stay errors — but a
      // comment explaining how a BOM is stripped has to be able to show one.
      'no-irregular-whitespace': ['error', { skipComments: true }],
    },
  },
  {
    // Scripts and config files run in Node and legitimately use the console.
    files: ['scripts/**/*.{js,mjs,ts}', '**/*.config.{js,mjs,ts}'],
    rules: { 'no-console': 'off' },
  },
);
