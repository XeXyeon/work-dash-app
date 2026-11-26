#!/usr/bin/env node
// Claude Code hook: 같은 계열의 Bash 명령이 연속으로 실패하면 모델에게 "멈추고 보고하라"는 문구를 돌려준다.
//
// - PostToolUseFailure(Bash): 그 명령 계열의 연속 실패 수를 올린다. 기준(3번)에 닿으면 경고를 낸다.
// - PostToolUse(Bash): 성공이므로 그 계열의 실패 수를 지운다.
// - 계열 = 명령의 앞 두 낱말(환경 변수 · cd 접두는 뺀다). 인자를 조금씩 바꿔 가며 실패하는 것도 같은 계열로 본다.
// - "같은 문제"를 직접 재는 것이 아니라 그 흔적을 재는 것이다. 그래서 막지 않고 경고만 한다.
// - 어떤 경우에도 Claude 작업을 막지 않는다: 항상 exit 0, 오류는 삼킨다.
const fs = require('fs');
const path = require('path');
const { WD } = require('./paths');

const DIR = path.join(WD, 'data', 'stuck');
const LIMIT = 3;        // 연속 실패 몇 번째에 처음 경고할지
const AGAIN = 2;        // 그 뒤로 몇 번마다 다시 경고할지
const KEEP_MS = 7 * 86400e3;

// 명령 계열: 앞에 붙은 `cd … &&`, `VAR=값`, `sudo` · `time` 등을 떼고 남은 앞 두 낱말
function family(command) {
  let c = String(command || '').replace(/\s+/g, ' ').trim();
  for (let i = 0; i < 4; i++) {
    const before = c;
    c = c.replace(/^cd [^&;]+(&&|;)\s*/, '').replace(/^([A-Za-z_][A-Za-z0-9_]*=\S*\s+)+/, '').replace(/^(sudo|time|command|exec|npx|env)\s+/, '');
    if (c === before) break;
  }
  const all = c.split(/[\s|;&]+/).filter(Boolean);
  // `npm run build`와 `npm run typecheck`는 다른 계열이다: 둘째 낱말이 run이면 셋째까지 본다
  const words = all.slice(0, all[1] === 'run' ? 3 : 2);
  return words.join(' ').slice(0, 80);
}

function main(ev) {
  if (ev.tool_name !== 'Bash') return null;
  const event = ev.hook_event_name;
  if (event !== 'PostToolUse' && event !== 'PostToolUseFailure') return null;
  const fam = family(ev.tool_input && ev.tool_input.command);
  if (!fam) return null;

  // 하위 에이전트의 실패는 메인 세션과 따로 센다
  const who = `${ev.session_id || 'unknown'}${ev.agent_id ? '.' + ev.agent_id : ''}`.replace(/[^A-Za-z0-9._-]/g, '_');
  const file = path.join(DIR, who + '.json');
  let state = {};
  try { state = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}

  let warn = null;
  if (event === 'PostToolUse') {
    if (!state[fam]) return null;          // 지울 것이 없으면 파일을 건드리지 않는다
    delete state[fam];
  } else {
    const n = ((state[fam] && state[fam].n) || 0) + 1;
    state[fam] = { n, at: Date.now() };
    if (n === LIMIT || (n > LIMIT && (n - LIMIT) % AGAIN === 0)) {
      warn = `[work-dash] \`${fam}\` 계열 명령이 연속 ${n}번 실패했다. 다음 시도 전에 멈춘다: `
        + '① 작업 카드의 "막혔던 문제와 해결"에 지금까지의 시도를 한 줄씩 적는다(증상 · 바꾼 것 · 결과). '
        + '② 같은 가설을 다시 시도하지 않는다. 시도한 방법과 결과, 원인 가설을 모아 사용자(또는 지휘 세션)에게 보고하고, 정보를 더 모을지 설계를 다시 볼지 판단을 받는다. 이 문제와 무관한 작업은 계속한다. '
        + '서로 다른 문제를 하나씩 고쳐 가는 정상적인 반복이라면 그렇다고 한 줄로 밝히고 계속한다.';
    }
  }

  fs.mkdirSync(DIR, { recursive: true });
  if (Object.keys(state).length) {
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state));
    fs.renameSync(tmp, file);
  } else {
    try { fs.unlinkSync(file); } catch {}
  }
  // 오래된 상태 파일은 가끔 치운다
  if (Math.random() < 0.02) {
    try {
      for (const f of fs.readdirSync(DIR)) {
        const p = path.join(DIR, f);
        if (Date.now() - fs.statSync(p).mtimeMs > KEEP_MS) fs.unlinkSync(p);
      }
    } catch {}
  }
  return warn ? { hookSpecificOutput: { hookEventName: event, additionalContext: warn } } : null;
}

if (require.main === module) {
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (c) => { input += c; });
  process.stdin.on('end', () => {
    try {
      const out = input.trim() ? main(JSON.parse(input)) : null;
      if (out) process.stdout.write(JSON.stringify(out));
    } catch {}
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 2500);
}

module.exports = { family, main };
