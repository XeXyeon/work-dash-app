#!/usr/bin/env node
// work-dash — 대시보드 서버 관리 명령 (WEB-5 · WEB-15)
// 데스크톱 앱(desktop/src/server.rs)이 서버를 띄울 때 인자 없이(`work-dash-app.js`) 이 파일을 부른다.
//
//   work-dash            화면이 오래됐으면 빌드 → 서버가 없으면 백그라운드로 띄움
//   work-dash status     서버 실행 여부 · 주소 · PID · 가동 시간 · 연결된 화면 수 · 빌드 상태
//   work-dash stop       서버 끄기
//   work-dash restart    서버 다시 띄우기 (서버 코드를 바꿨을 때)
//   work-dash logs       서버 로그 마지막 50줄
//
// 서버는 터미널과 분리된 백그라운드 프로세스로 돈다. 이미 떠 있으면 다시 띄우지 않는다.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.WORK_DASH_APP_PORT) || 4949;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const URL_FOR_USER = `http://localhost:${PORT}`;
const RUN_DIR = path.join(ROOT, '.run');
const LOG = path.join(RUN_DIR, 'server.log');
const LOG_MAX = 1024 * 1024;

const c = process.stdout.isTTY
  ? { dim: (s) => `\x1b[2m${s}\x1b[22m`, green: (s) => `\x1b[32m${s}\x1b[39m`, red: (s) => `\x1b[31m${s}\x1b[39m`, amber: (s) => `\x1b[33m${s}\x1b[39m`, bold: (s) => `\x1b[1m${s}\x1b[22m` }
  : { dim: (s) => s, green: (s) => s, red: (s) => s, amber: (s) => s, bold: (s) => s };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- 서버 확인 ----
// 'ours': 우리 서버 / 'none': 아무것도 없음 / 'other': 다른 프로그램이 포트를 쓰는 중
async function probe() {
  try {
    const res = await fetch(`${ORIGIN}/api/health`, { signal: AbortSignal.timeout(1500) });
    const body = await res.json().catch(() => null);
    if (res.ok && body?.app === 'work-dash-app') return { state: 'ours', ...body };
    return { state: 'other' };
  } catch (e) {
    const code = e.cause?.code;
    if (code === 'ECONNREFUSED' || code === 'ECONNRESET') return { state: 'none' };
    return { state: 'other', error: e.message };   // 시간 초과 등: 무언가 응답하지 않고 포트를 잡고 있다
  }
}

async function waitFor(pred, timeoutMs) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const p = await probe();
    if (pred(p)) return p;
    if (Date.now() > end) return p;
    await sleep(150);
  }
}

// ---- 빌드 ----
// dist/index.html보다 새로운 화면 소스가 있으면 빌드가 오래된 것으로 본다
const BUILD_INPUTS = ['src', 'index.html', 'vite.config.ts', 'package.json', 'tsconfig.json'];
function newestMtime(p) {
  let st;
  try { st = fs.statSync(p); } catch { return 0; }
  if (!st.isDirectory()) return st.mtimeMs;
  let max = st.mtimeMs;
  for (const n of fs.readdirSync(p)) max = Math.max(max, newestMtime(path.join(p, n)));
  return max;
}
function buildState() {
  let built = 0;
  try { built = fs.statSync(path.join(ROOT, 'dist', 'index.html')).mtimeMs; } catch { return { state: 'missing' }; }
  const src = Math.max(...BUILD_INPUTS.map((n) => newestMtime(path.join(ROOT, n))));
  return { state: src > built ? 'stale' : 'fresh', builtAt: built };
}
function ensureBuilt() {
  const b = buildState();
  if (b.state === 'fresh') return true;
  if (!fs.existsSync(path.join(ROOT, 'node_modules', 'vite'))) {
    console.error(c.red(`화면을 빌드하려면 의존성이 필요합니다: cd ${ROOT} && npm install`));
    return false;
  }
  console.log(c.dim(b.state === 'missing' ? '화면을 처음 빌드합니다…' : '화면 소스가 바뀌어 다시 빌드합니다…'));
  const r = spawnSync(process.execPath, [path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js'), 'build', '--logLevel', 'warn'], { cwd: ROOT, stdio: 'inherit' });
  if (r.status !== 0) { console.error(c.red('빌드 실패. 위 오류를 확인하세요.')); return false; }
  return true;
}

// ---- 시작 · 종료 ----
async function start() {
  const p = await probe();
  if (p.state === 'ours') return p;
  if (p.state === 'other') {
    console.error(c.red(`포트 ${PORT}을 다른 프로그램이 쓰고 있습니다.`) + c.dim(` (확인: lsof -nP -iTCP:${PORT} -sTCP:LISTEN)`));
    return null;
  }
  fs.mkdirSync(RUN_DIR, { recursive: true });
  try { if (fs.statSync(LOG).size > LOG_MAX) fs.renameSync(LOG, `${LOG}.old`); } catch {}
  const fd = fs.openSync(LOG, 'a');
  fs.writeSync(fd, `\n--- ${new Date().toLocaleString('sv-SE')} 시작 ---\n`);
  // detached + stdio를 파일로: 터미널을 닫아도 서버는 계속 돈다
  const child = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
    cwd: ROOT, detached: true, stdio: ['ignore', fd, fd],
  });
  child.unref();
  fs.closeSync(fd);
  const up = await waitFor((x) => x.state !== 'none' || child.exitCode !== null, 5000);
  if (up.state !== 'ours') {
    console.error(c.red('서버를 띄우지 못했습니다.') + ` 로그: ${LOG}`);
    tail(15);
    return null;
  }
  console.log(`${c.green('●')} 서버 시작 ${c.dim(`(PID ${up.pid})`)}`);
  return up;
}

async function stop({ quiet = false } = {}) {
  const p = await probe();
  if (p.state !== 'ours') {
    if (!quiet) console.log(p.state === 'other' ? c.amber(`포트 ${PORT}의 프로그램은 work-dash-app 서버가 아니라 끄지 않았습니다.`) : '서버가 꺼져 있습니다.');
    return p.state === 'none';
  }
  try { process.kill(p.pid, 'SIGTERM'); } catch (e) { console.error(c.red(`끄지 못했습니다: ${e.message}`)); return false; }
  const after = await waitFor((x) => x.state === 'none', 5000);
  if (after.state !== 'none') { console.error(c.red(`서버(PID ${p.pid})가 5초 안에 꺼지지 않았습니다.`)); return false; }
  if (!quiet) console.log(`${c.dim('○')} 서버를 껐습니다 ${c.dim(`(PID ${p.pid})`)}`);
  return true;
}

function tail(n) {
  let text = '';
  try { text = fs.readFileSync(LOG, 'utf8'); } catch { console.log(c.dim('로그가 아직 없습니다.')); return; }
  console.log(text.trimEnd().split('\n').slice(-n).join('\n'));
}

const dur = (ms) => {
  const m = Math.floor(ms / 60e3);
  if (m < 1) return '1분 미만';
  if (m < 60) return `${m}분`;
  if (m < 1440) return `${Math.floor(m / 60)}시간 ${m % 60}분`;
  return `${Math.floor(m / 1440)}일 ${Math.floor((m % 1440) / 60)}시간`;
};

async function status() {
  const p = await probe();
  const b = buildState();
  const buildText = { fresh: c.green('최신'), stale: c.amber('소스가 더 새로움 (앱이 서버를 띄울 때 다시 빌드)'), missing: c.amber('없음 (앱이 서버를 띄울 때 빌드)') }[b.state];
  if (p.state === 'ours') {
    console.log(`${c.green('●')} ${c.bold('실행 중')}  ${URL_FOR_USER}`);
    console.log(`  PID ${p.pid} · 가동 ${dur(Date.now() - p.startedAt)} · 열린 화면 ${p.clients}개`);
    const serverChanged = newestMtime(path.join(ROOT, 'server')) > p.startedAt;
    if (serverChanged) console.log(`  ${c.amber('서버 코드가 시작 후 바뀌었습니다 → work-dash restart')}`);
  } else if (p.state === 'none') {
    console.log(`${c.dim('○')} ${c.bold('꺼짐')}  ${c.dim('켜기: work-dash 앱을 실행하세요')}`);
  } else {
    console.log(`${c.red('●')} ${c.bold(`포트 ${PORT}을 다른 프로그램이 쓰는 중`)}`);
  }
  console.log(`  화면 빌드: ${buildText}`);
  console.log(c.dim(`  로그: ${LOG}`));
  return p.state === 'ours' ? 0 : 3;   // 꺼져 있으면 0이 아닌 코드 (스크립트에서 확인용)
}

async function main() {
  const args = process.argv.slice(2);
  const cmd = args.includes('-h') || args.includes('--help') ? 'help' : args.find((a) => !a.startsWith('-')) || 'start';
  switch (cmd) {
    case 'start': {
      if (!ensureBuilt()) return 1;
      const up = await start();
      if (!up) return 1;
      console.log(`${c.green('●')} ${URL_FOR_USER}  ${c.dim('끄기: work-dash stop · 상태: work-dash status')}`);
      return 0;
    }
    case 'status': return status();
    case 'stop': return (await stop()) ? 0 : 1;
    case 'restart': {
      if (!(await stop({ quiet: true }))) return 1;
      if (!ensureBuilt()) return 1;
      const up = await start();
      if (!up) return 1;
      console.log(`${c.green('●')} ${URL_FOR_USER}`);
      return 0;
    }
    case 'logs': tail(50); return 0;
    case 'help':
      console.log('사용법: work-dash [status | stop | restart | logs]');
      return 0;
    default:
      console.error(`알 수 없는 명령: ${cmd}\n사용법: work-dash [status | stop | restart | logs]`);
      return 2;
  }
}

process.exitCode = await main();
