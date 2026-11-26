#!/usr/bin/env node
// Claude Code · Codex PostToolUse 훅(Edit · Write · MultiEdit · apply_patch): 로드맵 · 이슈 · 작업 카드를 고친 직후 문서 린터를 돌려
// 이번에 바꾼 줄에서 나온 위반만 에이전트에 돌려준다. 쓰기는 이미 끝난 뒤라 막지 않는다. 항상 exit 0.
const fs = require('fs');
const path = require('path');
const { HOME } = require('./paths');
const { lintFile, format, kindOf, resolveInWd } = require('./doclint');
const { record } = require('./hooklog');
const { projectName } = require('./scope');

const MAX_LINES = 20;

function linesFromPatch(patch) {
  const out = new Set();
  for (const h of patch) {
    let n = h.newStart;
    for (const l of h.lines || []) {
      if (l[0] === '+') out.add(n++);
      else if (l[0] === ' ') n++;
    }
  }
  return out;
}

function linesOfStrings(text, strings) {
  const out = new Set();
  for (const s of strings) {
    if (!s) continue;
    let at = text.indexOf(s);
    while (at >= 0) {
      const first = text.slice(0, at).split('\n').length;
      const count = s.split('\n').length;
      for (let k = 0; k < count; k++) out.add(first + k);
      at = text.indexOf(s, at + s.length);
    }
  }
  return out;
}

function linesFromOriginal(original, text) {
  const before = new Map();
  for (const l of original.split('\n')) before.set(l, (before.get(l) || 0) + 1);
  const out = new Set();
  text.split('\n').forEach((l, i) => {
    const c = before.get(l) || 0;
    if (c > 0) before.set(l, c - 1); else out.add(i + 1);
  });
  return out;
}

function changedLines(ev, text) {
  const input = ev.tool_input || {};
  const resp = ev.tool_response && typeof ev.tool_response === 'object' ? ev.tool_response : {};
  if (resp.type === 'create') return null;
  if (Array.isArray(resp.structuredPatch) && resp.structuredPatch.length) return linesFromPatch(resp.structuredPatch);
  if (typeof resp.originalFile === 'string') return linesFromOriginal(resp.originalFile, text);
  if (ev.tool_name === 'Edit') return linesOfStrings(text, [input.new_string]);
  if (ev.tool_name === 'MultiEdit') return linesOfStrings(text, (input.edits || []).map((e) => e.new_string));
  return null;
}

function patchTargets(patch, cwd) {
  const list = [];
  let cur = null;
  const at = (p) => path.resolve(cwd || process.cwd(), p.replace(/^~(?=\/)/, HOME));
  for (const l of String(patch).split('\n')) {
    const h = l.match(/^\*\*\* (Add|Update|Delete) File: (.+?)\s*$/);
    if (h) { cur = h[1] === 'Delete' ? null : { file: at(h[2]), create: h[1] === 'Add', added: new Set() }; if (cur) list.push(cur); continue; }
    const mv = l.match(/^\*\*\* Move to: (.+?)\s*$/);
    if (mv && cur) { cur.file = at(mv[1]); continue; }
    if (cur && l.startsWith('+') && l.slice(1).trim()) cur.added.add(l.slice(1));
  }
  return list.map((t) => ({ file: t.file, changed: (text) => (t.create ? null : new Set(text.split('\n').flatMap((line, i) => (t.added.has(line) ? [i + 1] : [])))) }));
}

function targets(ev) {
  const input = ev.tool_input || {};
  if (ev.tool_name === 'apply_patch') return patchTargets(typeof input === 'string' ? input : input.command, ev.cwd);
  if (!/^(Edit|Write|MultiEdit)$/.test(ev.tool_name || '') || !input.file_path) return [];
  return [{ file: input.file_path, changed: (text) => changedLines(ev, text) }];
}

function main(ev) {
  const shown = [];
  let total = 0;
  for (const { file, changed: changedOf } of targets(ev)) {
    if (!kindOf(resolveInWd(file))) continue;
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
    const r = lintFile(file, { text });
    if (!r) continue;
    const changed = changedOf(text);
    const hits = r.problems.filter((p) => !changed || (p.notice ? p.hookLines.some((n) => changed.has(n)) : changed.has(p.line)));
    total += hits.length;
    const room = Math.max(0, MAX_LINES - shown.length);
    shown.push(...hits.slice(0, room).map((p) => format(r, p)));
    if (hits.length > room) shown.push(`… 외 ${hits.length - room}건. 전체: node ~/.work-dash/app/core/doclint.js ${file}`);
  }
  if (!total) return null;
  record({ kind: 'deny', check: 'doc-format', project: projectName(ev.cwd), session: ev.session_id, text: shown.join(' / ') });
  return {
    decision: 'block',
    reason: `[work-dash] 방금 고친 줄이 형식 문서와 다르다(${total}건). 각 줄의 "→" 뒤대로 그 줄을 고친다:\n${shown.join('\n')}`,
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
  setTimeout(() => process.exit(0), 8000);
}

module.exports = { main, changedLines };
