#!/usr/bin/env node
// 설정 파일(JSON)에 work-dash 훅을 맞춰 넣는다. 파일을 쓰지 않는다: 표준 입력으로 받은 JSON을 고쳐 표준 출력으로 낸다.
//
//   node bin/hooks.js claude < ~/.claude/settings.json     Claude Code 설정
//   node bin/hooks.js codex  < ~/.codex/hooks.json         Codex 훅 파일
//
// 닷파일 관리 도구(chezmoi의 modify_ 스크립트 등)가 설정 파일의 주인일 때 쓴다.
// - work-dash 훅(명령 전체가 `<node> "<…>/.work-dash/app/core/<스크립트>"` 모양인 것)만 건드린다. 다른 훅과 다른 키는 그대로 둔다.
//   이 경로를 감싸 부르는 다른 명령은 남의 훅으로 본다.
// - 이미 있는 work-dash 훅은 명령과 제한 시간을 목록대로 고치고, 겹친 것은 하나만 남긴다.
// - 목록에 없는 work-dash 훅은 뺀다(없어진 스크립트를 부르는 훅이 남지 않게).
// - 입력이 비었으면 빈 객체로 본다. JSON이 아니거나 모양이 다르면 아무것도 내지 않고 실패한다.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const NODE = /\s/.test(process.execPath) ? `"${process.execPath}"` : process.execPath;
export const hookCmd = (script) => `${NODE} "$HOME/.work-dash/app/core/${script}"`;
const TOOL_MATCHER = '^(Agent|Task|TodoWrite|TaskCreate|TaskUpdate|mcp__ccd_turn__update_plan|mcp__ccd_turn__wrap_up)$';
const POLL_MATCHER = '^(mcp__ccd_session_mgmt__(get_session|list_sessions|list_events)|TaskOutput|BashOutput|TaskGet|TaskList)$';
export const CLAUDE_HOOKS = [
  ...['SessionStart', 'UserPromptSubmit', 'Stop', 'SessionEnd', 'Notification', 'SubagentStop'].map((event) => ({ event, script: 'push.js', timeout: 5 })),
  { event: 'PreToolUse', matcher: '*', script: 'push.js', timeout: 5 },
  { event: 'PostToolUse', matcher: TOOL_MATCHER, script: 'push.js', timeout: 5 },
  { event: 'PostToolUse', matcher: 'Bash', script: 'stuck.js', timeout: 5 },
  { event: 'PostToolUseFailure', matcher: 'Bash', script: 'stuck.js', timeout: 5 },
  { event: 'PostToolUse', matcher: 'Edit|Write|MultiEdit', script: 'doccheck.js', timeout: 10 },
  { event: 'PreToolUse', matcher: 'Bash', script: 'cmdcheck.js', timeout: 10 },
  { event: 'PreToolUse', matcher: 'Read', script: 'readcheck.js', timeout: 5 },
  { event: 'PreToolUse', matcher: 'Edit|Write|MultiEdit', script: 'editcheck.js', timeout: 5 },
  { event: 'PreToolUse', matcher: 'Agent', script: 'delegatecheck.js', timeout: 5 },
  { event: 'PostToolUse', matcher: 'Bash', script: 'watch.js', timeout: 5 },
  { event: 'PreToolUse', matcher: POLL_MATCHER, script: 'watch.js', timeout: 5 },
  { event: 'SessionStart', script: 'afterarchive.js', timeout: 5 },
  { event: 'UserPromptSubmit', script: 'afterarchive.js', timeout: 5 },
  { event: 'PreCompact', script: 'handoff.js', timeout: 10 },
  { event: 'PostCompact', script: 'handoff.js', timeout: 10 },
];
export const CODEX_HOOKS = [
  { event: 'UserPromptSubmit', script: 'handoff.js', timeout: 10 },
  { event: 'PreToolUse', matcher: 'Bash', script: 'cmdcheck.js', timeout: 10 },
  { event: 'PreToolUse', matcher: 'apply_patch', script: 'editcheck.js', timeout: 5 },
  { event: 'PostToolUse', matcher: 'apply_patch', script: 'doccheck.js', timeout: 10 },
];

const sameMatcher = (a, b) => (a || '') === (b || '');
const scriptOf = (x) => (typeof x?.command === 'string' ? x.command.match(/^\s*(?:"[^"]+"|\S+)\s+"?[^"\s]*\.work-dash\/app\/core\/([\w-]+\.js)"?\s*$/)?.[1] : null) || null;

export function mergeHooks(json, hooks) {
  if (!json || typeof json !== 'object' || Array.isArray(json)) throw new Error('설정이 JSON 객체가 아니다');
  if (json.hooks != null && (typeof json.hooks !== 'object' || Array.isArray(json.hooks))) throw new Error('hooks가 객체가 아니다');
  const out = { ...json, hooks: {} };
  for (const [event, groups] of Object.entries(json.hooks || {})) {
    if (!Array.isArray(groups)) { out.hooks[event] = groups; continue; }
    const kept = [];
    const seen = new Set();
    for (const g of groups) {
      if (!g || !Array.isArray(g.hooks)) { kept.push(g); continue; }
      const list = [];
      for (const x of g.hooks) {
        const script = scriptOf(x);
        if (!script) { list.push(x); continue; }
        const want = hooks.find((h) => h.event === event && sameMatcher(h.matcher, g.matcher) && h.script === script);
        const key = `${g.matcher || ''}\n${script}`;
        if (!want || seen.has(key)) continue;
        seen.add(key);
        list.push({ ...x, type: 'command', command: hookCmd(script), timeout: want.timeout });
      }
      if (list.length) kept.push({ ...g, hooks: list });
    }
    if (kept.length) out.hooks[event] = kept;
  }
  for (const h of hooks) {
    const groups = out.hooks[h.event] || (out.hooks[h.event] = []);
    if (!Array.isArray(groups)) throw new Error(`hooks.${h.event}이 배열이 아니다`);
    const has = groups.some((g) => g && sameMatcher(g.matcher, h.matcher) && Array.isArray(g.hooks) && g.hooks.some((x) => scriptOf(x) === h.script));
    if (has) continue;
    const entry = { type: 'command', command: hookCmd(h.script), timeout: h.timeout };
    groups.push(h.matcher ? { matcher: h.matcher, hooks: [entry] } : { hooks: [entry] });
  }
  return out;
}

const isMain = process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const hooks = { claude: CLAUDE_HOOKS, codex: CODEX_HOOKS }[process.argv[2]];
  if (!hooks) { console.error('사용법: node bin/hooks.js claude|codex < 설정.json'); process.exit(2); }
  try {
    const text = fs.readFileSync(0, 'utf8');
    const json = text.trim() ? JSON.parse(text) : {};
    process.stdout.write(JSON.stringify(mergeHooks(json, hooks), null, 2) + '\n');
  } catch (e) {
    console.error(`work-dash 훅을 맞추지 못했다: ${e instanceof SyntaxError ? '입력이 JSON이 아니다' : e.message}`);
    process.exit(1);
  }
}
