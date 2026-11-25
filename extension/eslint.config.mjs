import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/**', 'media/**', 'node_modules/**', '.vscode-test/**', '*.vsix'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      'no-control-regex': 'off',
    },
  },
  {
    files: ['scripts/**/*.mjs', 'test/integration/**/*.mjs', 'test/integration/**/*.js'],
    languageOptions: { globals: { process: 'readonly', console: 'readonly', __dirname: 'readonly', require: 'readonly', module: 'writable', setTimeout: 'readonly', WebAssembly: 'readonly', TextDecoder: 'readonly' } },
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },
);
