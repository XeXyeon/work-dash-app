#!/usr/bin/env node
// Claude Code · Codex PreToolUse 훅(Edit · Write · MultiEdit · apply_patch): 로드맵 · 이슈 파일에서 항목의 상태 기호를 바꾸거나
// 새 항목 줄을 손으로 넣는 편집을 막고, 그 일을 하는 명령을 알려 준다. 제목 · 범위 · 메모를 고치는 편집은 지나간다. 항상 exit 0.
const fs = require('fs');
const path = require('path');
const { HOME } = require('./paths');
const { kindOf, resolveInWd } = require('./doclint');
const { record } = require('./hooklog');
const { projectName } = require('./scope');

const LINE = /^- \[(.)\] ([A-Z][A-Z0-9]*-\d+(?:#\d+)?)(?![\w#-])/;
const VALID = new Set([' ', '~', 'x', '!', '>', '-']);
const CLI = 'node ~/.work-dash/app/core/item.js';
const ROADMAP_CMD = { '~': ['start', ''], x: ['done', ''], '!': ['wait', ' "<누구 · 무엇>"'], '>': ['hold', ' "<이유>"'], '-': ['drop', ' "<이유>"'], ' ': ['reopen', ''] };
const ISSUE_CMD = { '~': ['issue start', ''], x: ['issue resolve', ' "<무엇을 바꿨는지>"'], '-': ['issue close', ' "<이유>"'] };

function marks(lines) {
  const map = new Map();
  for (const l of lines) {
    const m = l.match(LINE);
    if (m) map.set(m[2], m[1]);
  }
  return map;
}

function splice(text, input) {
  const old = String(input.old_string ?? '');
  const neu = String(input.new_string ?? '');
  if (!old || !text.includes(old)) return null;
  return input.replace_all ? text.split(old).join(neu) : text.replace(old, () => neu);
}

function afterLines(ev, before) {
  const input = ev.tool_input || {};
  if (ev.tool_name === 'Write') return typeof input.content === 'string' ? input.content.split('\n') : null;
  if (ev.tool_name === 'Edit') { const t = splice(before, input); return t == null ? null : t.split('\n'); }
  if (ev.tool_name === 'MultiEdit') {
    let t = before;
    for (const e of input.edits || []) { t = splice(t, e); if (t == null) return null; }
    return t.split('\n');
  }
  return null;
}

function patchFiles(patch, cwd) {
  const list = [];
  let cur = null;
  const at = (p) => path.resolve(cwd || process.cwd(), p.replace(/^~(?=\/)/, HOME));
  for (const l of String(patch).split('\n')) {
    const h = l.match(/^\*\*\* (Add|Update|Delete) File: (.+?)\s*$/);
    if (h) { cur = h[1] === 'Delete' ? null : { file: at(h[2]), added: [] }; if (cur) list.push(cur); continue; }
    const mv = l.match(/^\*\*\* Move to: (.+?)\s*$/);
    if (mv) { if (cur) cur.file = at(mv[1]); continue; }
    if (cur && l.startsWith('+')) cur.added.push(l.slice(1));
  }
  return list;
}

function targets(ev) {
  const input = ev.tool_input || {};
  if (ev.tool_name === 'apply_patch') {
    const raw = typeof input === 'string' ? input : input.command;
    return patchFiles(Array.isArray(raw) ? raw.join('\n') : raw, ev.cwd).map((t) => ({ file: t.file, lines: () => t.added }));
  }
  if (!/^(Edit|Write|MultiEdit)$/.test(ev.tool_name || '') || !input.file_path) return [];
  return [{ file: input.file_path, lines: (before) => afterLines(ev, before) }];
}

function problems(kind, before, lines) {
  const was = marks(before.split('\n'));
  const out = [];
  for (const [id, mark] of marks(lines)) {
    if (!was.has(id)) {
      out.push(kind === 'roadmap'
        ? `새 항목 \`${id}\` 줄을 손으로 넣는다 → \`${CLI} add <M번호> "<결과물 이름 (범위)>"\`으로 넣는다(번호는 명령이 붙인다)`
        : `새 이슈 \`${id}\` 줄을 손으로 넣는다 → \`${CLI} issue add --parent <항목 ID|ISS> --sev <심각도> --kind <종류> "<제목>"\`으로 넣는다`);
      continue;
    }
    const old = was.get(id);
    if (old === mark || !VALID.has(old)) continue;
    const cmd = (kind === 'roadmap' ? ROADMAP_CMD : ISSUE_CMD)[mark];
    out.push(`\`${id}\`의 상태를 \`[${old}]\`에서 \`[${mark}]\`로 손으로 바꾼다 → ${cmd ? `\`${CLI} ${cmd[0]} ${id}${cmd[1]}\`를 쓴다` : `\`${CLI} --help\`에서 맞는 동작을 찾아 쓴다`}`);
  }
  return out;
}

function main(ev) {
  const found = [];
  for (const { file, lines } of targets(ev)) {
    const k = kindOf(resolveInWd(file));
    if (!k || (k.kind !== 'roadmap' && k.kind !== 'issues')) continue;
    let before;
    try { before = fs.readFileSync(file, 'utf8'); } catch { continue; }
    const after = lines(before);
    if (!after) continue;
    found.push(...problems(k.kind, before, after));
  }
  if (!found.length) return null;
  record({ kind: 'deny', check: 'edit-state', project: projectName(ev.cwd), session: ev.session_id, text: found.join(' / ') });
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: `[work-dash] 편집을 막았다. 항목 · 이슈의 상태와 번호는 명령이 쓴다:\n${found.slice(0, 8).map((p) => `- ${p}`).join('\n')}\n제목 · 범위 · 메모 줄을 고치는 편집은 그대로 하면 된다.`,
    },
  };
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
