#!/usr/bin/env node
// Claude Code 훅: 막지 않고 세기만 한다. 기준을 짐작으로 정하지 않으려고 먼저 data/hook-log.jsonl에 적는다(`check.js --log`로 본다).
//
// - PostToolUse(Bash): 명령 출력이 크면(2만 자 초과) `big-output`으로 적는다.
// - PreToolUse(세션 · 백그라운드 작업의 상태를 보는 도구): `status-poll`로 적는다. 같은 세션에서 10분 안에 되풀이한 수는 요약이 센다.
// - 어떤 경우에도 작업을 막지 않는다: 항상 exit 0, 출력 없음, 오류는 삼킨다.
const { record } = require('./hooklog');
const { projectName } = require('./scope');

const BIG_CHARS = 20000;
const POLL_RE = /^(?:mcp__ccd_session_mgmt__(?:get_session|list_sessions|list_events)|TaskOutput|BashOutput|TaskGet|TaskList)$/;

function size(response) {
  if (typeof response === 'string') return response.length;
  if (!response || typeof response !== 'object') return 0;
  try { return JSON.stringify(response).length; } catch { return 0; }
}

function head(command) {
  const c = String(command || '').replace(/\s+/g, ' ').trim().replace(/^(?:cd [^&;]+(?:&&|;)\s*)+/, '').replace(/^(?:[A-Za-z_]\w*=\S*\s+)+/, '');
  return c.split(' ').slice(0, 2).join(' ').slice(0, 60);
}

function main(ev) {
  const base = { kind: 'watch', project: projectName(ev.cwd), session: ev.session_id };
  if (ev.hook_event_name === 'PostToolUse' && ev.tool_name === 'Bash') {
    const n = size(ev.tool_response);
    if (n > BIG_CHARS) record({ ...base, check: 'big-output', text: `출력 ${Math.round(n / 1000)}천 자: ${head(ev.tool_input && ev.tool_input.command)}` });
  } else if (ev.hook_event_name === 'PreToolUse' && POLL_RE.test(String(ev.tool_name || ''))) {
    record({ ...base, check: 'status-poll', text: `상태 확인: ${ev.tool_name}` });
  }
  return null;
}

if (require.main === module) {
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (c) => { input += c; });
  process.stdin.on('end', () => {
    try { if (input.trim()) main(JSON.parse(input)); } catch {}
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 4000);
}

module.exports = { main };
