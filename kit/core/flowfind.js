const fs = require('fs');
const path = require('path');
const { WD } = require('./paths');

const MAX_LINES = 120;
const MAX_SECTIONS = 6;

function sections(project) {
  let text;
  try { text = fs.readFileSync(path.join(WD, 'flows', `${project}.md`), 'utf8'); } catch { return null; }
  const lines = text.split('\n');
  const out = [];
  let fence = false;
  lines.forEach((l, i) => {
    if (l.startsWith('```')) fence = !fence;
    const m = !fence && l.match(/^## (.+)/);
    if (m) out.push({ name: m[1].trim(), from: i + 1, lines: [] });
    if (out.length) out[out.length - 1].lines.push(l);
  });
  for (const s of out) { s.to = s.from + s.lines.length - 1; s.text = s.lines.join('\n'); }
  return out;
}

function variants(term) {
  const t = String(term).trim();
  if (!t) return [];
  const out = new Set([t]);
  if (t.includes('/') || /\.[a-z]{1,5}$/i.test(t)) {
    const base = path.basename(t);
    out.add(base);
    const stem = base.replace(/\.[^.]+$/, '');
    if (stem.length >= 8) out.add(stem);
  }
  return [...out];
}

const ID = /^[A-Z][A-Z0-9]*-\d+(?:#\d+)?$/;
const has = (text, v) => (ID.test(v) ? new RegExp(`(?<![\\w-])${v}(?![\\w-]|#?\\d)`).test(text) : text.includes(v));
const hit = (s, terms) => terms.some((term) => variants(term).some((v) => has(s.text, v)));
const isOverview = (s) => /^전체 구조/.test(s.name);

function related(project, terms) {
  const all = sections(project);
  if (!all) return null;
  return all.filter((s) => !isOverview(s) && hit(s, terms));
}

function body(s) {
  const shown = s.lines.slice(0, MAX_LINES);
  const more = s.lines.length - shown.length;
  return `${shown.join('\n').trimEnd()}${more > 0 ? `\n… ${more}줄 더 — flows/…의 ${s.from + MAX_LINES}~${s.to}줄` : ''}`;
}

function show(project, terms) {
  const all = sections(project);
  const file = `flows/${project}.md`;
  if (!all) return [`흐름 문서가 없다(${file}). 코드를 직접 본다`];
  const titles = all.filter((s) => !isOverview(s)).map((s) => `- ${s.name} (${s.from}~${s.to}줄)`);
  const overview = all.find(isOverview);
  const out = [];
  if (!terms.length) {
    if (overview) out.push(body(overview), '');
    out.push(`${file}의 흐름 절 ${titles.length}개:`, ...titles, '고칠 파일 경로나 항목 ID를 주면 걸리는 절만 보여 준다: `flow <경로|ID>…`');
    return out;
  }
  const found = all.filter((s) => !isOverview(s) && hit(s, terms));
  if (!found.length) return [`${file}에 ${terms.map((t) => `\`${t}\``).join(' · ')}가 걸리는 흐름 절이 없다. 절 목록:`, ...titles];
  if (overview) out.push(body(overview), '');
  for (const s of found.slice(0, MAX_SECTIONS)) out.push(`[${file} ${s.from}~${s.to}줄]`, body(s), '');
  if (found.length > MAX_SECTIONS) out.push(`… 걸리는 절 ${found.length - MAX_SECTIONS}개 더: ${found.slice(MAX_SECTIONS).map((s) => s.name).join(' · ')}`);
  return out;
}

module.exports = { show, related };
