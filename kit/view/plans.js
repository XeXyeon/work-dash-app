import fs from 'node:fs';
import path from 'node:path';
import { redact, redactText } from './redact.js';
import { createRequire } from 'node:module';

const core = (name) => createRequire(import.meta.url)(`../core/${name}`);

const { foldersOf } = core('projects.js');
const { findFolder } = core('scope.js');
const MAX_BYTES = 1024 * 1024;
const RETRY_MS = 5000;
const IDLE_RETRY_MS = 30_000;
const TEXT_EXT = new Set(['.yaml', '.yml', '.sql', '.json', '.txt', '.toml', '.xml', '.csv', '.properties', '.sh', '.http', '.puml']);
const isHidden = (n) => n.startsWith('.');

function repoDirs(project) {
  const out = [];
  for (const name of foldersOf(project)) {
    const d = findFolder(name, { git: true });
    if (d) out.push({ repo: name, dir: d });
  }
  return out;
}

const kindOf = (file) => {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.md') return 'markdown';
  if (ext === '.json') return 'json';
  return TEXT_EXT.has(ext) ? 'text' : null;
};

const encodeId = (repo, rel) => Buffer.from(`${repo}/${rel}`, 'utf8').toString('base64url');
function decodeId(id) {
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]+$/.test(id)) return null;
  const s = Buffer.from(id, 'base64url').toString('utf8');
  const i = s.indexOf('/');
  return i > 0 && i < s.length - 1 ? { repo: s.slice(0, i), rel: s.slice(i + 1) } : null;
}

function scan(root, limit = Infinity) {
  const out = [];
  const walk = (dir, rel) => {
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents.sort((a, b) => a.name.localeCompare(b.name))) {
      if (out.length >= limit) return;
      if (isHidden(e.name) || e.name === 'node_modules' || e.isSymbolicLink()) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(dir, e.name), r);
      else if (e.isFile() && kindOf(e.name)) out.push(r);
    }
  };
  walk(root, '');
  return out;
}

function docsRoot(dir) {
  try {
    const repo = fs.realpathSync(dir);
    const root = fs.realpathSync(path.join(dir, 'docs'));
    return root.startsWith(repo + path.sep) ? root : null;
  } catch { return null; }
}

export function getPlans(project) {
  const repos = repoDirs(project).map(({ repo, dir }) => {
    const root = docsRoot(dir);
    const docs = (root ? scan(root) : []).map((rel) => {
      let st; try { st = fs.statSync(path.join(root, rel)); } catch { st = null; }
      return { id: encodeId(repo, rel), repo, path: rel, kind: kindOf(rel), size: st?.size || 0, mtime: st?.mtimeMs || 0 };
    });
    return { repo, hasDocs: docs.length > 0, docs };
  });
  return { project, repos };
}

export function hasPlans(project) {
  return repoDirs(project).some(({ dir }) => { const r = docsRoot(dir); return !!r && scan(r, 1).length > 0; });
}

export function getPlan(project, id) {
  const ref = decodeId(id);
  if (!ref) return null;
  const found = repoDirs(project).find((r) => r.repo === ref.repo);
  const root = found && docsRoot(found.dir);
  if (!root) return null;
  if (!scan(root).includes(ref.rel)) return null;
  const file = path.join(root, ref.rel);
  let real;
  try { real = fs.realpathSync(file); } catch { return null; }
  if (!real.startsWith(root + path.sep)) return null;
  let st;
  try { st = fs.statSync(real); if (!st.isFile()) return null; } catch { return null; }
  const kind = kindOf(ref.rel);
  const base = { id, repo: ref.repo, path: ref.rel, kind, size: st.size, mtime: st.mtimeMs };
  let content = '';
  let truncated = false;
  try {
    truncated = st.size > MAX_BYTES;
    const buf = Buffer.alloc(Math.min(st.size, MAX_BYTES + 1));
    const fd = fs.openSync(real, 'r');
    let n = 0;
    try { n = fs.readSync(fd, buf, 0, buf.length, 0); } finally { fs.closeSync(fd); }
    truncated = truncated || n > MAX_BYTES;
    content = buf.subarray(0, Math.min(n, MAX_BYTES)).toString('utf8');
    if (kind === 'json') {
      if (truncated) return { ...base, content: '', truncated, error: '파일이 너무 커서(1MB 초과) 표시하지 않습니다' };
      try { content = JSON.stringify(redact(JSON.parse(content)), null, 2); }
      catch { return { ...base, content: '', truncated, error: 'JSON 해석 실패 — 비밀 값이 있을 수 있어 원문을 표시하지 않습니다' }; }
    } else if (kind === 'text') {
      content = redactText(content);
    }
  } catch (e) {
    return { ...base, content: '', truncated, error: `읽기 실패: ${e.message}` };
  }
  return { ...base, content, truncated };
}

const SECTION_MAX = 20_000;
const SECTION_DOCS = 5;
export function getPlanSection(project, num) {
  if (typeof num !== 'string' || !/^\d{1,3}(\.\d{1,3}){0,5}$/.test(num)) return null;
  const matches = [];
  for (const { repo, dir } of repoDirs(project)) {
    const root = docsRoot(dir);
    if (!root) continue;
    for (const rel of scan(root)) {
      if (matches.length >= SECTION_DOCS) break;
      if (kindOf(rel) !== 'markdown') continue;
      const doc = getPlan(project, encodeId(repo, rel));
      const sec = doc && !doc.error ? findSection(doc.content, num) : null;
      if (sec) matches.push({ id: doc.id, repo, path: rel, ...sec });
    }
  }
  return { project, num, matches };
}

function findSection(text, num) {
  const lines = text.split('\n');
  let fence = false, start = -1, end = lines.length, level = 0, title = '';
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (/^\s*(```|~~~)/.test(l)) { fence = !fence; continue; }
    if (fence) continue;
    const h = l.match(/^(#{1,6})\s+(.*)$/);
    if (!h) continue;
    if (start < 0) {
      const m = h[2].match(/^§?\s*(\d+(?:\.\d+)*)[.)]?(?:\s|$)/);
      if (m && m[1] === num) { start = i; level = h[1].length; title = h[2].trim(); }
    } else if (h[1].length <= level) { end = i; break; }
  }
  if (start < 0) return null;
  const content = lines.slice(start + 1, end).join('\n').trim();
  return { title, content: content.slice(0, SECTION_MAX), truncated: content.length > SECTION_MAX };
}

export function watchPlans(onChange, projectNames) {
  const pending = new Set();
  let timer = null;
  const push = (project) => {
    pending.add(project);
    if (!timer) timer = setTimeout(() => { timer = null; const list = [...pending]; pending.clear(); onChange(list.map((p) => ({ kind: 'plans', project: p }))); }, 150);
  };
  const watchers = new Set();
  const retries = new Set();
  let closed = false;
  const later = (fn, ms) => { const t = setTimeout(() => { retries.delete(t); fn(); }, ms); retries.add(t); };
  const watchDir = (project, repo, dir) => {
    if (closed) return;
    const docs = docsRoot(dir);
    if (!docs) {
      return later(() => { if (docsRoot(dir)) push(project); watchDir(project, repo, dir); }, IDLE_RETRY_MS);
    }
    let w;
    try {
      w = fs.watch(docs, { recursive: true }, (_ev, name) => {
        if (!name || name.endsWith('.tmp') || name.split(path.sep).some((s) => isHidden(s) || s === 'node_modules')) return;
        push(project);
      });
    } catch (e) {
      console.warn(`[plans] ${repo}/docs 감시 실패: ${e.message} — ${RETRY_MS / 1000}초 뒤 다시 시도`);
      return later(() => watchDir(project, repo, dir), RETRY_MS);
    }
    watchers.add(w);
    w.on('error', (e) => {
      w.close(); watchers.delete(w);
      console.warn(`[plans] ${repo}/docs 감시 끊김: ${e.message} — ${RETRY_MS / 1000}초 뒤 다시 시도`);
      push(project);
      later(() => watchDir(project, repo, dir), RETRY_MS);
    });
  };
  for (const project of projectNames()) for (const { repo, dir } of repoDirs(project)) watchDir(project, repo, dir);
  return () => { closed = true; clearTimeout(timer); for (const t of retries) clearTimeout(t); for (const w of watchers) w.close(); };
}
