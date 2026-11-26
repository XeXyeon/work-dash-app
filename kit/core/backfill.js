#!/usr/bin/env node
// 이미 완료된 로드맵 항목의 완료 시각을 과거 기록에서 찾아 로드맵 파일에 ✓ 스탬프로 남긴다.
//   1) Claude 대화 기록(~/.claude/projects)  2) Codex 기록(~/.codex/sessions) → 정확한 시각
//   3) 프로젝트 git 커밋 메시지에 항목 ID가 있으면 그 시각 → 추정(✓~)
// 셋 다 없으면 그대로 둔다 (대시보드에 '로드맵 이전 완료'로 보인다).
// 사용법: node backfill.js [--dry-run]
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { RDIR, HIST, readFiles, writeStamps, stampOf, saveHist } = require('./roadmap');
const { withLock } = require('./lib');
const { foldersOf } = require('./projects');
const { findFolder } = require('./scope');

const DRY = process.argv.includes('--dry-run');
const HOME = os.homedir();
const ID = /[A-Za-z][A-Za-z0-9]*-\d+/g;
const PROJECT_IN_PATH = /roadmaps\/([^/\s'"`\\]+)\.md/;

function walk(dir, out = []) {
  for (const n of (() => { try { return fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; } })()) {
    const p = path.join(dir, n.name);
    if (n.isDirectory()) walk(p, out);
    else if (n.name.endsWith('.jsonl')) out.push(p);
  }
  return out;
}

// 로드맵 파일 내용(전체 또는 일부)에서 항목별 완료 여부
function statesIn(text) {
  const m = new Map();
  for (const l of String(text).split('\n')) {
    const r = l.match(/^\s*[-*]\s+\[([ xX~])\]\s+([A-Za-z][A-Za-z0-9]*-\d+)/);
    if (r) m.set(r[2].toUpperCase(), /x/i.test(r[1]));
  }
  return m;
}

// sed/perl 치환식 s/찾기/바꾸기/ 에서 [x]로 바꾸는 항목 ID
function doneBySubst(cmd) {
  const res = new Map();
  // 경로 속 's/'(roadmaps/, docs/ 등)를 치환식으로 오인하지 않도록 따옴표·공백·; 뒤에서 시작하는 것만 본다
  for (const m of String(cmd).matchAll(/(?<=^|[\s'";])s\/((?:\\.|[^/])*)\/((?:\\.|[^/])*)\//g)) {
    const ids = [...new Set([...(m[1].match(ID) || []), ...(m[2].match(ID) || [])].map((x) => x.toUpperCase()))];
    const toDone = /\[x\]/i.test(m[2].replace(/\\/g, ''));
    const toOpen = /\[[ ~]\]/.test(m[2].replace(/\\/g, ''));
    for (const id of ids) if (toDone || toOpen) res.set(id, toDone);
  }
  return res;
}

const events = [];   // { t, project, kind: 'write' | 'set', states: Map<ID, done> }
function push(t, project, kind, states) { if (project && states.size) events.push({ t, project, kind, states }); }

// ── 1) Claude ──
for (const f of walk(path.join(HOME, '.claude', 'projects'))) {
  let text; try { text = fs.readFileSync(f, 'utf8'); } catch { continue; }
  if (!text.includes('roadmaps/')) continue;
  for (const l of text.split('\n')) {
    if (!l.includes('roadmaps/') || !l.includes('tool_use')) continue;
    let j; try { j = JSON.parse(l); } catch { continue; }
    const t = Date.parse(j.timestamp);
    for (const c of j.message?.content || []) {
      if (c.type !== 'tool_use') continue;
      const inp = c.input || {};
      if (c.name === 'Write' && PROJECT_IN_PATH.test(inp.file_path || '')) {
        push(t, inp.file_path.match(PROJECT_IN_PATH)[1], 'write', statesIn(inp.content));
      } else if ((c.name === 'Edit' || c.name === 'MultiEdit') && PROJECT_IN_PATH.test(inp.file_path || '')) {
        const edits = inp.edits || [inp];
        const st = new Map();
        for (const e of edits) for (const [id, done] of statesIn(e.new_string)) st.set(id, done);
        push(t, inp.file_path.match(PROJECT_IN_PATH)[1], 'set', st);
      } else if (c.name === 'Bash' && PROJECT_IN_PATH.test(inp.command || '')) {
        push(t, inp.command.match(PROJECT_IN_PATH)[1], 'set', doneBySubst(inp.command));
      }
    }
  }
}

// ── 2) Codex ──
for (const f of walk(path.join(HOME, '.codex', 'sessions'))) {
  let text; try { text = fs.readFileSync(f, 'utf8'); } catch { continue; }
  if (!text.includes('roadmaps/')) continue;
  for (const l of text.split('\n')) {
    if (!l.includes('roadmaps/')) continue;
    let j; try { j = JSON.parse(l); } catch { continue; }
    const t = Date.parse(j.timestamp);
    const p = j.payload || {};
    if (p.type === 'custom_tool_call' && p.name === 'apply_patch') {
      for (const part of String(p.input).split(/^\*\*\* (?=(?:Update|Add) File: )/m)) {
        const fm = part.match(PROJECT_IN_PATH);
        if (!fm) continue;
        const added = part.split('\n').filter((x) => x.startsWith('+')).map((x) => x.slice(1)).join('\n');
        push(t, fm[1], /^Add File/.test(part) ? 'write' : 'set', statesIn(added));
      }
    } else {
      const cmd = p.item?.type === 'CommandExecution' ? [].concat(p.item.command).join(' ')
        : p.type === 'function_call' && p.name === 'exec_command' ? (JSON.parse(p.arguments || '{}').cmd || '')
        : p.type === 'custom_tool_call' && p.name === 'exec' ? p.input : '';
      const fm = String(cmd).match(PROJECT_IN_PATH);
      if (fm) push(t, fm[1], 'set', doneBySubst(cmd));
    }
  }
}

// 시간순으로 재생해 항목별 마지막 완료 시각을 구한다. 파일의 첫 Write는 '처음부터 완료'라서 시각을 남기지 않는다.
events.sort((a, b) => a.t - b.t);
const found = {};   // project → Map<ID, t>
const state = {};
for (const e of events) {
  const st = state[e.project] || (state[e.project] = { seen: false, done: new Map() });
  const fd = found[e.project] || (found[e.project] = new Map());
  for (const [id, done] of e.states) {
    const was = st.done.get(id) || false;
    if (done && !was && (st.seen || e.kind === 'set')) fd.set(id, e.t);
    if (!done) fd.delete(id);
    st.done.set(id, done);
  }
  if (e.kind === 'write') st.seen = true;
}

// ── 3) git 커밋 (추정) ──
function projectDirs(name) {
  const out = [];
  for (const f of foldersOf(name)) {
    const d = findFolder(f, { git: true });
    if (d) out.push(d);
  }
  return out;
}
function gitTimes(dir) {
  try {
    const log = execFileSync('git', ['-C', dir, 'log', '--all', '--format=%ct%x09%s %b%x00'], { encoding: 'utf8', maxBuffer: 50e6 });
    return log.split('\0').map((x) => { const [t, ...m] = x.trim().split('\t'); return { t: Number(t) * 1000, msg: m.join('\t') }; }).filter((x) => x.t);
  } catch { return []; }
}

// ── 적용 ──
const report = [];
withLock('roadmap-history', () => {
  let hist = {};
  try { hist = JSON.parse(fs.readFileSync(HIST, 'utf8')); } catch {}
  for (const r of readFiles()) {
    const fd = found[r.project] || new Map();
    const commits = projectDirs(r.project).flatMap(gitTimes);
    const stamps = new Map();
    const ph = hist[r.project] || (hist[r.project] = {});
    for (const it of r.milestones.flatMap((m) => m.items)) {
      if (it.state !== 'done' || it.stamp || !it.id) continue;
      let at = fd.get(it.id), estimated = false, source = '대화 기록';
      if (!at) {
        const hit = commits.filter((c) => new RegExp(`\\b${it.id}\\b`, 'i').test(c.msg)).sort((a, b) => b.t - a.t)[0];
        if (hit) { at = hit.t; estimated = true; source = 'git 커밋 (추정)'; }
      }
      if (!at) { report.push([r.project, it.id, '못 찾음 → 로드맵 이전 완료']); continue; }
      stamps.set(it.id, stampOf(at, estimated));
      ph[it.id] = { ...(ph[it.id] || {}), state: 'done', doneAt: at, estimated: estimated || undefined };
      report.push([r.project, it.id, `${stampOf(at, estimated)}  (${source})`]);
    }
    if (!DRY && stamps.size) writeStamps(r.file, stamps);
  }
  if (!DRY) saveHist(hist);
});

for (const [p, id, msg] of report) console.log(`${p.padEnd(24)} ${id.padEnd(10)} ${msg}`);
console.log(DRY ? '\n(--dry-run: 파일은 바꾸지 않았어요)' : `\n완료. 로드맵 파일: ${RDIR}`);
