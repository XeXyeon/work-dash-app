#!/usr/bin/env node
// 예시 데이터로 대시보드를 띄운다: npm run demo [-- --port 4950]
// 임시 홈 폴더를 만들어 그 안에서만 설치(init)하고 서버를 띄우므로 내 ~/.work-dash · ~/.claude · ~/.codex는 읽지도 쓰지도 않는다.
// demo/data/의 파일은 {{t:-5h}}(시각) · {{d:-1d}}(날짜) · {{md:+6d}}(월/일) 자리를 지금 기준으로 채워 옮긴다.
// Ctrl-C로 끝내면 임시 폴더를 지운다.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { KIT } from '../server/kit.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(REPO, 'demo', 'data');
const portArg = process.argv.indexOf('--port');
const PORT = Number(portArg > 0 ? process.argv[portArg + 1] : process.env.WORK_DASH_APP_PORT) || 4950;

const now = Date.now();
const UNIT = { m: 60e3, h: 3600e3, d: 86400e3 };
const pad = (n) => String(n).padStart(2, '0');
const at = (offset) => {
  const m = /^([+-]\d+)([mhd])$/.exec(offset);
  if (!m) throw new Error(`시각 자리의 모양이 틀렸다: ${offset}`);
  return new Date(now + Number(m[1]) * UNIT[m[2]]);
};
const day = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const fill = (text) => text.replace(/\{\{(t|d|md):([^}]+)\}\}/g, (_, kind, offset) => {
  const d = at(offset);
  if (kind === 'd') return day(d);
  if (kind === 'md') return `${pad(d.getMonth() + 1)}/${pad(d.getDate())}`;
  return `${day(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
});

function copyFilled(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, e.name);
    const dst = path.join(to, e.name);
    if (e.isDirectory()) copyFilled(src, dst);
    else fs.writeFileSync(dst, fill(fs.readFileSync(src, 'utf8')));
  }
}

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'work-dash-demo-'));
const wd = path.join(home, '.work-dash');
const env = { ...process.env, HOME: home, WORK_DASH_KIT: KIT, WORK_DASH_APP_PORT: String(PORT), WORK_DASH_NOTIFY: '0' };
// 실제 홈을 가리킬 수 있는 변수는 넘기지 않는다 (XDG_*는 사용량 계산기 ccusage가 읽는다)
for (const key of ['WORK_DASH_DIR', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME']) delete env[key];

// 어디서 끝나든(설치 실패 · 예외 · 신호) 임시 폴더를 지운다
let server = null;
process.on('exit', () => {
  // 서버가 띄운 사용량 계산(npx)까지 함께 끝내야 지운 폴더에 다시 쓰지 않는다 → 프로세스 그룹째로 끝낸다
  if (server && server.exitCode == null) { try { process.kill(-server.pid, 'SIGKILL'); } catch { server.kill('SIGKILL'); } }
  fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => process.exit(0));

// 1. 임시 홈에 설치한다 (규칙 · 형식 문서 링크와 기본 설정이 생긴다)
// Claude · Codex 폴더가 있어야 설치가 두 쪽 모두에 규칙을 놓고, 서버가 지켜볼 폴더도 생긴다
for (const dir of ['.codex/skills', '.claude/plugins']) fs.mkdirSync(path.join(home, dir), { recursive: true });
const init = spawnSync(process.execPath, [path.join(KIT, 'bin', 'install.js'), 'init', '--yes'], { env, encoding: 'utf8' });
if (init.status !== 0) {
  console.error(init.stdout + init.stderr);
  process.exit(1);
}

// 2. 예시 프로젝트 폴더 (기획 탭은 저장소의 docs/를 읽는다)
const projects = ['shop-api', 'shop-web', 'side-blog'];
const projectDir = (name) => path.join(home, 'projects', name);
for (const name of projects) fs.mkdirSync(path.join(projectDir(name), '.git'), { recursive: true });
const config = JSON.parse(fs.readFileSync(path.join(wd, 'config.json'), 'utf8'));
config.include = ['~/projects/*'];
fs.writeFileSync(path.join(wd, 'config.json'), JSON.stringify(config, null, 2));
// 임시 홈에는 Claude 앱이 없어 환경 점검이 대화 열기 · 압축 · 종결을 끈다. 예시 화면에서는 실제로 쓰는 기기처럼 켜 둔다
fs.mkdirSync(path.join(wd, 'data'), { recursive: true });
fs.writeFileSync(path.join(wd, 'data', 'features.json'), JSON.stringify({ open: true, compact: true, closeout: true }));

// 3. 예시 데이터
for (const dir of ['roadmaps', 'issues', 'worklogs', 'flows', 'improvements']) copyFilled(path.join(DATA, dir), path.join(wd, dir));
for (const name of fs.readdirSync(path.join(DATA, 'plans'))) copyFilled(path.join(DATA, 'plans', name), path.join(projectDir(name), 'docs'));

// 4. 예시 세션 (Claude Code 훅이 남기는 기록과 같은 모양)
// 터미널 세션은 대화 기록 파일이 있어야 "대화 열기"가 켜진다
const transcripts = path.join(home, '.claude', 'projects', 'demo');
fs.mkdirSync(transcripts, { recursive: true });
const transcript = (id) => {
  const file = path.join(transcripts, `${id}.jsonl`);
  fs.writeFileSync(file, '');
  return file;
};
const session = (id, project, minutesAgo, rest) => ({
  id, cwd: projectDir(project), project, transcript: transcript(id), title: '', lastPrompt: '', status: 'idle',
  startedAt: now - 5 * UNIT.h, updatedAt: now - minutesAgo * UNIT.m, tasks: [], agents: [], ...rest,
});
const sessions = [
  session('00000000-0000-4000-8000-000000000001', 'shop-api', 4, {
    title: 'ORD-2 주문 생성 · 재고 차감', status: 'working', lastPrompt: 'ORD-2 이어서 진행해 줘',
    tasks: [
      { id: '1', content: '재고 잠금 조회 추가', status: 'completed' },
      { id: '2', content: '동시 주문 100건 테스트', status: 'in_progress' },
      { id: '3', content: '중복 주문 409 처리', status: 'pending' },
    ],
  }),
  session('00000000-0000-4000-8000-000000000002', 'shop-api', 6, {
    title: 'ORD-3 주문 조회 · 취소 API', status: 'waiting', waitReason: '질문에 답변 대기',
    lastPrompt: 'ORD-3 시작해 줘',
  }),
  session('00000000-0000-4000-8000-000000000003', 'shop-web', 33, {
    title: 'WEB-4 상품 상세 · 장바구니 담기', status: 'idle', lastPrompt: '장바구니 담기 버튼 연결해 줘',
  }),
  session('00000000-0000-4000-8000-000000000004', 'side-blog', 20 * 60, {
    title: 'BLOG-3 RSS · 사이트맵', status: 'ended', lastPrompt: '사이트맵 생성 확인했어',
  }),
];
fs.mkdirSync(path.join(wd, 'data', 'sessions'), { recursive: true });
for (const s of sessions) fs.writeFileSync(path.join(wd, 'data', 'sessions', `${s.id}.json`), JSON.stringify(s));

// 5. 서버
if (!fs.existsSync(path.join(REPO, 'dist', 'index.html'))) console.log('화면이 아직 빌드되지 않았다. 먼저 npm run build를 돌린다.');
server = spawn(process.execPath, [path.join(REPO, 'server', 'index.js')], { env, stdio: 'inherit', detached: true });
console.log(`예시 데이터로 띄웠다 → http://localhost:${PORT}  (임시 폴더 ${home}, Ctrl-C로 끝낸다)`);
server.on('error', (e) => { console.error(e.message); process.exit(1); });
server.on('exit', (code) => process.exit(code ?? 0));
