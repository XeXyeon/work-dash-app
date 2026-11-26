import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { KIT } from '../server/kit.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let home, port, server, logs = '';

function seed(wd) {
  for (const d of ['roadmaps', 'issues', 'worklogs/demo', 'data/sessions']) fs.mkdirSync(path.join(wd, d), { recursive: true });
  fs.writeFileSync(path.join(wd, 'roadmaps', 'demo.md'), [
    '# demo 로드맵', '',
    '## M1. 장바구니 공유', '    완료 기준: 공유 링크로 같은 장바구니를 본다',
    '- [x] CART-1 장바구니 엔티티',
    '- [~] CART-2 공유 API (after: CART-1) @claude',
    '- [ ] CART-3 링크 만료 (after: CART-2)', '',
  ].join('\n'));
  fs.writeFileSync(path.join(wd, 'issues', 'demo.md'), [
    '# demo 이슈', '',
    '- [ ] CART-2#1 [중간][버그] 공유 링크가 두 번 만들어짐',
    '  - 재현: 버튼 두 번 클릭',
    '- [ ] ISS-1 [낮음][설정] 설정 키 누락', '',
  ].join('\n'));
  fs.writeFileSync(path.join(wd, 'worklogs', 'demo', 'CART-2.md'), '# CART-2 공유 API\n- 상태: 진행 중 · @claude · 시작 2026-11-20 10:00\n\n## 계획\n- 할 일: 공유 API\n');
}

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => { const { port: p } = s.address(); s.close(() => resolve(p)); });
  s.on('error', reject);
});

function request(pathname, { method = 'GET', host } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: pathname, method, headers: { host: host || `127.0.0.1:${port}` } }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => { let json = null; try { json = JSON.parse(body); } catch {} resolve({ status: res.statusCode, json }); });
    });
    req.on('error', reject);
    req.end();
  });
}

async function waitReady(ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try { if ((await request('/api/health')).status === 200) return; } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`서버가 ${ms}ms 안에 뜨지 않았다\n${logs}`);
}

before(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'wd-server-'));
  seed(path.join(home, '.work-dash'));
  port = await freePort();
  const env = { ...process.env, HOME: home, WORK_DASH_KIT: KIT, WORK_DASH_APP_PORT: String(port), npm_config_offline: 'true', npm_config_cache: path.join(home, '.npm') };
  delete env.WORK_DASH_DIR;
  delete env.CODEX_HOME;
  server = spawn(process.execPath, [path.join(REPO, 'server', 'index.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stdout.on('data', (c) => { logs += c; });
  server.stderr.on('data', (c) => { logs += c; });
  await waitReady(10_000);
});

after(async () => {
  if (server && server.exitCode == null) {
    const exited = new Promise((r) => server.once('exit', r));
    server.kill('SIGTERM');
    await Promise.race([exited, new Promise((r) => setTimeout(r, 3000))]);
    if (server.exitCode == null) server.kill('SIGKILL');
  }
  fs.rmSync(home, { recursive: true, force: true });
});

test('health는 임시 데이터 폴더를 가리킨다', async () => {
  const r = await request('/api/health');
  assert.equal(r.status, 200);
  assert.equal(r.json.app, 'work-dash-app');
  assert.equal(fs.realpathSync(r.json.dataDir), fs.realpathSync(path.join(home, '.work-dash')));
});

test('projects에 로드맵 진행 수가 들어 있다', async () => {
  const r = await request('/api/projects');
  assert.equal(r.status, 200);
  const demo = r.json.find((p) => p.project === 'demo');
  assert.ok(demo, 'demo 프로젝트가 없다');
  assert.equal(demo.total, 3);
  assert.equal(demo.done, 1);
  assert.equal(demo.doing, 1);
  assert.equal(demo.openIssues, 2);
});

test('roadmaps는 마일스톤 · 항목 · 선행 · 항목별 이슈를 돌려준다', async () => {
  const r = await request('/api/roadmaps/demo');
  assert.equal(r.status, 200);
  assert.equal(r.json.milestones.length, 1);
  const items = Object.fromEntries(r.json.milestones[0].items.map((i) => [i.id, i]));
  assert.equal(items['CART-1'].state, 'done');
  assert.equal(items['CART-2'].state, 'doing');
  assert.equal(items['CART-2'].owner, 'claude');
  assert.equal(items['CART-2'].hasCard, true);
  assert.equal(items['CART-3'].state, 'blocked');
  assert.deepEqual(items['CART-2'].issues.map((i) => i.id), ['CART-2#1']);
  assert.deepEqual(r.json.commonIssues.map((i) => i.id), ['ISS-1']);
});

test('issues는 심각도 · 종류 · 세부 줄을 돌려준다', async () => {
  const r = await request('/api/issues/demo');
  assert.equal(r.status, 200);
  const i = r.json.issues.find((x) => x.id === 'CART-2#1');
  assert.equal(i.severity, '중간');
  assert.equal(i.kind, '버그');
  assert.deepEqual(i.details, [{ key: '재현', value: '버튼 두 번 클릭' }]);
  assert.equal(r.json.open, 2);
});

test('cards · details는 항목 하나를 돌려준다', async () => {
  const card = await request('/api/cards/demo/CART-2');
  assert.equal(card.status, 200);
  assert.match(card.json.markdown, /^# CART-2 공유 API/);
  const detail = await request('/api/details/demo/CART-2');
  assert.equal(detail.status, 200);
  assert.equal(detail.json.id, 'CART-2');
});

test('docs · sessions는 200을 돌려준다', async () => {
  assert.equal((await request('/api/docs')).status, 200);
  assert.equal((await request('/api/sessions')).status, 200);
});

test('없는 것 · 막힌 요청은 거절한다', async () => {
  assert.equal((await request('/api/roadmaps/none')).status, 404);
  assert.equal((await request('/api/cards/demo/a%2Fb')).status, 400);
  assert.equal((await request('/api/health', { host: 'evil.example:80' })).status, 403);
  assert.equal((await request('/api/health', { method: 'DELETE' })).status, 405);
});
