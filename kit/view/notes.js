import fs from 'node:fs';
import path from 'node:path';
import { DIRS } from './workdash.js';

function cardDate(lines, mtime) {
  const status = lines.slice(0, 6).find((l) => l.startsWith('- 상태:'));
  const m = status?.match(/(\d{4})-(\d{2})-(\d{2})(?:\s+(\d{2}):(\d{2}))?/);
  if (!m) return mtime;
  const t = new Date(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0)).getTime();
  return Number.isNaN(t) ? mtime : t;
}

function sections(lines) {
  const notes = [];
  let inSec = false, fence = null, cur = null;
  const flush = () => { if (cur) notes.push({ name: cur.name, body: cur.lines.join('\n').trim() }); cur = null; };
  for (const line of lines) {
    const f = line.match(/^\s{0,3}(`{3,}|~{3,})(.*)$/);
    if (f) {
      if (!fence) fence = { ch: f[1][0], len: f[1].length };
      else if (f[1][0] === fence.ch && f[1].length >= fence.len && !f[2].trim()) fence = null;
    }
    if (!fence && !f) {
      if (/^##\s+/.test(line)) {
        flush();
        inSec = /^##\s+학습 노트\s*$/.test(line);
        if (inSec) cur = { name: null, lines: [] };
        continue;
      }
      if (inSec && /^###\s+/.test(line)) { flush(); cur = { name: line.replace(/^###\s+/, '').trim(), lines: [] }; continue; }
    }
    if (inSec && cur) cur.lines.push(line);
  }
  flush();
  return notes;
}

const isNone = (body) => {
  const ls = body.split('\n').map((l) => l.trim()).filter(Boolean);
  return ls.length === 0 || (ls.length === 1 && ls[0].length < 60 && /없음\s*(\([^)]*\))?\s*[.。]?$/.test(ls[0].replace(/^[-*]\s+/, '')));
};

const cache = new Map();
function parseCard(file, id) {
  let st; try { st = fs.statSync(file); } catch { return null; }
  const c = cache.get(file);
  if (c && c.m === st.mtimeMs) return c.parsed;
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  const title = (lines.find((l) => l.startsWith('# ')) || '').replace(/^#\s+/, '').replace(new RegExp(`^${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*`), '').trim();
  const date = cardDate(lines, st.mtimeMs);
  const secs = sections(lines);
  const named = secs.filter((s) => s.name);
  const notes = (named.length ? named : secs).filter((s) => !isNone(s.body)).map((s) => ({ name: s.name || title || id, body: s.body }));
  const parsed = { id, title, date, notes };
  cache.set(file, { m: st.mtimeMs, parsed });
  return parsed;
}

const keyOf = (name) => name.toLowerCase().replace(/\s+/g, '');

export function getNotes(project) {
  const dir = path.join(DIRS.worklogs, project);
  if (path.dirname(dir) !== DIRS.worklogs) return null;
  let names;
  try { names = fs.readdirSync(dir).filter((n) => n.endsWith('.md')); } catch { return { project, cards: 0, notes: [] }; }
  const cards = names.map((n) => parseCard(path.join(dir, n), n.slice(0, -3))).filter(Boolean).sort((a, b) => b.date - a.date);
  const groups = new Map();
  for (const c of cards) {
    for (const n of c.notes) {
      const k = keyOf(n.name);
      let g = groups.get(k);
      if (!g) groups.set(k, g = { key: k, name: n.name, latest: c.date, entries: [] });
      g.entries.push({ item: c.id, cardTitle: c.title, date: c.date, body: n.body });
    }
  }
  return { project, cards: cards.length, notes: [...groups.values()] };
}
