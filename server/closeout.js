import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { WD } from './workdash.js';
import { compactSession, endSession } from './openSession.js';
import { markCompacting } from './usage.js';
import { core, corePath } from './kit.js';

const CHECK_JS = corePath('closeout.js');
const { contextTokens, lastCompactAt } = core('closeout.js');
const CHECK_TIMEOUT_MS = 60_000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function runCheck(id, flags = []) {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [CHECK_JS, id, ...flags], { timeout: CHECK_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 }, (err, out) => {
      try { resolve(JSON.parse(out)); } catch { reject(new Error(err ? err.message.split('\n')[0] : '점검 결과를 읽지 못했습니다')); }
    });
  });
}

function publicCheck(r) {
  return { ...r, cleanable: { processes: r.cleanable.processes, branches: r.cleanable.branches.map(({ repo: _repo, ...b }) => b) } };
}

let checking = null;
export function closeoutSession(target) {
  if (target?.kind !== 'claude-desktop') return Promise.resolve({ status: 400, error: 'Claude 앱에서 연 세션만 보관할 수 있습니다' });
  if (checking) return Promise.resolve({ status: 409, error: '다른 세션을 점검하는 중입니다' });
  checking = runCheck(target.id, ['--gh', '--fetch']).then((r) => {
    if (r.error) return { status: 404, error: r.error };
    const stage = r.archived === true ? 'archived' : r.blockers.length ? 'blocked' : 'checked';
    return { status: 200, body: { ok: true, stage, check: publicCheck(r) } };
  }).catch((e) => {
    console.warn(`[closeout] ${target.id} 점검 실패: ${e.message}`);
    return { status: 500, error: '점검하지 못했습니다' };
  }).finally(() => { checking = null; });
  return checking;
}

const COMPACT_OVER = 200_000;
const COMPACT_WAIT_MS = 15 * 60_000;
const COMPACT_AGAIN_MS = 30 * 60_000;
const COMPACT_POLL_MS = 5_000;
const compactSent = new Map();
const waiting = new Set();

export async function requestEnd(target, opts = {}) {
  const r = await requestEndInner(target, opts);
  record(target?.id, 'request', { fromSession: opts.fromSession === true, status: r.status, ...(r.error ? { error: r.error } : { compact: r.body?.compact === true, tokens: r.body?.tokens ?? null, ...(r.body?.waiting ? { waiting: true } : {}) }) });
  return r;
}
async function requestEndInner(target, { fromSession = false } = {}) {
  if (target?.kind !== 'claude-desktop') return { status: 400, error: 'Claude 앱에서 연 세션만 종결을 요청할 수 있습니다' };
  const id = target.id;
  if (waiting.has(id)) return { status: 200, body: { ok: true, compact: true, waiting: true } };
  let tokens = null;
  try { tokens = contextTokens(id); } catch { }
  const recently = Date.now() - (compactSent.get(id) || 0) < COMPACT_AGAIN_MS;
  if (tokens != null && tokens > COMPACT_OVER && !recently) {
    const r = await compactSession(target);
    if (r.status !== 200) return r;
    const sentAt = Date.now();
    compactSent.set(id, sentAt);
    markCompacting(id);
    waiting.add(id);
    resumeAfterCompact(target, sentAt).finally(() => waiting.delete(id));
    return { status: 200, body: { ...r.body, compact: true, tokens } };
  }
  if (fromSession) return { status: 200, body: { ok: true, compact: false, tokens, ...(recently ? { reason: '방금 압축한 세션이라 다시 압축하지 않습니다' } : {}) } };
  const r = await endSession(target);
  return r.status === 200 ? { status: 200, body: { ...r.body, compact: false } } : r;
}

async function resumeAfterCompact(target, sentAt) {
  const id = target.id;
  for (;;) {
    await sleep(COMPACT_POLL_MS);
    if (Date.now() - sentAt > COMPACT_WAIT_MS) { console.warn(`[end] ${id} 압축이 끝난 것을 확인하지 못해 종결 요청을 보내지 않았습니다`); record(id, 'after-compact', { sent: false, reason: '압축 끝을 확인하지 못함' }); return; }
    let done = false;
    try { done = lastCompactAt(id) > sentAt - 2000; } catch { }
    if (done) break;
  }
  await sleep(COMPACT_POLL_MS);
  for (let i = 0; i < 6; i++) {
    const r = await endSession(target);
    if (r.status === 200) { console.log(`[end] ${id} 압축 뒤 종결 요청 보냄`); record(id, 'after-compact', { sent: true, waitedMs: Date.now() - sentAt }); return; }
    if (r.status !== 409) { console.warn(`[end] ${id} 압축 뒤 종결 요청 실패: ${r.error}`); record(id, 'after-compact', { sent: false, reason: r.error }); return; }
    await sleep(COMPACT_POLL_MS);
  }
  console.warn(`[end] ${id} 압축 뒤 종결 요청을 보내지 못했습니다(키 입력이 계속 겹침)`);
  record(id, 'after-compact', { sent: false, reason: '키 입력이 계속 겹침' });
}

const LOG_FILE = path.join(WD, 'data', 'closeout-log.jsonl');
function record(id, step, data = {}) {
  try { fs.appendFileSync(LOG_FILE, `${JSON.stringify({ at: new Date().toISOString(), id, step, ...data })}\n`); } catch { }
}

const AFTER_JS = corePath('afterarchive.js');
export function registerAfterArchive(target, { ignoredOk = false } = {}) {
  if (target?.kind !== 'claude-desktop') return Promise.resolve({ status: 400, error: 'Claude 앱에서 연 세션만 등록할 수 있습니다' });
  if (!UUID_RE.test(target.id)) return Promise.resolve({ status: 400, error: '세션 id 형식이 올바르지 않습니다' });
  return new Promise((resolve) => {
    execFile(process.execPath, [AFTER_JS, 'register', target.id, ...(ignoredOk ? ['--ignored-ok'] : [])], { timeout: CHECK_TIMEOUT_MS + 60_000, maxBuffer: 1024 * 1024 }, (_err, out) => {
      let r = null;
      try { r = JSON.parse(out); } catch { }
      if (!r) { console.warn(`[closeout] ${target.id} 보관 뒤 정리 등록 실패`); return resolve({ status: 500, error: '점검하지 못했습니다' }); }
      if (!r.ok) return resolve({ status: { busy: 409, notfound: 404, input: 400 }[r.kind] || 500, error: r.error });
      console.log(`[closeout] ${target.id} 보관 뒤 정리 등록 (브랜치 ${r.branches.length}개)`);
      resolve({ status: 200, body: r });
    });
  });
}
