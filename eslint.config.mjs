import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  { ignores: ['dist/**', 'node_modules/**', '*.vsix'] },
  { files: ['src/**/*.{ts,tsx}', 'test/**/*.ts'], languageOptions: { parserOptions: { project: './tsconfig.json' } }, rules: { '@typescript-eslint/no-explicit-any': 'off' } },
  { files: ['examples/**/*.mjs', 'test/integration/**/*.mjs', 'esbuild.mjs'], languageOptions: { globals: { process: 'readonly', Buffer: 'readonly', console: 'readonly', setTimeout: 'readonly' } } },
  { files: ['test/visual/**/*.mjs'], languageOptions: { globals: { process: 'readonly', console: 'readonly', URL: 'readonly', document: 'readonly', getComputedStyle: 'readonly' } } }
);
