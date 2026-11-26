#!/usr/bin/env node
// work-dash 설치 · 제거 (WEB-52 · WEB-53). 정의는 WEB-49 카드의 "init이 하는 일" 표.
//
//   npm run init                 바꿀 내용을 보여 주고, 터미널이면 적용할지 묻는다 (터미널이 아니면 미리 보기만)
//   npm run init -- --yes        묻지 않고 적용한다 (같은 이름의 명령 · 스킬이 있으면 그것만 건너뛴다)
//   npm run init -- --links      폴더 · 링크만 만든다. 훅과 규칙 줄은 넣지 않는다(설정 파일을 닷파일 도구가 관리할 때. 훅은 bin/hooks.js로 맞춘다)
//   npm run uninstall            init이 넣은 것만 되돌릴 내용을 보여 주고 묻는다
//   npm run uninstall -- --yes   묻지 않고 되돌린다
//
// 지키는 것
// - 고치는 파일은 모두 먼저 백업한다(~/.work-dash/backup-init-<시각>/, HOME 기준 상대 경로). 바뀌는 것이 없으면 백업 폴더도 만들지 않는다.
// - 넣은 것은 ~/.work-dash/data/install.json에 적는다. uninstall은 여기 적힌 것만 되돌린다.
// - 같은 이름의 명령 · 스킬이 있으면 묻는다. 전에 init이 만든 링크 그대로면 묻지 않고 지금 저장소로 바꾼다.
// - 두 번 돌려도 결과가 같다: 이미 있는 것은 "이미 있음"으로 건너뛴다.
// - settings.json의 env · 권한 등 훅이 아닌 값은 읽어서 그대로 다시 쓸 뿐 화면에 내지 않는다.
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import crypto from 'node:crypto';
import readline from 'node:readline';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CLAUDE_HOOKS, CODEX_HOOKS, hookCmd } from './hooks.js';

const REPO = fs.realpathSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));
const { HOME, REAL_HOME, WD } = createRequire(import.meta.url)('../core/paths.js');
const CLAUDE = path.join(HOME, '.claude');
const CODEX = process.env.CODEX_HOME || path.join(HOME, '.codex');
const MANIFEST = path.join(WD, 'data', 'install.json');
const pad = (n) => String(n).padStart(2, '0');
let BACKUP_DIR;
function startRun() {
  const now = new Date();
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  BACKUP_DIR = path.join(WD, `backup-init-${stamp}`);
  for (let n = 2; lstat(BACKUP_DIR); n++) BACKUP_DIR = path.join(WD, `backup-init-${stamp}-${n}`);
}

const DATA_DIRS = ['roadmaps', 'issues', 'flows', 'worklogs', 'improvements', 'interview', 'data'];
const DOCS = fs.readdirSync(path.join(REPO, 'rules')).filter((n) => n.endsWith('.md')).sort();
const COMMANDS = ['roadmap', 'issue', 'flows', 'interview'];
const SKILLS = ['end'];
const CODEX_SKILLS = ['roadmap', 'issue', 'flows', 'interview'];

const CLAUDE_LINE = '@~/.work-dash/RULES.md';
const CODEX_LINE = '**work-dash 공통 규칙:** 세션을 시작하면 `~/.work-dash/RULES.md`(Claude · GPT 공통 작업 규칙)를 읽고 따른다.';

const tilde = (p) => (p === HOME || p.startsWith(HOME + path.sep) ? '~' + p.slice(HOME.length) : p);
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const shaOf = (file) => { try { return sha(fs.readFileSync(file)); } catch { return null; } };
const lstat = (p) => { try { return fs.lstatSync(p); } catch { return null; } };
const readLink = (p) => { try { return fs.readlinkSync(p); } catch { return null; } };
const sameMatcher = (a, b) => (a || '') === (b || '');
const exists = (p) => { try { fs.statSync(p); return true; } catch { return false; } };
startRun();

function writeAtomic(file, text) {
  let real = file, mode = null;
  try { real = fs.realpathSync(file); mode = fs.statSync(real).mode & 0o7777; } catch {}
  const tmp = `${real}.init-${process.pid}.tmp`;
  fs.writeFileSync(tmp, text, mode == null ? undefined : { mode });
  if (mode != null) fs.chmodSync(tmp, mode);
  fs.renameSync(tmp, real);
}

function readManifest() {
  if (!lstat(MANIFEST)) return null;
  try { return JSON.parse(fs.readFileSync(MANIFEST, 'utf8')); } catch (e) {
    throw new Error(`${tilde(MANIFEST)}을 읽지 못했다(${e instanceof SyntaxError ? 'JSON 형식 오류' : e.message}). 이 기록이 있어야 넣은 것만 되돌릴 수 있어 멈춘다. 파일을 고치거나 옮긴 뒤 다시 돌린다`);
  }
}
function emptyManifest() {
  return { version: 1, repo: REPO, files: {}, links: {}, dirs: [] };
}

function backupPath(file) {
  const rel = file.startsWith(HOME + path.sep) ? file.slice(HOME.length + 1) : file.replace(/^\/+/, '');
  return path.join(BACKUP_DIR, rel);
}

function backup(file, move) {
  const dest = backupPath(file);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  if (move) fs.renameSync(file, dest);
  else fs.copyFileSync(file, dest);
  return dest;
}

function mkdirTracked(dir, m) {
  const made = [];
  let d = dir;
  while (!lstat(d)) { made.unshift(d); d = path.dirname(d); }
  for (const x of made) { fs.mkdirSync(x); if (!m.dirs.includes(x)) m.dirs.push(x); }
}

function originalFor(m, file) {
  const f = m.files[file];
  const exists = !!lstat(file);
  if (!f) return exists ? backup(file, false) : 'absent';
  if (exists && shaOf(file) !== f.sha) { f.userEdited = true; backup(file, false); }
  return f.original;
}

function recordFile(m, file, original, inserted) {
  const f = m.files[file] || (m.files[file] = { original, inserted: { hooks: [], lines: [], keys: [] } });
  for (const k of Object.keys(inserted)) for (const v of inserted[k]) {
    if (!f.inserted[k].some((x) => JSON.stringify(x) === JSON.stringify(v))) f.inserted[k].push(v);
  }
  f.sha = shaOf(file);
}

function planDataDir() {
  const items = [];
  for (const d of ['', ...DATA_DIRS]) {
    const p = path.join(WD, d);
    if (lstat(p)) items.push({ mark: '=', text: tilde(p) + '/' });
    else items.push({ mark: '+', text: tilde(p) + '/', apply: (m) => mkdirTracked(p, m) });
  }
  const cfg = path.join(WD, 'config.json');
  if (lstat(cfg)) items.push({ mark: '=', text: tilde(cfg) });
  else {
    const repoRoot = REPO.includes('/.claude/worktrees/') ? REPO.slice(0, REPO.indexOf('/.claude/worktrees/')) : REPO;
    const include = [tilde(path.dirname(repoRoot)) + '/*'];
    const text = JSON.stringify({
      _설명: "work-dash가 기록할 작업 폴더. 'X/*'는 X 아래 하위 폴더만 (X 자체는 제외). 이 밖에서 연 Claude·GPT 세션은 기록하지 않는다.",
      include,
      recentHours: 24,
      projects: {},
    }, null, 2) + '\n';
    items.push({
      mark: '+', text: `${tilde(cfg)} (기록 범위: ${include.join(', ')})`,
      apply: (m) => { mkdirTracked(WD, m); writeAtomic(cfg, text); recordFile(m, cfg, 'absent', {}); },
    });
  }
  return { title: '데이터 폴더와 기본 config.json', items };
}

function planLink(linkPath, target, { ask = false } = {}) {
  const st = lstat(linkPath);
  const label = `${tilde(linkPath)} → ${tilde(target)}`;
  const make = (m, how) => {
    mkdirTracked(path.dirname(linkPath), m);
    let backupFile = null, oldLink = null;
    if (how === 'file') backupFile = backup(linkPath, true);
    if (how === 'link') { oldLink = readLink(linkPath); fs.unlinkSync(linkPath); }
    fs.symlinkSync(target, linkPath);
    const prev = m.links[linkPath];
    m.links[linkPath] = prev && prev.target === target ? prev : { target, backup: backupFile, oldLink };
  };
  if (!st) return { mark: '+', text: label, apply: (m) => make(m, null) };
  if (st.isSymbolicLink()) {
    const cur = readLink(linkPath);
    if (path.resolve(path.dirname(linkPath), cur) === target) return { mark: '=', text: label };
    const gone = exists(linkPath) ? '' : ', 그 자리에 아무것도 없다';
    if (ask) return { mark: '?', text: `${label} (지금은 다른 곳 ${tilde(cur)}을 가리키는 링크${gone})`, apply: (m) => make(m, 'link') };
    return { mark: '~', text: `${label} (지금 링크 ${tilde(cur)}을 바꾼다${gone})`, apply: (m) => make(m, 'link') };
  }
  if (st.isDirectory()) return { mark: '!', text: `${label} — 같은 이름의 폴더가 있다. 옮기거나 지운 뒤 다시 돌린다` };
  if (ask) return { mark: '?', text: `${label} (같은 이름의 파일이 있다. 바꾸면 백업한다)`, apply: (m) => make(m, 'file') };
  return { mark: '~', text: `${label} (지금 파일은 백업한다)`, apply: (m) => make(m, 'file') };
}

function planLinks() {
  const app = path.join(WD, 'app');
  let appReal = null;
  try { appReal = fs.realpathSync(app); } catch {}
  const items = [appReal === REPO && !lstat(app).isSymbolicLink() ? { mark: '=', text: `${tilde(app)}/ (저장소가 이 자리에 있다)` } : planLink(app, REPO)];
  for (const n of DOCS) items.push(planLink(path.join(WD, n), path.join(REPO, 'rules', n)));
  return { title: '문서 링크 · app 링크', items };
}

function findHook(groups, h) {
  let stale = null;
  for (const g of groups || []) {
    if (!sameMatcher(g.matcher, h.matcher)) continue;
    for (const x of g.hooks || []) {
      const c = typeof x.command === 'string' ? x.command : '';
      if (c.includes(`.work-dash/app/core/${h.script}`)) {
        if (c === hookCmd(h.script)) return { kind: 'same', hook: x };
        stale = stale || { kind: 'stale', hook: x };
      } else if (new RegExp(`\\.work-dash/${h.script.replace('.', '\\.')}`).test(c)) return { kind: 'old', hook: x };
    }
  }
  return stale;
}

function hookScriptPath(cmd, script) {
  const esc = script.replace('.', '\\.');
  const m = cmd.match(new RegExp(`"([^"]*\\.work-dash/app/core/${esc})"|(\\S*\\.work-dash/app/core/${esc})`));
  const raw = (m?.[1] ?? m?.[2])?.replace(/^(\$HOME|\$\{HOME\}|~)(?=\/)/, HOME);
  return raw && raw.startsWith('/') && !raw.includes('$') ? raw : null;
}
function hookNodePath(cmd) {
  const m = cmd.match(/^\s*(?:"([^"]+)"|(\S+))/);
  const p = m?.[1] ?? m?.[2];
  return p && p.startsWith('/') ? p : null;
}

function planHooks(file, hooks, title, appFix = false, server = false) {
  const items = [];
  let json = {};
  const st = lstat(file);
  if (st) {
    try { json = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {
      return { title, items: [{ mark: '!', text: `${tilde(file)}을 JSON으로 읽지 못했다. 손으로 고친 뒤 다시 돌린다` }] };
    }
    if (!json || typeof json !== 'object' || Array.isArray(json) || (json.hooks != null && typeof json.hooks !== 'object')) {
      return { title, items: [{ mark: '!', text: `${tilde(file)}의 모양이 예상과 다르다(hooks가 객체가 아님). 손으로 확인한다` }] };
    }
  }
  const todo = [];
  for (const h of hooks) {
    const where = `${h.event}${h.matcher ? ` [${h.matcher.length > 30 ? h.matcher.slice(0, 30) + '…' : h.matcher}]` : ''} → ${h.script}`;
    const found = findHook(json.hooks?.[h.event], h);
    const cmd = typeof found?.hook?.command === 'string' ? found.hook.command : '';
    const nodePath = found && found.kind !== 'old' ? hookNodePath(cmd) : null;
    const nodeGone = !!nodePath && !exists(nodePath);
    if (server && found?.kind === 'stale' && nodePath && !nodeGone
      && (cmd === `${nodePath} "$HOME/.work-dash/app/core/${h.script}"` || cmd === `"${nodePath}" "$HOME/.work-dash/app/core/${h.script}"`)) {
      found.kind = 'same';
    }
    const scriptPath = found?.kind === 'same' ? hookScriptPath(cmd, h.script) : null;
    const scriptGone = !!scriptPath && !exists(scriptPath);
    const willExist = exists(appFix ? path.join(REPO, 'core', h.script) : path.join(HOME, '.work-dash', 'app', 'core', h.script));
    if (found?.kind === 'same' && scriptGone) {
      if (appFix && willExist) items.push({ mark: '~', text: `${where} (부르는 스크립트가 없다. 위의 app 링크를 고치면 풀린다)` });
      else items.push({ mark: '!', text: `${where} — 부르는 스크립트 ${tilde(scriptPath)}가 없다. ~/.work-dash/app 링크와 저장소의 core/ 폴더를 확인한다` });
    } else if (found?.kind === 'same') items.push({ mark: '=', text: where });
    else if (found?.kind === 'old') items.push({ mark: '=', text: `${where} (예전 경로 ~/.work-dash/${h.script}로 등록돼 있다. 새 경로로 바꾸는 것은 손으로)` });
    else if (found?.kind === 'stale') {
      todo.push(h);
      items.push({ mark: '~', text: nodeGone ? `${where} (명령의 node 실행 파일이 없다. 지금 node 경로로 다시 쓴다)` : `${where} (명령이 다르다. node 경로 등을 지금 것으로 다시 쓴다)` });
    } else { todo.push(h); items.push({ mark: '+', text: where }); }
  }
  if (todo.length) {
    const first = items.find((i, k) => (i.mark === '+' || i.mark === '~') && todo.includes(hooks[k]));
    first.apply = (m) => {
      mkdirTracked(path.dirname(file), m);
      const exists = !!lstat(file);
      let original = exists ? null : originalFor(m, file);
      let cur = {};
      if (exists) {
        cur = JSON.parse(fs.readFileSync(file, 'utf8'));
        original = originalFor(m, file);
      }
      cur.hooks = cur.hooks || {};
      const inserted = [];
      const recorded = m.files[file]?.inserted.hooks || [];
      for (const h of todo) {
        const command = hookCmd(h.script);
        const found = findHook(cur.hooks[h.event], h);
        if (found?.kind === 'same' || found?.kind === 'old') continue;
        if (found?.kind === 'stale') {
          const previous = found.hook.command;
          found.hook.command = command;
          const mine = recorded.find((r) => r.event === h.event && sameMatcher(r.matcher, h.matcher) && (r.command === previous || r.command === command));
          if (mine) mine.command = command;
          else inserted.push({ event: h.event, matcher: h.matcher || null, command, previous });
          continue;
        }
        const entry = { type: 'command', command, timeout: h.timeout };
        const group = h.matcher ? { matcher: h.matcher, hooks: [entry] } : { hooks: [entry] };
        (cur.hooks[h.event] = cur.hooks[h.event] || []).push(group);
        inserted.push({ event: h.event, matcher: h.matcher || null, command });
      }
      writeAtomic(file, JSON.stringify(cur, null, 2) + '\n');
      recordFile(m, file, original, { hooks: inserted });
    };
  }
  return { title, items };
}

function planLine(file, line, has, title) {
  const st = lstat(file);
  const text = st ? fs.readFileSync(file, 'utf8') : '';
  if (st && has(text)) return { title, items: [{ mark: '=', text: `${tilde(file)}에 규칙 불러오는 줄이 있다` }] };
  return {
    title,
    items: [{
      mark: st ? '~' : '+', text: `${tilde(file)} 맨 위에 넣는다: ${line}`,
      apply: (m) => {
        mkdirTracked(path.dirname(file), m);
        const nowText = lstat(file) ? fs.readFileSync(file, 'utf8') : null;
        if (nowText != null && has(nowText)) return;
        const original = originalFor(m, file);
        writeAtomic(file, `${line}\n\n${nowText ?? ''}`);
        recordFile(m, file, original, { lines: [line] });
      },
    }],
  };
}

function codexInstalled() {
  if (lstat(CODEX)?.isDirectory()) return { dir: true };
  try { execFileSync('/bin/sh', ['-c', 'command -v codex'], { stdio: 'pipe' }); return { dir: false, bin: true }; } catch { return null; }
}

export function buildPlan({ server = false, linksOnly = false } = {}) {
  const docLinks = planLinks();
  const steps = [planDataDir(), docLinks];
  const appOk = docLinks.items[0].mark !== '!';
  const blocked = (title) => ({ title, items: [{ mark: '!', text: '~/.work-dash/app 링크를 만들 수 없어 훅을 넣지 않는다. 위의 확인 필요를 먼저 푼다' }] });
  const appFix = !!docLinks.items[0].apply;
  const codex = codexInstalled();
  if (!linksOnly) {
  steps.push(appOk ? planHooks(path.join(CLAUDE, 'settings.json'), CLAUDE_HOOKS, 'Claude 훅 (~/.claude/settings.json)', appFix, server) : blocked('Claude 훅'));
  if (codex?.dir) steps.push(appOk ? planHooks(path.join(CODEX, 'hooks.json'), CODEX_HOOKS, `Codex 훅 (${tilde(path.join(CODEX, 'hooks.json'))})`, appFix, server) : blocked('Codex 훅'));
  else steps.push({ title: 'Codex 훅', items: [{ mark: '=', text: codex?.bin ? `Codex 실행 파일은 있으나 ${tilde(CODEX)} 폴더가 없다. 건너뛴다` : 'Codex가 없다. 건너뛴다' }] });
  steps.push(planLine(path.join(CLAUDE, 'CLAUDE.md'), CLAUDE_LINE,
    (t) => t.split('\n').some((l) => /^@\S*\.work-dash\/RULES\.md\s*$/.test(l.trim())), '규칙 불러오는 줄 (Claude)'));
  if (codex?.dir) steps.push(planLine(path.join(CODEX, 'AGENTS.md'), CODEX_LINE, (t) => t.includes('.work-dash/RULES.md'), '규칙 불러오는 줄 (Codex)'));
  }
  let made = {};
  try { made = readManifest()?.links || {}; } catch {}
  const ask = (p) => {
    const cur = readLink(p);
    return !(cur != null && made[p] && path.resolve(path.dirname(p), cur) === made[p].target);
  };
  const link = (p, target) => planLink(p, target, { ask: ask(p) });
  const links = [
    ...COMMANDS.map((n) => link(path.join(CLAUDE, 'commands', `${n}.md`), path.join(REPO, 'claude', 'commands', `${n}.md`))),
    ...SKILLS.map((n) => link(path.join(CLAUDE, 'skills', n), path.join(REPO, 'claude', 'skills', n))),
  ];
  steps.push({ title: '명령 · 스킬 링크', items: links });
  if (codex?.dir) {
    steps.push({ title: 'Codex 스킬 링크', items: CODEX_SKILLS.map((n) => link(path.join(CODEX, 'skills', n), path.join(REPO, 'codex', 'skills', n))) });
  }
  return steps;
}

function withIds(steps) {
  const seen = new Map();
  for (const s of steps) for (const i of s.items) {
    const base = sha(`${s.title}\n${i.mark}\n${i.text}`).slice(0, 12);
    const n = (seen.get(base) || 0) + 1;
    seen.set(base, n);
    i.id = n === 1 ? base : `${base}-${n}`;
  }
  return steps;
}

const isWorktree = REPO.includes('/.claude/worktrees/');

function fixBlocked() {
  if (path.resolve(WD) !== path.join(HOME, '.work-dash')) return `데이터 폴더(${WD})가 ~/.work-dash가 아니라 고칠 수 없다. 훅 · 규칙 줄이 ~/.work-dash를 가리킨다`;
  if (isWorktree && REAL_HOME && path.resolve(HOME) === path.resolve(REAL_HOME)) return '워크트리에서 띄운 서버라 고치지 않는다. 링크가 이 워크트리를 가리키게 된다. 원래 저장소에서 띄운 서버로 고친다';
  return null;
}

function repoInfo() {
  let branch = null;
  try { branch = execFileSync('git', ['-C', REPO, 'rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch {}
  const app = path.join(HOME, '.work-dash', 'app');
  const link = readLink(app);
  return {
    repo: tilde(REPO), branch, worktree: isWorktree,
    app: { path: tilde(app), target: link == null ? null : tilde(path.resolve(path.dirname(app), link)), exists: exists(app), isLink: link != null },
  };
}

export function installStatus() {
  const steps = withIds(buildPlan({ server: true }));
  return {
    ...repoInfo(),
    blocked: fixBlocked(),
    checkedAt: new Date().toISOString(),
    steps: steps.map((s) => ({ title: s.title, items: s.items.map((i) => ({ id: i.id, mark: i.mark, text: i.text, fixable: !!i.apply && i.mark !== '!' })) })),
  };
}

export function fixInstall(ids) {
  const blocked = fixBlocked();
  if (blocked) return { status: 409, error: blocked };
  startRun();
  const all = withIds(buildPlan({ server: true })).flatMap((s) => s.items);
  const want = Array.isArray(ids) ? new Set(ids.filter((x) => typeof x === 'string')) : null;
  const picked = all.filter((i) => i.apply && i.mark !== '!' && (want ? want.has(i.id) : i.mark === '+' || i.mark === '~'));
  const stale = want ? [...want].filter((id) => !picked.some((i) => i.id === id)) : [];
  const result = { applied: [], failed: [], stale, backup: null };
  if (!picked.length) return { status: 200, body: result };
  const m = readManifest() || emptyManifest();
  try {
    for (const i of picked) {
      const err = applyOne(m, i);
      if (err) result.failed.push({ id: i.id, text: i.text, error: err instanceof SyntaxError ? 'JSON으로 읽지 못했다' : err.message });
      else result.applied.push(i.id);
    }
  } finally {
    saveManifest(m);
  }
  if (lstat(BACKUP_DIR)) result.backup = tilde(BACKUP_DIR) + '/';
  return { status: 200, body: result };
}

const MARKS = { '+': '＋ 만든다  ', '~': '↺ 바꾼다  ', '=': '· 이미 있음', '!': '! 확인 필요', '?': '? 물어봄  ', '-': '－ 되돌린다' };
function show(steps) {
  for (const s of steps) {
    console.log(`\n■ ${s.title}`);
    for (const i of s.items) console.log(`  ${MARKS[i.mark]}  ${i.text}`);
  }
}

function applyOne(m, i) {
  try { i.apply(m); return null; } catch (e) { return e; }
}

async function ask(q) {
  if (!process.stdin.isTTY) return false;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const a = await new Promise((r) => rl.question(q, r));
  rl.close();
  return /^(y|yes|예|네|ㅇ)$/i.test(a.trim());
}

function saveManifest(m) {
  fs.mkdirSync(path.dirname(MANIFEST), { recursive: true });
  m.repo = REPO;
  m.updatedAt = new Date().toISOString();
  writeAtomic(MANIFEST, JSON.stringify(m, null, 2) + '\n');
}

export async function init({ yes = false, linksOnly = false } = {}) {
  console.log(`work-dash init — 저장소 ${tilde(REPO)} · 데이터 ${tilde(WD)}`);
  if (REPO.includes('/.claude/worktrees/')) console.log('주의: 워크트리 안에서 돌리고 있다. 링크가 이 워크트리를 가리키므로 워크트리가 지워지면 훅 · 문서가 깨진다. 원래 저장소에서 돌린다.');
  const steps = buildPlan({ linksOnly });
  show(steps);
  const todo = steps.flatMap((s) => s.items).filter((i) => i.apply && i.mark !== '!');
  const asks = todo.filter((i) => i.mark === '?');
  const changes = todo.filter((i) => i.mark !== '?');
  if (!todo.length) { console.log('\n바꿀 것이 없다. 이미 설치돼 있다.'); return 0; }
  if (!changes.length && !process.stdin.isTTY) {
    console.log('\n바꿀 것은 없고, 같은 이름이 있어 물어봐야 하는 것만 남았다. 터미널에서 npm run init을 돌려 답한다.');
    return 0;
  }
  console.log(`\n바꿀 것 ${changes.length}개${asks.length ? `, 물어볼 것 ${asks.length}개` : ''}. 고치는 파일은 ${tilde(BACKUP_DIR)}/에 백업한다.`);
  if (!yes) {
    if (!process.stdin.isTTY) { console.log('미리 보기만 했다. 적용하려면: npm run init -- --yes'); return 0; }
    if (!(await ask('적용할까요? [y/N] '))) { console.log('적용하지 않았다.'); return 0; }
  }
  const m = readManifest() || emptyManifest();
  const hadBackup = !!lstat(BACKUP_DIR);
  let failed = 0;
  try {
    for (const i of changes) {
      const e = applyOne(m, i);
      if (e) { failed++; console.error(`  실패: ${i.text} — ${e.message}`); }
    }
    for (const i of asks) {
      if (yes && !process.stdin.isTTY) { console.log(`  건너뜀(같은 이름이 있어 묻지 못함): ${i.text}`); continue; }
      if (!(await ask(`  ${i.text}\n  바꿀까요? [y/N] `))) { console.log('  건너뜀'); continue; }
      const e = applyOne(m, i);
      if (e) { failed++; console.error(`  실패: ${i.text} — ${e.message}`); }
    }
  } finally {
    saveManifest(m);
  }
  console.log(failed ? `\n${failed}개가 실패했다. 위 메시지를 확인한다.` : '\n적용했다. 다시 돌려도 결과가 같다.');
  if (!hadBackup && lstat(BACKUP_DIR)) console.log(`백업: ${tilde(BACKUP_DIR)}/`);
  return failed ? 1 : 0;
}

function surgicalHooks(file, hooks) {
  const json = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const h of hooks) {
    const groups = json.hooks?.[h.event];
    if (!Array.isArray(groups)) continue;
    for (const g of groups) {
      if (!sameMatcher(g.matcher, h.matcher) || !Array.isArray(g.hooks)) continue;
      if (h.previous) { for (const x of g.hooks) if (x.command === h.command) x.command = h.previous; }
      else g.hooks = g.hooks.filter((x) => x.command !== h.command);
    }
    json.hooks[h.event] = groups.filter((g) => !(Array.isArray(g.hooks) && g.hooks.length === 0));
    if (!json.hooks[h.event].length) delete json.hooks[h.event];
  }
  if (json.hooks && !Object.keys(json.hooks).length) delete json.hooks;
  writeAtomic(file, JSON.stringify(json, null, 2) + '\n');
}
function surgicalLines(file, lines) {
  let t = fs.readFileSync(file, 'utf8');
  for (const l of lines) {
    if (t.startsWith(`${l}\n\n`)) t = t.slice(l.length + 2);
    else if (t.startsWith(`${l}\n`)) t = t.slice(l.length + 1);
    else { const i = t.split('\n').indexOf(l); if (i >= 0) { const a = t.split('\n'); a.splice(i, 1); t = a.join('\n'); } }
  }
  writeAtomic(file, t);
}
function surgicalKeys(file, keys) {
  const json = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const k of keys) delete json[k];
  writeAtomic(file, JSON.stringify(json, null, 2) + '\n');
}

function planUninstall(m) {
  const items = [];
  for (const [p, l] of Object.entries(m.links)) {
    const st = lstat(p);
    const ours = st?.isSymbolicLink() && path.resolve(path.dirname(p), readLink(p)) === l.target;
    if (!ours) { items.push({ mark: '=', text: `${tilde(p)} — init이 만든 링크가 아니게 바뀌었다. 그대로 둔다` }); continue; }
    const restore = l.backup ? ` (백업 ${tilde(l.backup)}을 되돌린다)` : l.oldLink ? ` (예전 링크 ${tilde(l.oldLink)}로 되돌린다)` : '';
    items.push({
      mark: '-', text: `링크 ${tilde(p)}${restore}`,
      apply: () => {
        if (l.backup && !lstat(l.backup)) throw new Error(`백업 ${tilde(l.backup)}이 없어 링크를 그대로 둔다`);
        fs.unlinkSync(p);
        if (l.backup) fs.renameSync(l.backup, p);
        else if (l.oldLink) fs.symlinkSync(l.oldLink, p);
      },
    });
  }
  for (const [p, f] of Object.entries(m.files)) {
    if (!lstat(p)) { items.push({ mark: '=', text: `${tilde(p)} — 이미 없다` }); continue; }
    const untouched = shaOf(p) === f.sha && !f.userEdited;
    if (untouched) {
      items.push({
        mark: '-', text: f.original === 'absent' ? `${tilde(p)} 지운다 (init이 만든 파일, 그 뒤 바뀌지 않음)` : `${tilde(p)} 원본으로 되돌린다 (백업 ${tilde(f.original)})`,
        apply: () => {
          if (f.original === 'absent') fs.unlinkSync(p);
          else writeAtomic(p, fs.readFileSync(f.original));
        },
      });
      continue;
    }
    const what = [f.inserted.hooks.length && `훅 ${f.inserted.hooks.length}개`, f.inserted.lines.length && `줄 ${f.inserted.lines.length}개`, f.inserted.keys.length && `키 ${f.inserted.keys.join(', ')}`].filter(Boolean);
    if (!what.length) { items.push({ mark: '=', text: `${tilde(p)} — init 뒤에 바뀌었다. 그대로 둔다` }); continue; }
    items.push({
      mark: '-', text: `${tilde(p)} — init 뒤에 바뀌어서 넣은 것(${what.join(' · ')})만 뺀다`,
      apply: () => {
        if (f.inserted.hooks.length) surgicalHooks(p, f.inserted.hooks);
        if (f.inserted.lines.length) surgicalLines(p, f.inserted.lines);
        if (f.inserted.keys.length) surgicalKeys(p, f.inserted.keys);
        if (f.original === 'absent' && /^\s*(\{\s*\})?\s*$/.test(fs.readFileSync(p, 'utf8'))) fs.unlinkSync(p);
      },
    });
  }
  return items;
}

export async function uninstall({ yes = false } = {}) {
  console.log(`work-dash uninstall — 데이터 ${tilde(WD)}`);
  const m = readManifest();
  if (!m) { console.log(`${tilde(MANIFEST)}이 없다. init이 넣은 기록이 없어 되돌릴 것이 없다.`); return 0; }
  const items = planUninstall(m);
  const dirs = [...m.dirs].sort((a, b) => b.length - a.length);
  show([{ title: 'init이 넣은 것', items }, { title: 'init이 만든 폴더 (비어 있을 때만 지운다)', items: dirs.map((d) => ({ mark: '-', text: tilde(d) + '/' })) }]);
  if (!yes) {
    if (!process.stdin.isTTY) { console.log('\n미리 보기만 했다. 되돌리려면: npm run uninstall -- --yes'); return 0; }
    if (!(await ask('\n되돌릴까요? [y/N] '))) { console.log('되돌리지 않았다.'); return 0; }
  }
  let failed = 0;
  for (const i of items) if (i.apply) { try { i.apply(); } catch (e) { failed++; console.error(`  실패: ${i.text} — ${e.message}`); } }
  if (failed) { console.log(`\n${failed}개가 실패했다. 기록(${tilde(MANIFEST)})은 남겨 둔다.`); return 1; }
  fs.unlinkSync(MANIFEST);
  const kept = [];
  for (const d of dirs) { try { fs.rmdirSync(d); } catch { if (lstat(d)) kept.push(d); } }
  if (kept.length) console.log(`\n비어 있지 않아 남긴 폴더: ${kept.map((d) => tilde(d) + '/').join(', ')}`);
  console.log('\n되돌렸다. 백업 폴더(backup-init-*)는 지우지 않았다.');
  return 0;
}

function checkWd() {
  if (path.resolve(WD) !== path.join(HOME, '.work-dash')) {
    console.error(`WORK_DASH_DIR(${WD})가 ~/.work-dash가 아니다. 훅 · 규칙 줄이 ~/.work-dash를 가리키므로 init · uninstall은 기본 위치에서만 돌린다. WORK_DASH_DIR을 빼고 다시 돌린다.`);
    process.exit(2);
  }
}
const isMain = process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const [cmd, ...rest] = process.argv.slice(2);
  const yes = rest.includes('--yes') || rest.includes('-y');
  if (cmd === 'init' || cmd === 'uninstall') checkWd();
  const run = cmd === 'init' ? init({ yes, linksOnly: rest.includes('--links') }) : cmd === 'uninstall' ? uninstall({ yes }) : null;
  if (!run) { console.log('사용법: node bin/install.js init|uninstall [--yes] [--links]'); process.exit(2); }
  run.then((code) => process.exit(code), (e) => { console.error(e.message || e); process.exit(1); });
}
