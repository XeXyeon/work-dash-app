#!/usr/bin/env node
// Claude Code · Codex PreToolUse 훅(Bash): git commit · gh pr create 직전에 메시지를 보고, 걸리면 명령을 막는다.
// 메시지가 괜찮으면 PR 만들기만 사용자 승인을 묻는다(Codex는 훅의 묻기를 지원하지 않아 묻지 않는다). 커밋 · 푸시 · 병합 · 항목 추가는 묻지 않는다.
// 검사가 틀렸으면 명령 앞에 WD_SKIP="<이유>"를 붙여 지나간다. 그때 훅이 사용자에게 알린다. 막은 것과 건너뛴 것은 data/hook-log.jsonl에 적는다.
// 푸시는 설정에 fullBeforePush가 있는 저장소에서 전체 확인이 통과한 커밋만 지나간다. 로드맵 · 이슈 · 작업 카드를 셸로 쓰는 명령은 막는다.
// 세션의 첫 커밋은 한 번 막으면서 커밋 규칙을 돌려준다. 승인을 묻는 명령은 config.json의 ask로 바꾼다(기본: PR 만들기).
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { buildIndex } = require('./doclint');
const { HOME, REAL_HOME, WD } = require('./paths');
const { projectName } = require('./scope');
const { bashProblem, OPEN_KEY, OPEN_HOW } = require('./readcheck');
const { blockProblem, segments, bare, pushGate } = require('./check');
const { writeProblem } = require('./writecheck');
const { record } = require('./hooklog');
const { firstTime, flag, setFlag, modelOf } = require('./oncerule');

const HEAD = '(?:^|[\\s;&|("\'`])';
const TAIL = '(?=\\s|$|[;&|)"\'`])';
const VAL = '(?:"[^"]*"|\'[^\']*\'|[^\\s"\']\\S*)';
const GIT_SUB = (sub) => new RegExp(`${HEAD}(?:\\S*/)?git((?:\\s+(?:-[Cc]\\s+${VAL}|--(?:git-dir|work-tree|namespace|exec-path)\\s+${VAL}|--[\\w-]+(?:=\\S+)?|-[A-Za-z]))*)\\s+${sub}${TAIL}`);
const REPO_FLAG = `(?:\\s+(?:-R|--repo)(?:=|\\s+)${VAL})?`;
const GH_PR = (sub) => new RegExp(`${HEAD}(?:\\S*/)?gh${REPO_FLAG}\\s+pr${REPO_FLAG}\\s+${sub}${TAIL}`);
const COMMIT_RE = GIT_SUB('commit');
const ITEM_START_RE = /\bitem\.js\s+start\s/;
const PR_RE = GH_PR('create');
const PUSH_RE = GIT_SUB('push');
const ASK_KINDS = { pr: [PR_RE, 'PR 만들기'], push: [PUSH_RE, '푸시'], commit: [COMMIT_RE, '커밋'], merge: [GH_PR('merge'), 'PR 병합'] };
const ASK_DEFAULT = ['pr'];
const PUSH_OTHER = /^(?:--delete|-d|--tags|--mirror|--all|--dry-run|-n|--prune)$/;
const PUSH_VALUE = /^(?:-o|--push-option|--repo|--receive-pack|--exec)$/;
const REDIRECTS = /\d*>{1,2}&?[ \t]*[^\s;&|]*/g;
const MARK = /WD_SKIP=(?:"([^"\n]*)"|'([^'\n]*)'|[^\s;&|"']*)[ \t]+/y;
const SKIP_HOW = '검사가 틀리게 막았으면 명령 앞에 `WD_SKIP="<이유>"`를 붙여 다시 실행한다(건너뛴 것은 훅이 사용자에게 알린다).';
const UNBLOCK_RE = /^(?:node\s+)?\S*check\.js\s.*--unblock\s+("[^"]*"|'[^']*'|\S+)/;
const MAX_COMMAND = 100000;
const ID_RE = /(?<![\w:.#-])(?:[A-Za-z][A-Za-z0-9_]*:)?([A-Z][A-Z0-9]*-\d+(?:#\d+)?)(?![\w-])/g;
const CONVENTIONAL = /^([a-z]+)(\([^)]*\))?!?: \S/;
const GIT_MADE = /^(Revert "|Merge |fixup! |squash! |amend! )/;
const HEREDOC_RE = /<<-?\s*(['"]?)([A-Za-z_][\w]*)\1[^\n]*\n([\s\S]*?)\n[ \t]*\2(?=\s|\)|$)/g;
const RECENT = 30;
const HISTORY = 200;
const MIN_COMMITS = 5;
const FOLLOW_RATIO = 0.8;

function unquote(v) {
  if (v.startsWith("'") && v.endsWith("'")) return v.slice(1, -1);
  if (v.startsWith('"') && v.endsWith('"')) return v.slice(1, -1).replace(/\\(["\\$`])/g, '$1');
  return v;
}

const expand = (p, cwd) => path.resolve(cwd || process.cwd(), p.replace(/^~(?=\/|$)/, HOME));

function heredocs(command, from) {
  return [...command.matchAll(HEREDOC_RE)].filter((m) => m.index > from).map((m) => m[3]);
}

const blankHeredocs = (command) => command.replace(HEREDOC_RE, (all, q, tag, body) => all.replace(body, ' '.repeat(body.length)));

function flagValues(command, from, flags) {
  const out = [];
  const re = new RegExp(`(?:^|\\s)(?:${flags})(?:=|\\s+|(?=["']))("(?:[^"\\\\]|\\\\.)*"|'[^']*'|[^\\s;&|]+)`, 'g');
  re.lastIndex = from;
  let m;
  while ((m = re.exec(command))) {
    const v = unquote(m[1]);
    if (!v.includes('<<')) out.push(v);
  }
  return out;
}

const readText = (f, dir) => { try { return fs.readFileSync(expand(f, dir), 'utf8'); } catch { return null; } };

function messages(command, kind, at, dir) {
  const msgFlags = kind === 'commit' ? '-[a-zA-Z]*m|--message' : '-t|--title|-b|--body';
  const fileFlags = kind === 'commit' ? '-F|--file' : '-F|--body-file';
  const flat = blankHeredocs(command);
  const inline = [], files = [];
  let fromCommand = false;
  for (const v of flagValues(flat, at, msgFlags)) {
    const cat = v.match(/^\$\(\s*cat\s+("[^"]*"|'[^']*'|[^\s)]+)\s*\)$/);
    if (cat) { const t = readText(unquote(cat[1]), dir); if (t != null) files.push(t); fromCommand = true; }
    else if (v.startsWith('$')) fromCommand = true;
    else inline.push(v);
  }
  for (const f of flagValues(flat, at, fileFlags)) {
    if (f === '-') continue;
    const t = readText(f, dir);
    if (t != null) files.push(t);
    fromCommand = true;
  }
  const docs = heredocs(command, at);
  const all = [...inline, ...docs, ...files];
  if (fromCommand) all.push(command.slice(0, at));
  return { inline, docs, files, all };
}

function subjectOf({ inline, docs, files }) {
  for (const t of [...inline, ...docs, ...files]) {
    const line = t.split('\n').map((l) => l.trim()).find((l) => l && !l.startsWith('#'));
    if (line) return GIT_MADE.test(line) ? null : line;
  }
  return null;
}

function repoDir(command, at, globals, cwd) {
  const c = globals.match(/-C\s+("[^"]*"|'[^']*'|\S+)/);
  if (c) return expand(unquote(c[1]), cwd);
  const cds = [...command.slice(0, at).matchAll(/(?:^|[;&|(]\s*)cd\s+("[^"]*"|'[^']*'|[^\s;&|]+)\s*(?:&&|;)/g)];
  if (cds.length) return expand(unquote(cds[cds.length - 1][1]), cwd);
  return cwd || process.cwd();
}

function gitSubjects(dir, n) {
  try {
    return execFileSync('git', ['-C', dir, 'log', `-${n}`, '--no-merges', '--format=%s'], { encoding: 'utf8', timeout: 4000, stdio: ['ignore', 'pipe', 'ignore'] })
      .split('\n').filter(Boolean);
  } catch { return []; }
}

function prefixProblem(subject, dir) {
  const recent = gitSubjects(dir, RECENT);
  if (recent.length < MIN_COMMITS) return null;
  const typed = recent.filter((s) => CONVENTIONAL.test(s)).length;
  const m = subject.match(CONVENTIONAL);
  if (typed / recent.length >= FOLLOW_RATIO) {
    const types = [...new Set(gitSubjects(dir, HISTORY).map((s) => (s.match(CONVENTIONAL) || [])[1]).filter(Boolean))];
    if (!m) return `이 저장소는 최근 커밋 ${recent.length}개 중 ${typed}개가 \`종류: 제목\` 머리말을 쓴다. 제목 "${subject}"에 머리말이 없다 → 제목 앞에 ${types.map((t) => `\`${t}:\``).join(' · ')} 가운데 맞는 것을 붙인다`;
    if (!types.includes(m[1])) return `머리말 \`${m[1]}:\`는 이 저장소의 최근 커밋 ${HISTORY}개에서 쓴 적이 없다 → ${types.map((t) => `\`${t}:\``).join(' · ')} 가운데 맞는 것으로 바꾼다`;
    return null;
  }
  if (typed === 0 && m) return `이 저장소의 최근 커밋 ${recent.length}개는 머리말을 쓰지 않는다. 제목의 \`${m[0].replace(/ \S$/, '')}\`를 지운다 → 최근 커밋처럼 무엇을 했는지만 한 줄로 쓴다`;
  return null;
}

const EMPTY_SUBJECT = /^(?:(?:수정(?:함|했음|했다)?|변경|작업|기타|임시|wip\d*|update|updates|fix|fixes|misc|minor|temp\d*|tmp\d*|etc)[\s.!…]*|[.…]+)$/i;

function emptyProblem(subject) {
  const body = subject.replace(/^[a-z]+(?:\([^)]*\))?!?:\s*/, '').trim();
  if (!EMPTY_SUBJECT.test(body)) return null;
  return `제목 "${subject}"만으로는 무엇을 바꿨는지 알 수 없다 → 무엇을 했는지 한 줄로 쓴다(예: \`공유 링크 만료 시각을 7일로 고침\`)`;
}

function knownIds() {
  const ids = new Set();
  for (const p of buildIndex().values()) { for (const x of p.items) ids.add(x); for (const x of p.issues) ids.add(x); }
  return ids;
}

function idProblem(texts) {
  const ids = knownIds();
  const found = new Set();
  for (const t of texts) for (const m of t.matchAll(ID_RE)) if (ids.has(m[1]) || ids.has(m[1].split('#')[0])) found.add(m[0]);
  if (!found.size) return null;
  return `메시지에 개인 로드맵 · 이슈 ID ${[...found].map((x) => `\`${x}\``).join(' · ')}가 있다. 저장소를 보는 사람은 개인 로드맵을 열 수 없다 → ID와 \`Roadmap:\` · \`로드맵:\` 줄을 지우고, 무엇을 왜 바꿨는지를 글로 쓴다. 커밋과 항목의 연결은 작업 카드의 \`바뀐 것\`에 커밋 해시로 남긴다`;
}

const PERSONAL_DOC_RE = /(?<![\w.\/-])((?:~\/|\$HOME\/|\$\{HOME\}\/)?\.work-dash\/(?:roadmaps|issues|worklogs|flows|improvements)\/[^\s"'`)<]+)/g;
const PATH_END = /[\s"'`)\]}>,;]/;

function pathProblem(texts) {
  const found = new Set();
  const homes = [...new Set([HOME, REAL_HOME])].filter((h) => h && h.length > 1);
  for (const t of texts) {
    for (const home of homes) {
      for (let i = t.indexOf(home + '/'); i !== -1; i = t.indexOf(home + '/', i + 1)) {
        if (i > 0 && /[\w.-]/.test(t[i - 1])) continue;
        const rest = t.slice(i);
        const end = rest.search(PATH_END);
        found.add(end === -1 ? rest : rest.slice(0, end));
      }
    }
    for (const m of t.matchAll(PERSONAL_DOC_RE)) found.add(m[1]);
  }
  if (!found.size) return null;
  return `메시지에 내 컴퓨터의 경로 ${[...found].slice(0, 3).map((x) => `\`${x}\``).join(' · ')}가 있다. 내 홈 폴더 경로나 개인 로드맵 · 카드 파일이라 저장소를 보는 사람은 열 수 없다 → 저장소 기준 경로(\`src/…\`)로 바꾸거나 지운다`;
}

function check(command, cwd) {
  const problems = [];
  const commit = command.match(COMMIT_RE);
  const pr = command.match(PR_RE);
  if (commit) {
    const at = commit.index + commit[0].length;
    const dir = repoDir(command, commit.index, commit[1] || '', cwd);
    const msg = messages(command, 'commit', at, dir);
    const p = idProblem(msg.all);
    if (p) problems.push(p);
    const h = pathProblem([...msg.inline, ...msg.docs, ...msg.files]);
    if (h) problems.push(h);
    const subject = subjectOf(msg);
    const q = subject && prefixProblem(subject, dir);
    if (q) problems.push(q);
    const e = subject && emptyProblem(subject);
    if (e) problems.push(e);
  }
  if (pr) {
    const msg = messages(command, 'pr', pr.index + pr[0].length, repoDir(command, pr.index, '', cwd));
    const p = idProblem(msg.all);
    if (p) problems.push(`PR ${p}`);
    const h = pathProblem([...msg.inline, ...msg.docs, ...msg.files]);
    if (h) problems.push(`PR ${h}`);
  }
  return problems;
}

function askKinds() {
  try {
    const list = JSON.parse(fs.readFileSync(path.join(WD, 'config.json'), 'utf8')).ask;
    if (Array.isArray(list)) return list.filter((k) => ASK_KINDS[k]);
  } catch {}
  return ASK_DEFAULT;
}

function asks(command) {
  const flat = blankHeredocs(command);
  return askKinds().map((k) => ASK_KINDS[k]).filter(([re]) => re.test(flat)).map(([, name]) => name);
}

function pushProblem(flat, cwd) {
  const m = flat.match(PUSH_RE);
  if (!m) return null;
  const dir = repoDir(flat, m.index, m[1] || '', cwd);
  const words = (flat.slice(m.index + m[0].length).replace(REDIRECTS, ' ').split(/[;&|\n]/)[0].match(/"[^"]*"|'[^']*'|\S+/g) || []).map(unquote);
  if (words.some((w) => PUSH_OTHER.test(w))) return null;
  const refs = words.filter((w, i) => !w.startsWith('-') && !PUSH_VALUE.test(words[i - 1] || ''));
  if (refs.length > 2) return null;
  if (refs[1]) {
    const src = refs[1].replace(/^\+/, '').split(':')[0];
    let branch = '';
    try { branch = execFileSync('git', ['-C', dir, 'rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8', timeout: 4000, stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch {}
    if (src !== 'HEAD' && src !== branch) return null;
  }
  return pushGate(dir);
}

const isCodex = (ev) => ev.turn_id != null || /\/\.codex\//.test(String(ev.transcript_path || ''));

function skipMarks(text) {
  const out = [];
  let q = null;
  let start = true;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '\\' && q === '"') i++;
      else if (ch === q) q = null;
      continue;
    }
    if (start && ch === 'W') {
      MARK.lastIndex = i;
      const m = MARK.exec(text);
      if (m) { out.push({ start: i, end: MARK.lastIndex, reason: (m[1] || m[2] || '').trim() }); i = MARK.lastIndex - 1; continue; }
    }
    if (ch === '"' || ch === "'") { q = ch; start = false; } else if (';&|(\n'.includes(ch)) start = true;
    else if (ch !== ' ' && ch !== '\t') start = false;
  }
  return out;
}

const log = (ev, kind, check, text, reason) => record({ kind, check, project: projectName(ev.cwd), session: ev.session_id, text, reason });

function skip(ev, reason, found) {
  for (const f of found) log(ev, 'skip', f.check, f.text, reason);
  const problem = found.map((f) => f.text).join(' / ');
  return `[work-dash] 에이전트가 검사를 건너뛰었다 — 이유: ${reason.slice(0, 200)}\n건너뛴 검사: ${problem.replace(/\s+/g, ' ').slice(0, 240)}`;
}

const READ_ALL_RE = /\bcheck\.js\s+--read-all(?:\s+(?:"([^"\n]*)"|'([^'\n]*)'))?/;

function openReads(ev, flat) {
  const m = flat.match(READ_ALL_RE);
  if (!m) return null;
  const why = (m[1] || m[2] || '').trim();
  if (!why) return { deny: '[work-dash] 명령을 막았다: `--read-all`에는 이유가 필요하다 → `check.js --read-all "<왜 전체를 봐야 하는지>"`' };
  if (!setFlag(ev, OPEN_KEY, { at: new Date().toISOString(), reason: why.slice(0, 300) })) return null;
  log(ev, 'skip', 'read-doc', '이 세션의 통째 읽기를 열었다', why);
  return { note: `[work-dash] 에이전트가 이 세션의 문서 통째 읽기를 열었다 — 이유: ${why.slice(0, 200)}` };
}

const deny = (text) => ({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: text } });

function main(ev) {
  if (ev.tool_name !== 'Bash') return null;
  const raw = ev.tool_input && ev.tool_input.command;
  const typed = Array.isArray(raw) ? (raw.length > 2 && /^-l?c$/.test(raw[1]) ? raw.slice(2) : raw).join(' ') : String(raw || '');
  if (typed.length > MAX_COMMAND) return null;
  const marks = skipMarks(blankHeredocs(typed));
  const reason = (marks.find((m) => m.reason) || {}).reason || '';
  let command = typed;
  for (const m of [...marks].reverse()) command = command.slice(0, m.start) + command.slice(m.end);
  const flat = blankHeredocs(command);
  const notes = [];
  const skipped = [];
  let dump = null;
  const opened = openReads(ev, flat);
  if (opened && opened.deny) return deny(opened.deny);
  if (opened) notes.push(opened.note);
  const open = Boolean(flag(ev, OPEN_KEY));
  for (const [name, find] of [['read-dump', () => bashProblem(command, ev.cwd, (file, kb) => log(ev, 'watch', 'big-dump', `${kb}KB ${path.extname(file) || '(확장자 없음)'} 파일을 통째로 내보냄`))], ['doc-write', () => writeProblem(command, flat, ev.cwd)], ['block-command', () => blockProblem(flat, ev.cwd)], ['push-full', () => pushProblem(flat, ev.cwd)]]) {
    let text = null;
    try { text = find(); } catch {}
    if (text && name === 'read-dump' && open) continue;
    if (text) { dump = { check: name, text }; break; }
  }
  if (dump && !reason) { log(ev, 'deny', dump.check, dump.text); return deny(`${dump.text}\n${dump.check === 'read-dump' ? `${OPEN_HOW}\n` : ''}${SKIP_HOW}`); }
  if (dump) skipped.push(dump);
  if (flat.includes('--unblock')) {
    for (const seg of segments(flat).map(bare)) {
      const un = seg.match(UNBLOCK_RE);
      if (un) notes.push(`[work-dash] 에이전트가 확인 설정에서 막는 명령을 뺀다: ${un[1].slice(0, 200)}`);
    }
  }
  let problems = [];
  if (/\bcommit\b|\bgh\s/.test(command)) { try { problems = check(command, ev.cwd); } catch {} }
  const rules = COMMIT_RE.test(flat) || PR_RE.test(flat) ? firstTime(ev, 'commit') : ITEM_START_RE.test(flat) && /sonnet/i.test(modelOf(ev)) ? firstTime(ev, 'implement') : null;
  if (problems.length && !reason) { log(ev, 'deny', 'message', problems.join(' / ')); return deny(`[work-dash] 명령을 막았다:\n${problems.map((p) => `- ${p}`).join('\n')}\n메시지를 고쳐 다시 실행한다. ${SKIP_HOW}${rules ? `\n\n${rules}` : ''}`); }
  if (rules) return deny(rules);
  if (problems.length) skipped.push({ check: 'message', text: problems.join(' / ') });
  if (skipped.length) notes.push(skip(ev, reason, skipped));
  const what = [...new Set(asks(command))];
  const out = {};
  if (notes.length) out.systemMessage = notes.join('\n');
  if (what.length && !isCodex(ev)) out.hookSpecificOutput = { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: `[work-dash] ${what.join(' · ')}: 사용자가 승인해야 실행된다.` };
  return Object.keys(out).length ? out : null;
}

if (require.main === module) {
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (c) => { input += c; });
  process.stdin.on('end', () => {
    try {
      const out = input.trim() ? main(JSON.parse(input)) : null;
      if (out) process.stdout.write(JSON.stringify(out));
    } catch {}
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 8000);
}

module.exports = { main, check, asks };
