const fs = require('fs');
const path = require('path');
const { WD, HOME } = require('./paths');

const DIR = path.join(WD, 'data', 'hook-state');
const KEEP_MS = 14 * 86400000;
const RULES = {
  commit: { label: '커밋 · PR', files: [path.join(WD, 'RULES-COMMIT.md')] },
  implement: { label: '항목 시작', files: [path.join(HOME, '.claude', 'CLAUDE-IMPLEMENT.md')] },
  delegate: { label: '위임', files: [path.join(WD, 'RULES-DELEGATE.md'), path.join(HOME, '.claude', 'CLAUDE-DELEGATE.md')] },
};

function prune() {
  try {
    for (const name of fs.readdirSync(DIR)) {
      const f = path.join(DIR, name);
      if (Date.now() - fs.statSync(f).mtimeMs > KEEP_MS) fs.rmSync(f, { force: true });
    }
  } catch {}
}

const sessionOf = (ev) => [ev.session_id, ev.agent_id].filter(Boolean).join('-').replace(/[^\w-]/g, '');

function flag(ev, key) {
  const session = sessionOf(ev);
  if (!session) return null;
  try { return JSON.parse(fs.readFileSync(path.join(DIR, `${session}.json`), 'utf8'))[key] || null; } catch { return null; }
}

function setFlag(ev, key, value) {
  const session = sessionOf(ev);
  if (!session) return false;
  const file = path.join(DIR, `${session}.json`);
  let state = {};
  try { state = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
  try {
    fs.mkdirSync(DIR, { recursive: true });
    if (!fs.existsSync(file)) prune();
    fs.writeFileSync(file, JSON.stringify({ ...state, [key]: value }));
    return true;
  } catch { return false; }
}

function firstTime(ev, key) {
  const session = sessionOf(ev);
  const rule = RULES[key];
  if (!session || !rule) return null;
  const file = path.join(DIR, `${session}.json`);
  let state = {};
  try { state = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
  if (state[key]) return null;
  const texts = [];
  for (const f of rule.files) { try { texts.push(fs.readFileSync(f, 'utf8').trim()); } catch {} }
  if (!texts.length) return null;
  try {
    fs.mkdirSync(DIR, { recursive: true });
    if (!fs.existsSync(file)) prune();
    fs.writeFileSync(file, JSON.stringify({ ...state, [key]: new Date().toISOString() }));
  } catch { return null; }
  return `[work-dash] 이 세션의 첫 ${rule.label}이라 한 번 막고 규칙을 보여 준다. 아래를 읽고 맞게 고친 뒤 다시 실행한다(이 세션에서는 다시 막지 않는다).\n\n${texts.join('\n\n')}`;
}

const TAIL_BYTES = 65536;

function modelOf(ev) {
  try {
    const fd = fs.openSync(String(ev.transcript_path || ''), 'r');
    try {
      const size = fs.fstatSync(fd).size;
      const buf = Buffer.alloc(Math.min(size, TAIL_BYTES));
      fs.readSync(fd, buf, 0, buf.length, size - buf.length);
      const found = [...buf.toString('utf8').matchAll(/"model":"([^"]+)"/g)];
      return found.length ? found[found.length - 1][1] : '';
    } finally { fs.closeSync(fd); }
  } catch { return ''; }
}

module.exports = { firstTime, flag, setFlag, modelOf };
