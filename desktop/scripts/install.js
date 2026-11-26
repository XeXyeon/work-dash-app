#!/usr/bin/env node
// work-dash 앱을 /Applications에 설치한다 (WEB-12). 개인용이라 서명 · 공증은 하지 않는다.
//
//   npm run app:install              릴리스 빌드 → 실행 중이면 종료 → /Applications/work-dash.app 교체 → 다시 실행
//   npm run app:install -- --no-build   빌드 없이 마지막 빌드 결과만 설치
//   npm run app:install -- --no-open    설치 뒤 실행하지 않음
//
// 이미 있는 /Applications/work-dash.app이 이 앱(번들 id local.workdash.dashboard)이 아니면 건드리지 않는다.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const BUNDLE_ID = 'local.workdash.dashboard';
const BUILT = path.join(ROOT, 'desktop', 'target', 'release', 'bundle', 'macos', 'work-dash.app');
const DEST = '/Applications/work-dash.app';
const TMP = '/Applications/.work-dash.app.installing';

const args = process.argv.slice(2);
const noBuild = args.includes('--no-build');
const noOpen = args.includes('--no-open');

const fail = (msg) => { console.error(`✗ ${msg}`); process.exit(1); };
const run = (cmd, argv, opts = {}) => spawnSync(cmd, argv, { encoding: 'utf8', ...opts });
const bundleId = (app) => run('/usr/libexec/PlistBuddy', ['-c', 'Print CFBundleIdentifier', path.join(app, 'Contents', 'Info.plist')]).stdout?.trim();
const isRunning = () => run('/usr/bin/pgrep', ['-f', `${DEST}/Contents/MacOS/`]).status === 0;
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

if (process.platform !== 'darwin') fail('macOS에서만 설치할 수 있습니다.');

// 1. 빌드
if (!noBuild) {
  console.log('… 앱 빌드 (릴리스)');
  const r = run(process.execPath, [path.join(ROOT, 'node_modules', '@tauri-apps', 'cli', 'tauri.js'), 'build', '--bundles', 'app'], { cwd: ROOT, stdio: 'inherit' });
  if (r.status !== 0) fail('빌드 실패. 위 오류를 확인하세요.');
}
if (!fs.existsSync(BUILT)) fail(`빌드 결과가 없습니다: ${BUILT}`);
if (bundleId(BUILT) !== BUNDLE_ID) fail(`빌드 결과의 번들 id가 ${BUNDLE_ID}가 아닙니다.`);

// 2. 남의 앱이면 멈춤
if (fs.existsSync(DEST) && bundleId(DEST) !== BUNDLE_ID) {
  fail(`${DEST}가 이미 있는데 이 앱이 아닙니다 (번들 id: ${bundleId(DEST) || '알 수 없음'}). 직접 확인해 주세요.`);
}

// 3. 실행 중이면 정상 종료 (앱이 띄운 서버도 이때 정리된다)
const wasRunning = isRunning();
if (wasRunning) {
  console.log('… 실행 중인 앱 종료');
  run('/usr/bin/osascript', ['-e', `tell application id "${BUNDLE_ID}" to quit`]);
  for (let i = 0; i < 50 && isRunning(); i++) sleep(100);
  if (isRunning()) fail('앱이 5초 안에 꺼지지 않았습니다. 메뉴 막대에서 종료한 뒤 다시 실행하세요.');
}

// 4. 교체: 임시 이름으로 복사한 뒤 바꿔 끼운다 (복사 도중 실패해도 기존 앱이 남는다)
fs.rmSync(TMP, { recursive: true, force: true });
const cp = run('/usr/bin/ditto', [BUILT, TMP]);
if (cp.status !== 0) { fs.rmSync(TMP, { recursive: true, force: true }); fail(`복사 실패: ${cp.stderr.trim()}`); }
fs.rmSync(DEST, { recursive: true, force: true });
fs.renameSync(TMP, DEST);
// Finder · Dock이 예전 아이콘을 붙잡고 있지 않도록 수정 시각을 갱신하고 Launch Services에 다시 등록한다
const now = new Date();
fs.utimesSync(DEST, now, now);
run('/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister', ['-f', DEST]);
console.log(`✓ 설치: ${DEST}`);

// 5. 다시 실행
if (!noOpen) {
  run('/usr/bin/open', [DEST]);
  console.log(wasRunning ? '✓ 다시 실행했습니다.' : '✓ 실행했습니다. 메뉴 막대 아이콘에서 창 열기 · 종료를 할 수 있습니다.');
}
