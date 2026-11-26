import fs from 'node:fs';
import path from 'node:path';
import { DIRS } from './workdash.js';

function h2Sections(lines) {
  const out = [];
  let fence = null, cur = null;
  for (const line of lines) {
    const f = line.match(/^\s{0,3}(`{3,}|~{3,})(.*)$/);
    if (f) {
      if (!fence) fence = { ch: f[1][0], len: f[1].length };
      else if (f[1][0] === fence.ch && f[1].length >= fence.len && !f[2].trim()) fence = null;
    }
    if (!fence && !f && /^##\s+/.test(line)) { cur = { head: line.replace(/^##\s+/, '').trim(), lines: [] }; out.push(cur); continue; }
    if (cur) cur.lines.push(line);
  }
  return out;
}

const field = (lines, name) => {
  const l = lines.find((x) => x.replace(/^\s*[-*]\s+/, '').startsWith(`${name}:`));
  return l ? l.slice(l.indexOf(':') + 1).trim() : null;
};
const dateOf = (y, m, d) => { const t = new Date(+y, +m - 1, +d).getTime(); return Number.isNaN(t) ? null : t; };

function readRecords(project) {
  let text;
  try { text = fs.readFileSync(path.join(DIRS.improvements, `${project}.md`), 'utf8'); } catch { return []; }
  return h2Sections(text.split(/\r?\n/)).map((s, i) => {
    const m = s.head.match(/^(\d{4})-(\d{2})-(\d{2})\s+(.*)$/);
    const metric = field(s.lines, '전 → 후') ?? field(s.lines, '전 -> 후');
    return {
      key: `${i}-${s.head}`,
      title: m ? m[4] : s.head,
      date: m ? dateOf(m[1], m[2], m[3]) : null,
      kind: field(s.lines, '종류'),
      metric,
      measured: metric ? (/\(측정\)\s*$/.test(metric) ? 'measured' : /\(어림\)\s*$/.test(metric) ? 'estimate' : null) : null,
      body: s.lines.join('\n').trim(),
    };
  });
}

function cardDate(lines, mtime) {
  const m = lines.slice(0, 6).find((l) => l.startsWith('- 상태:'))?.match(/(\d{4})-(\d{2})-(\d{2})(?:\s+(\d{2}):(\d{2}))?/);
  if (!m) return mtime;
  const t = new Date(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0)).getTime();
  return Number.isNaN(t) ? mtime : t;
}

const cache = new Map();
function parseCard(file, id) {
  let st; try { st = fs.statSync(file); } catch { return null; }
  const c = cache.get(file);
  if (c && c.m === st.mtimeMs) return c.parsed;
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  const title = (lines.find((l) => l.startsWith('# ')) || '').replace(/^#\s+/, '').replace(new RegExp(`^${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*`), '').trim();
  const bodies = h2Sections(lines).filter((s) => /^막혔던 문제와 해결/.test(s.head)).map((s) => s.lines.join('\n').trim())
    .filter((b) => b && !(b.split('\n').length === 1 && b.length < 60 && /없음/.test(b)));
  const parsed = bodies.length ? { item: id, cardTitle: title, date: cardDate(lines, st.mtimeMs), body: bodies.join('\n\n') } : null;
  cache.set(file, { m: st.mtimeMs, parsed });
  return parsed;
}

export function getImprovements(project) {
  const dir = path.join(DIRS.worklogs, project);
  if (path.dirname(dir) !== DIRS.worklogs) return null;
  let names = [];
  try { names = fs.readdirSync(dir).filter((n) => n.endsWith('.md')); } catch { }
  const solved = names.map((n) => parseCard(path.join(dir, n), n.slice(0, -3))).filter(Boolean).sort((a, b) => b.date - a.date);
  return { project, hasFile: fs.existsSync(path.join(DIRS.improvements, `${project}.md`)), records: readRecords(project), solved };
}
