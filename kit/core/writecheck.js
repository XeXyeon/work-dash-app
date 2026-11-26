const path = require('path');
const { HOME } = require('./paths');
const { kindOf, resolveInWd } = require('./doclint');
const { segments, bare } = require('./check');

const TOKEN = /"[^"\n]*"|'[^'\n]*'|[^\s;&|<>"'()]+/g;
const REDIRECT = /(?:^|[^<>&\d])\d?>{1,2}[ \t]*("[^"\n]*"|'[^'\n]*'|[^\s;&|<>()]+)/g;
const MD = /[^\s"'`()<>;|&=,]+\.md\b/g;
const INTERPRETER = /^(?:python3?|node|perl|ruby|deno|bun)$/;
const WRITES = /\bopen\([^)]*,\s*['"][wa]|write_text\(|writeFileSync|appendFileSync|fs\.writeFile|createWriteStream|File\.write/;
const HEREDOC = /<<-?\s*(['"]?)([A-Za-z_][\w]*)\1[^\n]*\n([\s\S]*?)\n[ \t]*\2(?=\s|\)|$)/g;
const CLI = 'node ~/.work-dash/app/core/item.js';

const unquote = (v) => (/^(['"]).*\1$/s.test(v) ? v.slice(1, -1) : v);
const expand = (v) => v.replace(/^~(?=\/|$)/, HOME).replace(/^\$(?:HOME|\{HOME\})(?=\/|$)/, HOME);

function docOf(token, cwd) {
  const v = expand(unquote(token));
  if (!v.endsWith('.md')) return null;
  const abs = resolveInWd(path.resolve(cwd || process.cwd(), v));
  return kindOf(abs) ? abs : null;
}

function target(command, flat, cwd) {
  let dir = path.resolve(cwd || process.cwd());
  const stdin = [...command.matchAll(HEREDOC)].map((m) => m[3]).join('\n');
  for (const raw of segments(flat)) {
    for (const m of raw.matchAll(REDIRECT)) {
      const doc = docOf(m[1], dir);
      if (doc) return doc;
    }
    const words = (bare(raw).match(TOKEN) || []).map(unquote);
    const tool = path.basename(words[0] || '');
    const args = words.slice(1);
    if (tool === 'cd' && args[0]) { dir = path.resolve(dir, expand(args[0])); continue; }
    const docs = args.map((a) => docOf(a, dir)).filter(Boolean);
    if (tool === 'tee' && docs.length) return docs[0];
    if ((tool === 'sed' || tool === 'perl') && docs.length && args.some((a) => /^-[a-zA-Z]*i|^--in-place/.test(a))) return docs[0];
    if ((tool === 'cp' || tool === 'mv') && args.length > 1) { const d = docOf(args[args.length - 1], dir); if (d) return d; }
    if (INTERPRETER.test(tool)) {
      const code = `${raw}\n${stdin}`;
      if (WRITES.test(code)) for (const m of code.matchAll(MD)) { const d = docOf(m[0], dir); if (d) return d; }
    }
  }
  return null;
}

function writeProblem(command, flat, cwd) {
  if (!/\.md\b/.test(command)) return null;
  const doc = target(command, flat, cwd);
  if (!doc) return null;
  const rel = path.basename(path.dirname(doc)) + '/' + path.basename(doc);
  return `[work-dash] 명령을 막았다: 셸로 \`${rel}\`를 고친다. 로드맵 · 이슈 · 작업 카드는 셸로 쓰면 형식 검사가 돌지 않는다 → 상태 · 새 항목 · 카드의 절은 \`${CLI}\`(\`--help\`), 그 밖의 줄은 Edit · Write 도구로 고친다`;
}

module.exports = { writeProblem };
