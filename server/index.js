import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WD, getProjects, getRoadmap, getIssues, getCard, getDetail, getFlows, setArchived, setMilestoneFold, trashProject, renameProject } from './workdash.js';
import { watchWorkDash } from './watch.js';
import { getDocs, getDoc, watchDocs } from './docs.js';
import { getPlans, getPlan, getPlanSection, hasPlans, watchPlans } from './plans.js';
import { getNotes } from './notes.js';
import { getImprovements } from './improvements.js';
import { getTodayUsage, getSessionUsage, refreshUsage, watchUsage, markCompacting } from './usage.js';
import { getSessions, watchSessions, sessionTarget } from './sessions.js';
import { validSessionId, openSession, compactSession } from './openSession.js';
import { closeoutSession, requestEnd, registerAfterArchive } from './closeout.js';
import { features, FEATURE_OFF } from './features.js';
import { installer } from './kit.js';
const { installStatus, fixInstall } = await installer();

const HOST = '127.0.0.1';
const PORT = Number(process.env.WORK_DASH_APP_PORT) || 4949;
const DIST = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const HEARTBEAT_MS = 25_000;
const STARTED_AT = Date.now();

function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(data);
}
const notFound = (res, message = '찾을 수 없음') => sendJson(res, 404, { error: message });

const ALLOWED_HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);
const hostOk = (req) => ALLOWED_HOSTS.has((req.headers.host || '').toLowerCase());
const VITE_PORT = Number(process.env.VITE_PORT) || 5173;
const DEV_ORIGINS = [`http://127.0.0.1:${VITE_PORT}`, `http://localhost:${VITE_PORT}`];
const originOk = (req) => {
  const o = req.headers.origin;
  if (!o) return true;
  try { return ALLOWED_HOSTS.has(new URL(o).host.toLowerCase()) || DEV_ORIGINS.includes(o); } catch { return false; }
};
const BODY_LIMIT = 16 * 1024;
function readJson(req) {
  return new Promise((resolve, reject) => {
    if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) return reject(Object.assign(new Error('JSON 본문만 받습니다'), { status: 415 }));
    let size = 0; const chunks = [];
    let over = false;
    req.on('data', (c) => {
      if (over) return;
      size += c.length;
      if (size > BODY_LIMIT) { over = true; reject(Object.assign(new Error('본문이 너무 큽니다'), { status: 413 })); } else chunks.push(c);
    });
    req.on('end', () => { if (over) return; try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch { reject(Object.assign(new Error('잘못된 JSON'), { status: 400 })); } });
    req.on('error', reject);
  });
}

const buildId = () => { try { return String(Math.floor(fs.statSync(path.join(DIST, 'index.html')).mtimeMs)); } catch { return null; } };
let currentBuild = buildId();

const clients = new Set();
function sseOpen(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
  });
  res.write('retry: 2000\n');
  res.write(`event: hello\ndata: ${JSON.stringify({ at: Date.now(), build: currentBuild })}\n\n`);
  req.socket.setKeepAlive(true);
  clients.add(res);
  res.on('close', () => clients.delete(res));
  res.on('error', () => clients.delete(res));
}
function broadcast(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) res.write(msg);
}
const heartbeat = setInterval(() => { for (const res of clients) res.write(': ping\n\n'); }, HEARTBEAT_MS);
const buildCheck = setInterval(() => {
  const b = buildId();
  if (b && b !== currentBuild) { currentBuild = b; broadcast('build', { build: b }); }
}, 2000);

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2', '.woff': 'font/woff',
};
function serveStatic(res, pathname) {
  let rel;
  try { rel = path.normalize(decodeURIComponent(pathname)).replace(/^([/\\])+/, ''); }
  catch { return sendJson(res, 400, { error: '잘못된 경로 인코딩' }); }
  let file = path.join(DIST, rel);
  if (rel.split(/[/\\]/).includes('..') || (file !== DIST && !file.startsWith(DIST + path.sep))) return notFound(res);
  try { if (!fs.statSync(file).isFile()) throw new Error(); }
  catch { file = path.join(DIST, 'index.html'); }
  fs.readFile(file, (err, buf) => {
    if (err) {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('work-dash-app API 서버가 실행 중입니다. 화면은 아직 빌드되지 않았습니다 (npm run build).\n');
    }
    const immutable = rel.startsWith('assets/');
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache' });
    res.end(buf);
  });
}

function handleApi(req, res, segs) {
  const [name, project, ...rest] = segs;
  if (name === 'health' && segs.length === 1) return sendJson(res, 200, { app: 'work-dash-app', pid: process.pid, startedAt: STARTED_AT, clients: clients.size, dataDir: WD });
  if (name === 'projects' && segs.length === 1) return sendJson(res, 200, getProjects().map((p) => ({ ...p, hasPlans: hasPlans(p.project) })));
  if (name === 'projects' && segs.length === 3 && ['archive', 'unarchive', 'trash', 'rename'].includes(rest[0])) {
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'POST만 허용' });
    if (!originOk(req)) return sendJson(res, 403, { error: '허용되지 않은 Origin' });
    return readJson(req).then((body) => {
      const r = rest[0] === 'trash' ? trashProject(project, body?.confirm)
        : rest[0] === 'rename' ? renameProject(project, body?.name)
          : setArchived(project, rest[0] === 'archive');
      if (r.status === 200) console.log(`[write] ${rest[0]} ${project}`);
      sendJson(res, r.status, r.body ?? { error: r.error });
    }, (e) => {
      if (e.status === 413) res.on('finish', () => req.destroy());
      sendJson(res, e.status || 400, { error: e.message });
    });
  }
  if (name === 'ui-state' && segs.length === 2 && project === 'fold') {
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'POST만 허용' });
    if (!originOk(req)) return sendJson(res, 403, { error: '허용되지 않은 Origin' });
    return readJson(req).then((body) => {
      const { key, folded } = body ?? {};
      const r = setMilestoneFold(key, folded);
      if (r.status === 200) console.log(`[write] fold ${key} ${folded}`);
      sendJson(res, r.status, r.body ?? { error: r.error });
    }, (e) => {
      if (e.status === 413) res.on('finish', () => req.destroy());
      sendJson(res, e.status || 400, { error: e.message });
    });
  }
  if (name === 'usage' && segs.length === 2 && segs[1] === 'refresh' && req.method === 'POST') {
    if (!originOk(req)) return sendJson(res, 403, { error: '허용되지 않은 Origin' });
    return refreshUsage().then((r) => sendJson(res, 200, r));
  }
  if (name === 'sessions' && segs.length === 3 && rest[0] === 'open') {
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'POST만 허용' });
    if (!originOk(req)) return sendJson(res, 403, { error: '허용되지 않은 Origin' });
    const id = project;
    if (!validSessionId(id)) return sendJson(res, 400, { error: '세션 id 형식이 올바르지 않습니다' });
    return readJson(req).then(() => {
      const target = sessionTarget(id);
      if (!target) return sendJson(res, 404, { error: `세션 없음: ${id}` });
      if (target.kind === 'claude-desktop' && !features().open) return sendJson(res, 409, { error: FEATURE_OFF });
      return openSession(target).then((r) => sendJson(res, r.status, r.body ?? { error: r.error }));
    }, (e) => {
      if (e.status === 413) res.on('finish', () => req.destroy());
      sendJson(res, e.status || 400, { error: e.message });
    });
  }
  if (name === 'sessions' && segs.length === 3 && rest[0] === 'compact') {
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'POST만 허용' });
    if (!originOk(req)) return sendJson(res, 403, { error: '허용되지 않은 Origin' });
    const id = project;
    if (!validSessionId(id)) return sendJson(res, 400, { error: '세션 id 형식이 올바르지 않습니다' });
    return readJson(req).then(() => {
      const target = sessionTarget(id);
      if (!target) return sendJson(res, 404, { error: `세션 없음: ${id}` });
      if (!features().compact || (target.kind === 'claude-desktop' && !features().open)) return sendJson(res, 409, { error: FEATURE_OFF });
      return compactSession(target).then((r) => {
        if (r.body?.ok) markCompacting(id);
        sendJson(res, r.status, r.body ?? { error: r.error });
      });
    }, (e) => {
      if (e.status === 413) res.on('finish', () => req.destroy());
      sendJson(res, e.status || 400, { error: e.message });
    });
  }
  if (name === 'sessions' && segs.length === 3 && (rest[0] === 'end' || rest[0] === 'after-archive')) {
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'POST만 허용' });
    if (!originOk(req)) return sendJson(res, 403, { error: '허용되지 않은 Origin' });
    const id = project;
    if (!validSessionId(id)) return sendJson(res, 400, { error: '세션 id 형식이 올바르지 않습니다' });
    return readJson(req).then((body) => {
      const target = sessionTarget(id);
      if (!target) return sendJson(res, 404, { error: `세션 없음: ${id}` });
      if (rest[0] === 'end' && !features().closeout) return sendJson(res, 409, { error: FEATURE_OFF });
      const job = rest[0] === 'end' ? requestEnd(target, { fromSession: body?.fromSession === true }) : registerAfterArchive(target, { ignoredOk: body?.ignoredOk === true });
      return job.then((r) => sendJson(res, r.status, r.body ?? { error: r.error }));
    }, (e) => {
      if (e.status === 413) res.on('finish', () => req.destroy());
      sendJson(res, e.status || 400, { error: e.message });
    });
  }
  if (name === 'sessions' && segs.length === 3 && rest[0] === 'closeout') {
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'POST만 허용' });
    if (!originOk(req)) return sendJson(res, 403, { error: '허용되지 않은 Origin' });
    const id = project;
    if (!validSessionId(id)) return sendJson(res, 400, { error: '세션 id 형식이 올바르지 않습니다' });
    return readJson(req).then(() => {
      const target = sessionTarget(id);
      if (!target) return sendJson(res, 404, { error: `세션 없음: ${id}` });
      if (!features().closeout) return sendJson(res, 409, { error: FEATURE_OFF });
      return closeoutSession(target).then((r) => sendJson(res, r.status, r.body ?? { error: r.error }));
    }, (e) => {
      if (e.status === 413) res.on('finish', () => req.destroy());
      sendJson(res, e.status || 400, { error: e.message });
    });
  }
  if (name === 'install' && segs.length === 2 && segs[1] === 'fix') {
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'POST만 허용' });
    if (!originOk(req)) return sendJson(res, 403, { error: '허용되지 않은 Origin' });
    return readJson(req).then((body) => {
      const ids = body?.ids;
      if (ids !== undefined && !(Array.isArray(ids) && ids.length <= 200 && ids.every((x) => typeof x === 'string' && x.length <= 40))) {
        return sendJson(res, 400, { error: 'ids는 항목 id 문자열 배열이어야 합니다' });
      }
      let r;
      try { r = fixInstall(ids); } catch (e) { console.error('[install]', e); return sendJson(res, 500, { error: e.message }); }
      if (r.status === 200) console.log(`[write] install fix 적용 ${r.body.applied.length} · 실패 ${r.body.failed.length} · 낡음 ${r.body.stale.length}`);
      sendJson(res, r.status, r.body ?? { error: r.error });
    }, (e) => {
      if (e.status === 413) res.on('finish', () => req.destroy());
      sendJson(res, e.status || 400, { error: e.message });
    });
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: '읽기 전용 API입니다' });
  if (name === 'install' && segs.length === 1) {
    try { return sendJson(res, 200, installStatus()); } catch (e) { console.error('[install]', e); return sendJson(res, 500, { error: e.message }); }
  }
  if (name === 'events' && segs.length === 1) return req.method === 'GET' ? sseOpen(req, res) : sendJson(res, 405, { error: 'GET만 허용' });
  if (name === 'roadmaps' && segs.length === 2) {
    const r = getRoadmap(project);
    return r ? sendJson(res, 200, r) : notFound(res, `로드맵 없음: ${project}`);
  }
  if (name === 'issues' && segs.length === 2) {
    const r = getIssues(project);
    return r ? sendJson(res, 200, r) : notFound(res, `이슈 파일 없음: ${project}`);
  }
  if (name === 'flows' && segs.length === 2) {
    const r = getFlows(project);
    return r ? sendJson(res, 200, r) : notFound(res, `흐름 문서 없음: ${project}`);
  }
  if (name === 'plans' && segs.length === 2) return sendJson(res, 200, getPlans(project));
  if (name === 'plans' && segs.length === 4 && rest[0] === 'section') {
    const r = getPlanSection(project, rest[1]);
    return r ? sendJson(res, 200, r) : notFound(res, `절 번호가 아님: ${rest[1]}`);
  }
  if (name === 'plans' && segs.length === 3) {
    const r = getPlan(project, rest[0]);
    return r ? sendJson(res, 200, r) : notFound(res, `기획 문서 없음: ${project}/${rest[0]}`);
  }
  if (name === 'notes' && segs.length === 2) {
    const r = getNotes(project);
    return r ? sendJson(res, 200, r) : notFound(res, `학습 노트 없음: ${project}`);
  }
  if (name === 'improvements' && segs.length === 2) {
    const r = getImprovements(project);
    return r ? sendJson(res, 200, r) : notFound(res, `개선 기록 없음: ${project}`);
  }
  if (name === 'cards' && segs.length === 3) {
    const r = getCard(project, rest[0]);
    return r ? sendJson(res, 200, r) : notFound(res, `작업 카드 없음: ${project}/${rest[0]}`);
  }
  if (name === 'docs' && segs.length === 1) return sendJson(res, 200, getDocs());
  if (name === 'docs' && segs.length === 2) {
    const r = getDoc(project);
    return r ? sendJson(res, 200, r) : notFound(res, `문서 없음: ${project}`);
  }
  if (name === 'usage' && segs.length === 1) return sendJson(res, 200, getTodayUsage());
  if (name === 'usage' && segs.length === 2) return sendJson(res, 200, getSessionUsage(project));
  if (name === 'sessions' && segs.length === 1) return sendJson(res, 200, getSessions());
  if (name === 'details' && segs.length === 3) {
    const r = getDetail(project, rest[0]);
    return r ? sendJson(res, 200, r) : notFound(res, `로드맵 항목 없음: ${project}/${rest[0]}`);
  }
  return notFound(res, '알 수 없는 API');
}

const server = http.createServer((req, res) => {
  if (!hostOk(req)) return sendJson(res, 403, { error: '허용되지 않은 Host' });
  const url = new URL(req.url, `http://${req.headers.host}`);
  const isApi = url.pathname === '/api' || url.pathname.startsWith('/api/');
  if (req.method !== 'GET' && req.method !== 'HEAD' && !(isApi && req.method === 'POST')) return sendJson(res, 405, { error: '읽기 전용 서버입니다' });
  try {
    if (isApi) {
      let segs;
      try { segs = url.pathname.split('/').slice(2).filter(Boolean).map(decodeURIComponent); }
      catch { return sendJson(res, 400, { error: '잘못된 경로 인코딩' }); }
      if (segs.some((s) => s === '.' || s === '..' || s.includes('/') || s.includes('\\') || s.includes('\0'))) return sendJson(res, 400, { error: '잘못된 경로' });
      const r = handleApi(req, res, segs);
      if (r && typeof r.catch === 'function') r.catch((e) => { console.error('[server]', e); if (!res.headersSent) sendJson(res, 500, { error: '서버 오류 (서버 로그 참고)' }); });
      return;
    }
    return serveStatic(res, url.pathname);
  } catch (e) {
    console.error('[server]', e);
    if (!res.headersSent) sendJson(res, 500, { error: '서버 오류 (서버 로그 참고)' });
    else res.end();
  }
});

const stopWatch = watchWorkDash((changes) => {
  console.log(`[watch] ${changes.map((c) => [c.kind, c.project, c.file].filter(Boolean).join('/')).join(', ')}`);
  broadcast('changed', { at: Date.now(), changes });
});

const stopPlansWatch = watchPlans((changes) => {
  console.log(`[watch] ${changes.map((c) => `plans/${c.project}`).join(', ')}`);
  broadcast('changed', { at: Date.now(), changes });
}, () => getProjects().map((p) => p.project));

const stopDocsWatch = watchDocs((changes) => {
  console.log(`[watch] ${changes.map((c) => `docs/${c.file}`).join(', ')}`);
  broadcast('changed', { at: Date.now(), changes });
});

const stopSessions = watchSessions((changes) => broadcast('changed', { at: Date.now(), changes }));

const stopUsage = watchUsage((changes) => broadcast('changed', { at: Date.now(), changes }), () => clients.size > 0);

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') console.error(`포트 ${PORT}이 이미 사용 중입니다. 이미 실행 중인 서버가 있는지 확인하세요.`);
  else console.error(e);
  process.exit(1);
});
server.listen(PORT, HOST, () => {
  console.log(`work-dash-app: http://localhost:${PORT}  (데이터: ${WD})`);
});

function shutdown() {
  clearInterval(heartbeat);
  clearInterval(buildCheck);
  stopWatch();
  stopDocsWatch();
  stopPlansWatch();
  stopUsage();
  stopSessions();
  for (const res of clients) res.end();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
