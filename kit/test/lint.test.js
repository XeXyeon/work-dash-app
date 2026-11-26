import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const eslint = new ESLint({ cwd: REPO });
const fixer = new ESLint({ cwd: REPO, fix: true });

async function rules(code, file) {
  const [r] = await eslint.lintText(code, { filePath: path.join(REPO, file) });
  return r.messages.map((m) => m.ruleId);
}

test('홈 폴더를 직접 구하면 막는다', async () => {
  assert.deepEqual(await rules("import os from 'node:os';\nexport const a = os.homedir();\n", 'lint/x.js'), ['local/no-home-path']);
  assert.deepEqual(await rules('export const a = process.env.HOME;\n', 'lint/x.js'), ['local/no-home-path']);
  assert.deepEqual(await rules("export const a = process.env['USERPROFILE'];\n", 'bin/x.js'), ['local/no-home-path']);
  assert.deepEqual(await rules("const os = require('os');\nmodule.exports = os.userInfo().homedir;\n", 'core/x.js'), ['local/no-home-path']);
});

test('경로 모듈과 HOME을 넘겨주는 코드는 통과한다', async () => {
  assert.deepEqual(await rules("const os = require('os');\nmodule.exports = os.homedir();\n", 'core/paths.js'), []);
  assert.deepEqual(await rules("const os = require('os');\nmodule.exports = os.homedir();\n", 'core/scope.js'), []);
  assert.deepEqual(await rules('export const env = { ...process.env, HOME: process.cwd() };\n', 'test/x.test.js'), []);
});

test('주석을 막고, 실행 파일 머리와 도구 지시문은 남긴다', async () => {
  assert.deepEqual(await rules('// 설명\nexport const a = 1; /* 꼬리 */\n', 'lint/x.js'), ['local/no-comments', 'local/no-comments']);
  assert.deepEqual(await rules('#!/usr/bin/env node\n// 사용법\n//   node x.js\nexport const a = 1;\n', 'bin/x.js'), []);
  assert.deepEqual(await rules('#!/usr/bin/env node\n// 사용법\nexport const a = 1;\n// 본문 주석\n', 'bin/x.js'), ['local/no-comments']);
  assert.deepEqual(await rules('// 머리 설명\nexport const a = 1;\n', 'lint/x.js'), ['local/no-comments']);
  assert.deepEqual(await rules("import os from 'node:os';\n// eslint-disable-next-line local/no-home-path\nexport const a = os.homedir();\n", 'lint/x.js'), []);
  assert.deepEqual(await rules("export const u = 'http://a/b'; export const s = '/* x */';\n", 'lint/x.js'), []);
});

test('--fix는 주석만 지운다', async () => {
  const code = '// 머리\nexport const a = 1;   // 꼬리\n\n  /* 블록\n     둘째 줄 */\nexport const b = /* 사이 */ 2;\n';
  const [r] = await fixer.lintText(code, { filePath: path.join(REPO, 'lint/x.js') });
  assert.equal(r.output, 'export const a = 1;\n\nexport const b = 2;\n');
});
