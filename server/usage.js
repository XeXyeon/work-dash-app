// 오늘 비용 · 토큰과 프로젝트별 세션 컨텍스트 사용량 (WEB-20). 옛 TUI 하단 상태 줄(statusBar)을 앱으로 옮긴 것.
// - 오늘 사용량: ccusage(`daily --by-agent`)를 1시간마다(자정이 지나면 바로) 백그라운드로 돌려 캐시한다 (한 번에 1초 이상 걸린다).
//   ccusage 20.x는 Claude Code 기록과 Codex 로그(~/.codex/sessions)를 함께 읽고 agent별(claude · codex)로 나눠 준다.
//   비용은 ccusage의 API 단가 환산이라 구독 요금제의 실제 청구액과 다를 수 있다.
// - 세션 컨텍스트: 세션 기록(sessions.js allSessions — lib.js loadAll · codex.js loadCodex)에서 프로젝트별로 작업 중 세션(없으면 가장 최근)을 골라
//   Claude는 transcript 끝의 마지막 응답 usage, GPT는 Codex 로그의 token_count에서 읽는다.
// 바뀌면 SSE changed로 알린다: { kind: 'usage' } (오늘 사용량), { kind: 'usage-session', project } (세션 컨텍스트)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { WD } from './workdash.js';
import { allSessions } from './sessions.js';   // 세션 목록(loadAll + loadCodex, 2초 캐시)은 세션 알림 카드(WEB-18)와 함께 쓴다

const TODAY_MS = 60 * 60_000;     // ccusage 주기 (1시간)
// ccusage 버전 고정: @latest는 실행마다 새 판을 받아 출력 형식이 바뀌면 조용히 깨지고, 악성 판도 자동 실행된다.
// 올릴 때는 새 판에서 `daily --json --by-agent` 출력이 같은지 확인한 뒤 여기만 바꾼다.
const CCUSAGE = 'ccusage@20.0.48';
const SESSION_MS = 5_000;         // 세션 컨텍스트 확인 주기 (세션 기록은 자주 바뀌어서 파일 감시 대신 짧게 확인한다)
const CCUSAGE_TIMEOUT_MS = 90_000;
const TAIL_BYTES = 1024 * 1024;   // transcript 끝에서 읽을 양
const DEFAULT_LIMIT = 200_000;
const LIMITS_FILE = path.join(WD, 'data', 'model-limits.json');

const pad2 = (n) => String(n).padStart(2, '0');
const localDate = (d = new Date()) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;

// ---- 오늘 사용량 (ccusage) ----

// 앱 서버는 PATH가 짧은 환경(앱 · launchd)에서 뜰 수 있어, 지금 node 옆의 npx를 먼저 쓰고 PATH에도 node 폴더를 넣는다
const NODE_BIN = path.dirname(process.execPath);
const NPX = fs.existsSync(path.join(NODE_BIN, 'npx')) ? path.join(NODE_BIN, 'npx') : 'npx';
const CHILD_ENV = { ...process.env, PATH: [NODE_BIN, process.env.PATH || '/usr/bin:/bin'].join(path.delimiter), NO_COLOR: '1' };

const emptySide = () => ({ cost: 0, tokens: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, models: [], unpriced: [] });

function addModel(side, m) {
  const input = m.inputTokens || 0, output = m.outputTokens || 0;
  const cacheWrite = m.cacheCreationTokens || 0, cacheRead = m.cacheReadTokens || 0;
  const tokens = input + output + cacheWrite + cacheRead;
  const cost = m.cost || 0;
  side.cost += cost; side.tokens += tokens; side.output += output;
  side.input += input; side.cacheRead += cacheRead; side.cacheWrite += cacheWrite;
  side.models.push({ name: m.modelName, cost, tokens, output });
  // 토큰은 있는데 비용이 0이면 ccusage에 그 모델 가격이 없는 것이다 → 화면에 '가격 없음'으로 알린다
  if (tokens > 0 && !cost) side.unpriced.push(m.modelName);
}

// ccusage daily --json --by-agent 결과 → { claude, gpt }. 오늘(로컬 날짜) 행만 본다
export function summarize(json, date) {
  const out = { claude: emptySide(), gpt: emptySide() };
  for (const day of json.daily || []) {
    if (day.period && day.period !== date) continue;
    if (Array.isArray(day.agents)) {
      for (const a of day.agents) {
        const side = a.agent === 'claude' ? out.claude : a.agent === 'codex' ? out.gpt : null;   // 다른 도구(opencode 등)는 빼고 센다
        if (side) for (const m of a.modelBreakdowns || []) addModel(side, m);
      }
    } else {
      // agent 구분이 없는 옛 형식: 모델 이름으로 나눈다
      for (const m of day.modelBreakdowns || []) {
        const name = String(m.modelName || '');
        if (/^claude/i.test(name)) addModel(out.claude, m);
        else if (/^(gpt|o\d|codex)/i.test(name)) addModel(out.gpt, m);
      }
    }
  }
  for (const side of [out.claude, out.gpt]) side.models.sort((a, b) => b.cost - a.cost || b.tokens - a.tokens);
  return out;
}

// status: pending(처음 계산 중) · ok · error(한 번도 성공 못 함). 성공한 뒤의 실패는 직전 값을 두고 error 문구만 단다
let today = { status: 'pending', date: localDate(), updatedAt: null, error: null, claude: null, gpt: null };
let running = false;
let waiters = [];                                  // 수동 새로고침: 지금 도는(또는 새로 띄운) 계산이 끝나면 부를 함수들
let lastRun = 0, lastRunDate = localDate();        // 주기 실행 기준 (수동 새로고침도 여기서 다시 센다)
let notify = () => {};                             // watchUsage가 정하는 SSE 알림

function runCcusage(onDone) {
  if (running) return;
  running = true;
  const date = localDate();
  const since = date.replace(/-/g, '');
  // npx는 ccusage를 자식으로 띄우므로, 시간 초과 때는 프로세스 그룹째 끝내야 ccusage가 고아로 남지 않는다 (detached = 새 그룹)
  let timedOut = false;
  const child = execFile(NPX, ['--yes', CCUSAGE, 'daily', '--json', '--by-agent', '--since', since, '--offline'],
    { maxBuffer: 20 * 1024 * 1024, env: CHILD_ENV, cwd: os.homedir(), detached: true },
    (err, stdout, stderr) => {
      clearTimeout(killer);
      running = false;
      if (timedOut) err = new Error(`ccusage가 ${CCUSAGE_TIMEOUT_MS / 1000}초 안에 끝나지 않음`);
      const prev = JSON.stringify({ ...today, updatedAt: null });
      if (err) {
        const msg = (String(stderr || '').trim().split('\n').pop() || err.message).slice(0, 300);
        console.warn(`[usage] ccusage 실패: ${msg}`);
        today = today.claude && today.date === date ? { ...today, error: msg } : { status: 'error', date, updatedAt: Date.now(), error: msg, claude: null, gpt: null };
      } else {
        try {
          const { claude, gpt } = summarize(JSON.parse(stdout), date);
          today = { status: 'ok', date, updatedAt: Date.now(), error: null, claude, gpt };
        } catch (e) {
          today = { status: 'error', date, updatedAt: Date.now(), error: `ccusage 결과를 읽지 못함: ${e.message}`, claude: null, gpt: null };
        }
      }
      if (JSON.stringify({ ...today, updatedAt: null }) !== prev) onDone();
      const w = waiters; waiters = [];
      for (const f of w) f();
    });
  const killer = setTimeout(() => {
    timedOut = true;
    try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
  }, CCUSAGE_TIMEOUT_MS);
}

// 자정이 지났는데 아직 새로 계산하지 못했으면 어제 합계를 오늘 것으로 보이지 않게 계산 중으로 돌려준다
export const getTodayUsage = () => (today.date === localDate() ? today
  : { status: 'pending', date: localDate(), updatedAt: null, error: null, claude: null, gpt: null });

// ---- 세션 컨텍스트 ----

// Claude 기록에는 컨텍스트 한도가 없다. model-limits.json(옛 TUI가 배운 값)을 읽고,
// 어느 세션이든 200K를 넘은 적이 있는 모델은 1M으로 본다. 이 파일은 읽기만 하고 새로 배운 값은 메모리에만 둔다
let fileLimits = null, fileLimitsMtime = -1;
const learned = new Map();
function limitFor(model, ctx) {
  try {
    const st = fs.statSync(LIMITS_FILE);
    if (st.mtimeMs !== fileLimitsMtime) { fileLimits = JSON.parse(fs.readFileSync(LIMITS_FILE, 'utf8')); fileLimitsMtime = st.mtimeMs; }
  } catch { fileLimits = fileLimits || {}; }
  if (ctx > DEFAULT_LIMIT) learned.set(model, 1_000_000);
  const v = learned.get(model) || fileLimits?.[model];
  return v ? { limit: v, limitSource: 'learned' } : { limit: DEFAULT_LIMIT, limitSource: 'default' };
}

const transcriptOf = (s) => s.transcript || path.join(os.homedir(), '.claude', 'projects',
  String(s.cwd || '').replace(/[^a-zA-Z0-9]/g, '-'), `${s.id}.jsonl`);

// transcript 끝부분에서 마지막(메인 에이전트) 응답의 모델과 컨텍스트 토큰을 읽는다. 파일 수정 시각으로 캐시
const tailCache = new Map();   // 경로 → { mtime, size, info }
const compactOverhead = new Map();   // transcript 파일 → 그 세션의 지난 압축에서 본 (압축 뒤 첫 응답 크기 − postTokens)
let lastCompactOverhead = 80_000;     // 아직 본 적 없는 세션에 쓰는 값: 가장 최근에 본 차이 (처음에는 최근 기록의 중간쯤)

function claudeUsage(s) {
  const file = transcriptOf(s);
  let st;
  try { st = fs.statSync(file); } catch { return null; }
  const hit = tailCache.get(file);
  if (hit && hit.mtime === st.mtimeMs && hit.size === st.size) return hit.info;
  let info = null;
  try {
    const len = Math.min(st.size, TAIL_BYTES);
    const buf = Buffer.alloc(len);
    const fd = fs.openSync(file, 'r');
    try { fs.readSync(fd, buf, 0, len, st.size - len); } finally { fs.closeSync(fd); }
    const lines = buf.toString('utf8').split('\n');
    // 압축 직후에는 새 응답이 없어 마지막 usage가 압축 전 값이다. 압축 기록(compact_boundary)의 postTokens는 요약 크기만이라
    // (시스템 프롬프트 · 도구 정의 · 규칙 문서가 빠져 실제보다 5만~10만 작다), 지난 압축에서 본 차이를 더해 어림한다. 다음 응답이 오면 정확한 값으로 바뀐다.
    let post = null, over = null;
    let compactAt = hit?.info?.compactAt || 0;   // 마지막 압축 기록의 시각 (압축 중 표시를 끄는 데 쓴다)
    const usageOf = (line) => {
      try {
        const j = JSON.parse(line);
        const u = j.message?.usage;
        if (j.type !== 'assistant' || j.isSidechain || !u || !j.message.model || j.message.model.startsWith('<')) return null;
        return { model: j.message.model, ctx: (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0) };
      } catch { return null; }   // 잘린 첫 줄 등
    };
    for (const line of lines) {
      if (line.includes('"compact_boundary"')) {
        try {
          const j = JSON.parse(line);
          const p = j.compactMetadata?.postTokens; post = p > 0 ? p : null;
          const at = Date.parse(j.timestamp); if (at > compactAt) compactAt = at;
        } catch { post = null; }
        continue;
      }
      if (!line.includes('"usage"')) continue;
      const u = usageOf(line);
      if (!u) continue;
      if (post != null) { over = u.ctx - post; post = null; }   // 압축 뒤 첫 응답: 요약 크기와 실제의 차이를 배운다
      info = u;
    }
    if (over > 0) { compactOverhead.set(file, over); lastCompactOverhead = over; }
    if (post != null) {
      const base = info || hit?.info;
      if (base) info = { model: base.model, ctx: post + (compactOverhead.get(file) ?? lastCompactOverhead), approx: true };
    }
    if (info && compactAt) info = { ...info, compactAt };
  } catch { /* 읽기 실패 */ }
  // 끝부분에 응답 usage가 없으면(큰 도구 출력이 이어진 경우 등) 직전에 읽은 값을 유지한다
  if (!info && hit) info = hit.info;
  tailCache.set(file, { mtime: st.mtimeMs, size: st.size, info });
  if (tailCache.size > 500) tailCache.delete(tailCache.keys().next().value);
  return info;
}

// 옛 TUI sessionForProject와 같은 규칙: 작업 중 · 입력 대기 세션 중 가장 최근, 없으면 그 프로젝트의 가장 최근 세션
function pickSession(sessions, project) {
  const mine = sessions.filter((s) => s.project === project && !s.parentThreadId);
  const active = mine.filter((s) => s.status === 'working' || s.status === 'waiting');
  return (active.length ? active : mine).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))[0];
}

function describe(s) {
  if (!s) return null;
  const base = { source: s.source, id: s.id, title: s.title || s.lastPrompt || '', status: s.status, updatedAt: s.updatedAt || null };
  if (s.source === 'gpt') {
    if (!s.ctx) return { ...base, model: s.model || null, ctx: null, limit: null, limitSource: null };
    return { ...base, model: s.model || null, ctx: s.ctx, ...(s.ctxLimit ? { limit: s.ctxLimit, limitSource: 'log' } : { limit: null, limitSource: null }) };
  }
  const u = claudeUsage(s);
  if (!u) return { ...base, model: null, ctx: null, limit: null, limitSource: null };
  return { ...base, model: u.model, ctx: u.ctx, ...(u.approx ? { approx: true } : {}), compactAt: u.compactAt || 0, ...limitFor(u.model, u.ctx) };
}

// 세션 알림 카드용 (WEB-37): 그 세션의 컨텍스트 크기와 압축 단계.
// 기준은 공통 규칙(~/.work-dash/RULES.md "긴 세션")의 숫자다: Claude는 20만에서 압축할 때 · 약 30만에서 자동 압축,
// Codex는 7만에서 인수인계 메모 · 10만에서 자동 압축. 숫자를 바꾸면 그 문서와 설정(settings.json · config.toml)도 함께 바꾼다
const COMPACT_AT = { claude: { soon: 200_000, auto: 300_000 }, gpt: { soon: 70_000, auto: 100_000 } };
// 압축 중 표시: 압축 버튼으로 /compact를 보낸 세션을 적어 두고, 압축이 끝난 것이 보일 때까지 카드에 '압축 중'을 띄운다.
// 끝난 것으로 보는 때: 보낸 뒤의 압축 기록(compact_boundary)이 생겼다(Claude) · 크기가 보낼 때의 70% 아래로 줄었다(Codex 등 기록이 없는 경우) · 10분이 지났다(압축이 실행되지 않은 경우)
const COMPACTING_MAX_MS = 10 * 60_000;
const compactRequests = new Map();   // 세션 id → { at, tokens }
export function markCompacting(id) { compactRequests.set(id, { at: Date.now(), tokens: null }); }
function isCompacting(id, d) {
  const req = compactRequests.get(id);
  if (!req) return false;
  if (req.tokens == null) req.tokens = d.ctx;
  const done = (d.compactAt || 0) > req.at - 2000 || d.ctx < req.tokens * 0.7 || Date.now() - req.at > COMPACTING_MAX_MS;
  if (done) compactRequests.delete(id);
  return !done;
}

export function sessionContext(s) {
  const d = describe(s);
  if (!d || !d.ctx) return null;
  const at = COMPACT_AT[s.source === 'gpt' ? 'gpt' : 'claude'];
  return { tokens: d.ctx, ...(d.approx ? { approx: true } : {}), ...(isCompacting(s.id, d) ? { compacting: true } : {}), limit: d.limit, level: d.ctx >= at.auto ? 'over' : d.ctx >= at.soon ? 'soon' : 'ok', soonAt: at.soon, autoAt: at.auto };
}

export function getSessionUsage(project, sessions = allSessions()) {
  return { project, session: describe(pickSession(sessions, project)) };
}

// 처음 한 번: 다른 Claude 세션 기록을 훑어 모델별 한도(1M 여부)를 미리 배운다 (옛 TUI learnModelLimits)
function learnLimits(sessions) {
  for (const s of sessions) if (s.source === 'claude') { const u = claudeUsage(s); if (u) limitFor(u.model, u.ctx); }
}

// ---- 주기 확인 ----
// onChange(changes): watch.js와 같은 changes 배열. hasClients(): 화면이 하나라도 연결돼 있으면 true (없으면 쉰다)
// 사이드바 새로고침 버튼: 바로 계산하고 끝나면 결과를 돌려준다(이미 계산 중이면 그 결과를 기다린다). 1시간 주기는 지금부터 다시 센다
export function refreshUsage() {
  return new Promise((resolve) => {
    waiters.push(() => resolve(getTodayUsage()));
    lastRun = Date.now(); lastRunDate = localDate();
    runCcusage(notify);
  });
}

export function watchUsage(onChange, hasClients) {
  const fire = () => onChange([{ kind: 'usage' }]);
  notify = fire;
  lastRun = Date.now(); lastRunDate = localDate();
  runCcusage(fire);
  try { learnLimits(allSessions()); } catch { /* 다음 확인 때 다시 */ }

  // 오늘 사용량: 화면이 없으면 건너뛰되, 오래된 값이 남지 않게 다음 연결 때 바로 다시 돈다
  const todayTimer = setInterval(() => {
    if (!hasClients()) return;
    const newDay = lastRunDate !== localDate();   // 자정이 지났으면 1시간을 기다리지 않고 바로 (실패해도 한 번만)
    if (!newDay && Date.now() - lastRun < TODAY_MS - 1000) return;
    lastRun = Date.now(); lastRunDate = localDate();
    runCcusage(fire);
  }, 5_000);

  // 세션 컨텍스트: 프로젝트마다 고른 세션의 요약이 바뀌면 그 프로젝트만 알린다
  let sigs = new Map();
  const sessionTimer = setInterval(() => {
    if (!hasClients()) { sigs = new Map(); return; }
    let sessions;
    try { sessions = allSessions(); } catch { return; }
    const next = new Map();
    for (const project of new Set(sessions.map((s) => s.project))) {
      const d = describe(pickSession(sessions, project));
      next.set(project, d ? [d.id, d.status, d.model, d.ctx, d.limit].join('|') : '');
    }
    const changes = [];
    for (const [project, sig] of next) if (sigs.size && sigs.get(project) !== sig) changes.push({ kind: 'usage-session', project });
    for (const project of sigs.keys()) if (!next.has(project)) changes.push({ kind: 'usage-session', project });
    sigs = next;
    if (changes.length) onChange(changes);
  }, SESSION_MS);

  return () => { clearInterval(todayTimer); clearInterval(sessionTimer); };
}
