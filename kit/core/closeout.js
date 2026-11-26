#!/usr/bin/env node
// 세션 종결 점검 (WEB-44): 세션 ID → 닫기 전에 남은 것 목록(JSON). 읽기만 한다. 아무것도 지우지 않는다.
//   node closeout.js <세션 id | local_… id> [--gh] [--fetch]
//   node closeout.js <세션 id> --end   종결 명령(/end, WEB-48)용: 판단에 필요한 것만 한 줄 JSON으로
// 대시보드의 보관 버튼(WEB-45)과 보관 도구 앞 훅(WEB-46)이 같은 check()를 부른다.
//
// 읽는 곳
// - Claude 앱 세션 저장 파일(claude-code-sessions/**/local_*.json): 워크트리 · 원래 폴더 · 브랜치 · 보관 여부 · 하위 세션 · PR
//   앱 내부 형식이라 필드가 없을 수 있다. 없으면 그 점검을 "모름"(unknowns)으로 두고 넘어간다.
// - 대시보드 세션 상태 파일(data/sessions/<id>.json): 세션 상태, 돌고 있는 서브에이전트
// - git: 커밋 전 변경, 스태시, 병합 판정, 깃이 무시하는 파일
// - lsof · ps: 작업 폴더가 워크트리 안인 프로세스
//
// 결과
// - blockers: 있으면 보관하지 않는다 (커밋 전 변경 · 스태시 · 병합되지 않은 커밋 · 무시 파일 중 생성물이 아닌 것 · 돌고 있는 하위 세션과 서브에이전트)
// - cleanable: 치워도 되는 것 (워크트리 안에서 뜨고 부모가 사라진 프로세스, 병합이 확인된 브랜치). 치우는 일은 부르는 쪽이 한다
// - notes: 알려 둘 것, unknowns: 확인하지 못한 것
//
// 깃 점검이 보관을 막는 것은 워크트리 세션뿐이다. 원래 저장소 폴더에서 연 세션은 보관해도 폴더가 그대로 남고,
// 그 폴더의 변경이 어느 세션 것인지 가릴 수 없어서 알려 두기만 한다.
// 예약 작업(/loop · 예약)은 다루지 않는다. 스쿼시 병합은 PR 근거(--gh)로만 확인된다.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { WD } = require('./paths');
const { execFileSync } = require('child_process');

const HOME = os.homedir();
const DESKTOP_DIR = path.join(HOME, 'Library', 'Application Support', 'Claude', 'claude-code-sessions');
const STATE_DIR = path.join(WD, 'data', 'sessions');
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const ID_RE = new RegExp(`^(local_)?${UUID}$`, 'i');
const BASES = ['dev', 'Dev', 'develop', 'main', 'master'];
const END_BASES = ['dev', 'Dev', 'develop'];
const STALE_MS = 15 * 60_000;
const LIST_MAX = 30;
// 깃이 무시하는 것 중 다시 만들 수 있는 생성물 (경로 조각 이름 · 파일 이름 끝)
// bin · tmp · logs · out처럼 손으로 쓴 것이 들어갈 수 있는 이름은 넣지 않는다(틀리면 워크트리와 함께 사라진다)
const GENERATED_DIRS = new Set(['node_modules', 'dist', 'build', 'target', 'coverage', '.next', '.nuxt', '.vite', '.turbo', '.cache',
  '.gradle', '.idea', '.vscode', '__pycache__', '.pytest_cache', '.venv', 'venv', 'Pods', 'DerivedData', '.playwright-mcp', '.dart_tool']);
const GENERATED_FILE_RE = /(\.log|\.tsbuildinfo|\.pyc|\.class|\.DS_Store|\.pid|^next-env\.d\.ts)$/;
// 추적하지 않는 파일(깃이 무시하지 않는 것)은 더 좁게: 도구가 남기는 것만 뺀다
const UNTRACKED_SKIP = new Set(['.playwright-mcp', '.DS_Store', '.claude']);
// 저장소 꼭대기의 .claude/(세션 개인 설정 · 워크트리 폴더)는 남은 것으로 보지 않는다(사용자 확정 2026-11-17)
const isClaudeDir = (rel) => rel === '.claude' || rel === '.claude/' || rel.startsWith('.claude/');

const str = (v) => (typeof v === 'string' ? v : '');
const tilde = (p) => (p && p.startsWith(HOME) ? `~${p.slice(HOME.length)}` : p);
const cap = (list) => (list.length > LIST_MAX ? [...list.slice(0, LIST_MAX), `… 외 ${list.length - LIST_MAX}개`] : list);
const inside = (p, dir) => !!p && !!dir && (p === dir || p.startsWith(dir.endsWith('/') ? dir : `${dir}/`));

function run(cmd, args, opts = {}) {
  try {
    return { ok: true, out: execFileSync(cmd, args, { encoding: 'utf8', timeout: 10_000, maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'], ...opts }) };
  } catch (e) {
    return { ok: false, out: str(e.stdout), err: str(e.stderr) || e.message, code: e.status };
  }
}
const git = (dir, args, opts) => run('git', ['-C', dir, ...args], opts);
const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };

// ---- 앱 세션 저장 파일 ----
function desktopFiles(dir = DESKTOP_DIR, out = [], depth = 0) {
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory() && depth < 4) desktopFiles(p, out, depth + 1);
    else if (e.isFile() && e.name.startsWith('local_') && e.name.endsWith('.json')) out.push(p);
  }
  return out;
}
// broken: 읽지 못한 파일 수(앱이 쓰는 중이거나 형식이 바뀜). 하나라도 있으면 "같은 폴더를 쓰는 세션"을 다 안다고 할 수 없다
function loadDesktop() {
  const list = [];
  let broken = 0;
  for (const f of desktopFiles()) {
    try {
      const j = JSON.parse(fs.readFileSync(f, 'utf8'));
      if (j && typeof j === 'object' && typeof j.sessionId === 'string') list.push(j); else broken++;
    } catch { broken++; }
  }
  return { list, broken };
}
// 보관 여부만 (보관 뒤로 미뤄 둔 일을 하는 쪽이 가볍게 묻는다). 모르면 null
function isArchived(sessionId) {
  const d = loadDesktop().list.find((x) => x.sessionId === sessionId || x.cliSessionId === sessionId);
  return d ? d.isArchived === true : null;
}
// 대시보드가 아는 세션(터미널 · 앱 모두) 중 끝나지 않았고 작업 폴더가 dir 안인 것
function liveStatesIn(dir, exceptCliId) {
  const out = [];
  let names = [];
  try { names = fs.readdirSync(STATE_DIR).filter((n) => n.endsWith('.json')); } catch { return null; }
  for (const n of names) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(STATE_DIR, n), 'utf8'));
      if (j && j.id !== exceptCliId && j.status !== 'ended' && inside(str(j.cwd), dir)) out.push({ id: str(j.id), title: str(j.title).split('\n')[0].slice(0, 60) || str(j.id) });
    } catch { return null; }   // 쓰는 중이라 못 읽은 것이 있으면 "없다"고 하지 않는다
  }
  return out;
}
// 세션이 쓰는 폴더: 워크트리 경로가 있으면 그것, 없으면 cwd
const dirOf = (d) => str(d.worktreePath) || str(d.cwd);

function readState(cliId) {
  if (!cliId) return null;
  try { return JSON.parse(fs.readFileSync(path.join(STATE_DIR, `${cliId.replace(/[^\w.-]/g, '_')}.json`), 'utf8')); } catch { return null; }
}
// 상태 파일의 '작업 중'은 훅이 끊기면 그대로 남는다. 15분 넘게 기록이 없으면 '응답 없음'으로 따로 적는다
function liveStatus(state, now) {
  if (!state) return 'unknown';
  if (state.status === 'working') return now - (state.updatedAt || 0) > STALE_MS ? 'stale' : 'working';
  return str(state.status) || 'unknown';
}

// ---- git ----
function gitInfo(dir) {
  const top = git(dir, ['rev-parse', '--show-toplevel']);
  if (!top.ok) return null;
  const gd = git(dir, ['rev-parse', '--absolute-git-dir']).out.trim();
  const common = git(dir, ['rev-parse', '--path-format=absolute', '--git-common-dir']).out.trim();
  const head = git(dir, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  return {
    top: top.out.trim(),
    linked: !!gd && !!common && path.resolve(gd) !== path.resolve(common),   // 연결된 워크트리인지
    mainRoot: common ? path.dirname(common) : '',
    branch: head.ok ? head.out.trim() : '',   // 비어 있으면 분리된 HEAD
    sha: git(dir, ['rev-parse', 'HEAD']).out.trim(),
  };
}

// 원격 기준 브랜치 후보: 세션이 갈라져 나온 브랜치(sourceBranch)가 먼저, 그다음 흔한 이름. 실제로 있는 것만
function baseCandidates(dir, sourceBranch) {
  const out = [];
  for (const name of [...new Set([sourceBranch, ...BASES].filter(Boolean))]) {
    if (!/^[\w./#-]+$/.test(name)) continue;
    const ref = `refs/remotes/origin/${name}`;
    if (git(dir, ['rev-parse', '--verify', '--quiet', ref]).ok) out.push({ name, ref });
  }
  return out;
}
// 후보 중 어느 하나에라도 병합이 확인되면 그것으로 본다(원격 기준 브랜치에 들어가 있으면 잃지 않는다).
// 어디에도 확인되지 않으면 첫 후보를 기준으로 남은 커밋을 센다
function judge(dir, tip, bases, opts0) {
  const opts = { ...opts0, baseNames: bases.map((b) => b.name) };
  let first = null;
  for (const base of bases) {
    const v = mergeVerdict(dir, tip, base, { ...opts, useGh: false });
    if (v.merged) return { base, ...v };
    first = first || { base, ...v };
  }
  if (opts.useGh && bases.length) { const v = mergeVerdict(dir, tip, bases[0], opts); if (v.merged) return { base: bases[0], ...v }; }
  return first;
}

// 병합 판정: 조상 관계 → 패치 일치 → PR 근거. 확인되지 않으면 merged는 null("모름")이고 지우지 않는다
function mergeVerdict(dir, tip, base, { branch, useGh, baseNames = [base.name] }) {
  if (git(dir, ['merge-base', '--is-ancestor', tip, base.ref]).ok) return { merged: 'ancestor', ahead: 0 };
  const cherry = git(dir, ['cherry', base.ref, tip]);
  const lines = cherry.ok ? cherry.out.split('\n').filter(Boolean) : null;
  const ahead = lines ? lines.filter((l) => l.startsWith('+')).length : null;
  // 패치 일치는 병합 커밋을 보지 않는다. 브랜치에 병합 커밋(충돌을 풀며 고친 내용이 들어갈 수 있다)이 있으면 인정하지 않는다
  const merges = git(dir, ['rev-list', '--merges', '-n', '1', `${base.ref}..${tip}`]);
  if (lines && lines.length && ahead === 0 && merges.ok && !merges.out.trim()) return { merged: 'patch', ahead: 0 };
  // PR 근거는 병합된 PR의 끝 커밋이 지금 브랜치 끝과 같을 때만 쓴다 (PR 뒤에 더 쌓은 커밋을 놓치지 않으려고)
  if (useGh && branch) {
    const r = run('gh', ['pr', 'list', '--head', branch, '--state', 'merged', '--json', 'number,headRefOid,baseRefName', '--limit', '5'], { cwd: dir, timeout: 8_000 });
    if (r.ok) {
      try {
        const hit = JSON.parse(r.out).find((p) => p.headRefOid === tip && baseNames.includes(p.baseRefName));   // 기준 브랜치로 들어간 PR만
        if (hit) return { merged: 'pr', ahead, pr: hit.number };
      } catch { /* 출력 형식이 다름 */ }
    }
  }
  return { merged: null, ahead };
}

const commitLines = (dir, range) => git(dir, ['log', '--format=%h %s', '-n', String(LIST_MAX + 1), range]).out.split('\n').filter(Boolean);

function isGenerated(rel) {
  const parts = rel.replace(/\/$/, '').split('/');
  return parts.some((p) => GENERATED_DIRS.has(p)) || GENERATED_FILE_RE.test(parts[parts.length - 1]);
}
// 원래 저장소의 같은 경로에 같은 내용이 있으면 잃는 것이 아니다 (워크트리를 만들 때 복사해 온 개인 설정 등)
// 폴더는 그 안의 파일(생성물 제외)이 모두 같아야 한다. 파일이 너무 많으면 비교하지 않고 남은 것으로 둔다
function sameInOrigin(dir, origin, rel) {
  if (!origin || origin === dir) return false;
  const budget = { left: 300 };
  const same = (r) => {
    if (--budget.left < 0) return false;
    try {
      const a = fs.lstatSync(path.join(dir, r));
      if (a.isDirectory()) return fs.readdirSync(path.join(dir, r)).every((n) => isGenerated(n) || same(path.join(r, n)));
      const b = fs.lstatSync(path.join(origin, r));
      if (!a.isFile() || !b.isFile() || a.size !== b.size || a.size > 4 * 1024 * 1024) return false;
      return fs.readFileSync(path.join(dir, r)).equals(fs.readFileSync(path.join(origin, r)));
    } catch { return false; }
  };
  return same(rel.replace(/\/$/, ''));
}

// ---- 프로세스 ----
// 작업 폴더가 dir 안인 프로세스. 부모가 사라진 것(PPID 1)만 치울 후보(orphan)로 본다:
// 부모가 있는 것은 세션이나 다른 프로그램이 띄워 쓰고 있는 것이다
function processesIn(dir) {
  const r = run('lsof', ['-a', '-d', 'cwd', '-F', 'pn'], { timeout: 15_000 });
  const out = r.out || '';   // lsof는 일부 프로세스를 못 읽으면 0이 아닌 코드로 끝나도 출력은 준다
  if (!out) return null;
  const pids = [];
  let pid = 0;
  for (const line of out.split('\n')) {
    if (line[0] === 'p') pid = Number(line.slice(1));
    else if (line[0] === 'n' && pid && pid !== process.pid && inside(line.slice(1), dir)) pids.push({ pid, cwd: line.slice(1) });
  }
  return pids.map((p) => ({ ...p, ...procInfo(p.pid) })).filter((p) => p.startedAt);
}
function procInfo(pid) {
  const r = run('ps', ['-o', 'ppid=,lstart=,command=', '-p', String(pid)], { env: { ...process.env, LC_ALL: 'C' } });
  const m = /^\s*(\d+)\s+(\w{3}\s+\w{3}\s+\d+\s+[\d:]+\s+\d{4})\s+(.*)$/.exec((r.out || '').trim());
  if (!m) return {};
  const ports = run('lsof', ['-a', '-p', String(pid), '-iTCP', '-sTCP:LISTEN', '-P', '-n', '-F', 'n']).out || '';
  return {
    ppid: Number(m[1]), startedAt: m[2].replace(/\s+/g, ' '), command: m[3].slice(0, 200),
    ports: [...new Set(ports.split('\n').filter((l) => l[0] === 'n').map((l) => Number(l.split(':').pop())).filter(Boolean))],
  };
}

// ---- 점검 ----
// fetch: 병합 판정 전에 원격 기준 브랜치를 새로 받아 온다(원격 추적 참조만 바뀐다. 실패하면 받아 둔 것으로 판정한다)
// endMode: 종결 명령(/end)용. 병합 기준을 통합 브랜치(dev · main 등)로만 잡고, 워크트리 안 프로세스를 가르지 않은 채로도 돌려준다
function check(sessionId, { useGh = false, fetch = false, endMode = false, now = Date.now() } = {}) {
  const res = { sessionId, at: now, found: false, blockers: [], cleanable: { processes: [], branches: [] }, notes: [], unknowns: [] };
  if (!ID_RE.test(str(sessionId))) { res.error = '세션 id 형식이 올바르지 않습니다'; return res; }
  const { list: all, broken } = loadDesktop();
  const d = all.find((x) => x.sessionId === sessionId || x.cliSessionId === sessionId);
  const cliId = d ? str(d.cliSessionId) : sessionId.startsWith('local_') ? '' : sessionId;
  const state = readState(cliId);
  if (!d && !state) { res.error = '세션을 찾지 못했습니다'; return res; }
  res.found = true;
  res.localId = d ? d.sessionId : null;
  res.cliSessionId = cliId || null;
  res.archived = d ? d.isArchived === true : null;
  res.status = liveStatus(state, now);
  if (!d) res.unknowns.push('Claude 앱 세션 저장 파일에 없는 세션이라 워크트리 · 하위 세션을 확인하지 못했습니다');

  // 하위 세션: 이 세션이 띄웠고 보관되지 않은 것 중 돌고 있는 것
  if (d) {
    const kids = all.filter((x) => x.spawnedFrom && x.spawnedFrom.sessionId === d.sessionId && x.isArchived !== true);
    const running = [], open = [];
    for (const k of kids) {
      const st = liveStatus(readState(str(k.cliSessionId)), now);
      const label = `${str(k.title) || k.sessionId} (${st === 'working' ? '작업 중' : st === 'waiting' ? '입력 대기' : st === 'stale' ? '응답 없음' : st === 'unknown' ? '상태 모름' : '멈춤'})`;
      (st === 'working' || st === 'waiting' ? running : open).push(label);
    }
    if (running.length) res.blockers.push({ kind: 'children', summary: `돌고 있는 하위 세션 ${running.length}개`, items: cap(running) });
    if (open.length) res.notes.push({ kind: 'children-open', summary: `보관하지 않은 하위 세션 ${open.length}개`, items: cap(open) });
  }
  // 서브에이전트: 세션이 끝났으면 돌고 있을 수 없다 (백그라운드 에이전트는 끝 이벤트가 안 와서 상태가 남는다)
  if (state && state.status !== 'ended' && Array.isArray(state.agents)) {
    const agents = state.agents.filter((a) => a && (a.status === 'running' || a.status === 'background'))
      .map((a) => `${str(a.type) || 'subagent'}: ${str(a.description).slice(0, 80)}`);
    if (agents.length) res.blockers.push({ kind: 'agents', summary: `돌고 있는 서브에이전트 ${agents.length}개`, items: cap(agents) });
  }

  const dir = d ? dirOf(d) : str(state && state.cwd);
  const origin = d ? str(d.originCwd) : '';
  res.dir = tilde(dir);
  res.origin = tilde(origin);
  if (!dir || !isDir(dir)) {
    res.worktree = { exists: false };
    if (dir) res.notes.push({ kind: 'gone', summary: '세션 폴더가 이미 없습니다', items: [tilde(dir)] });
    return res;
  }
  const info = gitInfo(dir);
  if (!info) { res.worktree = { exists: true, git: false }; res.notes.push({ kind: 'nogit', summary: '깃 저장소가 아니라 변경 · 병합을 점검하지 않았습니다', items: [] }); return res; }
  // 워크트리 세션: 깃이 연결된 워크트리라고 하고, 세션 폴더가 그 워크트리 꼭대기 안이며, 원래 폴더와 다르다
  // 그리고 앱이 만든 워크트리여야 한다(저장 파일에 워크트리 경로가 있거나 .claude/worktrees 아래). 사용자가 직접 만들어 오래 쓰는 워크트리는 치우는 대상이 아니다
  const appMade = (d && str(d.worktreePath)) || info.top.includes('/.claude/worktrees/');
  const isWorktree = !!appMade && info.linked && inside(dir, info.top) && path.resolve(info.top) !== path.resolve(origin || info.mainRoot);
  res.worktree = { exists: true, git: true, linked: isWorktree, path: tilde(info.top) };
  res.branch = info.branch || null;
  const wt = info.top;
  // 같은 폴더를 쓰는 다른 열린 세션이 있으면 치우지 않는다
  const appSharers = d ? all.filter((x) => x.sessionId !== d.sessionId && x.isArchived !== true && inside(dirOf(x), wt)) : [];
  // 터미널 · Codex 세션은 앱 저장 파일에 없다. 대시보드 상태 파일에서 끝나지 않은 세션도 센다(앱 세션과 겹치는 것은 뺀다)
  const known = new Set(appSharers.map((x) => str(x.cliSessionId)));
  const live = liveStatesIn(wt, cliId);
  const sharers = [...appSharers.map((x) => str(x.title) || x.sessionId), ...(live || []).filter((x) => !known.has(x.id)).map((x) => x.title)];
  res.sharedWith = cap(sharers);
  // 치워도 되는 조건: 이 세션의 저장 파일을 읽었고, 다른 세션 파일도 모두 읽었고, 같은 폴더를 쓰는 열린 세션이 없다
  const sure = !!d && broken === 0 && live !== null;
  if (isWorktree && !sure) res.unknowns.push('세션 저장 파일 일부를 읽지 못해 같은 워크트리를 쓰는 세션을 다 확인하지 못했습니다. 프로세스 · 브랜치를 건드리지 않습니다');
  const touchable = isWorktree && sure && sharers.length === 0;
  // 깃 점검을 하지 못한 것은 워크트리 세션에서는 남은 것으로 본다(확인되지 않으면 보관하지 않는다)
  const unverified = [];
  const unsure = (msg) => (isWorktree ? unverified : res.unknowns).push(msg);
  if (isWorktree && sharers.length) res.notes.push({ kind: 'shared', summary: `다른 열린 세션 ${sharers.length}개가 같은 워크트리를 쓰고 있어 프로세스 · 브랜치를 건드리지 않습니다`, items: cap(sharers) });
  const put = (entry) => (isWorktree ? res.blockers : res.notes).push(entry);

  // 커밋 전 변경
  const status = git(wt, ['status', '--porcelain', '--ignored']);
  if (!status.ok) unsure('git status를 읽지 못해 커밋 전 변경을 확인하지 못했습니다');
  else {
    const lines = status.out.split('\n').filter(Boolean);
    // 추적하지 않는 것 중 도구가 저장소 꼭대기에 남기는 것(브라우저 도구 스냅숏 폴더 등)만 뺀다
    const dirty = lines.filter((l) => !l.startsWith('!!') && !(l.startsWith('?? ') && UNTRACKED_SKIP.has(l.slice(3).replace(/\/$/, '')))).map((l) => l.trim());
    if (dirty.length) put({ kind: 'dirty', n: dirty.length, summary: `커밋 전 변경 ${dirty.length}개`, items: cap(dirty) });
    const ignored = lines.filter((l) => l.startsWith('!!')).map((l) => l.slice(3).replace(/^"|"$/g, ''))
      .filter((rel) => !isClaudeDir(rel) && !isGenerated(rel) && !sameInOrigin(wt, isWorktree ? (origin || info.mainRoot) : '', rel));
    if (ignored.length && isWorktree) res.blockers.push({ kind: 'ignored', summary: `깃이 무시하는 파일 ${ignored.length}개 (워크트리와 함께 사라집니다)`, items: cap(ignored) });
  }
  // 스태시는 저장소 단위다. 이 브랜치에서 만든 것만 이 세션 것으로 본다
  if (info.branch) {
    const stash = git(wt, ['stash', 'list', '--format=%gd %gs']).out.split('\n').filter((l) => l.toLowerCase().includes(` on ${info.branch.toLowerCase()}:`));   // 'WIP on <브랜치>:' · 'On <브랜치>:'
    if (stash.length) put({ kind: 'stash', summary: `이 브랜치에서 만든 스태시 ${stash.length}개`, items: cap(stash) });
  }

  // 병합 판정
  const hasOrigin = git(wt, ['remote']).out.split('\n').includes('origin');
  if (fetch && hasOrigin && !git(wt, ['fetch', '--quiet', 'origin'], { timeout: 15_000 }).ok) res.notes.push({ kind: 'fetch', summary: '원격을 새로 받아 오지 못해 받아 둔 상태로 병합을 판정했습니다', items: [] });
  // 종결 명령은 dev 계열로만 병합한다. main · master는 기준으로 쓰지 않고, dev 계열이 원격에 없으면 사용자에게 묻게 한다(noBase)
  const bases = endMode ? baseCandidates(wt, '').filter((b) => END_BASES.includes(b.name)) : baseCandidates(wt, d ? str(d.sourceBranch) : '');
  if (!info.sha) unsure('커밋이 없는 저장소라 병합을 확인하지 못했습니다');
  else if (!bases.length && endMode) res.noBase = true;
  else if (!bases.length) unsure('원격 기준 브랜치(origin/dev · main 등)를 찾지 못해 병합을 확인하지 못했습니다');
  else {
    const v = judge(wt, info.sha, bases, { branch: info.branch, useGh });
    const base = v.base;
    res.base = `origin/${base.name}`;
    res.merge = { merged: v.merged, ahead: v.ahead, pr: v.pr ?? null };
    if (!v.merged) {
      const commits = commitLines(wt, `${base.ref}..${info.sha}`);
      const known = d && Array.isArray(d.prs) ? d.prs.filter((p) => p && p.branch === info.branch && p.state === 'MERGED').map((p) => `#${p.prNumber}`) : [];
      put({
        kind: 'unmerged', n: v.ahead ?? commits.length,
        summary: `${res.base}에 병합이 확인되지 않은 커밋 ${v.ahead ?? commits.length}개${known.length ? ` (PR ${known.join(' · ')}는 병합됨. 스쿼시 병합이면 깃으로는 확인되지 않습니다)` : ''}`,
        items: cap(commits),
      });
    } else if (touchable && info.branch && !BASES.includes(info.branch) && info.branch !== str(d.sourceBranch)) {
      // 지울 수 있는지는 부르는 쪽이 지우기 직전에 다시 본다 (sha가 그대로인지, 어느 워크트리도 쓰고 있지 않은지)
      res.cleanable.branches.push({ name: info.branch, sha: info.sha, merged: v.merged, base: base.name, repo: info.mainRoot, checkedOutAt: tilde(wt) });
    }
  }

  if (unverified.length) res.blockers.push({ kind: 'unverified', summary: '확인하지 못해 보관하지 않습니다', items: unverified });

  // 프로세스 (워크트리 세션만: 원래 저장소 폴더의 프로세스는 어느 세션 것인지 가릴 수 없다)
  if (isWorktree) {
    const procs = processesIn(wt);
    if (!procs) res.unknowns.push('lsof를 돌리지 못해 프로세스를 확인하지 못했습니다');
    else {
      if (endMode) res.procs = procs;
      // 이 세션이 만들어진 뒤에 뜬 것만 치울 후보다(그 전부터 떠 있던 것은 이 세션이 띄운 것이 아니다)
      const born = d && Number.isFinite(d.createdAt) ? d.createdAt : Infinity;
      const mine = (p) => p.ppid === 1 && Date.parse(p.startedAt) >= born - 60_000;
      const orphans = procs.filter((p) => p.ppid === 1);
      const owned = procs.filter((p) => p.ppid !== 1);
      if (touchable) res.cleanable.processes = orphans.filter(mine);
      const left = touchable ? orphans.filter((p) => !mine(p)) : orphans;
      if (left.length) res.notes.push({ kind: 'processes-left', summary: `워크트리 안 프로세스 ${left.length}개 (건드리지 않음)`, items: left.map((p) => `${p.pid} ${p.command}`) });

      if (owned.length) res.notes.push({ kind: 'processes-owned', summary: `세션 등이 띄워 쓰고 있는 프로세스 ${owned.length}개 (부모가 살아 있어 건드리지 않습니다)`, items: cap(owned.map((p) => `${p.pid}${p.ports.length ? ` :${p.ports.join(',')}` : ''} ${p.command}`)) });
    }
  }
  return res;
}

// ---- 종결 명령(/end)용 짧은 결과 (WEB-48) ----
// 한 번 실행으로 판단에 필요한 것만 낸다. 읽기만 한다(원격 받기 · gh 조회 포함). 비어 있는 항목은 빼고 한 줄 JSON으로 낸다.
const PROJECTS_DIR = path.join(HOME, '.claude', 'projects');
// 대화 크기: 이 세션 기록의 마지막 응답 사용량(입력 + 캐시 읽기 + 캐시 쓰기). 못 읽으면 null
function transcriptTail(cliId) {
  if (!cliId || !new RegExp(`^${UUID}$`, 'i').test(cliId)) return null;
  try {
    for (const dir of fs.readdirSync(PROJECTS_DIR)) {
      const file = path.join(PROJECTS_DIR, dir, `${cliId}.jsonl`);
      if (!fs.existsSync(file)) continue;
      const size = fs.statSync(file).size;
      const len = Math.min(size, 4 * 1024 * 1024);
      const buf = Buffer.alloc(len);
      const fd = fs.openSync(file, 'r');
      try { fs.readSync(fd, buf, 0, len, size - len); } finally { fs.closeSync(fd); }
      return buf.toString('utf8').split('\n');
    }
  } catch { /* 기록 없음 */ }
  return null;
}
// 압축 직후에는 새 응답이 없어 마지막 사용량이 압축 전 값이다. 그때는 압축 기록의 요약 크기를 낸다(실제보다 작게 나온다)
function contextTokens(cliId) {
  const lines = transcriptTail(cliId);
  if (!lines) return null;
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i];
    if (l.includes('"compact_boundary"')) {
      try { const j = JSON.parse(l); if (j.subtype === 'compact_boundary') return j.compactMetadata?.postTokens || 0; } catch { /* 잘린 줄 */ }
    }
    if (!l.includes('"usage"') || l.includes('"isSidechain":true')) continue;
    try {
      const u = JSON.parse(l).message?.usage;
      const n = u ? (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0) : 0;
      if (n > 0) return n;
    } catch { /* 잘린 첫 줄 */ }
  }
  return null;
}
// 마지막 압축 기록의 시각(ms). 없으면 0
function lastCompactAt(cliId) {
  const lines = transcriptTail(cliId) || [];
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].includes('"compact_boundary"')) continue;
    try { const j = JSON.parse(lines[i]); if (j.subtype === 'compact_boundary') return Date.parse(j.timestamp) || 0; } catch { /* 잘린 줄 */ }
  }
  return 0;
}
// 이 워크트리에서 띄운 도커: 컴포즈를 띄운 폴더가 워크트리 안인 묶음, 워크트리 폴더를 물고 있는 그 밖의 컨테이너. 도커가 없거나 꺼져 있으면 null
function dockerIn(dir) {
  const ids = run('docker', ['ps', '-aq'], { timeout: 4_000 });
  if (!ids.ok) return null;
  const list = ids.out.split('\n').filter(Boolean);
  if (!list.length) return { compose: [], containers: [] };
  const fmt = '{{.Name}}\t{{index .Config.Labels "com.docker.compose.project"}}\t{{index .Config.Labels "com.docker.compose.project.working_dir"}}\t{{range .Mounts}}{{.Source}}|{{end}}';
  const r = run('docker', ['inspect', '--format', fmt, ...list], { timeout: 6_000 });
  if (!r.ok) return null;
  // 묶음 이름이 원래 폴더와 겹칠 수 있다(COMPOSE_PROJECT_NAME). 그 묶음의 컨테이너가 모두 워크트리 안일 때만 묶음째 내리게 하고, 아니면 워크트리 쪽 컨테이너만 낸다
  const groups = new Map(), containers = [];
  for (const line of r.out.split('\n').filter(Boolean)) {
    const [raw, project, wd, mounts = ''] = line.split('\t');
    const name = raw.replace(/^\//, '');
    const mine = project ? inside(wd, dir) : mounts.split('|').some((m) => inside(m, dir));
    if (project) { const g = groups.get(project) || { wd, mine: [], other: 0 }; if (mine) g.mine.push(name); else g.other++; groups.set(project, g); }
    else if (mine) containers.push(name);
  }
  const compose = [];
  for (const [project, g] of groups) {
    if (!g.mine.length) continue;
    if (g.other) containers.push(...g.mine); else compose.push({ project, dir: tilde(g.wd) });
  }
  return { compose, containers };
}
// 이 스크립트를 부른 쪽(세션의 claude 프로세스와 그 셸)은 내릴 대상이 아니다
function ancestors() {
  const set = new Set([process.pid]);
  let pid = process.ppid;
  for (let i = 0; i < 20 && pid > 1 && !set.has(pid); i++) {
    set.add(pid);
    pid = Number(run('ps', ['-o', 'ppid=', '-p', String(pid)]).out.trim()) || 0;
  }
  return set;
}
// 로드맵에서 진행 중([~])인 항목. 어느 세션 것인지는 가리지 못해 프로젝트의 것을 모두 낸다
function inProgress(folder) {
  if (!folder) return [];
  let project = folder;
  try {
    const projects = JSON.parse(fs.readFileSync(path.join(WD, 'config.json'), 'utf8')).projects || {};
    for (const [k, v] of Object.entries(projects)) if (Array.isArray(v && v.folders) && v.folders.includes(folder)) project = k;
  } catch { /* 설정 없음 */ }
  try {
    return fs.readFileSync(path.join(WD, 'roadmaps', `${project}.md`), 'utf8').split('\n')
      .filter((l) => /^\s*- \[~\]/.test(l)).map((l) => l.replace(/^\s*- \[~\]\s*/, '').replace(/\s*\((after|by):.*$/, '').slice(0, 80));
  } catch { return []; }
}
function brief(sessionId, opts = {}) {
  const r = check(sessionId, { useGh: true, fetch: true, endMode: true, ...opts });
  if (r.error) return { ok: false, error: r.error };
  const all = [...r.blockers, ...r.notes];
  const of = (kind) => all.find((e) => e.kind === kind);
  const untilde = (p) => (p && p.startsWith('~') ? HOME + p.slice(1) : p);
  const wt = r.worktree && r.worktree.path ? untilde(r.worktree.path) : '';
  const isWt = !!(r.worktree && r.worktree.linked);
  const out = { ok: true, id: str(r.cliSessionId).slice(0, 8), tokens: contextTokens(r.cliSessionId), archived: r.archived || undefined, worktree: isWt, dir: r.worktree && r.worktree.path || r.dir, branch: r.branch };
  if (r.worktree && r.worktree.exists === false) { out.gone = true; return out; }
  const kids = of('children'), agents = of('agents');
  if (kids || agents) out.running = { ...(kids ? { sessions: kids.items } : {}), ...(agents ? { agents: agents.items } : {}) };
  if (of('children-open')) out.openChildren = of('children-open').items;
  if (r.sharedWith && r.sharedWith.length) out.sharedWith = r.sharedWith;
  const dirty = of('dirty');
  if (dirty) out.dirty = { n: dirty.n, files: dirty.items };
  if (of('stash')) out.stash = of('stash').items;
  // 원래 체크아웃: 6단계(당겨 받기)에서 쓴다
  const origin = untilde(r.origin);
  if (isWt && origin && isDir(origin)) {
    const st = git(origin, ['status', '--porcelain']);
    const files = st.ok ? st.out.split('\n').filter(Boolean).map((l) => l.trim()) : null;
    out.origin = { dir: r.origin, branch: git(origin, ['symbolic-ref', '--quiet', '--short', 'HEAD']).out.trim() || null, dirty: files ? files.length : null, ...(files && files.length ? { files: cap(files) } : {}) };
  }
  // 병합: base는 병합할 통합 브랜치. ahead가 0이고 merged가 있으면 병합할 것이 없다
  if (r.base) {
    const un = of('unmerged');
    out.merge = { base: r.base.replace(/^origin\//, ''), merged: r.merge.merged, ahead: un ? un.n : 0, ...(un ? { commits: un.items } : {}) };
    if (un && r.branch && wt) {
      const pr = run('gh', ['pr', 'list', '--head', r.branch, '--state', 'open', '--json', 'number,baseRefName', '--limit', '3'], { cwd: wt, timeout: 8_000 });
      try { const list = JSON.parse(pr.out); if (list.length) out.merge.openPr = list.map((p) => ({ number: p.number, base: p.baseRefName })); } catch { out.merge.openPr = 'unknown'; }
      const up = git(wt, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${r.branch}`]);
      out.merge.pushed = up.ok && up.out.trim() === git(wt, ['rev-parse', 'HEAD']).out.trim();
    }
    if (r.branch && BASES.includes(r.branch)) out.merge.onBase = true;   // 통합 브랜치에서 직접 일한 세션: PR을 만들 수 없다
  } else if (r.noBase) out.merge = { base: null };   // 원격에 dev 계열 브랜치가 없다: 어디로 병합할지 사용자에게 묻는다
  // 프로세스: 포트를 열고 있거나 부모가 사라진 것만 내릴 후보. 같은 워크트리를 쓰는 열린 세션이 있으면 내지 않는다
  if (r.procs && !(r.sharedWith && r.sharedWith.length)) {
    const mine = ancestors();
    const rest = r.procs.filter((p) => !mine.has(p.pid));
    const stop = rest.filter((p) => p.ports.length || p.ppid === 1);
    if (stop.length) out.processes = stop.map((p) => ({ pid: p.pid, started: p.startedAt, ...(p.ports.length ? { ports: p.ports } : {}), cmd: p.command.slice(0, 80) }));
    if (rest.length - stop.length) out.otherProcesses = rest.length - stop.length;
  }
  if (isWt && wt) {
    const dk = dockerIn(wt);
    if (dk && (dk.compose.length || dk.containers.length)) out.docker = dk;
  }
  if (of('ignored')) out.ignored = of('ignored').items;
  const todo = inProgress(path.basename(origin || wt || ''));
  if (todo.length) out.inProgress = todo;
  const unknowns = [...r.unknowns, ...(of('unverified') ? of('unverified').items : []), ...(of('fetch') ? [of('fetch').summary] : [])];
  if (unknowns.length) out.unknowns = unknowns;
  return out;
}

module.exports = { check, brief, contextTokens, lastCompactAt, isArchived, loadDesktop, liveStatesIn, procInfo, gitInfo, mergeVerdict, baseCandidates, judge, inside, BASES };

if (require.main === module) {
  const args = process.argv.slice(2);
  const id = args.find((a) => !a.startsWith('--'));
  if (!id) { console.error('사용법: node closeout.js <세션 id | local_… id> [--gh] [--fetch]'); process.exit(2); }
  if (args.includes('--end')) { const b = brief(id); console.log(JSON.stringify(b)); process.exit(b.ok ? 0 : 1); }
  // --end-check: 종결 기준(dev 계열로만 병합 판정)으로 점검하되 결과 전체를 낸다(대시보드가 보관 뒤 정리를 등록할 때 쓴다)
  const r = check(id, { useGh: args.includes('--gh'), fetch: args.includes('--fetch'), endMode: args.includes('--end-check') });
  console.log(JSON.stringify(r, null, 2));
  process.exit(r.error ? 1 : 0);
}
