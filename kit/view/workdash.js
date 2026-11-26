import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const core = (name) => createRequire(import.meta.url)(`../core/${name}`);

export const { WD } = core('paths.js');
const { loadRoadmaps, UNCOUNTED } = core('roadmap.js');
const { loadIssues, finished } = core('issues.js');
const { parse: parseFlows } = core('flows.js');
const { itemDetail } = core('detail.js');
const { displayName, foldersOf, readProjects, setDisplayName, CONFIG: CONFIG_FILE } = core('projects.js');
export const CONFIG = CONFIG_FILE;

export const DIRS = {
  roadmaps: path.join(WD, 'roadmaps'),
  issues: path.join(WD, 'issues'),
  worklogs: path.join(WD, 'worklogs'),
  flows: path.join(WD, 'flows'),
  improvements: path.join(WD, 'improvements'),
};
export const UI_STATE = path.join(WD, 'data', 'ui-state.json');
export const ARCHIVED = path.join(WD, 'data', 'archived-projects.json');
const TRASH = path.join(WD, 'trash');

export const cardName = (idOrTitle) => idOrTitle.replace(/[/:]/g, '_');

const ACTIVE = new Set(['ready', 'blocked', 'doing']);

function readFold() {
  try { return JSON.parse(fs.readFileSync(UI_STATE, 'utf8')).milestoneFold || {}; } catch { return {}; }
}

function cardSet(project) {
  try { return new Set(fs.readdirSync(path.join(DIRS.worklogs, project)).filter((n) => n.endsWith('.md')).map((n) => n.slice(0, -3))); } catch { return new Set(); }
}

const isOpen = (iss) => !finished(iss.state);

function readArchived() {
  try { const a = JSON.parse(fs.readFileSync(ARCHIVED, 'utf8')); return new Set(Array.isArray(a) ? a.filter((x) => typeof x === 'string') : []); } catch { return new Set(); }
}
function writeArchived(set) {
  const tmp = `${ARCHIVED}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify([...set].sort((a, b) => a.localeCompare(b)), null, 2) + '\n');
  fs.renameSync(tmp, ARCHIVED);
}

function flowSet() {
  try { return new Set(fs.readdirSync(DIRS.flows).filter((n) => n.endsWith('.md')).map((n) => n.slice(0, -3))); } catch { return new Set(); }
}

function projectNames(roadmaps, issues, flows) {
  return [...new Set([...roadmaps.map((r) => r.project), ...Object.keys(issues), ...flows])].sort((a, b) => a.localeCompare(b));
}

export function getProjects() {
  const roadmaps = loadRoadmaps();
  const issues = loadIssues();
  const flows = flowSet();
  const archived = readArchived();
  const byName = new Map(roadmaps.map((r) => [r.project, r]));
  const refKeys = Object.fromEntries(Object.entries(readProjects()).map(([id, p]) => [id, typeof p?.key === 'string' ? p.key : null]));
  return projectNames(roadmaps, issues, flows).map((name) => {
    const r = byName.get(name);
    const items = r ? r.milestones.flatMap((m) => m.items) : [];
    const iss = issues[name]?.issues || [];
    const count = (st) => items.filter((i) => i.state === st).length;
    return {
      project: name,
      displayName: displayName(name),
      refKey: refKeys[name] || null,
      folders: foldersOf(name),
      hasRoadmap: !!r,
      hasIssues: !!issues[name],
      hasFlows: flows.has(name),
      archived: archived.has(name),
      total: r?.total || 0,
      done: r?.done || 0,
      doing: count('doing'),
      ready: count('ready'),
      blocked: count('blocked'),
      await: count('await'),
      recentDone: r?.recentDone || 0,
      doingItems: items.filter((i) => i.state === 'doing').map((i) => ({ id: i.id, title: i.title, owner: i.owner, startedAt: i.startedAt })),
      openIssues: iss.filter(isOpen).length,
      mtime: r?.mtime || 0,
    };
  });
}

export function getRoadmap(project) {
  const r = loadRoadmaps().find((x) => x.project === project);
  if (!r) return null;
  const iss = loadIssues()[project];
  const byParent = iss?.byParent || new Map();
  const fold = readFold();
  const cards = cardSet(project);
  const milestones = r.milestones.map((ms) => {
    const items = ms.items.map((it) => ({
      ...it,
      issues: (it.id && byParent.get(it.id)) || [],
      hasCard: cards.has(cardName(it.id || it.title)),
    }));
    const openIssues = items.reduce((n, it) => n + it.issues.filter(isOpen).length, 0);
    const key = `${project}::${ms.name}`;
    const folded = key in fold ? fold[key] : items.length > 0 && !items.some((i) => ACTIVE.has(i.state)) && !openIssues;
    const counted = items.filter((i) => !UNCOUNTED.has(i.state));
    return {
      key, name: ms.name, due: ms.due, folded, foldRemembered: key in fold,
      total: counted.length, done: items.filter((i) => i.state === 'done').length, openIssues, items,
    };
  });
  return {
    project, total: r.total, done: r.done, recentDone: r.recentDone, mtime: r.mtime,
    milestones,
    commonIssues: iss?.common || [],
  };
}

export function getIssues(project) {
  const iss = loadIssues()[project];
  if (!iss) return null;
  return {
    project,
    issues: iss.issues,
    common: iss.common,
    byParent: Object.fromEntries(iss.byParent),
    open: iss.issues.filter(isOpen).length,
  };
}

export function getCard(project, id) {
  const dir = path.join(DIRS.worklogs, project);
  const file = path.join(dir, `${cardName(id)}.md`);
  if (path.dirname(dir) !== DIRS.worklogs || path.dirname(file) !== dir) return null;
  try {
    const st = fs.statSync(file);
    if (!st.isFile()) return null;
    return { project, id, markdown: fs.readFileSync(file, 'utf8'), mtime: st.mtimeMs };
  } catch { return null; }
}

const ASK_MAX = 40, TEXT_MAX = 600;
export function getDetail(project, id) {
  const r = loadRoadmaps().find((x) => x.project === project);
  const item = r?.milestones.flatMap((m) => m.items).find((it) => (it.id ? it.id === id : cardName(it.title) === id));
  if (!item) return null;
  const d = itemDetail(project, item);
  const seen = new Set();
  const asks = d.asks.filter((a) => { const k = `${a.t}:${a.text}`; if (seen.has(k)) return false; seen.add(k); return true; });
  const cut = (t) => (t.length > TEXT_MAX ? `${t.slice(0, TEXT_MAX)}…` : t);
  return {
    project, id, mode: d.mode, from: d.from, to: d.to,
    asks: asks.slice(-ASK_MAX).map((a) => ({ t: a.t, source: a.source, text: cut(a.text) })),
    asksTotal: asks.length,
    commits: d.commits.map((c) => ({ t: c.t, subject: c.subject, add: c.stats.reduce((n, f) => n + f.add, 0), del: c.stats.reduce((n, f) => n + f.del, 0), files: c.files.length })),
    files: d.files.map((f) => ({ path: f, ...(d.stats.get(f) || {}) })),
    agents: d.agents,
  };
}

export function getFlows(project) {
  const file = path.join(DIRS.flows, `${project}.md`);
  if (path.dirname(file) !== DIRS.flows) return null;
  let st, md;
  try {
    st = fs.statSync(file);
    if (!st.isFile()) return null;
    md = fs.readFileSync(file, 'utf8');
  } catch { return null; }
  return { ...parseFlows(md, project), mtime: st.mtimeMs };
}

function projectPaths(project) {
  return [
    path.join(DIRS.roadmaps, `${project}.md`),
    path.join(DIRS.issues, `${project}.md`),
    path.join(DIRS.worklogs, project),
    path.join(DIRS.flows, `${project}.md`),
    path.join(DIRS.flows, `${project}.html`),
    path.join(DIRS.flows, `${project}.share.json`),
  ];
}
const safeName = (project) => typeof project === 'string' && project.length > 0 && project.length <= 200
  && !/[\/\\\0]/.test(project) && project !== '.' && project !== '..';
const known = (project) => getProjects().some((p) => p.project === project);

export function setArchived(project, on) {
  if (!safeName(project)) return { status: 400, error: '잘못된 프로젝트 이름' };
  const set = readArchived();
  if (on && !known(project)) return { status: 404, error: `프로젝트 없음: ${project}` };
  if (on) set.add(project); else set.delete(project);
  writeArchived(set);
  return { status: 200, body: { project, archived: on } };
}

export function setMilestoneFold(key, folded) {
  if (typeof key !== 'string' || key.length < 1 || key.length > 300 || !key.includes('::')) return { status: 400, error: '잘못된 마일스톤 키' };
  if (typeof folded !== 'boolean') return { status: 400, error: 'folded는 참 또는 거짓이어야 합니다' };
  let state;
  try { state = JSON.parse(fs.readFileSync(UI_STATE, 'utf8')); } catch { state = {}; }
  if (!state || typeof state !== 'object' || Array.isArray(state)) state = {};
  if (!state.milestoneFold || typeof state.milestoneFold !== 'object' || Array.isArray(state.milestoneFold)) state.milestoneFold = {};
  state.milestoneFold[key] = folded;
  fs.mkdirSync(path.dirname(UI_STATE), { recursive: true });
  const tmp = `${UI_STATE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n');
  fs.renameSync(tmp, UI_STATE);
  return { status: 200, body: { key, folded } };
}

export function renameProject(project, name) {
  if (!safeName(project)) return { status: 400, error: '잘못된 프로젝트 이름' };
  if (name !== undefined && name !== null && typeof name !== 'string') return { status: 400, error: 'name은 문자열이어야 합니다' };
  if (!known(project)) return { status: 404, error: `프로젝트 없음: ${project}` };
  try {
    return { status: 200, body: { project, displayName: setDisplayName(project, name) } };
  } catch (e) {
    return { status: 400, error: e.message };
  }
}

export function trashProject(project, confirm) {
  if (!safeName(project)) return { status: 400, error: '잘못된 프로젝트 이름' };
  if (confirm !== project) return { status: 400, error: '확인 이름이 프로젝트 이름과 다릅니다' };
  const exists = projectPaths(project).filter((p) => { try { fs.lstatSync(p); return true; } catch { return false; } });
  if (!exists.length) return { status: 404, error: `프로젝트 없음: ${project}` };
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  fs.mkdirSync(TRASH, { recursive: true });
  let dest;
  for (let n = 1; ; n++) {
    dest = path.join(TRASH, `${stamp}-${project}${n > 1 ? `-${n}` : ''}`);
    if (path.dirname(dest) !== TRASH) return { status: 400, error: '잘못된 프로젝트 이름' };
    try { fs.mkdirSync(dest); break; } catch (e) { if (e.code !== 'EEXIST' || n >= 100) throw e; }
  }
  const moved = [];
  try {
    for (const src of exists) {
      const rel = path.relative(WD, src);
      const to = path.join(dest, rel);
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.renameSync(src, to);
      moved.push({ from: src, to });
    }
  } catch (e) {
    for (const m of moved.reverse()) { try { fs.renameSync(m.to, m.from); } catch { } }
    fs.writeFileSync(path.join(dest, 'manifest.json'), JSON.stringify({ project, failed: e.message, moved }, null, 2));
    return { status: 500, error: `옮기기 실패: ${e.message}` };
  }
  fs.writeFileSync(path.join(dest, 'manifest.json'), JSON.stringify({ project, trashedAt: d.toISOString(), moved }, null, 2));
  const set = readArchived();
  if (set.delete(project)) writeArchived(set);
  return { status: 200, body: { project, trashedTo: dest, moved: moved.map((m) => path.relative(WD, m.from)) } };
}
