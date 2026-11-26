#!/usr/bin/env node
// Claude Code PreToolUse 훅(Read): 큰 로드맵 · 이슈 · 흐름 문서를 통째로 읽으려 하면 막고, 필요한 부분만 보는 길을 알려 준다.
// 형식 문서(*-FORMAT.md)도 크면 통째로 읽지 못한다. 범위를 준 읽기(limit 400줄 이하)와 작은 파일은 그대로 둔다. 막은 것은 data/hook-log.jsonl에 적는다.
// 지휘 · 설계처럼 전체를 봐야 하는 세션은 `check.js --read-all "<이유>"`로 그 세션의 통째 읽기를 연다(cmdcheck.js가 표시를 남긴다).
// 그 밖의 큰 파일(100KB 초과)을 셸로 통째 내보내는 것은 막지 않고 기록만 한다. Bash의 `cat <문서>`와 400줄 넘게 내보내는 `head` · `tail` · `sed -n`은 cmdcheck.js가 bashProblem을 불러 막는다.
const fs = require('fs');
const path = require('path');
const { resolveInWd } = require('./doclint');
const { WD, HOME } = require('./paths');
const { record } = require('./hooklog');
const { projectName } = require('./scope');
const { flag } = require('./oncerule');

const BIG_BYTES = 20000;
const FORMAT_BYTES = 20000;
const WATCH_BYTES = 100000;
const FORMAT_RE = /^[A-Z]+-FORMAT\.md$/;
const MAX_LINES = 400;
const KINDS = ['roadmaps', 'issues', 'flows'];
const ITEM = 'node ~/.work-dash/app/core/item.js';
const OPEN_KEY = 'readAll';
const OPEN_HOW = '지휘 · 설계처럼 전체를 봐야 하는 세션이면 `node ~/.work-dash/app/core/check.js --read-all "<이유>"`를 한 번 실행한다(이 세션의 통째 읽기가 열리고 기록에 남는다).';
const MAX_COMMAND = 20000;
const DUMP_HEAD = /(?:^|[;&|(\n])[ \t]*(cat|bat|less|more|head|tail|sed)(?=[ \t])/g;
const DUMP_ARG = /[ \t]+("[^"\n]*"|'[^'\n]*'|[^\s;&|<>"')]+)/y;
const DUMP_REST = /(?:[ \t]*\d*>&\d+)*[ \t]*(.?)(.?)/y;

function bigDoc(file, cwd) {
  const abs = resolveInWd(path.resolve(cwd || process.cwd(), file));
  const parts = path.relative(WD, abs).split(path.sep);
  if (parts.length === 1 && FORMAT_RE.test(parts[0])) {
    let bytes = 0;
    try { bytes = fs.statSync(abs).size; } catch { return null; }
    return bytes > FORMAT_BYTES ? { kind: 'format', rel: parts[0], kb: Math.round(bytes / 1000) } : null;
  }
  if (parts.length !== 2 || !KINDS.includes(parts[0]) || !parts[1].endsWith('.md')) return null;
  let size = 0;
  try { size = fs.statSync(abs).size; } catch { return null; }
  if (size <= BIG_BYTES) return null;
  return { kind: parts[0], rel: parts.join('/'), kb: Math.round(size / 1000) };
}

function howTo({ kind, rel }) {
  const sections = `\`grep -n '^## ' ~/.work-dash/${rel}\`로 절의 줄 번호를 찾아 그 절만 읽는다(Read의 offset · limit, ${MAX_LINES}줄 이하)`;
  if (kind === 'format') return `지금 하려는 일의 절만 읽는다: ${sections}. 상태 변경 · 카드 틀 · 이슈 추가는 \`${ITEM}\`이 해 주므로 읽지 않는다`;
  if (kind === 'roadmaps') return `항목 하나는 \`${ITEM} show <ID>\`, 마일스톤 하나는 \`show M<번호>\`, 현황은 \`${ITEM}\`. 그 밖에는 ${sections}`;
  if (kind === 'issues') return `열린 이슈는 \`${ITEM} issue\`, 이슈 하나는 \`${ITEM} show <이슈 ID>\`. 그 밖에는 ${sections}`;
  return `\`## 전체 구조\` 절과 관련된 흐름 절만 읽는다: ${sections}. 관련 절은 고칠 파일 경로 · 항목 ID로 \`grep -n\` 해서 찾는다`;
}

const reason = (doc) => `[work-dash] 읽기를 막았다: \`${doc.rel}\`는 ${doc.kb}KB라 통째로 읽으면 ${doc.kind === 'format' ? '수천' : '수만'} 토큰이 든다 → ${howTo(doc)}. 전체가 꼭 필요하면 ${MAX_LINES}줄씩 나눠 읽는다.`;

function readProblem(input, cwd) {
  const file = input && input.file_path;
  if (!file) return null;
  const limit = Number(input.limit);
  if (limit > 0 && limit <= MAX_LINES) return null;
  const doc = bigDoc(String(file), cwd);
  return doc ? reason(doc) : null;
}

const unquote = (v) => (/^(['"]).*\1$/.test(v) ? v.slice(1, -1) : v);
const expand = (v) => v.replace(/^~(?=\/|$)/, HOME).replace(/^\$(?:HOME|\{HOME\})(?=\/|$)/, HOME);

function headTail(tool, args) {
  let count = 10, open = false;
  const files = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    let v = null;
    if (a === '-n' || a === '--lines') v = args[++i] || '';
    else if (/^--lines=/.test(a)) v = a.slice(8);
    else if (/^-n./.test(a)) v = a.slice(2);
    else if (/^-\d+$/.test(a)) v = a.slice(1);
    else if (/^\+\d+$/.test(a) && tool === 'tail') v = a;
    else if (a === '-c' || a === '--bytes') { i++; continue; }
    else if (a.startsWith('-')) continue;
    else { files.push(a); continue; }
    if (/^\d+$/.test(v)) count = Number(v);
    else open = true;
  }
  return open || count > MAX_LINES ? files : [];
}

function sedPrint(args) {
  if (args.some((a) => /^-[a-zA-Z]*i|^--in-place/.test(a))) return [];
  const quiet = args.some((a) => /^-[a-zA-Z]*n[a-zA-Z]*$/.test(a) || a === '--quiet' || a === '--silent');
  const rest = [];
  const scripts = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-e' || a === '--expression') scripts.push(args[++i] || '');
    else if (a.startsWith('--expression=')) scripts.push(a.slice(13));
    else if (a === '-f' || a === '--file') return [];
    else if (!a.startsWith('-')) rest.push(a);
  }
  if (!scripts.length) scripts.push(rest.shift() || '');
  if (!quiet) return rest;
  for (const sc of scripts) {
    const m = sc.replace(/\\\$/g, '$').match(/^(\d+),(\d+|\$)p$/);
    if (m && (m[2] === '$' || Number(m[2]) - Number(m[1]) + 1 > MAX_LINES)) return rest;
  }
  return [];
}

function dumped(tool, args) {
  if (tool === 'head' || tool === 'tail') return headTail(tool, args);
  if (tool === 'sed') return sedPrint(args);
  return args.filter((a) => !a.startsWith('-'));
}

function bashProblem(command, cwd, watch) {
  if (command.length > MAX_COMMAND) return null;
  for (const head of command.matchAll(DUMP_HEAD)) {
    const args = [];
    let at = head.index + head[0].length;
    for (;;) {
      DUMP_ARG.lastIndex = at;
      const m = DUMP_ARG.exec(command);
      if (!m) break;
      args.push(m[1]);
      at = DUMP_ARG.lastIndex;
    }
    DUMP_REST.lastIndex = at;
    const [, c1, c2] = DUMP_REST.exec(command) || [];
    if ((c1 === '|' && c2 !== '|') || c1 === '>' || c1 === '<') continue;
    for (const file of dumped(head[1], args.map(unquote))) {
      const doc = bigDoc(expand(file), cwd);
      if (doc) return reason(doc);
      if (watch) {
        let bytes = 0;
        try { bytes = fs.statSync(path.resolve(cwd || process.cwd(), expand(file))).size; } catch {}
        if (bytes > WATCH_BYTES) watch(file, Math.round(bytes / 1000));
      }
    }
  }
  return null;
}

function main(ev) {
  if (ev.tool_name !== 'Read') return null;
  const problem = readProblem(ev.tool_input, ev.cwd);
  if (!problem || flag(ev, OPEN_KEY)) return null;
  record({ kind: 'deny', check: 'read-doc', project: projectName(ev.cwd), session: ev.session_id, text: problem });
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: `${problem}\n${OPEN_HOW}` } };
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

module.exports = { main, readProblem, bashProblem, OPEN_KEY, OPEN_HOW };
