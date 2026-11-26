import local from './lint/rules.js';

const CODE = ['server/**/*.js', 'bin/**/*.js', 'scripts/**/*.js', 'desktop/scripts/**/*.js', 'test/**/*.js', 'lint/**/*.js', 'eslint.config.js'];

export default [
  { ignores: ['node_modules/**', 'dist/**', 'desktop/target/**', 'desktop/gen/**', 'test/lint-fixtures/**'] },
  {
    files: CODE,
    plugins: { local },
    languageOptions: { ecmaVersion: 'latest', sourceType: 'module' },
    linterOptions: { reportUnusedDisableDirectives: 'error' },
    rules: { 'local/no-home-path': 'error', 'local/no-comments': 'error' },
  },
];
