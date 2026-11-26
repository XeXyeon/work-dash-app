#!/usr/bin/env node
// 보관한 세션이 남긴 것(임시 폴더 · 앱이 만든 워크트리 · 병합된 로컬 브랜치)을 보관 뒤에 지운다. 대시보드 서버 없이 돈다.
//
//   node afterarchive.js register <세션 id> [--ignored-ok]   지울 것을 대기 목록(data/closeout-pending.json)에 적는다. 결과는 한 줄 JSON
//   node afterarchive.js run                                 대기 목록을 한 번 처리한다. 세션이 보관된 것만 지운다
//   node afterarchive.js                                     훅으로 불릴 때: 대기 목록이 있으면 run을 따로 띄우고 바로 끝난다
//
// 지키는 것
// - 세션이 보관된 것을 앱의 세션 저장 파일에서 확인한 뒤에만 지운다.
// - 워크트리: 앱이 만든 자리(<저장소>/.claude/worktrees/<이름>)이고, 등록 때의 커밋 그대로이고, 커밋 전 변경 · 새 파일 · 등록 뒤 생긴 무시 파일이 없고, 다른 열린 세션 · 프로세스가 쓰지 않을 때만 `git worktree remove`로 지운다.
// - 브랜치: 등록 때의 커밋 그대로이고, 워크트리가 쓰지 않고, 통합 브랜치에 병합된 것을 다시 확인한 뒤에만 지운다. main · master와 통합 브랜치는 지우지 않는다.
// - 대화 기록 · 앱의 세션 저장 파일 · 도커 볼륨은 건드리지 않는다.
const fs = require('fs');
const path = require('path');
const { execFileSync, execFile, spawn } = require('child_process');
const { WD } = require('./paths.js');
const { loadDesktop, liveStatesIn, gitInfo, baseCandidates, judge, BASES } = require('./closeout.js');

const CHECK_JS = path.join(__dirname, 'closeout.js');
const CHECK_TIMEOUT_MS = 60_000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PENDING_FILE = path.join(WD, 'data', 'closeout-pending.json');
const LOCK_FILE = path.join(WD, 'data', 'closeout-pending.lock');
const LOG_FILE = path.join(WD, 'data', 'closeout-log.jsonl');
const KEEP_MS = 30 * 24 * 3600_000;
const WT_RETRY_MS = 7 * 24 * 3600_000;
const LOCK_STALE_MS = 10 * 60_000;
const LOCK_WAIT_MS = 45_000;
const TMP_ROOT = `/private/tmp/claude-${process.getuid?.() ?? ''}`;

function record(id, step, data = {}) {
  try { fs.appendFileSync(LOG_FILE, `${JSON.stringify({ at: new Date().toISOString(), id, step, ...data })}\n`); } catch { }
}

function loadPending() {
  const out = {};
  let j;
  try { j = JSON.parse(fs.readFileSync(PENDING_FILE, 'utf8')); } catch { return out; }
  for (const [id, p] of Object.entries(j && typeof j === 'object' ? j : {})) {
    if (!UUID_RE.test(id) || !p || typeof p.at !== 'number' || !Array.isArray(p.branches)) continue;
    const w = p.worktree;
    const t = p.wt;
    out[id] = {
      at: p.at, tmpDone: p.tmpDone === true,
      ...(w && typeof w.path === 'string' && typeof w.repo === 'string' && typeof w.sha === 'string' ? { worktree: { path: w.path, repo: w.repo, sha: w.sha, ignored: Array.isArray(w.ignored) ? w.ignored.filter((x) => typeof x === 'string') : [] } } : {}),
      ...(t && typeof t.first === 'number' && typeof t.tries === 'number' && typeof t.nextAt === 'number' ? { wt: { first: t.first, tries: t.tries, nextAt: t.nextAt, reason: String(t.reason || '') } } : {}),
      branches: p.branches.filter((b) => b && typeof b.name === 'string' && typeof b.sha === 'string' && typeof b.repo === 'string')
        .map((b) => ({ name: b.name, sha: b.sha, repo: b.repo, base: typeof b.base === 'string' ? b.base : '' })),
    };
  }
  return out;
}
function savePending(pending) {
  fs.mkdirSync(path.dirname(PENDING_FILE), { recursive: true });
  const tmp = `${PENDING_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(pending, null, 1));
  fs.renameSync(tmp, PENDING_FILE);
}

function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
function tryLock(token) {
  try {
    if (Date.now() - fs.statSync(LOCK_FILE).mtimeMs > LOCK_STALE_MS) {
      const aside = `${LOCK_FILE}.${token}.stale`;
      fs.renameSync(LOCK_FILE, aside);
      fs.unlinkSync(aside);
    }
  } catch { }
  try { fs.writeFileSync(LOCK_FILE, token, { flag: 'wx' }); return true; } catch { return false; }
}
function touchLock(token) {
  try { if (fs.readFileSync(LOCK_FILE, 'utf8') === token) { const now = new Date(); fs.utimesSync(LOCK_FILE, now, now); } } catch { }
}
function withLock(fn, waitMs = 0) {
  fs.mkdirSync(path.dirname(LOCK_FILE), { recursive: true });
  const token = `${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}`;
  const until = Date.now() + waitMs;
  while (!tryLock(token)) {
    if (Date.now() >= until) return null;
    sleepMs(500);
  }
  try { return fn(() => touchLock(token)); }
  finally { try { if (fs.readFileSync(LOCK_FILE, 'utf8') === token) fs.unlinkSync(LOCK_FILE); } catch { } }
}

function git(dir, args) {
  try { return { ok: true, out: execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'pipe'] }) }; }
  catch (e) { return { ok: false, out: String(e.stdout || ''), err: String(e.stderr || e.message) }; }
}

function checkedOutAt(repo, name) {
  const r = git(repo, ['worktree', 'list', '--porcelain']);
  if (!r.ok) return '(워크트리 목록을 읽지 못함)';
  let cur = '';
  for (const line of r.out.split('\n')) {
    if (line.startsWith('worktree ')) cur = line.slice(9);
    else if (line === `branch refs/heads/${name}` && fs.existsSync(cur)) return cur;
  }
  return null;
}

function deleteBranch(b) {
  const base = { name: b.name, sha: String(b.sha || '').slice(0, 9) };
  if (typeof b.name !== 'string' || !b.name || b.name.startsWith('-') || BASES.includes(b.name)) return { ...base, result: 'skipped', reason: '지우지 않는 브랜치 이름' };
  if (typeof b.repo !== 'string' || !path.isAbsolute(b.repo) || !gitInfo(b.repo)) return { ...base, result: 'skipped', reason: '저장소를 찾지 못함' };
  const ref = `refs/heads/${b.name}`;
  const tip = git(b.repo, ['rev-parse', '--verify', '--quiet', ref]);
  if (!tip.ok) return { ...base, result: 'gone', reason: '이미 없음' };
  if (tip.out.trim() !== b.sha) return { ...base, result: 'skipped', reason: '등록 뒤에 커밋이 더 쌓임' };
  const at = checkedOutAt(b.repo, b.name);
  if (at) return { ...base, result: 'in-use', reason: '워크트리가 쓰고 있음', at };
  const bases = baseCandidates(b.repo, typeof b.base === 'string' ? b.base : '').filter((c) => c.name !== 'main' && c.name !== 'master');
  const v = bases.length ? judge(b.repo, b.sha, bases, { branch: b.name, useGh: true }) : null;
  if (!v || !v.merged) return { ...base, result: 'skipped', reason: '병합을 다시 확인하지 못함' };
  const del = git(b.repo, ['update-ref', '-d', ref, b.sha]);
  if (!del.ok) return { ...base, result: 'failed', reason: del.err.trim().split('\n')[0].slice(0, 200) };
  git(b.repo, ['config', '--remove-section', `branch.${b.name}`]);
  return { ...base, result: 'deleted', merged: v.merged, base: `origin/${v.base.name}` };
}

const REBUILD = new Set(['node_modules', '.next', 'dist', 'build', 'out', 'target', '.gradle', '.turbo', '.cache', 'coverage', '.DS_Store', 'next-env.d.ts']);
function sigOf(abs) {
  let n = 0, size = 0, mt = 0;
  const walk = (x) => {
    if (++n > 20_000) throw new Error('too many');
    const st = fs.lstatSync(x);
    size += st.size; mt = Math.max(mt, st.mtimeMs);
    if (st.isDirectory()) for (const c of fs.readdirSync(x)) walk(path.join(x, c));
  };
  try { walk(abs); } catch { return `?${Date.now()}`; }
  return `${n}:${size}:${Math.round(mt)}`;
}
function ignoredOf(wt) {
  const r = git(wt, ['status', '--porcelain', '--untracked-files=normal', '--ignored']);
  if (!r.ok) return null;
  return r.out.split('\n').filter((l) => l.startsWith('!! ')).map((l) => {
    const rel = l.slice(3).replace(/^"|"$/g, '').replace(/\/$/, '');
    const name = path.basename(rel);
    if (REBUILD.has(name) || name.endsWith('.tsbuildinfo')) return l;
    return `${l}\t${sigOf(path.join(wt, rel))}`;
  });
}

function removeWorktree(w, desk, selfId) {
  const skip = (reason) => ({ result: 'skipped', reason });
  const never = (reason) => ({ result: 'skipped', reason, final: true });
  if (!desk || !Array.isArray(desk.list) || desk.broken) return { result: 'retry', reason: '앱 세션 저장 파일을 다 읽지 못함' };
  const desktop = desk.list;
  const real = (x) => { try { return fs.realpathSync.native(x); } catch { return x; } };
  if (!w || !path.isAbsolute(w.path) || !path.isAbsolute(w.repo) || path.normalize(w.path) !== w.path) return never('경로 모양이 다름');
  const rel = path.relative(path.join(w.repo, '.claude', 'worktrees'), w.path);
  if (!rel || rel.includes(path.sep) || rel.startsWith('.')) return never('앱이 만든 워크트리 자리가 아님');
  let st;
  try { st = fs.lstatSync(w.path); } catch { return { result: 'gone' }; }
  if (!st.isDirectory() || st.isSymbolicLink()) return never('폴더가 아님');
  const list = git(w.repo, ['worktree', 'list', '--porcelain']);
  if (!list.ok) return skip('깃의 워크트리 목록을 읽지 못함');
  const block = list.out.split('\n\n').find((b) => b.split('\n').includes(`worktree ${w.path}`));
  if (!block) return never('깃의 워크트리 목록에 없음');
  if (block.split('\n').some((l) => l === 'locked' || l.startsWith('locked '))) return never('잠긴 워크트리');
  const rp = real(w.path);
  const within = (x) => x === w.path || x.startsWith(`${w.path}/`) || x === rp || x.startsWith(`${rp}/`);
  const users = desktop.filter((d) => d.isArchived !== true && d.sessionId !== selfId && d.cliSessionId !== selfId
    && [d.worktreePath, d.cwd].some((x) => typeof x === 'string' && x && within(real(x))));
  if (users.length) return skip('다른 열린 세션이 쓰고 있음');
  const live = liveStatesIn(w.path, selfId);
  if (!live) return { result: 'retry', reason: '세션 상태 파일을 읽지 못함' };
  if (live.length) return skip('다른 열린 세션이 쓰고 있음');
  let cwds;
  try { cwds = execFileSync('lsof', ['-d', 'cwd', '-Fn'], { encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'ignore'] }); } catch (e) { cwds = String(e.stdout || ''); }
  if (cwds.split('\n').some((l) => l[0] === 'n' && within(l.slice(1)))) return skip('워크트리 안에서 도는 프로세스가 있음');
  try { if (fs.readdirSync(path.join(w.path, '.claude', 'worktrees')).length) return skip('안에 하위 워크트리가 있음'); } catch { }
  const head = git(w.path, ['rev-parse', 'HEAD']);
  if (!head.ok || head.out.trim() !== w.sha) return skip('등록 뒤에 커밋이 바뀜');
  const dirty = git(w.path, ['status', '--porcelain', '--untracked-files=all']);
  const ign = ignoredOf(w.path);
  if (!dirty.ok || !ign) return skip('상태를 읽지 못함');
  const lines = [...dirty.out.split('\n').filter(Boolean), ...ign];
  const APP_FILES = ['?? .claude/settings.local.json', '?? .claude/launch.json'];
  const left = lines.filter((l) => !l.startsWith('!! ') && !APP_FILES.includes(l));
  if (left.length) return skip(`커밋 전 변경 · 새 파일 ${left.length}개가 있음`);
  const known = new Set(Array.isArray(w.ignored) ? w.ignored : []);
  const fresh = lines.filter((l) => l.startsWith('!! ') && !known.has(l));
  if (fresh.length) return skip(`등록 뒤에 생기거나 바뀐 무시 파일 ${fresh.length}개가 있음`);
  if (lines.some((l) => APP_FILES.includes(l))) {
    for (const l of lines) if (APP_FILES.includes(l)) { try { fs.unlinkSync(path.join(w.path, l.slice(3))); } catch { } }
    for (const d of ['.claude/worktrees', '.claude']) { try { fs.rmdirSync(path.join(w.path, d)); } catch { } }
  }
  let del;
  try { execFileSync('git', ['-C', w.repo, 'worktree', 'remove', w.path], { encoding: 'utf8', timeout: 120_000, stdio: ['ignore', 'pipe', 'pipe'] }); del = { ok: true }; }
  catch (e) { del = { ok: false, err: String(e.stderr || e.message) }; }
  return del.ok ? { result: 'removed' } : { result: 'failed', reason: del.err.trim().split('\n')[0].slice(0, 200) };
}

function removeTmp(cliId) {
  const removed = [];
  if (!UUID_RE.test(String(cliId)) || !/^\/private\/tmp\/claude-\d+$/.test(TMP_ROOT)) return removed;
  const uid = process.getuid();
  const mine = (p) => { try { const st = fs.lstatSync(p); return st.isDirectory() && !st.isSymbolicLink() && st.uid === uid; } catch { return false; } };
  if (!mine(TMP_ROOT)) return removed;
  let names = [];
  try { names = fs.readdirSync(TMP_ROOT); } catch { return removed; }
  for (const n of names) {
    const parent = path.join(TMP_ROOT, n);
    const dir = path.join(parent, cliId);
    if (!mine(parent) || !mine(dir)) continue;
    try { fs.rmSync(dir, { recursive: true, force: true }); removed.push(dir); }
    catch (e) { record(cliId, 'tmp-failed', { dir, reason: e.message }); }
  }
  return removed;
}


function runOnce(touch = () => {}) {
  const now = Date.now();
  const pending = loadPending();
  if (!Object.keys(pending).length) return { pending: 0 };
  let desk = null;
  try { desk = loadDesktop(); } catch { }
  const desktop = desk && Array.isArray(desk.list) ? desk.list : null;
  let changed = false;
  for (const [id, p] of Object.entries(pending)) {
    if (now - p.at > KEEP_MS) { delete pending[id]; changed = true; record(id, 'forgotten', { worktree: !!p.worktree, branches: p.branches.map((b) => b.name) }); continue; }
    if (!desktop) continue;
    const d = desktop.find((x) => x.sessionId === id || x.cliSessionId === id);
    if (!d || d.isArchived !== true) continue;
    touch();
    if (!p.tmpDone) {
      const removed = removeTmp(id);
      p.tmpDone = true; changed = true;
      record(id, 'tmp', { removed: removed.length, sinceRegisterMs: now - p.at });
    }
    if (p.worktree) {
      if (p.wt && now < p.wt.nextAt) continue;
      let out;
      try { out = removeWorktree(p.worktree, desk, id); } catch (e) { out = { result: 'failed', reason: e.message }; }
      if (out.result === 'retry') continue;
      const why = out.reason || out.result;
      const t = p.wt || { first: now, tries: 0, reason: '', nextAt: 0 };
      const done = out.result === 'removed' || out.result === 'gone';
      const giveUp = !!out.final || now - t.first > WT_RETRY_MS;
      if (t.reason !== why) record(id, 'worktree', { name: path.basename(p.worktree.path), result: out.result, ...(out.reason ? { reason: out.reason } : {}), ...(out.final ? { final: true } : {}), tries: t.tries + 1 });
      if (!done && (t.reason !== why || giveUp)) notify('보관한 세션의 워크트리를 지우지 못했습니다', `${path.basename(p.worktree.path)}: ${why}${giveUp ? ' (더 시도하지 않습니다)' : ' (다시 시도합니다)'}`);
      if (done || giveUp) { delete p.worktree; delete p.wt; }
      else p.wt = { first: t.first, tries: t.tries + 1, reason: why, nextAt: now + Math.min(600_000, 30_000 * 2 ** t.tries) };
      changed = true;
      touch();
    }
    const before = p.branches.length;
    p.branches = p.branches.filter((b) => {
      let out;
      try { out = deleteBranch(b); } catch (e) { out = { name: b.name, result: 'failed', reason: e.message }; }
      if (out.result === 'in-use') return true;
      record(id, 'branch', { name: b.name, result: out.result, ...(out.reason ? { reason: out.reason } : {}) });
      if (out.result === 'deleted') notify('보관한 세션의 브랜치를 지웠습니다', `${out.name} (${out.base}에 병합됨)`);
      return false;
    });
    if (p.branches.length !== before) changed = true;
    if (!p.branches.length && !p.worktree) { delete pending[id]; changed = true; }
  }
  if (changed) savePending(pending);
  return { pending: Object.keys(pending).length };
}

function run() {
  return withLock(runOnce) || { busy: true };
}

function register(id, { ignoredOk = false } = {}) {
  if (!UUID_RE.test(String(id))) return { ok: false, kind: 'input', error: '세션 id 형식이 올바르지 않습니다' };
  let r;
  try { r = JSON.parse(execFileSync(process.execPath, [CHECK_JS, id, '--gh', '--fetch', '--end-check'], { encoding: 'utf8', timeout: CHECK_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] })); }
  catch { return { ok: false, kind: 'check', error: '점검하지 못했습니다' }; }
  if (r.error) return { ok: false, kind: 'notfound', error: r.error };
  const untilde = (p) => (typeof p === 'string' && p.startsWith('~') ? require('./paths.js').HOME + p.slice(1) : p);
  const branches = r.worktree?.linked ? r.cleanable.branches.map((b) => ({ name: b.name, sha: b.sha, repo: b.repo, base: b.base })) : [];
  let worktree = null;
  const left = r.blockers.filter((b) => !(ignoredOk && b.kind === 'ignored'));
  if (r.worktree?.linked && !(r.sharedWith && r.sharedWith.length) && !r.unknowns.length && !left.length && typeof r.worktree.path === 'string' && typeof r.origin === 'string') {
    const wt = untilde(r.worktree.path), repo = untilde(r.origin);
    const head = git(wt, ['rev-parse', 'HEAD']);
    const ig = ignoredOf(wt);
    if (head.ok && ig) worktree = { path: wt, repo, sha: head.out.trim(), ignored: ig };
  }
  let saved = null;
  try {
    saved = withLock(() => {
      const pending = loadPending();
      pending[id] = { at: Date.now(), tmpDone: false, branches, ...(worktree ? { worktree } : {}) };
      savePending(pending);
      return true;
    }, LOCK_WAIT_MS);
  } catch (e) { return { ok: false, kind: 'save', error: `대기 목록을 쓰지 못했습니다: ${e.message}` }; }
  if (!saved) return { ok: false, kind: 'busy', error: '대기 목록을 다른 정리가 쓰고 있습니다. 한 번 더 등록한다' };
  record(id, 'register', {
    ignoredOk, worktree: !!worktree, branches: branches.map((b) => b.name),
    ...(!worktree && r.worktree?.linked ? { why: { blockers: left.map((b) => b.kind), shared: (r.sharedWith || []).length, unknowns: r.unknowns.length } } : {}),
  });
  return { ok: true, tmp: true, worktree: !!worktree, branches: branches.map((b) => b.name), ...(r.worktree?.linked && !branches.length ? { note: '병합이 확인된 브랜치가 없어 로컬 브랜치는 남습니다' } : {}) };
}

function notify(title, text) {
  if (process.platform !== 'darwin' || process.env.WORK_DASH_NOTIFY === '0') return;
  const q = (t) => `"${String(t).replace(/[\r\n]+/g, ' ').slice(0, 120).replace(/[\\"]/g, '\\$&')}"`;
  execFile('osascript', ['-e', `display notification ${q(text)} with title ${q(title)}`], { timeout: 10_000 }, () => {});
}


module.exports = { register, run, deleteBranch, removeWorktree, removeTmp, ignoredOf, PENDING_FILE };

if (require.main === module) {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === 'register') {
    const out = register(rest.find((a) => !a.startsWith('--')), { ignoredOk: rest.includes('--ignored-ok') });
    console.log(JSON.stringify(out));
    process.exit(out.ok ? 0 : 1);
  } else if (cmd === 'run') {
    try { console.log(JSON.stringify(run())); } catch (e) { record(null, 'run-failed', { reason: e.message }); console.error(e.message); process.exit(1); }
  } else {
    let has = false;
    try { has = fs.statSync(PENDING_FILE).size > 4; } catch { }
    if (!process.stdin.isTTY) process.stdin.resume();
    if (has) { const child = spawn(process.execPath, [__filename, 'run'], { detached: true, stdio: 'ignore' }); child.on('error', () => {}); child.unref(); }
  }
}
