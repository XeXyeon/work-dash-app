// 프로젝트 로드맵 파일(~/.work-dash/roadmaps/<프로젝트 폴더명>.md) 파싱
//
//   ## M2. 주문 (~11/01)
//   - [x] ORD-1 주문 생성
//   - [~] ORD-2 주문 취소 (after: ORD-1) @claude
//   - [ ] ORD-3 환불 처리 (after: ORD-2, CART-2)
//
// [ ] 할 일 · [~] 진행 중 · [x] 완료. 선행 작업이 끝나지 않은 할 일은 '막힘'으로 계산한다.
// [!] 외부 대기(팀원 · 인프라 등 내 작업이 아닌 것을 기다림) · [>] 보류(내가 미룸) · [-] 취소(하지 않음).
// 이 셋은 사람이 직접 적는 상태이고, 항목은 소속 마일스톤에 그대로 둔다.
// 줄 끝의 @claude / @gpt 는 그 항목을 잡고 있는 에이전트(담당 태그)다.
// 완료 항목 끝의 ✓2026-10-19 15:42 는 완료 시각이다 (~가 붙으면 git 커밋 등으로 추정한 시각). work-dash가 자동으로 붙인다.
const fs = require('fs');
const path = require('path');
const { WD } = require('./paths');
const { projectOfKey } = require('./projects');

const RDIR = path.join(WD, 'roadmaps');
const ITEM = /^\s*[-*]\s+\[([ xX~!>-])\]\s+(?:([A-Za-z][A-Za-z0-9]*-\d+)\s+)?(.*?)\s*(?:\((?:after|선행)\s*:\s*([^)]*)\))?\s*$/;
const STATE = { ' ': 'todo', x: 'done', X: 'done', '~': 'doing', '!': 'await', '>': 'hold', '-': 'dropped' };
// 선행이 풀린 것으로 보는 상태: 완료, 취소(하지 않기로 한 일은 기다릴 필요가 없다)
const RESOLVED = new Set(['done', 'dropped']);
// 진행률 분모에서 빼는 상태: 보류 · 취소. 외부 대기는 남은 일이라 분모에 넣는다
const UNCOUNTED = new Set(['hold', 'dropped']);
const TAG_RE = /\s+@([A-Za-z][\w-]*)\s*$/;
const STAMP_RE = /\s+✓(~?)(\d{4}-\d{2}-\d{2} \d{2}:\d{2})\s*$/;

const pad2 = (n) => String(n).padStart(2, '0');
function stampOf(ms, estimated) {
  const d = new Date(ms);
  return `✓${estimated ? '~' : ''}${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}
const parseStamp = (t) => new Date(t.replace(' ', 'T')).getTime();

function parse(text, project) {
  const milestones = [];
  let cur = null;
  for (const line of text.split('\n')) {
    const h = line.match(/^##\s+(.*?)\s*$/);
    if (h) {
      const due = h[1].match(/\(?~\s*([^)\s]+)\)?/);
      cur = { name: h[1].replace(/\s*\(?~\s*[^)\s]+\)?\s*$/, ''), due: due ? due[1] : '', items: [] };
      milestones.push(cur);
      continue;
    }
    // 줄 끝의 담당 태그와 완료 시각은 순서와 상관없이 떼어 낸다
    let rest = line, owner = '', stamp = null, t;
    while ((t = rest.match(TAG_RE)) || (t = rest.match(STAMP_RE))) {
      if (t[0].includes('✓')) stamp = { at: parseStamp(t[2]), estimated: t[1] === '~' };
      else owner = t[1].toLowerCase();
      rest = rest.slice(0, t.index);
    }
    const m = rest.match(ITEM);
    if (!m) continue;
    if (!cur) { cur = { name: '(마일스톤 없음)', due: '', items: [] }; milestones.push(cur); }
    cur.items.push({
      state: STATE[m[1]], id: m[2] ? m[2].toUpperCase() : '', title: m[3],
      after: (m[4] || '').split(/[,\s]+/).filter(Boolean).map((x) => x.toUpperCase()),
      owner, stamp,
    });
  }

  // 선행 작업 기준으로 막힘/진행 가능 계산
  const byId = new Map();
  for (const ms of milestones) for (const it of ms.items) if (it.id) byId.set(it.id, it);
  for (const ms of milestones) {
    for (const it of ms.items) {
      it.waiting = it.after.filter((id) => !RESOLVED.has(byId.get(id)?.state));
      it.unknown = it.after.filter((id) => !byId.has(id));
      if (it.state === 'todo') it.state = it.waiting.length ? 'blocked' : 'ready';
    }
  }
  // total은 진행률 분모다 (보류 · 취소 제외). 전체 항목 수는 milestones에서 센다
  const all = milestones.flatMap((m) => m.items).filter((i) => !UNCOUNTED.has(i.state));
  return { project, milestones, total: all.length, done: all.filter((i) => i.state === 'done').length };
}

const HIST = path.join(WD, 'data', 'roadmap-history.json');
const CONFIG = path.join(WD, 'config.json');

function recentHours() {
  try { return Number(JSON.parse(fs.readFileSync(CONFIG, 'utf8')).recentHours) || 24; } catch { return 24; }
}

// 교차 참조: (after: BE:MAT-11) 의 <접두어>:<항목 ID>. 모든 로드맵을 읽은 뒤 이 단계에서 다른 로드맵의 항목 상태로 푼다.
// 풀림 판정은 파일에 적힌 완료 · 취소만 본다. ready/blocked는 계산 결과라 쓰지 않으므로 서로 가리켜도 한 번만 돌면 된다.
const XREF = /^([^:]+):(.+)$/;
function linkRoadmaps(list) {
  const byProject = new Map();
  for (const r of list) {
    const m = new Map();
    for (const ms of r.milestones) for (const it of ms.items) if (it.id) m.set(it.id, it);
    byProject.set(r.project, m);
  }
  const ids = list.map((r) => r.project);
  for (const r of list) {
    const local = byProject.get(r.project);
    for (const ms of r.milestones) {
      for (const it of ms.items) {
        const xrefs = {};
        const found = new Set();
        for (const tok of it.after) {
          const x = tok.match(XREF);
          if (!x) { if (local.has(tok)) found.add(tok); continue; }
          const proj = projectOfKey(x[1], ids);
          const target = proj && byProject.get(proj) ? byProject.get(proj).get(x[2]) : undefined;
          if (proj && byProject.has(proj)) {
            xrefs[tok] = target ? { project: proj, id: x[2], found: true, state: target.state } : { project: proj, id: x[2], found: false };
          }
          if (target) found.add(tok);
        }
        const resolved = (tok) => {
          const x = tok.match(XREF);
          if (!x) return RESOLVED.has(local.get(tok)?.state);
          const proj = projectOfKey(x[1], ids);
          return RESOLVED.has(byProject.get(proj)?.get(x[2])?.state);
        };
        it.waiting = it.after.filter((tok) => !resolved(tok));
        it.unknown = it.after.filter((tok) => !found.has(tok));
        if (Object.keys(xrefs).length) it.xrefs = xrefs;
        if (it.state === 'ready' || it.state === 'blocked') it.state = it.waiting.length ? 'blocked' : 'ready';
      }
    }
  }
  return list;
}

function readFiles() {
  let names = [];
  try { names = fs.readdirSync(RDIR).filter((n) => n.endsWith('.md')).sort(); } catch { return []; }
  const out = [];
  for (const n of names) {
    try {
      const f = path.join(RDIR, n);
      const r = parse(fs.readFileSync(f, 'utf8'), n.replace(/\.md$/, ''));
      r.mtime = fs.statSync(f).mtimeMs;
      r.file = f;
      out.push(r);
    } catch {}
  }
  return linkRoadmaps(out);
}

// 완료 시각을 로드맵 파일에 기록한다. 파일을 다시 읽어 항목 키(ID 또는 제목)로 줄을 찾으므로
// 그 사이 에이전트가 다른 줄을 고쳤어도 덮어쓰지 않는다. changes: Map<키, 스탬프 문자열 | null(지우기)>
function writeStamps(file, changes) {
  const text = fs.readFileSync(file, 'utf8');
  let touched = false;
  const out = text.split('\n').map((line) => {
    const m = line.replace(/(\s+(✓~?\d{4}-\d{2}-\d{2} \d{2}:\d{2}|@[A-Za-z][\w-]*))+\s*$/, '').match(ITEM);
    if (!m) return line;
    const key = m[2] ? m[2].toUpperCase() : m[3];
    if (!changes.has(key)) return line;
    const stamp = changes.get(key);
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

// 로드맵 파일에는 상태만 있으므로, 상태가 바뀐 것을 감지해 언제 시작/완료됐는지 기록한다.
// - 바뀐 시각은 감지한 순간이 아니라 파일 수정 시각으로 잡는다 (대시보드가 꺼져 있던 사이의 변경도 근사치로 남도록).
// - 처음 보는 프로젝트는 현재 상태만 기억하고 시각은 남기지 않는다 (기존 항목이 전부 '방금 완료'가 되지 않도록).
// - 완료 시각은 로드맵 파일의 ✓ 스탬프가 기준이다. 스탬프가 없는 완료 항목에 시각을 알면 파일에 붙인다.
// history에 남기는 상태: done · doing · paused(외부 대기 · 보류 · 취소) · todo(진행 가능 · 선행 필요)
const PAUSED = new Set(['await', 'hold', 'dropped']);
const simple = (st) => (st === 'done' || st === 'doing' ? st : PAUSED.has(st) ? 'paused' : 'todo');
function track(list) {
  let hist = {};
  try { hist = JSON.parse(fs.readFileSync(HIST, 'utf8')); } catch {}
  let changed = false;
  for (const r of list) {
    const first = !hist[r.project];
    const ph = hist[r.project] || (hist[r.project] = {});
    const stamps = new Map();
    for (const it of r.milestones.flatMap((m) => m.items)) {
      const key = it.id || it.title;
      const cur = simple(it.state);
      let h = ph[key];
      if (!h) {
        h = ph[key] = { state: cur };
        if (!first && cur === 'done') h.doneAt = r.mtime;
        if (!first && cur === 'doing') h.startedAt = r.mtime;
        changed = true;
      } else if (h.state !== cur) {
        if (cur === 'done') { h.doneAt = r.mtime; delete h.estimated; }
        // 멈췄다가(paused) 다시 시작한 항목은 처음 시작 시각을 유지한다
        if (cur === 'doing') { if (!(h.state === 'paused' && h.startedAt)) h.startedAt = r.mtime; delete h.doneAt; }
        if (cur === 'todo') { delete h.doneAt; delete h.startedAt; }
        if (cur === 'paused') { delete h.doneAt; }   // 완료가 아니게 됐으니 완료 시각만 지우고 시작 시각은 남긴다
        h.state = cur;
        changed = true;
      }
      if (cur === 'done' && it.stamp) {
        if (h.doneAt !== it.stamp.at || !!h.estimated !== it.stamp.estimated) {
          h.doneAt = it.stamp.at; h.estimated = it.stamp.estimated || undefined; changed = true;
        }
      } else if (cur === 'done' && h.doneAt) {
        stamps.set(key, stampOf(h.doneAt, h.estimated));
      } else if (cur !== 'done' && it.stamp) {
        stamps.set(key, null);   // 완료가 풀린 항목의 스탬프는 지운다
      }
      it.doneAt = cur === 'done' ? h.doneAt : undefined;
      it.estimated = !!h.estimated;
      it.startedAt = h.startedAt;
    }
    if (stamps.size && r.file) { try { writeStamps(r.file, stamps); } catch {} }
  }
  if (changed) saveHist(hist);
  return list;
}

function saveHist(hist) {
  fs.mkdirSync(path.dirname(HIST), { recursive: true });
  const tmp = `${HIST}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(hist));
  fs.renameSync(tmp, HIST);
}

// 대시보드용: 읽고, 변경을 기록하고, 최근 기준(시간)을 붙여 돌려준다
function loadRoadmaps() {
  const { withLock } = require('./lib');
  const list = readFiles();
  try { withLock('roadmap-history', () => track(list)); } catch {}
  const since = Date.now() - recentHours() * 3600e3;
  for (const r of list) {
    const items = r.milestones.flatMap((m) => m.items);
    for (const it of items) {
      it.recentDone = it.state === 'done' && it.doneAt >= since;
      it.recentStart = it.state === 'doing' && it.startedAt >= since;
    }
    r.recentDone = items.filter((i) => i.recentDone).length;
  }
  return list;
}

// hook용: 로드맵 파일이 마지막 확인 이후 바뀌었을 때만 기록한다 (도구 호출마다 실행되므로 가볍게)
function trackIfChanged() {
  let latest = 0;
  try { for (const n of fs.readdirSync(RDIR)) if (n.endsWith('.md')) latest = Math.max(latest, fs.statSync(path.join(RDIR, n)).mtimeMs); } catch { return; }
  let checked = 0;
  try { checked = fs.statSync(HIST).mtimeMs; } catch {}
  if (latest <= checked) return;
  const { withLock } = require('./lib');
  withLock('roadmap-history', () => { track(readFiles()); const now = new Date(); fs.utimesSync(HIST, now, now); });
}

module.exports = { RDIR, HIST, parse, readFiles, linkRoadmaps, loadRoadmaps, trackIfChanged, writeStamps, stampOf, saveHist, UNCOUNTED };
