import local from './lint/rules.js';

const CODE = ['core/**/*.js', 'bin/**/*.js', 'view/**/*.js', 'test/**/*.js', 'lint/**/*.js', 'eslint.config.js'];

export default [
  { ignores: ['node_modules/**', 'test/lint-fixtures/**'] },
  {
    files: CODE,
    plugins: { local },
    languageOptions: { ecmaVersion: 'latest', sourceType: 'module' },
    linterOptions: { reportUnusedDisableDirectives: 'error' },
    rules: { 'local/no-home-path': 'error', 'local/no-comments': 'error' },
  },
  { files: ['core/**/*.js'], languageOptions: { sourceType: 'commonjs' } },
];
