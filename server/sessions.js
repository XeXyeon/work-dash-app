import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { WD } from './workdash.js';
import { features } from './features.js';
import { core, HOME } from './kit.js';
import { sessionContext } from './usage.js';

const { loadAll, DIR: SESSIONS_DIR } = core('lib.js');
const { loadCodex } = core('codex.js');
const { loadRoadmaps } = core('roadmap.js');
const { displayName, foldersOf } = core('projects.js');

const SESSIONS_CACHE_MS = 2_000;
const DESKTOP_CACHE_MS = 5_000;
const STALE_MS = 15 * 60_000;
const WATCH_BATCH_MS = 1_000;
const POLL_MS = 5_000;
const NOTIFY_COOLDOWN_MS = 60_000;
const TRACKER_KEEP_MS = 60_000;
const DESKTOP_DIR = path.join(HOME, 'Library', 'Application Support', 'Claude', 'claude-code-sessions');

let sessionsCache = { at: 0, list: [] };
function readSessions() {
  let claude = [], gpt = [];
  try { claude = loadAll(); } catch (e) { console.warn(`[sessions] Claude 세션 기록 읽기 실패: ${e.message}`); }
  try { gpt = loadCodex().sessions; } catch (e) { console.warn(`[sessions] Codex 로그 읽기 실패: ${e.message}`); }
  return [...claude.map((s) => ({ ...s, source: s.source || 'claude' })), ...gpt];
}
export function allSessions({ fresh = false } = {}) {
  if (!fresh && Date.now() - sessionsCache.at < SESSIONS_CACHE_MS) return sessionsCache.list;
  sessionsCache = { at: Date.now(), list: readSessions() };
  return sessionsCache.list;
}

const desktopFiles = new Map();
let desktopCache = { at: 0, map: new Map() };
function listDesktopFiles(dir, out, depth = 0) {
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory() && depth < 4) listDesktopFiles(p, out, depth + 1);
    else if (e.isFile() && e.name.startsWith('local_') && e.name.endsWith('.json')) out.push(p);
  }
  return out;
}
function desktopMap() {
  if (Date.now() - desktopCache.at < DESKTOP_CACHE_MS) return desktopCache.map;
  const map = new Map();
  const seen = new Set();
  try {
    for (const file of listDesktopFiles(DESKTOP_DIR, [])) {
      seen.add(file);
      let st;
      try { st = fs.statSync(file); } catch { continue; }
      let hit = desktopFiles.get(file);
      if (!hit || hit.mtime !== st.mtimeMs) {
        let info = null, cli = null;
        try {
          const j = JSON.parse(fs.readFileSync(file, 'utf8'));
          if (j && typeof j.cliSessionId === 'string' && typeof j.sessionId === 'string') {
            cli = j.cliSessionId;
            info = { localId: j.sessionId, title: typeof j.title === 'string' ? j.title : '', archived: j.isArchived === true };
          }
        } catch { }
        hit = { mtime: st.mtimeMs, info, cli };
        desktopFiles.set(file, hit);
      }
      if (hit.info && hit.cli) map.set(hit.cli, hit.info);
    }
  } catch (e) { console.warn(`[sessions] 데스크톱 세션 매핑 읽기 실패: ${e.message}`); }
  for (const f of desktopFiles.keys()) if (!seen.has(f)) desktopFiles.delete(f);
  desktopCache = { at: Date.now(), map };
  return map;
}

const clean = (t) => String(t || '')
  .replace(/<([a-z][\w-]*)(\s[^>]*)?>[\s\S]*?(<\/\1>|$)/gi, '\n')
  .trim();
const firstLine = (t, n = 160) => {
  const s = (clean(t).split('\n').map((l) => l.replace(/\s+/g, ' ').trim()).find(Boolean)) || '';
  return s.length > n ? `${s.slice(0, n)}…` : s;
};

const sessionTitle = (s) => { const t = firstLine(s.title, 120); return /^# AGENTS\.md instructions\b/i.test(t) ? '' : t; };

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const ROADMAPS_DIR = path.join(WD, 'roadmaps');
let roadmapCache = { sig: null, index: new Map() };
function roadmapSig() {
  try {
    return fs.readdirSync(ROADMAPS_DIR).filter((n) => n.endsWith('.md')).sort()
      .map((n) => { try { return `${n}:${fs.statSync(path.join(ROADMAPS_DIR, n)).mtimeMs}`; } catch { return n; } }).join('|');
  } catch { return ''; }
}
function roadmapIndex() {
  const sig = roadmapSig();
  if (sig === roadmapCache.sig) return roadmapCache.index;
  roadmapCache = { sig, index: readRoadmapIndex() };
  return roadmapCache.index;
}
function readRoadmapIndex() {
  const out = new Map();
  let roadmaps = [];
  try { roadmaps = loadRoadmaps(); } catch (e) { console.warn(`[sessions] 로드맵 읽기 실패: ${e.message}`); }
  for (const r of roadmaps) {
    const items = r.milestones.flatMap((m) => m.items).filter((it) => it.id);
    const byId = new Map(items.map((it) => [it.id.toUpperCase(), it]));
    const prefixes = [...new Set(items.map((it) => it.id.match(/^(.*?)-?\d+$/)?.[1]).filter(Boolean))];
    const re = prefixes.length
      ? new RegExp(`(?<![A-Za-z0-9])(${prefixes.map(escapeRe).join('|')})-?(\\d+)(?![0-9])`, 'gi')
      : null;
    out.set(r.project, { byId, re, doing: items.filter((it) => it.state === 'doing') });
  }
  return out;
}
function findId(rm, texts) {
  if (!rm?.re) return null;
  for (const t of texts) {
    if (!t) continue;
    for (const m of String(t).matchAll(rm.re)) {
      const it = rm.byId.get(`${m[1]}-${m[2]}`.toUpperCase());
      if (it) return it;
    }
  }
  return null;
}
function linkItem(s, desktop, index) {
  const texts = [desktop?.title, s.title, s.lastPrompt, ...(s.tasks || []).filter((t) => t.status === 'in_progress').map((t) => t.content)];
  const own = findId(index.get(s.project), texts);
  if (own) return { project: s.project, id: own.id, title: own.title, via: 'text' };
  const joined = texts.filter(Boolean).join('\n').toLowerCase();
  const others = [];
  for (const [project, rm] of index) {
    if (project === s.project) continue;
    const it = findId(rm, texts);
    const names = [project, displayName(project), ...foldersOf(project)];
    if (it) others.push({ project, it, named: names.some((n) => n && joined.includes(String(n).toLowerCase())) });
  }
  const pick = others.find((o) => o.named) ?? (others.length === 1 ? others[0] : null);
  if (pick) return { project: pick.project, id: pick.it.id, title: pick.it.title, via: 'text' };
  const rm = index.get(s.project);
  if (!rm) return null;
  if (s.status === 'ended') return null;
  const owner = s.source === 'gpt' ? 'gpt' : 'claude';
  const mine = rm.doing.filter((it) => String(it.owner || '').replace(/^@/, '') === owner && (!it.startedAt || (s.updatedAt || 0) >= it.startedAt));
  if (mine.length === 1) return { project: s.project, id: mine[0].id, title: mine[0].title, via: 'doing' };
  return null;
}

const tracker = new Map();
let initialized = false;

const activityCache = new Map();
const TAIL_BYTES = 256 * 1024;
function transcriptLastMessage(file) {
  let st;
  try { st = fs.statSync(file); } catch { return 0; }
  const c = activityCache.get(file);
  if (c && c.mtime === st.mtimeMs) return c.at;
  let at = 0;
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const len = Math.min(st.size, TAIL_BYTES);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, st.size - len);
      const lines = buf.toString('utf8').split('\n');
      for (let i = lines.length - 1; i >= 0 && !at; i--) {
        const l = lines[i];
        if (!l.includes('"timestamp"') || !/"type":"(user|assistant)"/.test(l)) continue;
        try { const d = JSON.parse(l); if (d.type === 'user' || d.type === 'assistant') at = Date.parse(d.timestamp) || 0; } catch { }
      }
    } finally { fs.closeSync(fd); }
  } catch { }
  activityCache.set(file, { mtime: st.mtimeMs, at });
  return at;
}
function lastActivity(s) {
  if (s.source !== 'gpt' && (s.status === 'idle' || s.status === 'ended') && typeof s.transcript === 'string') {
    const at = transcriptLastMessage(s.transcript);
    if (at) return Math.min(at, s.updatedAt || Infinity);
  }
  return s.updatedAt || s.startedAt || 0;
}

function track(s, now) {
  const prev = tracker.get(s.id);
  const st = s.status;
  if (!prev) {
    const t = { status: st, updatedAt: s.updatedAt || 0, eventAt: lastActivity(s) || now, event: null, staleIdle: false, notifiedAt: 0 };
    t.event = st === 'waiting' ? 'waiting' : st === 'ended' ? 'ended' : st === 'idle' ? 'done' : null;
    tracker.set(s.id, t);
    return { t, became: initialized && st === 'waiting' ? 'waiting' : null };
  }
  let became = null;
  if (st !== prev.status) {
    if (s.source === 'gpt' && prev.status === 'working' && st === 'idle' && (s.updatedAt || 0) === prev.updatedAt) prev.staleIdle = true;
    else {
      prev.staleIdle = false;
      if (st === 'waiting') became = 'waiting';
      else if (st === 'ended' && (prev.status === 'working' || prev.status === 'waiting')) became = 'ended';
      else if (st === 'idle' && (prev.status === 'working' || prev.status === 'waiting')) became = 'done';
      else if (st === 'working') prev.event = null;
      if (became) { prev.event = became; prev.eventAt = s.updatedAt || now; }
    }
    prev.status = st;
  } else if ((s.updatedAt || 0) !== prev.updatedAt) prev.staleIdle = false;
  prev.updatedAt = s.updatedAt || 0;
  return { t: prev, became };
}

function toView(s, t, desktop, index, now) {
  const kind = s.source === 'gpt' ? 'codex' : desktop ? 'claude-desktop' : 'claude-cli';
  const stale = (s.status === 'working' && now - (s.updatedAt || 0) > STALE_MS) || (s.source === 'gpt' && s.status === 'idle' && t.staleIdle);
  const task = (s.tasks || []).find((x) => x.status === 'in_progress');
  const f = features();
  const canOpen = (kind !== 'claude-cli' || hasTranscript(s)) && (kind !== 'claude-desktop' || f.open);
  return {
    id: s.id,
    source: s.source === 'gpt' ? 'gpt' : 'claude',
    kind,
    canOpen,
    canCompact: f.compact && kind !== 'claude-cli' && canOpen,
    canArchive: f.closeout && kind === 'claude-desktop',
    project: s.project || '(unknown)',
    title: firstLine(desktop?.title) || sessionTitle(s) || firstLine(s.lastPrompt, 120) || '(제목 없음)',
    sessionTitle: sessionTitle(s) || null,
    desktop: desktop ? { localId: desktop.localId, archived: desktop.archived } : null,
    status: stale ? 'stale' : (s.status || 'idle'),
    waitReason: s.status === 'waiting' ? firstLine(s.waitReason) || null : null,
    task: task ? firstLine(task.content) : null,
    lastPrompt: firstLine(s.lastPrompt) || null,
    event: stale ? null : t.event,
    eventAt: t.eventAt,
    startedAt: s.startedAt || null,
    updatedAt: s.updatedAt || null,
    item: linkItem(s, desktop, index),
    hasRoadmap: index.has(s.project),
    context: sessionContext(s),
  };
}

const asStr = (t) => `"${String(t || '').replace(/[\r\n]+/g, ' ').slice(0, 200).replace(/[\\"]/g, '\\$&')}"`;
const NOTIFY_ON = process.platform === 'darwin' && process.env.WORK_DASH_NOTIFY !== '0';
function notifyWaiting(v, t, now) {
  if (!NOTIFY_ON || now - t.notifiedAt < NOTIFY_COOLDOWN_MS) return;
  t.notifiedAt = now;
  const who = v.source === 'gpt' ? 'GPT' : 'Claude';
  const script = `display notification ${asStr(v.waitReason || v.title)} with title ${asStr(`입력 대기 · ${displayName(v.project)}`)} subtitle ${asStr(`${who} · ${v.title}`)}`;
  execFile('osascript', ['-e', script], { timeout: 10_000 }, (err) => { if (err) console.warn(`[sessions] macOS 알림 실패: ${err.message}`); });
}

let snapshot = { at: 0, sessions: [], sig: '' };
let onChanged = () => {};
const SUBAGENT_LIST_MAX = 12;
function subagentSummary(s, codexChildren, now) {
  let items = [];
  if (codexChildren && codexChildren.length) {
    items = codexChildren.map((x) => {
      const stale = x.status === 'working' && now - (x.updatedAt || 0) > STALE_MS;
      const task = (x.tasks || []).find((t) => t.status === 'in_progress');
      return {
        name: x.agentName || 'subagent', title: x.agentTask || firstLine(x.title || x.lastPrompt, 120) || '',
        status: stale ? 'stale' : x.status === 'working' ? 'running' : x.status === 'waiting' ? 'waiting' : 'done',
        detail: task ? firstLine(task.content, 120) : x.lastReply ? firstLine(x.lastReply, 120) : null,
        startedAt: x.startedAt || null, at: x.updatedAt || null,
      };
    });
  } else if (s.source !== 'gpt' && Array.isArray(s.agents) && s.agents.length) {
    items = s.agents.map((a) => ({
      name: a.type || 'subagent', title: firstLine(a.description, 120) || '',
      status: a.status === 'running' ? 'running' : a.status === 'background' ? 'background' : 'done',
      detail: a.lastActivity ? firstLine(a.lastActivity, 120) : null,
      startedAt: a.startedAt || null, at: a.endedAt || a.lastAt || a.startedAt || null,
    }));
  }
  if (!items.length) return undefined;
  items.sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
  return {
    total: items.length,
    working: items.filter((x) => x.status === 'running' || x.status === 'background').length,
    waiting: items.filter((x) => x.status === 'waiting').length,
    names: items.map((x) => x.name).slice(0, 6),
    items: items.slice(0, SUBAGENT_LIST_MAX),
  };
}

function refresh({ fresh = false } = {}) {
  const now = Date.now();
  const list = allSessions({ fresh });
  const desktop = desktopMap();
  const index = roadmapIndex();
  const views = [];
  const alive = new Set();
  const byThread = new Map(list.filter((s) => s && s.threadId).map((s) => [s.threadId, s]));
  const children = new Map();
  for (const s of list) {
    const parent = s && s.parentThreadId && byThread.get(s.parentThreadId);
    if (!parent) continue;
    if (!children.has(parent.id)) children.set(parent.id, []);
    children.get(parent.id).push(s);
  }
  const isChild = (s) => !!(s.parentThreadId && byThread.has(s.parentThreadId));
  for (const s of list) {
    if (!s || !s.id) continue;
    alive.add(s.id);
    if (isChild(s)) continue;
    const { t, became } = track(s, now);
    const v = toView(s, t, desktop.get(s.id), index, now);
    v.subagents = subagentSummary(s, children.get(s.id), now);
    views.push(v);
    if (became === 'waiting') notifyWaiting(v, t, now);
  }
  for (const [id, t] of tracker) {
    if (alive.has(id)) t.seenAt = now;
    else if (now - (t.seenAt || 0) > TRACKER_KEEP_MS) tracker.delete(id);
  }
  initialized = true;
  views.sort((a, b) => b.eventAt - a.eventAt || (b.updatedAt || 0) - (a.updatedAt || 0));
  const sig = JSON.stringify(views.map((v) => [v.id, v.status, v.event, v.eventAt, v.title, v.waitReason, v.task, v.lastPrompt, v.item?.id, v.kind, v.subagents?.total, v.subagents?.working, v.subagents?.waiting, v.context?.level, v.context?.compacting, v.context?.approx, Math.round((v.context?.tokens || 0) / 10_000), Math.floor((v.updatedAt || 0) / 60_000)]));
  const changed = snapshot.sig && sig !== snapshot.sig;
  snapshot = { at: now, sessions: views, sig };
  if (changed) onChanged([{ kind: 'sessions' }]);
  return snapshot;
}

export function getSessions() {
  const s = Date.now() - snapshot.at < SESSIONS_CACHE_MS ? snapshot : refresh();
  return { at: s.at, staleMs: STALE_MS, sessions: s.sessions };
}

const TARGET_FRESH_MS = 5_000;
let targetFreshAt = 0;
function hasTranscript(s) {
  return typeof s.transcript === 'string' && s.transcript.endsWith('.jsonl') && fs.existsSync(s.transcript);
}

export function sessionTarget(id) {
  let s = allSessions().find((x) => x && x.id === id);
  if (!s && Date.now() - targetFreshAt >= TARGET_FRESH_MS) {
    targetFreshAt = Date.now();
    s = allSessions({ fresh: true }).find((x) => x && x.id === id);
  }
  if (!s) {
    const d = desktopMap().get(id);
    return d && !d.archived ? { id, kind: 'claude-desktop', status: 'idle', localId: d.localId, cwd: '', hasTranscript: true } : null;
  }
  const desktop = s.source === 'gpt' ? null : desktopMap().get(s.id);
  const kind = s.source === 'gpt' ? 'codex' : desktop ? 'claude-desktop' : 'claude-cli';
  return { id: s.id, kind, status: s.status, localId: desktop?.localId ?? null, cwd: typeof s.cwd === 'string' ? s.cwd : '', hasTranscript: kind !== 'claude-cli' || hasTranscript(s) };
}

export function watchSessions(onChange) {
  onChanged = onChange;
  try { refresh({ fresh: true }); } catch (e) { console.warn(`[sessions] 처음 읽기 실패: ${e.message}`); }
  let batch = null, watcher = null, retry = null, closed = false;
  const flush = () => { batch = null; try { refresh({ fresh: true }); } catch (e) { console.warn(`[sessions] 갱신 실패: ${e.message}`); } };
  const start = () => {
    if (closed) return;
    try {
      watcher = fs.watch(SESSIONS_DIR, {}, (_ev, name) => {
        if (!name || !name.endsWith('.json')) return;
        if (!batch) batch = setTimeout(flush, WATCH_BATCH_MS);
      });
      watcher.on('error', () => { watcher?.close(); watcher = null; clearTimeout(retry); retry = setTimeout(start, POLL_MS); });
    } catch { retry = setTimeout(start, POLL_MS); }
  };
  start();
  const poll = setInterval(() => { try { refresh(); } catch { } }, POLL_MS);
  return () => { closed = true; clearTimeout(batch); clearTimeout(retry); clearInterval(poll); watcher?.close(); };
}
