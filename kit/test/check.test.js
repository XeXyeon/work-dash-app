import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHECK = path.join(REPO, 'core', 'check.js');
const CMDCHECK = path.join(REPO, 'core', 'cmdcheck.js');

const CONFIG = {
  checks: [
    { when: ['src/**'], run: 'node -e "console.log(\'타입 확인\')"' },
    { when: ['server/**/*.js'], run: 'node --check {files}' },
    { when: ['server/**', 'test/**'], run: 'node -e "console.log(\'시험\')"' },
  ],
  full: 'node -e "console.log(\'전체 확인\')"',
  fullOnly: ['npm test', './gradlew test'],
  serve: ['npm run dev'],
};

function setup(t, config = CONFIG) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wd-check-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const wd = path.join(root, 'data');
  const repo = path.join(root, 'demo');
  fs.mkdirSync(path.join(wd, 'checks'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'server'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'src'));
  if (config) fs.writeFileSync(path.join(wd, 'checks', 'demo.json'), typeof config === 'string' ? config : JSON.stringify(config));
  const env = { ...process.env, HOME: root, WORK_DASH_DIR: wd, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };
  delete env.CHECK_BASE;
  const git = (...a) => execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...a], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  fs.writeFileSync(path.join(repo, 'server', 'a.js'), 'const a = 1;\n');
  fs.writeFileSync(path.join(repo, 'README.md'), '# demo\n');
  git('init', '-q', '-b', 'main');
  git('add', '-A');
  git('commit', '-q', '-m', '처음');
  git('checkout', '-q', '-b', 'work');
  const run = (cwd, ...args) => {
    const r = spawnSync(process.execPath, [CHECK, ...args], { cwd, env, encoding: 'utf8' });
    return { code: r.status, out: r.stdout + r.stderr };
  };
  const hook = (command, cwd, more) => {
    const r = spawnSync(process.execPath, [CMDCHECK], { input: JSON.stringify({ tool_name: 'Bash', tool_input: { command }, cwd, ...more }), env, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    const out = r.stdout ? JSON.parse(r.stdout).hookSpecificOutput : null;
    return out && out.permissionDecision === 'deny' ? out.permissionDecisionReason : null;
  };
  return { root, wd, repo, git, run, hook, write: (rel, text) => fs.writeFileSync(path.join(repo, rel), text) };
}

test('check는 바뀐 파일에 맞는 확인만 골라 돌린다', (t) => {
  const s = setup(t);
  assert.match(s.run(s.repo).out, /바뀐 파일이 없다/);
  s.write('README.md', '# demo 2\n');
  const none = s.run(s.repo);
  assert.equal(none.code, 0);
  assert.match(none.out, /바뀐 파일 1개[\s\S]*맞는 확인이 설정에 없다/);

  s.write('server/a.js', 'const a = 2;\n');
  s.write('server/b c.js', 'const b = 1;\n');
  const dry = s.run(path.join(s.repo, 'server'), '--dry');
  assert.equal(dry.code, 0, dry.out);
  assert.match(dry.out, /\$ node --check server\/a\.js 'server\/b c\.js'/);
  assert.match(dry.out, /시험/);
  assert.doesNotMatch(dry.out, /타입 확인/);
  const ran = s.run(s.repo);
  assert.equal(ran.code, 0, ran.out);
  assert.match(ran.out, /\n시험\n[\s\S]*2개 통과/);

  s.git('add', '-A');
  s.git('commit', '-q', '-m', '둘째');
  assert.match(s.run(s.repo, '--dry').out, /기준 [0-9a-f]{7}에 비해 바뀐 파일 3개/);
});

test('check는 확인이 실패하면 나머지도 돌리고 실패로 끝난다', (t) => {
  const s = setup(t);
  s.write('server/a.js', 'const a = ;\n');
  const r = s.run(s.repo);
  assert.equal(r.code, 1);
  assert.match(r.out, /\n시험\n/);
  assert.match(r.out, /1개 통과 · 1개 실패: node --check server\/a\.js/);
  assert.match(r.out, /남의 변경에서 난 실패는 고치지 않고/);
});

test('check --full은 전체 확인을 돌리고, 설정이 없거나 틀리면 고칠 방법을 알린다', (t) => {
  const s = setup(t);
  const full = s.run(s.repo, '--full');
  assert.equal(full.code, 0, full.out);
  assert.match(full.out, /전체 확인\n[\s\S]*1개 통과/);
  assert.match(full.out, /아직 원격에 없는 커밋 1개:\n  [0-9a-f]+ 처음 · 파일 2개\n.*나눠서 다시 커밋/);

  const none = setup(t, null);
  const missing = none.run(none.repo);
  assert.equal(missing.code, 2);
  assert.match(missing.out, /확인 설정이 없다\(~\/\.work-dash\/checks\/demo\.json\) → /);
  for (const bad of ['{깨진', '[]', '{"fullOnly":"npm test"}', '{"full":["a"]}']) {
    const b = setup(t, bad);
    const r = b.run(b.repo);
    assert.equal(r.code, 2, bad);
    assert.match(r.out, / → 이 모양으로 고친다: /, bad);
  }
  const broken = setup(t, '{"checks":[{"when":"src/**","run":"x"}]}');
  const b = broken.run(broken.repo);
  assert.equal(b.code, 2);
  assert.match(b.out, /`checks`의 원소는 .* → /);
  assert.equal(broken.hook('npm test', broken.repo), null);
});

test('명령 훅: 설정에 적힌 전체 확인 명령을 직접 치면 막고 check로 돌려보낸다', (t) => {
  const s = setup(t);
  assert.match(s.hook('npm test', s.repo), /^\[work-dash\] 명령을 막았다: `npm test`.* → .*check\.js`.*check\.js --full`/);
  assert.ok(s.hook('npm run lint  &&  npm   test', path.join(s.repo, 'server')));
  assert.ok(s.hook('./gradlew test', s.repo, { turn_id: 't1' }));
  for (const c of ['npm test -- test/a.test.js', './gradlew test --tests "*Cart*"', 'npm run test:unit', 'echo "npm test"', 'node core/check.js --full', 'npm run dev']) assert.equal(s.hook(c, s.repo), null, c);
  for (const c of ['npm test 2>&1 | tail -20', 'CI=1 npm test', 'X="1" npm test', 'WD_SKIP="" echo hi; WD_SKIP="" npm test', '(npm test)', 'time npm test > out.log 2>&1']) assert.ok(s.hook(c, s.repo), c);
  for (const c of ['git commit -m "고침\n\nnpm test\n"', 'cat <<EOF\nnpm test\nEOF', 'git commit -m "$(cat <<\'EOF\'\n고침\n\nnpm test\nEOF\n)"', 'echo "a; npm test"', `cd ${s.root} && npm test`, 'cd "$DIR" && npm test']) assert.equal(s.hook(c, s.repo), null, c);
  assert.equal(s.hook('npm test', s.root), null);
  assert.equal(setup(t, null).hook('npm test', s.root), null);
});

test('명령 훅: 워크트리에서 서버를 띄우는 명령을 막고, 원래 저장소에서는 막지 않는다', (t) => {
  const s = setup(t);
  const tree = path.join(s.repo, '.claude', 'worktrees', 'side');
  s.git('worktree', 'add', '-q', tree, '-b', 'side');
  assert.match(s.hook('npm run dev', tree), /`npm run dev`는 서버 · 앱을 띄운다.* → .*지휘 세션/);
  assert.ok(s.hook('cd server && npm run dev -- --port 5000', tree));
  assert.equal(s.hook('npm run dev', s.repo), null);
  assert.ok(s.hook('PORT=5000 npm run dev &', tree));
  assert.equal(s.hook('npm run dev:server', tree), null);
  const far = path.join(s.root, 'far');
  s.git('worktree', 'add', '-q', far, '-b', 'far');
  assert.ok(s.hook('npm run dev', far));
  fs.mkdirSync(path.join(s.repo, 'sub'));
  fs.writeFileSync(path.join(s.repo, 'sub', '.git'), 'gitdir: ../.git/modules/sub\n');
  assert.equal(s.hook('npm run dev', path.join(s.repo, 'sub')), null);
  assert.equal(s.hook('npm run build', tree), null);
});

test('check는 한글 · 특수 문자 파일 이름과 첫 커밋 전 저장소를 다루고, 글롭의 ? · {a,b}를 읽는다', async (t) => {
  const s = setup(t, { checks: [{ when: ['**/*.{txt,js}'], run: 'node -e "console.log(process.argv.slice(1).join(String.fromCharCode(10)))" {files}' }] });
  s.write('한글 이름.txt', 'a\n');
  s.write('-n.txt', 'a\n');
  s.write('a"b.txt', 'a\n');
  const r = s.run(s.repo);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /바뀐 파일 3개/);
  assert.match(r.out, /\n한글 이름\.txt\n/);
  assert.match(r.out, /\n\.\/-n\.txt\n/);
  assert.match(r.out, /\na"b\.txt\n/);

  const { globRe } = (await import('../core/check.js')).default;
  assert.ok(globRe('src/?.js').test('src/a.js'));
  assert.ok(!globRe('src/?.js').test('src/ab.js'));
  assert.ok(globRe('src/*.{js,ts}').test('src/a.ts'));
  assert.ok(!globRe('src/*.{js,ts}').test('src/a.md'));

  const empty = path.join(s.root, 'fresh');
  fs.mkdirSync(empty);
  execFileSync('git', ['-C', empty, 'init', '-q']);
  fs.writeFileSync(path.join(empty, 'a.txt'), 'a\n');
  fs.writeFileSync(path.join(s.wd, 'checks', 'fresh.json'), JSON.stringify({ checks: [{ when: ['*.txt'], run: 'node -e "console.log(1)"' }] }));
  const f = s.run(empty, '--dry');
  assert.equal(f.code, 0, f.out);
  assert.match(f.out, /아직 커밋이 없어[\s\S]*바뀐 파일 1개/);
});

test('설정은 저장소 폴더 이름으로 찾고, 없으면 저장소 안의 파일을 읽는다. 확인 표가 남아 있으면 알린다', (t) => {
  const s = setup(t, null);
  s.write('.work-dash-checks.json', JSON.stringify({ checks: [{ when: ['*.md'], run: 'node -e "console.log(\'저장소 설정\')"' }], fullOnly: ['npm test'] }));
  s.write('AGENTS.md', '# demo\n\n## 테스트 범위\n| 바꾼 곳 | 확인 |\n');
  const r = s.run(s.repo);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /AGENTS\.md에 "테스트 범위" 표가 남아 있다.* → /);
  assert.match(r.out, /\n저장소 설정\n/);
  assert.ok(s.hook('npm test', s.repo));
  fs.writeFileSync(path.join(s.wd, 'checks', 'demo.json'), JSON.stringify({ fullOnly: ['yarn test'] }));
  assert.equal(s.hook('npm test', s.repo), null);
  assert.ok(s.hook('yarn test', s.repo));
  fs.writeFileSync(path.join(s.wd, 'config.json'), JSON.stringify({ projects: { other: { folders: ['demo'] } } }));
  assert.ok(s.hook('yarn test', s.repo));
});

test('check --init은 있는 스크립트만 보고 초안을 만들고, --all은 include의 저장소를 한 번에 돈다', (t) => {
  const s = setup(t, null);
  s.write('package.json', JSON.stringify({ scripts: { dev: 'vite', lint: 'eslint .', typecheck: 'tsc -b', test: 'vitest run', build: 'vite build' } }));
  s.write('pnpm-lock.yaml', '');
  fs.mkdirSync(path.join(s.repo, 'api'));
  s.write('api/gradlew', '');
  for (const d of ['dist', 'web', 'app']) fs.mkdirSync(path.join(s.repo, d));
  s.write('dist/package.json', JSON.stringify({ scripts: { test: 'jest', dev: 'vite' } }));
  s.write('web/package.json', JSON.stringify({ scripts: { test: 'jest', start: 'node cli.js', preview: 'vite preview' } }));
  s.write('app/gradlew', '');
  s.write('app/build.gradle', "plugins { id 'com.android.application' }");
  const two = path.join(s.root, 'empty');
  fs.mkdirSync(two);
  execFileSync('git', ['-C', two, 'init', '-q']);
  const three = path.join(s.root, 'node');
  fs.mkdirSync(three);
  execFileSync('git', ['-C', three, 'init', '-q']);
  fs.writeFileSync(path.join(three, 'package.json'), JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1', start: 'node .' } }));
  fs.writeFileSync(path.join(s.wd, 'config.json'), JSON.stringify({ include: { a: 1 } }));
  assert.equal(s.run(s.root, '--init', '--all').code, 0);
  fs.writeFileSync(path.join(s.wd, 'config.json'), JSON.stringify({ include: [`${s.root}/*`, 3] }));

  const dry = s.run(s.repo, '--init', '--dry');
  assert.match(dry.out, /demo: 만들 초안/);
  assert.ok(!fs.existsSync(path.join(s.wd, 'checks', 'demo.json')));

  const all = s.run(s.root, '--init', '--all');
  assert.equal(all.code, 0, all.out);
  assert.match(all.out, /demo: 초안을 만들었다/);
  assert.match(all.out, /empty: .*찾지 못했다/);
  assert.match(all.out, /node: .*찾지 못했다/);
  const c = JSON.parse(fs.readFileSync(path.join(s.wd, 'checks', 'demo.json'), 'utf8'));
  assert.deepEqual(c.fullOnly, ['pnpm test', 'pnpm run test', './gradlew test', './gradlew build', './gradlew check']);
  assert.deepEqual(c.serve, ['pnpm run dev', 'pnpm dev', './gradlew bootRun', 'npm run preview']);
  assert.deepEqual(c.checks.map((k) => k.run), ['pnpm run typecheck', 'pnpm run lint', 'pnpm exec vitest related --run {files}', 'cd api && ./gradlew classes testClasses -q']);
  assert.equal(c.full, 'pnpm run typecheck && pnpm run lint && pnpm test && pnpm run build && (cd api && ./gradlew build) && (cd app && ./gradlew build) && (cd web && npm test)');
  assert.ok(!fs.existsSync(path.join(s.wd, 'checks', 'node.json')));

  assert.match(s.run(s.root, '--init', '--all').out, /demo: 설정이 이미 있다.*건너뜀/);
  assert.ok(s.hook('pnpm test', s.repo));
  assert.equal(s.run(s.repo, '--dry').code, 0);
});

test('check --unblock은 틀리게 막는 명령을 설정에서 빼고 기록하며, --add는 확인을 더한다', (t) => {
  const s = setup(t);
  assert.match(s.hook('npm test', s.repo), /--unblock "npm test" "<이유>"/);
  assert.equal(s.run(s.repo, '--unblock', 'npm test').code, 2);
  assert.equal(s.run(s.repo, '--unblock', 'npm run nothing', '이유').code, 2);
  const r = s.run(s.repo, '--unblock', 'npm  test', '이 저장소의 테스트는 3초면 끝난다');
  assert.equal(r.code, 0, r.out);
  assert.equal(s.hook('npm test', s.repo), null);
  assert.ok(s.hook('./gradlew test', s.repo));
  const row = fs.readFileSync(path.join(s.wd, 'data', 'hook-log.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).find((x) => x.kind === 'unblock');
  assert.deepEqual([row.project, row.reason, row.text, row.check], ['demo', '이 저장소의 테스트는 3초면 끝난다', '설정에서 막는 명령을 뺌: npm test', 'block-command']);

  assert.equal(s.run(s.repo, '--add', '*.md').code, 2);
  assert.equal(s.run(s.repo, '--add', '*.md', 'node -e "console.log(\'문서 확인\')" {files}').code, 0);
  s.write('README.md', '# demo 2\n');
  assert.match(s.run(s.repo).out, /\n문서 확인\n/);
  const none = setup(t, null);
  assert.match(none.run(none.repo, '--unblock', 'npm test', '이유').out, /확인 설정이 없다.* → .*--init/);
});

test('푸시 앞 검사: fullBeforePush가 켜진 저장소는 전체 확인이 통과한 커밋만 푸시한다', (t) => {
  const s = setup(t, { ...CONFIG, fullBeforePush: true });
  assert.match(s.hook('git push origin work', s.repo), /푸시를 막았다: .*전체 확인이 통과한 기록이 없다 → .*--full/);
  assert.match(s.hook('git push', s.repo), /푸시를 막았다/);
  assert.match(s.hook(`git -C ${s.repo} push -u origin HEAD`, s.root), /푸시를 막았다/);
  s.write('server/a.js', 'const a = 2;\n');
  s.write('server/b.js', 'const b = 2;\n');
  assert.equal(s.run(s.repo, '--full').code, 0);
  assert.match(s.hook('git push', s.repo), /푸시를 막았다/);
  s.git('add', '-A');
  s.git('commit', '-q', '-m', '둘');
  assert.equal(s.hook('git push origin work', s.repo), null);
  assert.equal(s.hook('git push', s.repo), null);
  s.write('notes.txt', '커밋하지 않을 메모\n');
  s.write('server/d.js', 'const d = 4;\n');
  s.git('add', 'server/d.js');
  const staged = s.git('diff', '--cached', '--name-only');
  assert.equal(s.run(s.repo, '--full').code, 0);
  assert.equal(s.git('diff', '--cached', '--name-only'), staged);
  s.git('commit', '-q', '-m', '넷');
  assert.equal(s.hook('git push', s.repo), null);
  fs.rmSync(path.join(s.repo, 'notes.txt'));
  s.write('server/c.js', 'const c = 3;\n');
  s.git('add', '-A');
  s.git('commit', '-q', '-m', '셋');
  assert.match(s.hook('git push', s.repo), /푸시를 막았다/);
  assert.match(s.hook('git push origin work 2>&1 | tail -3', s.repo), /푸시를 막았다/);
  assert.match(s.hook('git push -o ci.skip origin work', s.repo), /푸시를 막았다/);
  const moving = setup(t, { ...CONFIG, full: 'node -e "require(\'fs\').writeFileSync(\'made.txt\', String(Date.now()))"', fullBeforePush: true });
  assert.match(moving.run(moving.repo, '--full').out, /확인하는 동안 파일이 바뀌어 통과 기록을 남기지 않았다/);
  for (const c of ['git push origin --delete old', 'git push --tags', 'git push origin main', 'git push origin a b c', 'git push --dry-run', 'git status']) assert.equal(s.hook(c, s.repo), null, c);
  const failing = setup(t, { ...CONFIG, full: 'node -e "process.exit(1)"', fullBeforePush: true });
  assert.equal(failing.run(failing.repo, '--full').code, 1);
  assert.match(failing.hook('git push', failing.repo), /푸시를 막았다/);
  const off = setup(t);
  assert.equal(off.hook('git push', off.repo), null);
  const bad = setup(t, { ...CONFIG, fullBeforePush: 'yes' });
  assert.match(bad.run(bad.repo, '--dry').out, /`fullBeforePush`는 true 또는 false/);
});
