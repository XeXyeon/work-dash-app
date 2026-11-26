#!/usr/bin/env node
// Codex 넘기기 명령 (CDX-3, 정의서 CDX-1 `확정 사항`): 지휘 세션이 항목 ID 하나로 부르면
// 항목 워크트리를 만들고 → 의존성을 깔고 → Codex를 비대화식으로 돌린 뒤 → 확인(check.js 설정)을 돌리고 →
// 받을 조건을 다 맞으면 한 커밋 한다. stdout에는 20줄 안의 결과 요약만 낸다(Codex의 진행 출력은 기록 파일로).
//
//   node ~/.work-dash/app/core/cdx.js <ID> [--base <브랜치>] [--timeout <분>]   새로 넘기기
//   node ~/.work-dash/app/core/cdx.js <ID> --answer "<답>" [--timeout <분>]     멈춘 넘기기에 답하고 이어 가기
//
// 권한(사용자 확정 2026-11-26): 파일 쓰기는 워크트리 안만(workspace-write), 네트워크는 연다. 승인 우회 옵션은 쓰지 않는다.
// workspace-write의 Codex는 .git에 쓸 수 없으므로 커밋은 이 명령이 한다. 푸시 · PR은 하지 않는다(지휘 세션 몫).
// 기록: data/handoff/<프로젝트>-<ID>-<시각>.jsonl(Codex 이벤트), data/handoff/log.jsonl(넘기기마다 한 줄),
//       data/handoff/<프로젝트>-<ID>.json(이어 가기용 상태). CDX_CODEX_BIN으로 codex 실행 파일을 바꿀 수 있다(시험용).
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync, execFileSync } = require('child_process');
const { WD } = require('./paths');
const { projectName } = require('./scope');
const { loadConfig, changedFiles, plan, globRe } = require('./check');
const { check: commitProblems } = require('./cmdcheck');

const CLI = 'node ~/.work-dash/app/core/cdx.js';
const CODEX = process.env.CDX_CODEX_BIN || 'codex';
const DIR = path.join(WD, 'data', 'handoff');
const DEFAULT_TIMEOUT_MIN = 30;
const REVIEW_LINES = 50;
// Codex가 고치면 실패로 돌리는 곳: 에이전트 규칙 · 설정
// .work-dash-checks.json: 사용자 쪽 확인 설정이 없으면 이 명령이 그 파일의 명령을 확인으로 돌린다
const PROTECTED = ['AGENTS.md', '**/AGENTS.md', 'CLAUDE.md', '**/CLAUDE.md', '.claude/**', '.codex/**', '**/hooks.json', '**/settings.json', '**/settings.local.json',
  '.work-dash-checks.json', '.husky/**', '.githooks/**'];
// 틀리면 숨는 곳: 닿으면 Opus 검토를 건다 (검사 · 훅 · 설치 · 데이터 파서 · 권한 · 마이그레이션)
const HIDDEN = ['core/*check*.js', 'core/doclint.js', 'core/hooklog.js', 'core/oncerule.js', 'core/paths.js', 'core/roadmap.js', 'core/issues.js', 'core/item.js', 'core/cdx.js',
  'bin/install.js', '.gitignore', '**/.gitignore', '**/migrations/**', '**/*.sql', 'desktop/tauri.conf.json', 'desktop/capabilities/**'];
const ID_RE = /^[A-Z][A-Z0-9]*-\d+$/;
const STATUSES = new Set(['done', 'blocked', 'failed']);

const HEAD = `너는 work-dash의 넘기기 명령이 띄운 구현 담당이다. 아래 작업 카드의 \`확정 사항\`(없으면 \`정의서\`) 절대로 이 워크트리에서 구현한다. 한국어로 답한다.

규칙:
- 이 폴더(현재 작업 폴더) 안의 파일만 고친다. 커밋 · 푸시 · 브랜치 변경은 하지 않는다(넘기기 명령이 확인 뒤 커밋한다). 작업 카드 · 로드맵 · \`~/.work-dash\`는 쓰지 않는다.
- 서버 · 앱 · 개발 서버를 띄우지 않는다.
- \`AGENTS.md\` · \`CLAUDE.md\` · \`.claude/\` · \`.codex/\` · 훅 · 설정 파일은 고치지 않는다.
- 카드의 검증 명령을 돌려 통과시킨다. 샌드박스 때문에 못 도는 확인은 건너뛰고 \`notes\`에 적는다.
- 아래 경우에는 고친 것을 그대로 두고 \`status: "blocked"\`로 끝내며 \`questions\`에 무엇을 정해야 하는지 적는다: 정의서에 없는 설계 선택이 필요함, 정의서에 없는 의존성 추가가 필요함, 정의서와 코드가 다름, 범위 밖 파일을 고쳐야 함, 샌드박스에 막힘, 같은 확인이 3번 실패함.
- 정의서가 정하지 않은 작은 선택(이름 · 메시지 문구 등)은 해도 되지만 \`decisions\`에 한 줄씩 적는다. 설계를 바꾸는 선택은 하지 말고 blocked로 묻는다.
- 마지막 응답은 지정된 JSON 형식만 낸다: \`status\`(done|blocked|failed), \`summary\`(무엇을 바꿨는지 최대 5줄), \`questions\`, \`decisions\`, \`commit_message\`(\`feat: …\`처럼 \`종류: 제목\` 한 줄 + 빈 줄 + 왜 그렇게 했는지 본문. 항목 ID는 넣지 않는다), \`notes\`(돌린 검증과 결과).

--- 작업 카드 ---
`;
const SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['status', 'summary', 'questions', 'decisions', 'commit_message', 'notes'],
  properties: {
    status: { type: 'string', enum: ['done', 'blocked', 'failed'] },
    summary: { type: 'array', items: { type: 'string' } },
    questions: { type: 'array', items: { type: 'string' } },
    decisions: { type: 'array', items: { type: 'string' } },
    commit_message: { type: 'string' },
    notes: { type: 'string' },
  },
};

const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 }).trim();
const now = () => new Date();
const stamp = (d) => `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}-${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}${String(d.getSeconds()).padStart(2, '0')}`;
const short = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

function parseArgs(argv) {
  const out = { id: null, base: null, answer: null, timeout: DEFAULT_TIMEOUT_MIN };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--base' || a === '--answer' || a === '--timeout') {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} 뒤에 값이 없다`);
      if (a === '--timeout') {
        out.timeout = Number(v);
        if (!(out.timeout > 0 && out.timeout <= 240)) throw new Error('--timeout은 1~240분이다');
      } else out[a.slice(2)] = v;
    } else if (a === '--help' || a === '-h') out.help = true;
    else if (!out.id && !a.startsWith('--')) out.id = a;
    else throw new Error(`모르는 인자: ${a}`);
  }
  return out;
}

// 지휘 세션 폴더 → 본 저장소 루트(워크트리면 그 원래 저장소)
function mainRoot(cwd) {
  const top = git(cwd, 'rev-parse', '--show-toplevel');
  const common = path.resolve(top, git(cwd, 'rev-parse', '--git-common-dir'));
  return { top, root: path.basename(common) === '.git' ? path.dirname(common) : top };
}

function readCard(project, id) {
  const file = path.join(WD, 'worklogs', project, `${id}.md`);
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return { file, error: `작업 카드가 없다(${file}) → 정의서를 카드에 쓴 뒤 넘긴다` }; }
  if (!/^## (확정 사항|정의서)(?:\s|$)/m.test(text)) return { file, error: '카드에 `## 확정 사항`이나 `## 정의서` 절이 없다 → 정의서를 쓴 뒤 넘긴다' };
  return { file, text, opus: /^\s*-?\s*검토:\s*Opus\b/mi.test(text) };
}

function validResult(r) {
  if (!r || typeof r !== 'object' || !STATUSES.has(r.status)) return false;
  for (const k of ['summary', 'questions', 'decisions']) if (!Array.isArray(r[k]) || !r[k].every((x) => typeof x === 'string')) return false;
  return typeof r.commit_message === 'string' && typeof r.notes === 'string';
}

function install(wt, logFd) {
  if (!fs.existsSync(path.join(wt, 'package.json')) || fs.existsSync(path.join(wt, 'node_modules'))) return null;
  const cmd = fs.existsSync(path.join(wt, 'package-lock.json')) ? ['ci', '--no-audit', '--no-fund'] : ['install', '--no-audit', '--no-fund'];
  const r = spawnSync('npm', cmd, { cwd: wt, stdio: ['ignore', logFd, logFd], timeout: 10 * 60000 });
  return r.status === 0 ? null : `의존성 설치 실패(npm ${cmd[0]})`;
}

// Codex를 돌린다. stdout(JSONL 이벤트)은 기록 파일로, 첫 thread.started에서 세션 id를 얻는다
function runCodex(args, input, cwd, logFile, timeoutMin) {
  return new Promise((resolve) => {
    const out = fs.openSync(logFile, 'a');
    // 프로세스 그룹으로 띄워 시간 제한 때 codex가 띄운 셸 · npm 자식까지 함께 끝낸다
    const child = spawn(CODEX, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
    const killAll = (sig) => { try { process.kill(-child.pid, sig); } catch { try { child.kill(sig); } catch {} } };
    let thread = null;
    let buf = '';
    let err = '';
    let timedOut = false;
    let done = false;
    child.stdout.on('data', (d) => {
      if (done) return;   // 끝낸 뒤(fd를 닫은 뒤) 남은 자식이 쓴 출력은 버린다
      fs.writeSync(out, d);
      if (thread) return;
      buf += d.toString('utf8');
      for (const line of buf.split('\n')) {
        try { const ev = JSON.parse(line); if (ev.type === 'thread.started' && ev.thread_id) { thread = ev.thread_id; break; } } catch {}
      }
      if (buf.length > 1e6) buf = '';
    });
    child.stderr.on('data', (d) => { err = (err + d.toString('utf8')).slice(-4000); });
    const timer = setTimeout(() => {
      timedOut = true;
      killAll('SIGTERM');
      setTimeout(() => killAll('SIGKILL'), 10000).unref();
    }, timeoutMin * 60000);
    const end = (code) => {
      if (done) return;
      done = true;
      child.stdout.destroy();
      child.stderr.destroy();
      clearTimeout(timer);
      fs.closeSync(out);
      resolve({ code, thread, timedOut, err: err.trim() });
    };
    child.on('error', (e) => { err += String(e.message); end(null); });
    child.on('close', end);
    // 자식이 파이프를 물고 남아 close가 안 올 때: codex가 끝나면 그룹을 정리하고 잠시 뒤 끝낸다
    child.on('exit', (code) => { killAll('SIGKILL'); setTimeout(() => end(code), 2000).unref(); });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

// 워크트리 변경: 스테이징해서 줄 수까지 센다(커밋 전 단계라 스테이징은 남아도 된다).
// -z · --no-renames: 이름 바꾸기(`a => b`)나 따옴표로 감싼 경로가 보호 경로 검사를 비켜 가지 않게
function changes(wt) {
  git(wt, 'add', '-A');
  const rows = [];
  for (const rec of git(wt, 'diff', '--cached', '--numstat', '-z', '--no-renames').split('\0')) {
    const m = rec.match(/^(-|\d+)\t(-|\d+)\t([\s\S]+)$/);
    if (m) rows.push({ file: m[3], add: Number(m[1]) || 0, del: Number(m[2]) || 0 });
  }
  // .gitignore에 걸려 스테이징되지 않는 새 파일(예: .claude/settings.local.json)도 보호 경로 검사에 넣는다
  // --directory는 통째로 무시된 폴더를 `.claude/` 한 줄로 낸다 → 폴더는 그 안의 가상 경로로 바꿔 `.claude/**` 같은 글롭에 걸리게 한다
  const ignored = git(wt, 'ls-files', '-z', '-o', '-i', '--exclude-standard', '--directory').split('\0').filter(Boolean)
    .flatMap((f) => (f.endsWith('/') ? [f.slice(0, -1), `${f}__cdx_dir__`] : [f]));
  return { rows, ignored, add: rows.reduce((n, r) => n + r.add, 0), del: rows.reduce((n, r) => n + r.del, 0) };
}

const hits = (files, globs) => { const res = globs.map(globRe); return files.filter((f) => res.some((r) => r.test(f))); };

function runChecks(wt, base, logFd) {
  const { config, error, shown } = loadConfig(wt);
  if (error || !config) return { error: `확인 설정 ${error ? `오류(${shown})` : `없음 → \`node ~/.work-dash/app/core/check.js --init\``}` };
  const prev = process.env.CHECK_BASE;
  process.env.CHECK_BASE = base;
  let files;
  try { files = changedFiles(wt).files; } finally { if (prev === undefined) delete process.env.CHECK_BASE; else process.env.CHECK_BASE = prev; }
  const list = plan(config, files);
  // 확인 명령은 Codex가 고친 코드(package.json scripts · 테스트 · 빌드 스크립트)를 실행하므로
  // Codex와 같은 샌드박스(워크트리만 쓰기, 네트워크 꺼짐) 안에서 돌린다
  const results = list.map(({ run }) => {
    fs.writeSync(logFd, `\n[cdx] $ ${run}\n`);
    const r = spawnSync(CODEX, ['sandbox', '-c', 'sandbox_mode="workspace-write"', '--', 'sh', '-c', run], { cwd: wt, stdio: ['ignore', logFd, logFd], timeout: 15 * 60000 });
    return { run, ok: r.status === 0 };
  });
  return { results };
}

function review(wt, commit, logFile, timeoutMin, tmp) {
  const out = path.join(tmp, 'review.txt');
  const args = ['exec', 'review', '--commit', commit, '-c', 'sandbox_mode="read-only"', '-o', out, '--json'];
  return runCodex(args, '', wt, logFile, Math.min(timeoutMin, 20)).then((r) => {
    let text = '';
    try { text = fs.readFileSync(out, 'utf8').trim(); } catch {}
    return r.code === 0 && text ? text.split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 4) : [`codex review 실패(exit ${r.code})`];
  });
}

async function main(argv) {
  let o;
  try { o = parseArgs(argv); } catch (e) { console.error(`[cdx] ${e.message} → ${CLI} --help`); return 2; }
  if (o.help || !o.id) { console.log(`${CLI} <ID> [--base <브랜치>] [--timeout <분>]   항목을 Codex에 넘긴다\n${CLI} <ID> --answer "<답>" [--timeout <분>]      멈춘 넘기기에 답하고 이어 간다\n  기본 시간 제한 ${DEFAULT_TIMEOUT_MIN}분. 결과 요약만 출력한다. 기록: ~/.work-dash/data/handoff/`); return o.help ? 0 : 2; }
  if (!ID_RE.test(o.id)) { console.error(`[cdx] 항목 ID 형식이 아니다: ${o.id}`); return 2; }
  const cwd = process.cwd();
  let top;
  let root;
  try { ({ top, root } = mainRoot(cwd)); } catch { console.error('[cdx] git 저장소 안이 아니다 → 넘길 저장소 폴더에서 부른다'); return 2; }
  const project = projectName(cwd);
  if (!project) { console.error('[cdx] work-dash가 관리하는 프로젝트가 아니다'); return 2; }
  const card = readCard(project, o.id);
  if (card.error) { console.error(`[cdx] ${card.error}`); return 2; }

  const wt = path.join(root, '.claude', 'worktrees', `cdx-${o.id.toLowerCase()}`);
  const branch = `cdx/${o.id}`;
  const stateFile = path.join(DIR, `${project}-${o.id}.json`);
  fs.mkdirSync(DIR, { recursive: true });
  let state = null;
  if (o.answer !== null) {
    try { state = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch {}
    if (!state?.thread || !fs.existsSync(wt)) { console.error(`[cdx] 이어 갈 넘기기가 없다(${state?.thread ? `워크트리 없음: ${wt}` : '세션 id 기록 없음'}) → --answer 없이 새로 넘긴다`); return 2; }
    if (state.outcome === '통과') { console.error(`[cdx] 이 넘기기는 이미 통과해 커밋했다(${state.commit || ''}) → 고칠 것이 있으면 새 항목으로 넘긴다`); return 2; }
  } else {
    if (fs.existsSync(wt)) { console.error(`[cdx] 워크트리가 이미 있다: ${wt} → 멈춘 넘기기면 --answer로 이어 가고, 버릴 거면 \`git worktree remove\` · 브랜치 삭제 뒤 다시 부른다`); return 2; }
    try { git(root, 'rev-parse', '--verify', '-q', `refs/heads/${branch}`); console.error(`[cdx] 브랜치 ${branch}가 이미 있다 → 지운 뒤 다시 부른다`); return 2; } catch {}
    fs.rmSync(stateFile, { force: true });   // 예전 넘기기의 세션 id를 이어받지 않게
  }
  // 임시 파일(결과 JSON · 커밋 메시지 · 리뷰)은 이 실행만의 폴더에 두고 끝날 때 지운다
  const tmp = fs.mkdtempSync(path.join(DIR, 'tmp-'));
  process.on('exit', () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} });
  // 기준 기본값: dev가 있으면 dev(세션 워크트리는 main에서 잘려 낡았을 수 있다, CDX-2), 없으면 지금 브랜치
  const hasDev = (() => { try { git(root, 'rev-parse', '--verify', '-q', 'refs/heads/dev'); return true; } catch { return false; } })();
  const base = o.answer !== null ? state.base : (o.base || (hasDev ? 'dev' : git(top, 'rev-parse', '--abbrev-ref', 'HEAD')));
  if (!base || base === 'HEAD') { console.error('[cdx] 기준 브랜치를 알 수 없다(detached HEAD) → --base <브랜치>로 준다'); return 2; }

  const started = now();
  const logFile = path.join(DIR, `${project}-${o.id}-${stamp(started)}.jsonl`);
  const logFd = fs.openSync(logFile, 'a');
  const finish = (rec, lines) => {
    fs.closeSync(logFd);
    const ended = now();
    const entry = { item: o.id, project, repo: path.basename(root), branch, worktree: wt, base, answer: o.answer !== null, startedAt: started.toISOString(), endedAt: ended.toISOString(), ...rec, thread: rec.thread || state?.thread || null, log: logFile };
    fs.appendFileSync(path.join(DIR, 'log.jsonl'), `${JSON.stringify(entry)}\n`);
    if (entry.thread) fs.writeFileSync(stateFile, `${JSON.stringify({ thread: entry.thread, worktree: wt, base, branch, outcome: rec.outcome, commit: rec.commit || null }, null, 2)}\n`);
    const sec = Math.round((ended - started) / 1000);
    console.log([`CDX ${o.id} — ${rec.outcome} (${sec >= 60 ? `${Math.floor(sec / 60)}분 ` : ''}${sec % 60}초)`,...lines, `기록: ${logFile}`].slice(0, 20).join('\n'));
    return rec.outcome === '통과' ? 0 : 1;
  };

  if (o.answer === null) {
    try { git(root, 'worktree', 'add', '-q', wt, '-b', branch, base); } catch (e) { fs.closeSync(logFd); console.error(`[cdx] 워크트리를 만들지 못했다: ${String(e.stderr || e.message).trim().split('\n')[0]}`); return 2; }
    const bad = install(wt, logFd);
    if (bad) return finish({ outcome: '실패', reason: bad }, [`워크트리 ${wt}`, `이유: ${bad}`]);
  }

  const schemaFile = path.join(DIR, '.schema.json');
  fs.writeFileSync(schemaFile, JSON.stringify(SCHEMA));
  const resultFile = path.join(tmp, 'result.json');
  const perm = ['-c', 'sandbox_mode="workspace-write"', '-c', 'sandbox_workspace_write.network_access=true'];
  const tail = ['--json', '--output-schema', schemaFile, '-o', resultFile];
  const args = o.answer !== null
    ? ['exec', 'resume', state.thread, ...perm, ...tail, '-']
    : ['exec', '-C', wt, '-s', 'workspace-write', '-c', 'sandbox_workspace_write.network_access=true', ...tail, '-'];
  const input = o.answer !== null ? `지휘 세션의 답:\n${o.answer}\n\n같은 규칙으로 이어서 구현하고 같은 JSON 형식으로 끝낸다.` : HEAD + card.text;
  const run = await runCodex(args, input, wt, logFile, o.timeout);

  let result = null;
  try { result = JSON.parse(fs.readFileSync(resultFile, 'utf8')); } catch {}
  const head = [`브랜치 ${branch} (기준 ${base}) · 워크트리 ${wt}`];
  if (run.timedOut) return finish({ outcome: '실패', thread: run.thread, reason: `시간 제한 ${o.timeout}분 초과` }, [...head, `이유: 시간 제한 ${o.timeout}분 초과 — 변경은 워크트리에 남아 있다`]);
  if (run.code !== 0) return finish({ outcome: '실패', thread: run.thread, reason: `codex exit ${run.code}` }, [...head, `이유: codex exit ${run.code}${run.err ? ` — ${short(run.err.split('\n').pop(), 120)}` : ''}`]);
  if (!validResult(result)) return finish({ outcome: '실패', thread: run.thread, reason: '결과 JSON이 형식과 다르다' }, [...head, '이유: Codex 결과 JSON이 형식과 다르다']);

  const ch = changes(wt);
  const files = ch.rows.map((r) => r.file);
  const summary = result.summary.slice(0, 5).map((s) => `  ${short(s, 160)}`);
  const changeLine = `변경 ${files.length}파일 +${ch.add} −${ch.del}${files.length ? `: ${files.slice(0, 10).join(', ')}${files.length > 10 ? ' …' : ''}` : ''}`;
  const base_ = { thread: run.thread, status: result.status, files: files.length, add: ch.add, del: ch.del };

  if (result.status === 'failed') return finish({ ...base_, outcome: '실패', reason: 'Codex가 failed로 끝냄' }, [...head, changeLine, '이유: Codex가 failed로 끝냈다', 'Codex 요약:', ...summary, `notes: ${short(result.notes.replace(/\s+/g, ' '), 200)}`]);
  if (result.status === 'blocked') {
    const qs = result.questions.slice(0, 6).map((q) => `  - ${short(q, 200)}`);
    return finish({ ...base_, outcome: '멈춤', questions: result.questions }, [...head, changeLine, 'Codex 요약:', ...summary, `질문(답은 ${CLI} ${o.id} --answer "<답>"):`, ...qs]);
  }
  const prot = [...new Set([...hits(files, PROTECTED), ...hits(ch.ignored, PROTECTED).map((f) => f.replace(/__cdx_dir__$/, ''))])];
  if (prot.length) return finish({ ...base_, outcome: '실패', reason: `보호 경로 변경: ${prot.join(', ')}` }, [...head, changeLine, `이유: 보호 경로를 고쳤다 — ${prot.slice(0, 5).join(', ')}`]);
  if (!files.length) return finish({ ...base_, outcome: '실패', reason: '변경 없음' }, [...head, '이유: Codex가 done이라 했지만 변경이 없다', 'Codex 요약:', ...summary]);
  // 정의서 밖의 작은 선택은 멈추지 않고 요약에 보인다(CDX-1 방향 전환). 설계 선택은 Codex가 blocked로 묻는다
  const decisionLines = result.decisions.length ? ['정의서 밖 선택:', ...result.decisions.slice(0, 3).map((d) => `  - ${short(d, 160)}`)] : [];

  const ck = runChecks(wt, base, logFd);
  if (ck.error) return finish({ ...base_, outcome: '실패', reason: ck.error }, [...head, changeLine, `이유: ${ck.error}`]);
  const checkLines = ck.results.map((r) => `확인: ${short(r.run, 100)} ${r.ok ? '통과' : '실패'}`);
  if (!ck.results.length) return finish({ ...base_, outcome: '실패', reason: '확인 없음', checks: [] }, [...head, changeLine, '이유: 바뀐 파일에 맞는 확인이 설정에 없다(확인 없음은 받지 않는다) → check.js --add로 확인을 더한다']);
  if (ck.results.some((r) => !r.ok)) return finish({ ...base_, outcome: '실패', reason: '확인 실패', checks: ck.results }, [...head, changeLine, ...checkLines, '확인은 네트워크 없는 샌드박스에서 돈다(받아 와야 하는 확인은 여기서 실패한다). 출력은 기록 파일에 있다', 'Codex 요약:', ...summary]);

  const msgFile = path.join(tmp, 'msg.txt');
  fs.writeFileSync(msgFile, `${result.commit_message.trim()}\n`);
  const problems = result.commit_message.trim() ? commitProblems(`git commit -F ${msgFile}`, wt) : ['커밋 메시지가 비었다'];
  if (problems.length) {
    return finish({ ...base_, outcome: '실패', reason: '커밋 메시지 검사', checks: ck.results }, [...head, changeLine, ...checkLines, `이유: 커밋 메시지 — ${short(problems[0], 200)}`, '변경은 스테이징된 채 남아 있다']);
  }
  // 저장소 훅은 돌리지 않는다: hooksPath가 상대 경로(.husky 등)면 Codex가 쓴 훅이 샌드박스 밖에서 돌 수 있다
  try { git(wt, '-c', 'core.hooksPath=/dev/null', 'commit', '--no-verify', '-q', '-F', msgFile); } catch (e) {
    return finish({ ...base_, outcome: '실패', reason: '커밋 실패', checks: ck.results }, [...head, changeLine, ...checkLines, `이유: 커밋 실패 — ${short(String(e.stderr || e.message).trim(), 160)}`]);
  }
  const sha = git(wt, 'rev-parse', '--short', 'HEAD');
  const subject = git(wt, 'log', '-1', '--format=%s');

  const hidden = hits(files, HIDDEN);
  let reviewLine;
  let reviewOut = [];
  if (card.opus || hidden.length) reviewLine = `검토: 필요(Opus — ${card.opus ? '카드에 검토: Opus' : `틀리면 숨는 경로 ${hidden.slice(0, 3).join(', ')}`})`;
  else if (ch.add + ch.del > REVIEW_LINES) {
    reviewOut = await review(wt, sha, logFile, o.timeout, tmp);
    reviewLine = `검토: codex review (${ch.add + ch.del}줄)`;
  } else reviewLine = '검토: 불필요';
  return finish({ ...base_, outcome: '통과', commit: `${sha} ${subject}`, checks: ck.results, decisions: result.decisions, review: reviewLine }, [
    `브랜치 ${branch} (기준 ${base}) · 커밋 ${sha} ${short(subject, 80)}`, changeLine, ...checkLines, 'Codex 요약:', ...summary, ...decisionLines, reviewLine, ...reviewOut.map((l) => `  ${short(l, 160)}`),
  ]);
}

if (require.main === module) main(process.argv.slice(2)).then((c) => process.exit(c), (e) => { console.error(`[cdx] ${e.stack || e}`); process.exit(2); });

module.exports = { main, parseArgs, validResult, PROTECTED, HIDDEN };
