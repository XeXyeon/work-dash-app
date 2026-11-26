// 이슈 파일(~/.work-dash/issues/<프로젝트>.md) 파싱과 처리 시간 기록
//
//   - [~] ORD-1#1 [중간][버그] 결제 대기 주문이 중복 생성됨 (발견: FE:ORD-1) @claude
//     - 원인: …
//   - [x] ISS-1 [낮음][설정] dev 설정 키 누락 ✓2026-10-20 15:10
//
// [ ] 열림 · [~] 처리 중 · [x] 해결 · [-] 닫음. ID가 <항목>#n 이면 그 로드맵 항목의 이슈, ISS-n 이면 공통 이슈.
// 발견·시작 시각은 상태 변화를 감지해 기록하고, 해결·닫은 시각은 줄 끝 ✓ 스탬프로 파일에도 남긴다.
const fs = require('fs');
const path = require('path');
const { WD } = require('./paths');
const { stampOf } = require('./roadmap');

const IDIR = path.join(WD, 'issues');
const HIST = path.join(WD, 'data', 'issue-history.json');
const LINE = /^\s*[-*]\s+\[([ xX~-])\]\s+([A-Za-z][A-Za-z0-9]*-\d+#\d+|ISS-\d+)\s+(.*)$/;
const DETAIL = /^\s{2,}[-*]\s+([^:：]+)[:：]\s*(.*)$/;
const STATE = { ' ': 'open', '~': 'doing', x: 'done', X: 'done', '-': 'closed' };
const SEVERITY = ['높음', '중간', '낮음'];
const STAMP_RE = /\s+✓(~?)(\d{4}-\d{2}-\d{2} \d{2}:\d{2})\s*$/;
const TAG_RE = /\s+@([A-Za-z][\w-]*)\s*$/;
const parseStamp = (t) => new Date(t.replace(' ', 'T')).getTime();

function parse(text, project) {
  const issues = [];
  let cur = null;
  for (const line of text.split('\n')) {
    const m = line.match(LINE);
    if (m) {
      let rest = m[3], owner = '', stamp = null, t;
      while ((t = rest.match(TAG_RE)) || (t = rest.match(STAMP_RE))) {
        if (t[0].includes('✓')) stamp = { at: parseStamp(t[2]), estimated: t[1] === '~' };
        else owner = t[1].toLowerCase();
        rest = rest.slice(0, t.index);
      }
      let severity = '', kind = '';
      while ((t = rest.match(/^\[([^\]]+)\]\s*/))) {
        if (SEVERITY.includes(t[1])) severity = t[1]; else kind = t[1];
        rest = rest.slice(t[0].length);
      }
      const info = {};
      while ((t = rest.match(/\s*\((발견|관련|GitHub)\s*[:：]\s*([^)]*)\)\s*$/))) {
        info[t[1]] = t[2].trim();
        rest = rest.slice(0, t.index);
      }
      const id = m[2].toUpperCase();
      cur = {
        id, parent: id.includes('#') ? id.split('#')[0] : '', state: STATE[m[1]],
        severity: severity || '중간', kind, title: rest.trim(), owner, stamp,
        from: info['발견'] || '', related: (info['관련'] || '').split(/[,\s]+/).filter(Boolean), github: info.GitHub || '',
        details: [],
      };
      issues.push(cur);
      continue;
    }
    const d = cur && line.match(DETAIL);
    if (d) { cur.details.push({ key: d[1].trim(), value: d[2].trim() }); continue; }
    if (!/^\s{2,}/.test(line)) cur = null;   // 들여쓰기 없는 다른 줄이 나오면 세부 줄 끝
  }
  return { project, issues };
}

function readFiles() {
  let names = [];
  try { names = fs.readdirSync(IDIR).filter((n) => n.endsWith('.md')).sort(); } catch { return []; }
  const out = [];
  for (const n of names) {
    try {
      const file = path.join(IDIR, n);
      const r = parse(fs.readFileSync(file, 'utf8'), n.replace(/\.md$/, ''));
      r.file = file; r.mtime = fs.statSync(file).mtimeMs;
      out.push(r);
    } catch {}
  }
  return out;
}

// 해결·닫은 시각을 이슈 줄 끝에 남긴다 (파일을 다시 읽어 ID로 줄을 찾으므로 다른 줄은 건드리지 않는다)
function writeStamps(file, changes) {
  const text = fs.readFileSync(file, 'utf8');
  let touched = false;
  const out = text.split('\n').map((line) => {
    const m = line.match(LINE);
    if (!m || !changes.has(m[2].toUpperCase())) return line;
    const stamp = changes.get(m[2].toUpperCase());
    let next = line.replace(/\s+✓~?\d{4}-\d{2}-\d{2} \d{2}:\d{2}/, '').replace(/\s+$/, '');
    if (stamp) next += ' ' + stamp;
    if (next !== line) touched = true;
    return next;
  });
  if (!touched) return;
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, out.join('\n'));
  fs.renameSync(tmp, file);
}

// 상태 변화를 감지해 발견·시작·해결 시각을 기록한다. 시각은 파일 수정 시각 기준.
// 처음 보는 프로젝트 파일은 현재 상태만 기억하고 시각은 남기지 않는다 (옮겨 온 이슈가 전부 '방금 발견'이 되지 않도록).
const finished = (st) => st === 'done' || st === 'closed';
function track(list) {
  let hist = {};
  try { hist = JSON.parse(fs.readFileSync(HIST, 'utf8')); } catch {}
  let changed = false;
  for (const r of list) {
    const first = !hist[r.project];
    const ph = hist[r.project] || (hist[r.project] = {});
    const stamps = new Map();
    for (const it of r.issues) {
      let h = ph[it.id];
      if (!h) {
        h = ph[it.id] = { state: it.state };
        if (!first) {
          h.createdAt = r.mtime;
          if (it.state === 'doing') h.startedAt = r.mtime;
          if (finished(it.state)) h.doneAt = r.mtime;
        }
        changed = true;
      } else if (h.state !== it.state) {
        if (it.state === 'doing') { h.startedAt = h.startedAt || r.mtime; delete h.doneAt; }
        if (finished(it.state)) h.doneAt = r.mtime;
        if (it.state === 'open') { delete h.doneAt; }
        h.state = it.state;
        changed = true;
      }
      if (finished(it.state) && it.stamp) {
        if (h.doneAt !== it.stamp.at) { h.doneAt = it.stamp.at; changed = true; }
      } else if (finished(it.state) && h.doneAt) {
        stamps.set(it.id, stampOf(h.doneAt, false));
      } else if (!finished(it.state) && it.stamp) {
        stamps.set(it.id, null);   // 다시 열린 이슈의 스탬프는 지운다
      }
      it.createdAt = h.createdAt; it.startedAt = h.startedAt;
      it.doneAt = finished(it.state) ? h.doneAt : undefined;
    }
    if (stamps.size) { try { writeStamps(r.file, stamps); } catch {} }
  }
  if (changed) {
    fs.mkdirSync(path.dirname(HIST), { recursive: true });
    const tmp = `${HIST}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(hist));
    fs.renameSync(tmp, HIST);
  }
  return list;
}

const SEV_ORDER = { 높음: 0, 중간: 1, 낮음: 2 };
const sortIssues = (a, b) => (SEV_ORDER[a.severity] ?? 1) - (SEV_ORDER[b.severity] ?? 1) || a.id.localeCompare(b.id, undefined, { numeric: true });

// 대시보드용: 프로젝트 → { issues, byParent: Map<항목 ID, 이슈[]>, common: 이슈[] }
function loadIssues() {
  const { withLock } = require('./lib');
  const list = readFiles();
  try { withLock('issue-history', () => track(list)); } catch {}
  const out = {};
  for (const r of list) {
    const byParent = new Map();
    const common = [];
    for (const it of r.issues) {
      if (it.parent) { if (!byParent.has(it.parent)) byParent.set(it.parent, []); byParent.get(it.parent).push(it); }
      else common.push(it);
    }
    for (const v of byParent.values()) v.sort(sortIssues);
    common.sort(sortIssues);
    out[r.project] = { issues: r.issues.slice().sort(sortIssues), byParent, common, file: r.file };
  }
  return out;
}

// hook용: 이슈 파일이 마지막 확인 이후 바뀌었을 때만 기록한다
function trackIfChanged() {
  let latest = 0;
  try { for (const n of fs.readdirSync(IDIR)) if (n.endsWith('.md')) latest = Math.max(latest, fs.statSync(path.join(IDIR, n)).mtimeMs); } catch { return; }
  let checked = 0;
  try { checked = fs.statSync(HIST).mtimeMs; } catch {}
  if (latest <= checked) return;
  const { withLock } = require('./lib');
  withLock('issue-history', () => { track(readFiles()); const now = new Date(); try { fs.utimesSync(HIST, now, now); } catch {} });
}

module.exports = { IDIR, parse, loadIssues, trackIfChanged, finished };
