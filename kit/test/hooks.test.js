import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DOCCHECK = path.join(REPO, 'core', 'doccheck.js');
const EDITCHECK = path.join(REPO, 'core', 'editcheck.js');
const CMDCHECK = path.join(REPO, 'core', 'cmdcheck.js');
const DELEGATECHECK = path.join(REPO, 'core', 'delegatecheck.js');

let root, wd, typed, plain, env;

function git(dir, ...args) {
  return execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}
function repo(name, subjects) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir);
  git(dir, 'init', '-q');
  for (const s of subjects) git(dir, 'commit', '-q', '--allow-empty', '-m', s);
  return dir;
}
function hook(script, ev) {
  const r = spawnSync(process.execPath, [script], { input: typeof ev === 'string' ? ev : JSON.stringify(ev), env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout ? JSON.parse(r.stdout) : null;
}

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'wd-hooks-'));
  wd = path.join(root, 'data');
  env = { ...process.env, HOME: root, WORK_DASH_DIR: wd, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };
  for (const d of ['roadmaps', 'issues', 'worklogs/demo']) fs.mkdirSync(path.join(wd, d), { recursive: true });
  fs.writeFileSync(path.join(wd, 'roadmaps', 'demo.md'), [
    '# demo 로드맵', '',
    '## M1. 장바구니 공유', '    완료 기준: 공유 링크로 같은 장바구니를 본다',
    '- [x] CART-1 장바구니 엔티티',
    '- [~] CART-2 공유 API',
    '- [ ] CART-3 링크 만료 (after: CART-2)', '',
  ].join('\n'));
  fs.writeFileSync(path.join(wd, 'issues', 'demo.md'), '# demo 이슈\n\n- [ ] CART-2#1 [중간][버그] 링크가 두 번 만들어짐\n- [ ] ISS-1 [낮음][설정] 설정 키 누락\n');
  typed = repo('typed', ['feat: 하나', 'fix: 둘', 'feat: 셋', 'chore: 넷', 'feat: 다섯', 'docs: 여섯']);
  plain = repo('plain', ['장바구니 추가', '주문 추가', '결제 추가', '환불 추가', '알림 추가']);
});
after(() => fs.rmSync(root, { recursive: true, force: true }));

const roadmapFile = () => path.join(wd, 'roadmaps', 'demo.md');
const edit = (file, extra) => ({ tool_name: 'Edit', tool_input: { file_path: file, old_string: 'a', new_string: 'b' }, ...extra });
const patch = (newStart, ...added) => ({ tool_response: { structuredPatch: [{ newStart, lines: added.map((l) => `+${l}`) }] } });

test('문서 훅: 방금 고친 줄의 위반은 고칠 방법과 함께 돌려준다', () => {
  const out = hook(DOCCHECK, edit(roadmapFile(), patch(6, '- [~] CART-2 공유 API')));
  assert.equal(out.decision, 'block');
  assert.match(out.reason, /roadmaps\/demo\.md:6 \[roadmap-owner\].* → /);
});

test('문서 훅: 고치지 않은 줄의 위반은 돌려주지 않는다', () => {
  assert.equal(hook(DOCCHECK, edit(roadmapFile(), patch(7, '- [ ] CART-3 링크 만료 (after: CART-2)'))), null);
});

test('문서 훅: 바뀐 줄 정보가 없으면 새 글에서 줄을 찾고, 새로 쓴 파일은 전부 본다', () => {
  const byString = hook(DOCCHECK, { tool_name: 'Edit', tool_input: { file_path: roadmapFile(), old_string: 'x', new_string: '- [~] CART-2 공유 API' } });
  assert.match(byString.reason, /\[roadmap-owner\]/);
  const created = hook(DOCCHECK, { tool_name: 'Write', tool_input: { file_path: roadmapFile() }, tool_response: { type: 'create' } });
  assert.match(created.reason, /\[roadmap-owner\]/);
  const original = fs.readFileSync(roadmapFile(), 'utf8').replace('- [~] CART-2 공유 API', '- [~] CART-2 공유 API @claude');
  const rewritten = hook(DOCCHECK, { tool_name: 'Write', tool_input: { file_path: roadmapFile() }, tool_response: { type: 'update', originalFile: original } });
  assert.match(rewritten.reason, /roadmaps\/demo\.md:6 \[roadmap-owner\]/);
});

test('문서 훅: 형식 문서가 아닌 파일 · 다른 도구 · 깨진 입력은 넘어간다', () => {
  const other = path.join(root, 'notes.md');
  fs.writeFileSync(other, '- [?] 아무 글\n');
  assert.equal(hook(DOCCHECK, edit(other)), null);
  assert.equal(hook(DOCCHECK, edit(path.join(wd, 'worklogs', 'demo', '인수인계.md'))), null);
  assert.equal(hook(DOCCHECK, { tool_name: 'Read', tool_input: { file_path: roadmapFile() } }), null);
  assert.equal(hook(DOCCHECK, edit(path.join(wd, 'roadmaps', 'none.md'))), null);
  assert.equal(hook(DOCCHECK, '{깨진 입력'), null);
  assert.equal(hook(DOCCHECK, ''), null);
});

const issuesFile = () => path.join(wd, 'issues', 'demo.md');
const swap = (file, old_string, new_string, more) => ({ tool_name: 'Edit', tool_input: { file_path: file, old_string, new_string, ...more } });

test('편집 훅: 로드맵 · 이슈의 상태 기호를 손으로 바꾸면 막고 명령을 알려 준다', () => {
  assert.match(denied(hook(EDITCHECK, swap(roadmapFile(), '- [ ] CART-3 링크 만료', '- [~] CART-3 링크 만료 @claude'))), /`CART-3`의 상태를 `\[ \]`에서 `\[~\]`로 .* → `node ~\/\.work-dash\/app\/core\/item\.js start CART-3`/);
  assert.match(denied(hook(EDITCHECK, swap(roadmapFile(), '[~] CART-2', '[x] CART-2'))), /item\.js done CART-2/);
  assert.match(denied(hook(EDITCHECK, swap(issuesFile(), '- [ ] ISS-1 ', '- [x] ISS-1 '))), /item\.js issue resolve ISS-1/);
  assert.match(denied(hook(EDITCHECK, { tool_name: 'MultiEdit', tool_input: { file_path: roadmapFile(), edits: [{ old_string: '공유 API', new_string: '공유 링크 API' }, { old_string: '[~] CART-2', new_string: '[>] CART-2' }] } })), /item\.js hold CART-2/);
  const whole = fs.readFileSync(roadmapFile(), 'utf8').replace('[x] CART-1', '[ ] CART-1');
  assert.match(denied(hook(EDITCHECK, { tool_name: 'Write', tool_input: { file_path: roadmapFile(), content: whole } })), /item\.js reopen CART-1/);
});

test('편집 훅: 새 항목 · 새 이슈 줄을 손으로 넣으면 막는다', () => {
  assert.match(denied(hook(EDITCHECK, swap(roadmapFile(), '- [ ] CART-3 링크 만료 (after: CART-2)', '- [ ] CART-3 링크 만료 (after: CART-2)\n- [ ] CART-4 링크 통계'))), /새 항목 `CART-4` .* → `node .*item\.js add /);
  assert.match(denied(hook(EDITCHECK, swap(issuesFile(), '- [ ] ISS-1 ', '- [ ] ISS-2 [낮음][버그] 새 문제\n- [ ] ISS-1 '))), /새 이슈 `ISS-2` .*issue add/);
});

test('편집 훅: 제목 · 범위 · 메모를 고치거나 줄을 옮기는 편집, 새 파일, 다른 파일은 지나간다', () => {
  assert.equal(hook(EDITCHECK, swap(roadmapFile(), 'CART-3 링크 만료', 'CART-3 링크 만료 처리 (만료 시각 · 정리)')), null);
  assert.equal(hook(EDITCHECK, swap(roadmapFile(), '- [~] CART-2 공유 API', '- [~] CART-2 공유 API\n    결정(2026-11-01): 7일 뒤 만료')), null);
  const lines = fs.readFileSync(roadmapFile(), 'utf8').split('\n');
  [lines[4], lines[5]] = [lines[5], lines[4]];
  assert.equal(hook(EDITCHECK, { tool_name: 'Write', tool_input: { file_path: roadmapFile(), content: lines.join('\n') } }), null);
  assert.equal(hook(EDITCHECK, { tool_name: 'Write', tool_input: { file_path: path.join(wd, 'roadmaps', 'new.md'), content: '# new 로드맵\n\n## M1. 시작\n    완료 기준: 된다\n- [ ] NEW-1 첫 항목\n' } }), null);
  assert.equal(hook(EDITCHECK, swap(path.join(root, 'note.md'), '- [ ] CART-3', '- [x] CART-3')), null);
  assert.equal(hook(EDITCHECK, swap(roadmapFile(), '없는 글', '- [x] CART-3 링크 만료')), null);
  assert.equal(hook(EDITCHECK, '{깨진 입력'), null);
});

test('편집 훅: Codex apply_patch로 상태를 바꾸거나 항목을 넣어도 막는다', () => {
  const ap = (...body) => ({ tool_name: 'apply_patch', turn_id: 't1', cwd: wd, tool_input: { command: ['*** Begin Patch', '*** Update File: roadmaps/demo.md', '@@', ...body, '*** End Patch'].join('\n') } });
  assert.match(denied(hook(EDITCHECK, ap('-- [ ] CART-3 링크 만료 (after: CART-2)', '+- [x] CART-3 링크 만료 (after: CART-2)'))), /item\.js done CART-3/);
  assert.match(denied(hook(EDITCHECK, ap(' - [ ] CART-3 링크 만료 (after: CART-2)', '+- [ ] CART-9 링크 통계'))), /새 항목 `CART-9`/);
  assert.equal(hook(EDITCHECK, ap('-- [ ] CART-3 링크 만료 (after: CART-2)', '+- [ ] CART-3 링크 만료 처리 (after: CART-2)')), null);
  const raw = (...lines) => ({ tool_name: 'apply_patch', turn_id: 't1', cwd: wd, tool_input: { command: ['*** Begin Patch', ...lines, '*** End Patch'].join('\n') } });
  assert.match(denied(hook(EDITCHECK, raw('*** Add File: roadmaps/demo.md', '+# demo 로드맵', '+- [x] CART-3 링크 만료'))), /item\.js done CART-3/);
  assert.match(denied(hook(EDITCHECK, raw('*** Update File: note.md', '*** Move to: roadmaps/demo.md', '+- [-] CART-3 링크 만료'))), /item\.js drop CART-3 "<이유>"/);
  assert.equal(hook(EDITCHECK, raw('*** Add File: roadmaps/fresh.md', '+# fresh 로드맵', '+- [ ] NEW-1 첫 항목')), null);
});

const bash = (command, cwd) => ({ tool_name: 'Bash', tool_input: { command }, cwd });
const denied = (out) => {
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
  return out.hookSpecificOutput.permissionDecisionReason;
};

const passed = (out) => assert.equal(out, null);
const denyOnly = (out) => (out && out.hookSpecificOutput.permissionDecision === 'deny' ? out : null);

const asked = (out) => {
  assert.equal(out.hookSpecificOutput.permissionDecision, 'ask');
  return out.hookSpecificOutput.permissionDecisionReason;
};

test('명령 훅: 저장소의 머리말 형식을 따른 커밋은 막지도 묻지도 않는다', () => {
  passed(hook(CMDCHECK, bash('git commit -m "feat: 공유 링크 추가"', typed)));
  passed(hook(CMDCHECK, bash('git add -A && git commit -m "fix(cart): 만료 처리"', typed)));
  passed(hook(CMDCHECK, bash('git commit -m "공유 링크 추가"', plain)));
  passed(hook(CMDCHECK, bash(`git -C ${plain} commit -m "공유 링크 추가"`, typed)));
  passed(hook(CMDCHECK, bash(`cd ${plain} && git commit -m "공유 링크 추가"`, typed)));
  passed(hook(CMDCHECK, bash('git commit -m "feat: UTF-8 처리와 HTTP-2 지원"', typed)));
  passed(hook(CMDCHECK, bash('git commit --amend --no-edit', typed)));
});

test('명령 훅: 승인은 PR 만들기에만 묻고, 푸시 · PR 병합 · 로드맵 항목 추가는 묻지 않는다', () => {
  passed(hook(CMDCHECK, bash('git push -u origin feat/share', typed)));
  passed(hook(CMDCHECK, bash(`git -C ${typed} push`, plain)));
  passed(hook(CMDCHECK, bash('git commit -m "feat: 하나" && git push', typed)));
  assert.match(asked(hook(CMDCHECK, bash('gh pr create --title "feat: 공유 링크" --body "공유 링크를 만든다"', typed))), /PR 만들기/);
  passed(hook(CMDCHECK, bash('gh pr merge 3 --squash', typed)));
  passed(hook(CMDCHECK, bash('node ~/.work-dash/app/core/item.js add M1 "링크 통계"', typed)));
  passed(hook(CMDCHECK, bash('node core/item.js --project demo add M1 "링크 통계"', typed)));
  passed(hook(CMDCHECK, bash('node core/item.js milestone "통계" "통계를 본다"', typed)));
  for (const c of [
    'bash -c "git push"', "sh -c 'git commit -m \"feat: x\"'", 'git -P push', 'git --git-dir .git push', 'env X=1 /usr/bin/git push',
    'gh api -X PUT repos/o/r/pulls/3/merge', 'gh -R o/r pr merge 3', 'gh pr --repo o/r merge 3',
    'node core/item.js --project "My Proj" add M1 "x"',
  ]) passed(hook(CMDCHECK, bash(c, typed)));
});

test('명령 훅: 상태만 바꾸거나 읽기만 하는 명령은 묻지 않는다', () => {
  for (const c of [
    'git stash push -m wip', 'git log --oneline | grep push', 'gh pr view 3', 'gh pr checks 3', 'gh api repos/o/r/pulls/3', 'git help push', 'git config push.default simple',
    'node core/item.js start CART-3', 'node core/item.js done CART-2', 'node core/item.js memo CART-2 결정 "add 하지 않음"',
    'node core/item.js issue add --parent CART-2 --sev 낮음 --kind 버그 "제목"', 'node core/item.js',
  ]) assert.equal(hook(CMDCHECK, bash(c, typed)), null, c);
});

test('명령 훅: 머리말이 저장소와 다르면 막는다', () => {
  assert.match(denied(hook(CMDCHECK, bash('git commit -m "공유 링크 추가"', typed))), /머리말이 없다 → /);
  assert.match(denied(hook(CMDCHECK, bash('git commit -m "wip: 공유 링크"', typed))), /`wip:`는 .*쓴 적이 없다 → /);
  assert.match(denied(hook(CMDCHECK, bash('git commit -m "feat: 공유 링크 추가"', plain))), /머리말을 쓰지 않는다/);
  assert.match(denied(hook(CMDCHECK, bash(`git -C ${typed} commit -m "공유 링크 추가"`, plain))), /머리말이 없다/);
});

test('명령 훅: 개인 로드맵 · 이슈 ID가 든 커밋 · PR 메시지를 막는다', () => {
  assert.match(denied(hook(CMDCHECK, bash('git commit -m "feat: CART-2 공유 링크"', typed))), /`CART-2`.* → /);
  assert.match(denied(hook(CMDCHECK, bash('git commit -m "feat: 공유 링크" -m "Roadmap: CART-2#1"', typed))), /`CART-2#1`/);
  assert.match(denied(hook(CMDCHECK, bash('git commit -m "$(cat <<\'EOF\'\nfeat: 공유 링크\n\nISS-1을 함께 고침\nEOF\n)"', typed))), /`ISS-1`/);
  const msg = path.join(root, 'msg.txt');
  fs.writeFileSync(msg, 'feat: 공유 링크\n\nCART-3 준비\n');
  assert.match(denied(hook(CMDCHECK, bash(`git commit -F ${msg}`, typed))), /`CART-3`/);
  assert.match(denied(hook(CMDCHECK, bash('gh pr create --title "feat: 공유 링크" --body "CART-2 구현"', typed))), /^\[work-dash\][\s\S]*PR 메시지에.*`CART-2`/);
});

test('명령 훅: 무엇을 바꿨는지 알 수 없는 커밋 제목을 막는다', () => {
  assert.match(denied(hook(CMDCHECK, bash('git commit -m "수정"', plain))), /제목 "수정"만으로는 .* → /);
  assert.match(denied(hook(CMDCHECK, bash('git commit -m "fix: 수정"', typed))), /제목 "fix: 수정"/);
  denied(hook(CMDCHECK, bash('git commit -m "WIP"', plain)));
  denied(hook(CMDCHECK, bash('git commit -m "chore: 기타."', typed)));
  denied(hook(CMDCHECK, bash('git commit -m "Update"', plain)));
  for (const t of ['...', '수정함', 'minor', 'wip2']) denied(hook(CMDCHECK, bash(`git commit -m "${t}"`, plain)));
  for (const t of ['수정함수 이름을 바꿈', 'minor 버전 올림', 'Revert \\"수정\\"']) passed(hook(CMDCHECK, bash(`git commit -m "${t}"`, plain)));
  passed(hook(CMDCHECK, bash('git commit -m "수정 버튼 색을 바꿈"', plain)));
  passed(hook(CMDCHECK, bash('git commit -m "fix: 기타 메뉴가 안 열리던 문제"', typed)));
  passed(hook(CMDCHECK, bash('git commit -m "fix: update 쿼리의 조건 누락"', typed)));
});

test('명령 훅: 내 컴퓨터의 경로가 든 커밋 · PR 메시지를 막는다', () => {
  assert.match(denied(hook(CMDCHECK, bash('gh pr create --title "feat: 공유 링크" --body "자세한 것은 ~/.work-dash/roadmaps/demo.md"', typed))), /PR 메시지에 내 컴퓨터의 경로 `~\/\.work-dash\/roadmaps\/demo\.md`.* → /);
  assert.match(denied(hook(CMDCHECK, bash(`gh pr create --title "feat: 공유 링크" --body "경로는${root}/app/src/a.ts, 그리고 [${root}/b.md]"`, typed))), /app\/src\/a\.ts` · `.*\/b\.md`/);
  assert.match(denied(hook(CMDCHECK, bash('git commit -m "feat: 공유 링크" -m "참고: $HOME/.work-dash/issues/demo.md"', typed))), /`\$HOME\/\.work-dash\/issues\/demo\.md`/);
  asked(hook(CMDCHECK, bash('gh pr create --title "feat: 공유 링크" --body "src/a.ts · docs/erd.md · 약 ~10분 · a/Users/b · /home/runner/work/x · /Users/Shared/x · https://example.com/home/user/x · ~/.work-dash/RULES.md · ~/.local/bin · ~/.work-dash/flows/<프로젝트>.md"', typed)));
  passed(hook(CMDCHECK, bash(`git -C ${typed} commit -m "feat: 공유 링크"`, plain)));
});

test('명령 훅: 옵션을 길게 되풀이한 명령도 바로 판정한다', () => {
  const started = Date.now();
  hook(CMDCHECK, bash('git ' + '-c "a" '.repeat(40) + 'status', typed));
  hook(CMDCHECK, bash('node core/item.js ' + '--a '.repeat(40) + 'status', typed));
  hook(CMDCHECK, bash('cat ' + '"a b" '.repeat(400) + 'x.md |', typed));
  assert.ok(Date.now() - started < 3000);
});

test('명령 훅: 커밋이 아닌 명령 · 다른 도구 · 깨진 입력은 넘어간다', () => {
  assert.equal(hook(CMDCHECK, bash('git status', typed)), null);
  assert.equal(hook(CMDCHECK, bash('git log --oneline | grep commit', typed)), null);
  assert.equal(hook(CMDCHECK, bash('echo "CART-2 commit"', typed)), null);
  assert.equal(hook(CMDCHECK, { tool_name: 'Edit', tool_input: { file_path: 'a', new_string: 'git commit -m "CART-2"' } }), null);
  assert.equal(hook(CMDCHECK, '{깨진 입력'), null);
});

const HANDOFF = path.join(REPO, 'core', 'handoff.js');

function codexSession(tokens) {
  const cwd = path.join(root, 'demo');
  const file = path.join(root, '.codex', 'sessions', 'rollout.jsonl');
  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: tokens } } } }) + '\n');
  return { hook_event_name: 'UserPromptSubmit', session_id: 's1', transcript_path: file, cwd };
}

test('인수인계 훅: Codex 세션이 커지면 메모 위치 · 모양 · 적을 것을 문구로 넣는다', () => {
  assert.equal(hook(HANDOFF, codexSession(50000)), null);
  const text = hook(HANDOFF, codexSession(80000)).hookSpecificOutput.additionalContext;
  assert.match(text, /약 8만 토큰/);
  assert.match(text, /worklogs\/demo\/인수인계\.md/);
  assert.match(text, /## 지금 상태 \(<날짜 시각>\)[\s\S]*## 지난 기록/);
  for (const s of ['맡겨 둔 세션 · 에이전트', '기다리는 것', '말로만 정한 것', '열려 있는 것', '다음에 할 일 · 확인하지 못한 것']) assert.ok(text.includes(`### ${s}`), s);
  assert.doesNotMatch(text, /RULES-HANDOFF/);
  assert.equal(hook(HANDOFF, codexSession(85000)), null);
  assert.ok(hook(HANDOFF, codexSession(96000)));
  assert.match(hook(HANDOFF, codexSession(50000)).hookSpecificOutput.additionalContext, /압축됐다.*worklogs\/demo\/인수인계\.md.*지금 상태/);
  assert.equal(hook(HANDOFF, codexSession(50000)), null);
  assert.ok(hook(HANDOFF, codexSession(80000)));
});

test('인수인계 훅: Claude 세션의 메시지와 관리하지 않는 폴더는 넘어간다', () => {
  const ev = codexSession(80000);
  assert.equal(hook(HANDOFF, { ...ev, session_id: 's2', transcript_path: path.join(root, 'claude.jsonl') }), null);
  const other = path.join(root, 'elsewhere');
  fs.mkdirSync(other, { recursive: true });
  assert.equal(hook(HANDOFF, { ...ev, session_id: 's3', cwd: other }), null);
});

test('인수인계 훅: 압축 요약의 블록을 메모 맨 위에 쓰고 이전 것은 지난 기록으로 내린다', () => {
  const cwd = path.join(root, 'demo');
  const pre = spawnSync(process.execPath, [HANDOFF], { input: JSON.stringify({ hook_event_name: 'PreCompact', cwd }), env, encoding: 'utf8' });
  assert.match(pre.stdout, /\[인수인계 시작\][\s\S]*### 말로만 정한 것[\s\S]*\[인수인계 끝\]/);
  const post = (body) => hook(HANDOFF, { hook_event_name: 'PostCompact', cwd, trigger: 'manual', compact_summary: `요약\n[인수인계 시작]\n${body}\n[인수인계 끝]` });
  post('첫째 상태');
  post('둘째 상태');
  const memo = fs.readFileSync(path.join(wd, 'worklogs', 'demo', '인수인계.md'), 'utf8');
  assert.match(memo, /^# demo 인수인계\n\n## 지금 상태 \([^)]*압축 때 자동 작성\)\n둘째 상태\n\n## 지난 기록 \([^)]*\)\n첫째 상태\n$/);
});

const READCHECK = path.join(REPO, 'core', 'readcheck.js');
const read = (file, extra) => ({ tool_name: 'Read', tool_input: { file_path: file, ...extra } });

function bigDocs() {
  const filler = Array.from({ length: 700 }, (_, i) => `- [ ] BULK-${i + 1} 채우는 항목 ${i + 1}`).join('\n');
  const big = { roadmap: path.join(wd, 'roadmaps', 'big.md'), issues: path.join(wd, 'issues', 'big.md'), flows: path.join(wd, 'flows', 'big.md') };
  fs.mkdirSync(path.join(wd, 'flows'), { recursive: true });
  for (const f of Object.values(big)) fs.writeFileSync(f, `# big\n\n## M1. 가\n${filler}\n`);
  return big;
}

test('읽기 훅: 큰 로드맵 · 이슈 · 흐름 문서를 통째로 읽으면 막고 볼 방법을 알려 준다', () => {
  const big = bigDocs();
  assert.match(denied(hook(READCHECK, read(big.roadmap))), /roadmaps\/big\.md.* → .*item\.js show <ID>/);
  assert.match(denied(hook(READCHECK, read(big.issues))), /item\.js issue`/);
  assert.match(denied(hook(READCHECK, read(big.flows))), /전체 구조/);
  denied(hook(READCHECK, read(big.roadmap, { offset: 100 })));
  denied(hook(READCHECK, read(big.roadmap, { limit: 2000 })));
});

test('지켜보는 훅: 큰 출력과 상태 확인을 막지 않고 기록하고, 요약이 되풀이 수를 센다', () => {
  const WATCH = path.join(REPO, 'core', 'watch.js');
  const logFile = path.join(wd, 'data', 'hook-log.jsonl');
  const rows = () => fs.readFileSync(logFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((r) => r.session === 'watch-1');
  const post = (stdout) => ({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'cd /tmp && npm test -- --verbose' }, tool_response: { stdout, stderr: '' }, session_id: 'watch-1' });
  assert.equal(hook(WATCH, post('x'.repeat(30000))), null);
  assert.equal(hook(WATCH, post('x'.repeat(500))), null);
  assert.equal(hook(WATCH, { ...post(''), tool_response: [{ type: 'text', text: 'y'.repeat(500) }], session_id: 'watch-2' }), null);
  assert.equal(hook(WATCH, { ...post(''), tool_response: [{ type: 'text', text: 'y'.repeat(30000) }], session_id: 'watch-3' }), null);
  assert.ok(fs.readFileSync(logFile, 'utf8').includes('"session":"watch-3"') && !fs.readFileSync(logFile, 'utf8').includes('"session":"watch-2"'));
  const poll = (tool) => ({ hook_event_name: 'PreToolUse', tool_name: tool, tool_input: {}, session_id: 'watch-1' });
  for (const tool of ['mcp__ccd_session_mgmt__get_session', 'mcp__ccd_session_mgmt__list_sessions', 'Read']) assert.equal(hook(WATCH, poll(tool)), null);
  const seen = rows();
  assert.deepEqual(seen.map((r) => [r.kind, r.check]), [['watch', 'big-output'], ['watch', 'status-poll'], ['watch', 'status-poll']]);
  assert.match(seen[0].text, /출력 30천 자: npm test/);
  const r = spawnSync(process.execPath, [path.join(REPO, 'core', 'check.js'), '--log'], { env, encoding: 'utf8' });
  assert.match(r.stdout, /- status-poll: 지켜봄 2 · 같은 세션에서 10분 안에 되풀이 1/);
});

test('읽기 훅: 이유를 대고 연 세션만 통째로 읽고, 다른 세션은 그대로 막힌다', () => {
  const big = bigDocs();
  const on = (ev, session) => ({ ...ev, session_id: session });
  assert.match(denied(hook(READCHECK, on(read(big.roadmap), 'lead-1'))), /check\.js --read-all "<이유>"/);
  assert.match(denied(hook(CMDCHECK, on(bash('node ~/.work-dash/app/core/check.js --read-all'), 'lead-1'))), /이유가 필요하다/);
  denied(hook(READCHECK, on(read(big.roadmap), 'lead-1')));
  const opened = hook(CMDCHECK, on(bash('node ~/.work-dash/app/core/check.js --read-all "마일스톤을 다시 나눈다"'), 'lead-1'));
  assert.match(opened.systemMessage, /통째 읽기를 열었다 — 이유: 마일스톤을 다시 나눈다/);
  assert.equal(hook(READCHECK, on(read(big.roadmap), 'lead-1')), null);
  assert.equal(hook(CMDCHECK, on(bash(`cat ${big.flows}`), 'lead-1')), null);
  denied(hook(READCHECK, on(read(big.roadmap), 'worker-2')));
  denied(hook(CMDCHECK, on(bash(`cat ${big.flows}`), 'worker-2')));
  denied(hook(READCHECK, { ...on(read(big.roadmap), 'lead-1'), agent_id: 'sub-1' }));
  const rows = fs.readFileSync(path.join(wd, 'data', 'hook-log.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.ok(rows.some((r) => r.kind === 'skip' && r.check === 'read-doc' && r.session === 'lead-1' && r.reason === '마일스톤을 다시 나눈다'));
});

test('읽기 훅: 범위를 준 읽기 · 작은 문서 · 다른 파일은 넘어간다', () => {
  const big = bigDocs();
  assert.equal(hook(READCHECK, read(big.roadmap, { offset: 100, limit: 80 })), null);
  assert.equal(hook(READCHECK, read(big.roadmap, { limit: 400 })), null);
  assert.equal(hook(READCHECK, read(roadmapFile())), null);
  assert.equal(hook(READCHECK, read(path.join(wd, 'worklogs', 'demo', 'CART-2.md'))), null);
  assert.equal(hook(READCHECK, read(path.join(root, 'none.md'))), null);
  assert.equal(hook(READCHECK, { tool_name: 'Bash', tool_input: { command: 'ls' } }), null);
  assert.equal(hook(READCHECK, '{깨진 입력'), null);
});

test('명령 훅: 큰 문서를 cat으로 통째로 내보내면 막고, 걸러 보는 명령은 넘어간다', () => {
  const big = bigDocs();
  assert.match(denied(hook(CMDCHECK, bash(`cat ${big.roadmap}`, typed))), /읽기를 막았다/);
  denied(hook(CMDCHECK, bash(`cd /tmp && cat -n "${big.issues}"`, typed)));
  denied(hook(CMDCHECK, bash('cat roadmaps/big.md', wd)));
  denied(hook(CMDCHECK, bash(`cat ${big.roadmap} 2>&1`, typed)));
  denied(hook(CMDCHECK, bash(`cat ${big.roadmap} || true`, typed)));
  denied(hook(CMDCHECK, bash(`cat README.md "${big.flows}" && ls`, typed)));
  for (const c of [`head -n 5000 ${big.roadmap}`, `head -5000 "${big.roadmap}"`, `head -n -5 ${big.roadmap}`, `tail -n +1 ${big.roadmap}`, `tail -n 3000 ${big.issues}`, `sed -n '1,9999p' ${big.roadmap}`, `sed -n "100,\\$p" ${big.flows}`, `sed 's/a/b/' ${big.roadmap}`, `sed -n -e '1,2000p' ${big.roadmap}`, `sed --expression=1,5000p -n ${big.roadmap}`, `cd /tmp && cat ${big.roadmap}`, `echo a; (head -n 5000 ${big.roadmap})`]) {
    denied(hook(CMDCHECK, bash(c, typed)));
  }
  for (const c of [`head ${big.roadmap}`, `head -n 400 ${big.roadmap}`, `head -50 ${big.roadmap}`, `tail -n 80 ${big.roadmap}`, `tail -c 500 ${big.roadmap}`, `sed -n '100,180p' ${big.roadmap}`, `sed -n '/^## M2/,/^## M3/p' ${big.roadmap}`, `sed 's/a/b/' ${big.roadmap} > /tmp/x`, `head -n 5000 ${big.roadmap} | grep CART`, `head -n 5000 ${roadmapFile()}`, 'head -n 5000 README.md', `grep more ${big.roadmap}`, `grep -n less ${big.roadmap}`, `grep cat ${big.roadmap}`, `echo "see more ${big.roadmap}"`, `cat ${big.roadmap} ${'x '.repeat(12000)}`]) {
    assert.equal(denyOnly(hook(CMDCHECK, bash(c, typed))), null, c);
  }
  for (const c of [`cat ${big.roadmap} | grep CART`, `grep -n '^## ' ${big.roadmap}`, `sed -n 1,40p ${big.roadmap}`, `cat ${big.roadmap} 2>&1 | head -5`, `cat ${big.roadmap} > /tmp/x`, `cat ${roadmapFile()}`, 'cat README.md']) {
    assert.equal(hook(CMDCHECK, bash(c, typed)), null, c);
  }
});

const codex = (ev) => ({ ...ev, turn_id: 't1', transcript_path: path.join(root, '.codex', 'sessions', 'rollout.jsonl') });

test('Codex: 명령 훅은 막을 것은 막고, 승인 묻기는 내지 않는다', () => {
  const big = bigDocs();
  assert.match(denied(hook(CMDCHECK, codex(bash('git commit -m "feat: CART-2 공유 링크"', typed)))), /`CART-2`/);
  assert.match(denied(hook(CMDCHECK, codex(bash(`cat ${big.roadmap}`, typed)))), /읽기를 막았다/);
  assert.equal(hook(CMDCHECK, codex(bash('git commit -m "feat: 공유 링크 추가"', typed))), null);
  assert.match(denied(hook(CMDCHECK, codex({ ...bash('', typed), tool_input: { command: ['bash', '-lc', 'git commit -m "feat: CART-2 공유 링크"'] } }))), /`CART-2`/);
  assert.equal(hook(CMDCHECK, codex(bash('git push', typed))), null);
  assert.equal(hook(CMDCHECK, codex(bash('node core/item.js add M1 "링크 통계"', typed))), null);
});

test('Codex: apply_patch로 고친 문서의 바뀐 줄 위반을 돌려준다', () => {
  const cwd = path.join(wd, 'roadmaps');
  const patch = (...lines) => codex({ tool_name: 'apply_patch', tool_input: { command: ['*** Begin Patch', ...lines, '*** End Patch'].join('\n') }, cwd });
  const out = hook(DOCCHECK, patch('*** Update File: demo.md', '@@', '-- [~] CART-2 공유 API @claude', '+- [~] CART-2 공유 API'));
  assert.equal(out.decision, 'block');
  assert.match(out.reason, /roadmaps\/demo\.md:6 \[roadmap-owner\].* → /);
  assert.equal(hook(DOCCHECK, patch(`*** Update File: ${roadmapFile()}`, '@@', '+- [ ] CART-3 링크 만료 (after: CART-2)')), null);
  fs.writeFileSync(path.join(wd, 'issues', 'new.md'), '# new 이슈\n\n- [?] ISS-1 [낮음][설정] 키 누락\n');
  fs.writeFileSync(path.join(wd, 'roadmaps', 'new.md'), '# new 로드맵\n\n## M1. 가\n    완료 기준: 된다\n- [ ] A-1 일\n');
  assert.match(hook(DOCCHECK, patch('*** Add File: ../issues/new.md', '+# new 이슈')).reason, /issues\/new\.md:3 \[issue-line\]/);
  assert.equal(hook(DOCCHECK, patch(`*** Update File: ${path.join(root, 'notes.md')}`, '+- [?] 아무 글')), null);
  assert.equal(hook(DOCCHECK, patch('*** Delete File: demo.md')), null);
});

test('명령 훅: WD_SKIP에 이유를 붙이면 막힌 검사를 지나가고, 사용자에게 알리며 기록한다', () => {
  const log = path.join(wd, 'data', 'hook-log.jsonl');
  const skips = () => fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((r) => r.kind === 'skip');
  fs.rmSync(log, { force: true });
  assert.match(denied(hook(CMDCHECK, bash('git commit -m "수정"', plain))), /WD_SKIP="<이유>"/);
  const out = hook(CMDCHECK, bash('WD_SKIP="되돌림 커밋의 제목을 그대로 둔다" git commit -m "수정"', plain));
  assert.equal(out.hookSpecificOutput, undefined);
  const pr = hook(CMDCHECK, bash('WD_SKIP="본문에 항목 번호가 필요하다" gh pr create --title "feat: 공유 링크" --body "CART-2"', typed));
  assert.equal(pr.hookSpecificOutput.permissionDecision, 'ask');
  assert.match(pr.systemMessage, /본문에 항목 번호가 필요하다/);
  asked(hook(CMDCHECK, bash('WD_SKIP="x" gh pr create --title "feat: 공유 링크" --body "공유 링크"', typed)));
  asked(hook(CMDCHECK, bash('/opt/homebrew/bin/gh pr create --title "feat: 공유 링크" --body "공유 링크"', typed)));
  denied(hook(CMDCHECK, bash('node core/check.js --unblock "npm test" "r"; git commit -m "feat: CART-2"', typed)));
  denied(hook(CMDCHECK, bash('git commit -m "feat: check.js --unblock 설명 CART-2"', typed)));
  asked(hook(CMDCHECK, bash('gh pr create --title "feat: x" --body "check.js --unblock 를 설명"', typed)));
  denied(hook(CMDCHECK, bash(`git commit -m "feat: 공유 링크\nWD_SKIP='CART-2' 본문"`, typed)));
  assert.match(hook(CMDCHECK, codex({ ...bash('', plain), tool_input: { command: ['bash', '-lc', 'WD_SKIP="이유" git commit -m "수정"'] } })).systemMessage, /이유/);
  assert.match(out.systemMessage, /검사를 건너뛰었다 — 이유: 되돌림 커밋의 제목을 그대로 둔다\n건너뛴 검사: .*수정/);
  const big = bigDocs();
  assert.match(hook(CMDCHECK, bash(`cd /tmp && WD_SKIP='전체를 옮겨 적어야 한다' cat ${big.roadmap}`, typed)).systemMessage, /전체를 옮겨 적어야 한다/);
  const rows = skips();
  assert.equal(rows.length, 4);
  assert.match(rows[0].text, /수정/);
  assert.deepEqual([rows[0].check, rows[3].check, rows[3].reason], ['message', 'read-dump', '전체를 옮겨 적어야 한다']);
  denied(hook(CMDCHECK, bash('WD_SKIP="" git commit -m "수정"', plain)));
  denied(hook(CMDCHECK, bash('WD_SKIP=x git commit -m "수정"', plain)));
  passed(hook(CMDCHECK, bash('WD_SKIP="필요 없는 표시" git commit -m "공유 링크 추가"', plain)));
  assert.equal(skips().length, 4);
  assert.match(hook(CMDCHECK, bash('node core/check.js --unblock "npm run start" "서버가 아니다"', typed)).systemMessage, /막는 명령을 뺀다: "npm run start"/);
});

const WRITECHECK_DOC = () => path.join(wd, 'worklogs', 'demo', 'CART-2.md');

test('명령 훅: 로드맵 · 이슈 · 작업 카드를 셸로 쓰는 명령을 막고, 읽는 명령과 다른 파일은 넘어간다', () => {
  const card = WRITECHECK_DOC();
  fs.writeFileSync(card, '# CART-2 공유 API\n');
  const road = roadmapFile();
  for (const c of [
    `cat >> ${card} <<'EOF'\n## 검증\n- 실행함\nEOF`,
    `echo "- 메모" >> "${card}"`,
    `printf x > ${road}`,
    `sed -i '' 's/\\[ \\]/[x]/' ${road}`,
    `perl -pi -e 's/a/b/' ${road}`,
    `echo x | tee -a ${card}`,
    `cp /tmp/new.md ${road}`,
    `python3 - <<'EOF'\np='${card}'\nopen(p,'w').write('x')\nEOF`,
    `node -e "require('fs').appendFileSync('${road}', 'x')"`,
    `cd ${path.join(wd, 'roadmaps')} && echo x >> demo.md`,
  ]) assert.match(denied(hook(CMDCHECK, bash(c, c.startsWith('cd ') ? root : typed))), /셸로 `(?:demo\/CART-2|roadmaps\/demo)\.md`를 고친다.* → .*item\.js.*Edit · Write/, c);
  for (const c of [
    `grep -n CART ${road}`,
    `sed -n '1,20p' ${road}`,
    `cat ${card} > /tmp/copy.md`,
    `echo x >> ${path.join(root, 'notes.md')}`,
    `python3 -c "print(open('${road}').read()[:10])"`,
    `node -e "process.stdout.write(require('fs').readFileSync('${road}', 'utf8'))"`,
    `node core/doclint.js ${path.join(wd, 'roadmaps', 'shop-api.md')}`,
    `node -e "require('fs').writeFileSync('/tmp/out.txt', 'x')" && grep -c CART ${road}`,
    `cp ${road} /tmp/backup.md`,
    `echo x >> ${path.join(wd, 'worklogs', 'demo', '인수인계.md')}`,
    'node core/item.js done CART-2',
  ]) passed(hook(CMDCHECK, bash(c, typed)), c);
  assert.match(hook(CMDCHECK, bash(`WD_SKIP="옮겨 적는 스크립트다" echo x >> ${card}`, typed)).systemMessage, /옮겨 적는 스크립트다/);
});

test('훅은 막을 때마다 기록하고, check --log가 검사별로 막음 · 건너뜀 · 다시 막힘을 보여 준다', () => {
  const log = path.join(wd, 'data', 'hook-log.jsonl');
  fs.rmSync(log, { force: true });
  const ev = (o) => ({ ...o, session_id: 's1' });
  denied(hook(CMDCHECK, ev(bash('git commit -m "수정"', plain))));
  denied(hook(CMDCHECK, ev(bash('git commit -m "변경"', plain))));
  hook(CMDCHECK, ev(bash('WD_SKIP="되돌림이다" git commit -m "수정"', plain)));
  denied(hook(EDITCHECK, ev(swap(roadmapFile(), '[~] CART-2', '[x] CART-2'))));
  hook(DOCCHECK, ev(edit(roadmapFile(), patch(6, '- [~] CART-2 공유 API'))));
  const rows = fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(rows.map((r) => `${r.kind}:${r.check}`), ['deny:message', 'deny:message', 'skip:message', 'deny:edit-state', 'deny:doc-format']);
  assert.deepEqual([rows[0].session, rows[0].project, rows[2].reason], ['s1', 'plain', '되돌림이다']);
  const r = spawnSync(process.execPath, [path.join(REPO, 'core', 'check.js'), '--log'], { env, encoding: 'utf8', cwd: root });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /지난 7일: 막음 4 · 건너뜀 1/);
  assert.match(r.stdout, /- message: 막음 2 · 건너뜀 1 · 막힌 뒤 같은 검사에 또 막힘 1 \(plain\)\n {4}\d{4}-\d\d-\d\d 건너뜀 — 이유: 되돌림이다/);
  fs.rmSync(log, { force: true });
  assert.match(spawnSync(process.execPath, [path.join(REPO, 'core', 'check.js'), '--log', '3'], { env, encoding: 'utf8', cwd: root }).stdout, /지난 3일 동안 .*기록이 없다/);
});

test('명령 훅: Sonnet 세션이 처음 항목을 시작하면 한 번 막으며 구현 세션 규칙을 보여 준다', () => {
  fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
  const rules = path.join(root, '.claude', 'CLAUDE-IMPLEMENT.md');
  fs.writeFileSync(rules, '# 구현 세션\n- 정의서에 없는 설계는 고르지 않는다\n');
  const log = (name, model) => { const f = path.join(root, `${name}.jsonl`); fs.writeFileSync(f, `{"type":"assistant","message":{"model":"claude-opus-5-5"}}\n{"type":"assistant","message":{"model":"${model}"}}\n`); return f; };
  const start = 'node ~/.work-dash/app/core/item.js start CART-2';
  const first = denied(hook(CMDCHECK, { ...bash(start, plain), session_id: 'i1', transcript_path: log('i1', 'claude-sonnet-5-5') }));
  assert.match(first, /첫 항목 시작이라 한 번 막고 규칙을 보여 준다[\s\S]*정의서에 없는 설계는 고르지 않는다/);
  passed(hook(CMDCHECK, { ...bash(start, plain), session_id: 'i1', transcript_path: log('i1', 'claude-sonnet-5-5') }));
  passed(hook(CMDCHECK, { ...bash(start, plain), session_id: 'i2', transcript_path: log('i2', 'claude-opus-5-5') }));
  passed(hook(CMDCHECK, { ...bash(start, plain), session_id: 'i3' }));
  passed(hook(CMDCHECK, { ...bash('node ~/.work-dash/app/core/item.js show CART-2', plain), session_id: 'i4', transcript_path: log('i4', 'claude-sonnet-5-5') }));
  fs.rmSync(rules);
});

test('명령 훅: 세션의 첫 커밋은 한 번 막으며 커밋 규칙을 보여 주고, 다음부터는 막지 않는다', () => {
  fs.writeFileSync(path.join(wd, 'RULES-COMMIT.md'), '# 커밋 규칙\n- 커밋은 한 가지 일만 담는다\n');
  const first = denied(hook(CMDCHECK, { ...bash('git commit -m "공유 링크 추가"', plain), session_id: 'c1' }));
  assert.match(first, /첫 커밋 · PR이라 한 번 막고 규칙을 보여 준다[\s\S]*커밋은 한 가지 일만 담는다/);
  passed(hook(CMDCHECK, { ...bash('git commit -m "공유 링크 추가"', plain), session_id: 'c1' }));
  asked(hook(CMDCHECK, { ...bash('gh pr create --title "feat: 공유 링크" --body "공유 링크"', typed), session_id: 'c1' }));
  const bad = denied(hook(CMDCHECK, { ...bash('git commit -m "수정"', plain), session_id: 'c2' }));
  assert.match(bad, /무엇을 바꿨는지 알 수 없다[\s\S]*커밋은 한 가지 일만 담는다/);
  denied(hook(CMDCHECK, { ...bash('git commit -m "수정"', plain), session_id: 'c2' }));
  passed(hook(CMDCHECK, { ...bash('git commit -m "공유 링크 추가"', plain), session_id: 'c2' }));
  passed(hook(CMDCHECK, { ...bash('git status', plain), session_id: 'c3' }));
  passed(hook(CMDCHECK, bash('git commit -m "공유 링크 추가"', plain)));
  fs.rmSync(path.join(wd, 'RULES-COMMIT.md'));
  passed(hook(CMDCHECK, { ...bash('git commit -m "공유 링크 추가"', plain), session_id: 'c4' }));
});

test('명령 훅: 승인을 묻는 명령은 config.json의 ask로 바꾼다', () => {
  const cfg = path.join(wd, 'config.json');
  const pr = bash('gh pr create --title "feat: 공유 링크" --body "공유 링크"', typed);
  fs.writeFileSync(cfg, JSON.stringify({ ask: ['push', 'merge'] }));
  passed(hook(CMDCHECK, pr));
  asked(hook(CMDCHECK, bash('git push origin main', typed)));
  asked(hook(CMDCHECK, bash('gh pr merge 3 --merge', typed)));
  fs.writeFileSync(cfg, JSON.stringify({ ask: [] }));
  passed(hook(CMDCHECK, pr));
  fs.writeFileSync(cfg, JSON.stringify({ ask: 'pr' }));
  asked(hook(CMDCHECK, pr));
  fs.rmSync(cfg);
  asked(hook(CMDCHECK, pr));
});

test('위임 훅: 모델을 정하지 않은 위임을 막고, 세션의 첫 위임은 한 번 막으며 규칙을 보여 준다', () => {
  fs.writeFileSync(path.join(wd, 'RULES-DELEGATE.md'), '# 위임 규칙\n- 목표와 완료 기준을 적는다\n');
  const agent = (input, session) => ({ tool_name: 'Agent', tool_input: { prompt: '찾아 줘', description: '찾기', ...input }, cwd: typed, session_id: session });
  const noModel = denied(hook(DELEGATECHECK, agent({ subagent_type: 'Explore' }, 'd1')));
  assert.match(noModel, /모델을 정하지 않았다 → `model`[\s\S]*첫 위임이라 한 번 막고[\s\S]*목표와 완료 기준을 적는다/);
  assert.doesNotMatch(denied(hook(DELEGATECHECK, agent({ subagent_type: 'Explore' }, 'd1'))), /목표와 완료 기준/);
  passed(hook(DELEGATECHECK, agent({ subagent_type: 'Explore', model: 'haiku' }, 'd1')));
  assert.match(denied(hook(DELEGATECHECK, agent({ model: 'sonnet' }, 'd2'))), /첫 위임이라 한 번 막고/);
  passed(hook(DELEGATECHECK, agent({ model: 'sonnet' }, 'd2')));
  passed(hook(DELEGATECHECK, agent({ subagent_type: 'fork' }, 'd3')));
  fs.mkdirSync(path.join(root, '.claude', 'agents'), { recursive: true });
  fs.writeFileSync(path.join(root, '.claude', 'agents', 'reviewer.md'), '---\nname: reviewer\nmodel: opus\n---\n검토한다\n');
  fs.writeFileSync(path.join(root, '.claude', 'agents', 'helper.md'), '---\nname: helper\n---\nmodel: 본문의 글\n');
  passed(hook(DELEGATECHECK, agent({ subagent_type: 'reviewer' }, 'd1')));
  denied(hook(DELEGATECHECK, agent({ subagent_type: 'helper' }, 'd1')));
  denied(hook(DELEGATECHECK, agent({ subagent_type: '../reviewer' }, 'd1')));
  passed(hook(DELEGATECHECK, { tool_name: 'Bash', tool_input: { command: 'ls' }, session_id: 'd4' }));
  passed(hook(DELEGATECHECK, agent({ model: 'haiku' })));
  passed(hook(DELEGATECHECK, '{깨진 입력'));
});

test('읽기 훅: 큰 형식 문서를 통째로 읽으면 막고, 작은 형식 문서와 범위를 준 읽기는 넘어간다', () => {
  const bigFormat = path.join(wd, 'ROADMAP-FORMAT.md');
  const small = path.join(wd, 'ISSUES-FORMAT.md');
  fs.writeFileSync(bigFormat, `# 형식\n\n## 항목 쓰는 법\n${'- 줄 하나를 이렇게 쓴다\n'.repeat(900)}`);
  fs.writeFileSync(small, '# 형식\n\n## 어디에 적나\n- 이슈 파일\n');
  const read = (file, more) => ({ tool_name: 'Read', tool_input: { file_path: file, ...more }, cwd: typed });
  assert.match(denied(hook(READCHECK, read(bigFormat))), /`ROADMAP-FORMAT\.md`는 \d+KB라 통째로 읽으면 수천 토큰.* → 지금 하려는 일의 절만 읽는다: `grep -n '\^## ' ~\/\.work-dash\/ROADMAP-FORMAT\.md`/);
  passed(hook(READCHECK, read(bigFormat, { offset: 3, limit: 80 })));
  passed(hook(READCHECK, read(small)));
  passed(hook(READCHECK, read(path.join(wd, 'RULES.md'))));
  denied(hook(CMDCHECK, bash(`cat ${bigFormat}`, typed)));
  passed(hook(CMDCHECK, bash(`grep -n '^## ' ${bigFormat}`, typed)));
  passed(hook(CMDCHECK, bash(`sed -n '3,60p' ${bigFormat}`, typed)));
});

test('명령 훅: 큰 파일을 셸로 통째 내보내면 막지 않고 기록만 한다', () => {
  const log = path.join(wd, 'data', 'hook-log.jsonl');
  fs.rmSync(log, { force: true });
  const bigFile = path.join(root, 'out.log');
  fs.writeFileSync(bigFile, 'x'.repeat(150000));
  fs.writeFileSync(path.join(root, 'small.log'), 'x');
  passed(hook(CMDCHECK, bash(`cat ${bigFile}`, typed)));
  passed(hook(CMDCHECK, bash(`cat ${bigFile} | grep x`, typed)));
  passed(hook(CMDCHECK, bash(`head -n 20 ${bigFile}`, typed)));
  passed(hook(CMDCHECK, bash(`cat ${path.join(root, 'small.log')}`, typed)));
  const rows = fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(rows.map((r) => [r.kind, r.check, r.text]), [['watch', 'big-dump', '150KB .log 파일을 통째로 내보냄']]);
});
