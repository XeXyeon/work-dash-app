const fs = require('fs');
const path = require('path');
const { WD } = require('./paths');

const FILE = path.join(WD, 'data', 'hook-log.jsonl');
const DAY = 86400000;
const RETRY_MS = 10 * 60000;
const KINDS = { deny: '막음', skip: '건너뜀', unblock: '설정에서 뺌', watch: '지켜봄' };

function record({ kind, check, project, session, text, reason }) {
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    const row = { at: new Date().toISOString(), kind, check, project: project || '(unknown)', session: session || null, text: String(text || '').replace(/\s+/g, ' ').slice(0, 400) };
    if (reason) row.reason = String(reason).slice(0, 300);
    fs.appendFileSync(FILE, `${JSON.stringify(row)}\n`);
  } catch {}
}

function rows(days) {
  let text = '';
  try { text = fs.readFileSync(FILE, 'utf8'); } catch { return []; }
  const since = Date.now() - days * DAY;
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line);
      if (r && KINDS[r.kind] && new Date(r.at).getTime() >= since) out.push(r);
    } catch {}
  }
  return out;
}

function retries(list, kind = 'deny') {
  const last = new Map();
  let n = 0;
  for (const r of list) {
    if (r.kind !== kind || !r.session) continue;
    const key = `${r.session}\n${r.check}`;
    const t = new Date(r.at).getTime();
    if (last.has(key) && t - last.get(key) <= RETRY_MS) n++;
    last.set(key, t);
  }
  return n;
}

function summary(days = 7) {
  const list = rows(days);
  if (!list.length) return [`[check] 지난 ${days}일 동안 훅이 막거나 건너뛴 기록이 없다`];
  const by = new Map();
  for (const r of list) {
    if (!by.has(r.check)) by.set(r.check, []);
    by.get(r.check).push(r);
  }
  const count = (l, kind) => l.filter((r) => r.kind === kind).length;
  const out = [`[check] 지난 ${days}일: 막음 ${count(list, 'deny')} · 건너뜀 ${count(list, 'skip')} · 설정에서 뺌 ${count(list, 'unblock')} · 지켜봄 ${count(list, 'watch')}`];
  const sorted = [...by.entries()].sort((a, b) => b[1].length - a[1].length);
  for (const [check, l] of sorted) {
    const parts = Object.keys(KINDS).map((k) => [KINDS[k], count(l, k)]).filter(([, n]) => n).map(([name, n]) => `${name} ${n}`);
    const again = retries(l);
    const seenAgain = retries(l, 'watch');
    const projects = [...new Set(l.map((r) => r.project))].slice(0, 4).join(' · ');
    out.push(`- ${check}: ${parts.join(' · ')}${again ? ` · 막힌 뒤 같은 검사에 또 막힘 ${again}` : ''}${seenAgain ? ` · 같은 세션에서 10분 안에 되풀이 ${seenAgain}` : ''} (${projects})`);
    const skipped = l.filter((r) => r.kind === 'skip' || r.kind === 'unblock').slice(-3);
    for (const r of skipped) out.push(`    ${r.at.slice(0, 10)} ${KINDS[r.kind]} — 이유: ${r.reason || '(없음)'} / ${r.text.slice(0, 120)}`);
    const sample = l.filter((r) => r.kind === 'deny' || r.kind === 'watch').slice(-1)[0];
    if (sample) out.push(`    최근: ${sample.text.slice(0, 160)}`);
  }
  return out;
}

module.exports = { record, rows, summary, FILE };
