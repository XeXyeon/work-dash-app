#!/usr/bin/env node
// Claude Code PreToolUse 훅(Agent): 서브에이전트에 일을 맡길 때 모델을 정하지 않았으면 막고, 세션의 첫 위임은 한 번 막으며 위임 규칙을 돌려준다.
// 대화를 물려받는 fork와, 에이전트 정의 파일(.claude/agents/<이름>.md)에 model이 적힌 에이전트는 모델을 요구하지 않는다. 항상 exit 0.
const fs = require('fs');
const path = require('path');
const { HOME } = require('./paths');
const { record } = require('./hooklog');
const { projectName } = require('./scope');
const { firstTime } = require('./oncerule');

function definedModel(type, cwd) {
  if (!/^[\w.-]+$/.test(String(type || ''))) return false;
  for (const dir of [path.join(cwd || process.cwd(), '.claude', 'agents'), path.join(HOME, '.claude', 'agents')]) {
    try {
      const head = fs.readFileSync(path.join(dir, `${type}.md`), 'utf8').match(/^---\n([\s\S]*?)\n---/);
      if (head && /^model:\s*\S/m.test(head[1])) return true;
    } catch {}
  }
  return false;
}

const deny = (text) => ({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: text } });

function main(ev) {
  if (ev.tool_name !== 'Agent' && ev.tool_name !== 'Task') return null;
  const input = ev.tool_input || {};
  if (input.subagent_type === 'fork') return null;
  const rules = firstTime(ev, 'delegate');
  if (!String(input.model || '').trim() && !definedModel(input.subagent_type, ev.cwd)) {
    const text = '[work-dash] 위임을 막았다: 모델을 정하지 않았다 → `model`에 그 일을 할 수 있는 가장 가벼운 모델을 적어 다시 맡긴다(메인 세션의 모델을 그대로 물려주지 않는다)';
    record({ kind: 'deny', check: 'delegate-model', project: projectName(ev.cwd), session: ev.session_id, text });
    return deny(rules ? `${text}\n\n${rules}` : text);
  }
  return rules ? deny(rules) : null;
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
  setTimeout(() => process.exit(0), 4000);
}

module.exports = { main };
