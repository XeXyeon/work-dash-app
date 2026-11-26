import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CLAUDE_HOOKS, CODEX_HOOKS, hookCmd, mergeHooks } from '../bin/hooks.js';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'hooks.js');
const commands = (json) => Object.values(json.hooks).flat().flatMap((g) => g.hooks.map((x) => x.command));

test('빈 설정에 넣으면 목록의 훅이 모두 들어가고, 다시 넣어도 그대로다', () => {
  const once = mergeHooks({}, CLAUDE_HOOKS);
  assert.equal(commands(once).length, CLAUDE_HOOKS.length);
  assert.deepEqual(mergeHooks(once, CLAUDE_HOOKS), once);
  assert.equal(commands(mergeHooks({}, CODEX_HOOKS)).length, CODEX_HOOKS.length);
});

test('다른 도구의 훅과 다른 키는 순서까지 그대로 둔다', () => {
  const other = { type: 'command', command: '/opt/other/hook.sh', timeout: 3 };
  const before = {
    theme: 'dark',
    env: { A: '1' },
    hooks: {
      PreToolUse: [{ matcher: 'Bash', hooks: [other] }],
      Elsewhere: [{ hooks: [other] }],
    },
  };
  const after = mergeHooks(before, CLAUDE_HOOKS);
  assert.equal(after.theme, 'dark');
  assert.deepEqual(after.env, { A: '1' });
  assert.deepEqual(after.hooks.Elsewhere, [{ hooks: [other] }]);
  assert.deepEqual(after.hooks.PreToolUse[0], { matcher: 'Bash', hooks: [other] });
  assert.equal(commands(after).filter((c) => c === other.command).length, 2);
  assert.deepEqual(before.hooks.PreToolUse, [{ matcher: 'Bash', hooks: [other] }], '입력을 바꿨다');
});

test('node 경로가 다른 work-dash 훅은 지금 경로로 고치고, 겹친 것은 하나만 남긴다', () => {
  const old = { type: 'command', command: '/old/node "$HOME/.work-dash/app/core/handoff.js"', timeout: 10 };
  const after = mergeHooks({ hooks: { UserPromptSubmit: [{ hooks: [old, { ...old }] }] } }, CODEX_HOOKS);
  assert.deepEqual(after.hooks.UserPromptSubmit, [{ hooks: [{ type: 'command', command: hookCmd('handoff.js'), timeout: 10 }] }]);
});

test('목록에 없는 work-dash 훅은 빼고, 비게 된 묶음과 이벤트도 지운다', () => {
  const gone = { type: 'command', command: '/n "$HOME/.work-dash/app/core/gone.js"' };
  const other = { type: 'command', command: '/opt/other/hook.sh' };
  const after = mergeHooks({ hooks: { Stop: [{ hooks: [gone, other] }], Removed: [{ hooks: [gone] }] } }, CODEX_HOOKS);
  assert.deepEqual(after.hooks.Stop, [{ hooks: [other] }]);
  assert.equal('Removed' in after.hooks, false);
});

test('명령: 표준 입력을 고쳐 표준 출력으로 내고, 읽지 못하면 아무것도 내지 않고 실패한다', () => {
  const ok = spawnSync(process.execPath, [CLI, 'codex'], { input: '', encoding: 'utf8' });
  assert.equal(ok.status, 0);
  assert.equal(commands(JSON.parse(ok.stdout)).length, CODEX_HOOKS.length);
  for (const input of ['{ 깨진', '[]', '{"hooks": []}']) {
    const bad = spawnSync(process.execPath, [CLI, 'claude'], { input, encoding: 'utf8' });
    assert.equal(bad.status, 1, input);
    assert.equal(bad.stdout, '', input);
  }
  assert.equal(spawnSync(process.execPath, [CLI], { input: '{}', encoding: 'utf8' }).status, 2);
});

test('work-dash 경로를 감싸 부르는 남의 명령은 건드리지 않는다', () => {
  const wrapped = { type: 'command', command: 'other wrap --then ~/.work-dash/app/core/cmdcheck.js', timeout: 3 };
  const after = mergeHooks({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [wrapped] }] } }, CODEX_HOOKS);
  assert.deepEqual(after.hooks.PreToolUse[0], { matcher: 'Bash', hooks: [wrapped] });
  assert.equal(commands(after).filter((c) => c === hookCmd('cmdcheck.js')).length, 1);
});

test('제한 시간을 목록 값으로 맞추고, 같은 matcher의 다른 묶음에 겹친 것도 하나만 남긴다', () => {
  const a = { type: 'command', command: '/n "$HOME/.work-dash/app/core/cmdcheck.js"', timeout: 99 };
  const after = mergeHooks({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [a] }, { matcher: 'Bash', hooks: [{ ...a }] }] } }, CODEX_HOOKS);
  assert.deepEqual(after.hooks.PreToolUse.filter((g) => g.matcher === 'Bash'), [{ matcher: 'Bash', hooks: [{ type: 'command', command: hookCmd('cmdcheck.js'), timeout: 10 }] }]);
});
