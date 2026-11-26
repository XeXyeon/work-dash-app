import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(REPO, 'core', 'afterarchive.js');
const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wd-after-')));
process.env.WORK_DASH_DIR = path.join(home, '.work-dash');
process.env.WORK_DASH_NOTIFY = '0';
const { run, deleteBranch, removeWorktree, removeTmp, PENDING_FILE } = createRequire(import.meta.url)(SCRIPT);
test.after(() => fs.rmSync(home, { recursive: true, force: true }));

const ID = '11111111-2222-4333-8444-555555555555';
const git = (dir, ...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
function repo() {
  const dir = fs.mkdtempSync(path.join(home, 'repo-'));
  git(dir, 'init', '-q', '-b', 'dev');
  git(dir, '-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '--allow-empty', '-m', 'first');
  git(dir, 'branch', 'feat');
  return dir;
}

test('대기 목록이 없으면 아무것도 하지 않는다', () => {
  assert.deepEqual(run(), { pending: 0 });
  assert.equal(spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' }).status, 0);
});

test('보관이 확인되지 않은 세션의 것은 지우지 않고 목록에 남긴다', () => {
  const dir = repo();
  const sha = git(dir, 'rev-parse', 'feat');
  fs.mkdirSync(path.dirname(PENDING_FILE), { recursive: true });
  fs.writeFileSync(PENDING_FILE, JSON.stringify({ [ID]: { at: Date.now(), tmpDone: false, branches: [{ name: 'feat', sha, repo: dir, base: 'dev' }] } }));
  assert.deepEqual(run(), { pending: 1 });
  assert.equal(git(dir, 'rev-parse', 'feat'), sha);
  fs.unlinkSync(PENDING_FILE);
});

test('브랜치: 통합 브랜치 · 커밋이 달라진 것 · 병합을 확인하지 못한 것은 지우지 않는다', () => {
  const dir = repo();
  const sha = git(dir, 'rev-parse', 'feat');
  assert.equal(deleteBranch({ name: 'dev', sha, repo: dir }).result, 'skipped');
  assert.equal(deleteBranch({ name: 'main', sha, repo: dir }).result, 'skipped');
  assert.equal(deleteBranch({ name: '-D', sha, repo: dir }).result, 'skipped');
  assert.equal(deleteBranch({ name: 'feat', sha: '0'.repeat(40), repo: dir }).result, 'skipped');
  assert.equal(deleteBranch({ name: 'feat', sha, repo: dir, base: 'dev' }).result, 'skipped');
  assert.equal(deleteBranch({ name: 'none', sha, repo: dir }).result, 'gone');
  assert.equal(git(dir, 'rev-parse', 'feat'), sha);
});

test('워크트리: 앱이 만든 자리가 아니거나 세션 목록을 못 읽으면 지우지 않는다', () => {
  const dir = repo();
  const outside = fs.mkdtempSync(path.join(home, 'wt-'));
  assert.equal(removeWorktree({ path: outside, repo: dir, sha: 'x' }, null, ID).result, 'retry');
  assert.deepEqual(removeWorktree({ path: outside, repo: dir, sha: 'x' }, { list: [] }, ID), { result: 'skipped', reason: '앱이 만든 워크트리 자리가 아님', final: true });
  const nested = path.join(dir, '.claude', 'worktrees', 'a', 'b');
  assert.equal(removeWorktree({ path: nested, repo: dir, sha: 'x' }, { list: [] }, ID).final, true);
  const plain = path.join(dir, '.claude', 'worktrees', 'plain');
  fs.mkdirSync(plain, { recursive: true });
  fs.writeFileSync(path.join(plain, 'keep.txt'), 'x');
  assert.equal(removeWorktree({ path: plain, repo: dir, sha: 'x' }, { list: [] }, ID).reason, '깃의 워크트리 목록에 없음');
  assert.ok(fs.existsSync(path.join(plain, 'keep.txt')));
  assert.ok(fs.existsSync(outside));
});

test('임시 폴더: 세션 id 모양이 아니면 아무것도 지우지 않는다', () => {
  assert.deepEqual(removeTmp('../..'), []);
  assert.deepEqual(removeTmp(''), []);
});

test('보관된 세션의 워크트리: 새 파일이 있으면 남기고, 깨끗하면 지운다. 잠금이 있으면 돌지 않는다', () => {
  const wd = process.env.WORK_DASH_DIR;
  const env = { ...process.env, HOME: home, WORK_DASH_DIR: wd, WORK_DASH_NOTIFY: '0', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };
  const cli = (...args) => spawnSync(process.execPath, [SCRIPT, ...args], { env, encoding: 'utf8' });
  const dir = repo();
  const wt = path.join(dir, '.claude', 'worktrees', 'w1');
  git(dir, 'worktree', 'add', '-q', '-b', 'work', wt);
  const sha = git(wt, 'rev-parse', 'HEAD');
  const sessions = path.join(home, 'Library', 'Application Support', 'Claude', 'claude-code-sessions', 'a');
  fs.mkdirSync(sessions, { recursive: true });
  fs.mkdirSync(path.join(wd, 'data', 'sessions'), { recursive: true });
  fs.writeFileSync(path.join(sessions, 'local_x.json'), JSON.stringify({ sessionId: 'local_x', cliSessionId: ID, isArchived: true, worktreePath: wt, cwd: wt }));
  const write = () => fs.writeFileSync(PENDING_FILE, JSON.stringify({ [ID]: { at: Date.now(), tmpDone: true, branches: [], worktree: { path: wt, repo: dir, sha, ignored: [] } } }));

  fs.writeFileSync(path.join(wt, 'new.txt'), 'x');
  write();
  const lock = path.join(wd, 'data', 'closeout-pending.lock');
  fs.writeFileSync(lock, 'other');
  assert.deepEqual(JSON.parse(cli('run').stdout), { busy: true });
  assert.equal(fs.readFileSync(lock, 'utf8'), 'other');
  fs.unlinkSync(lock);

  assert.deepEqual(JSON.parse(cli('run').stdout), { pending: 1 });
  assert.ok(fs.existsSync(path.join(wt, 'new.txt')));
  const kept = JSON.parse(fs.readFileSync(PENDING_FILE, 'utf8'))[ID];
  assert.equal(kept.wt.tries, 1);
  assert.match(kept.wt.reason, /새 파일 1개/);

  fs.unlinkSync(path.join(wt, 'new.txt'));
  assert.deepEqual(JSON.parse(cli('run').stdout), { pending: 1 });
  assert.ok(fs.existsSync(wt));

  write();
  assert.deepEqual(JSON.parse(cli('run').stdout), { pending: 0 });
  assert.ok(!fs.existsSync(wt));
  assert.ok(!fs.existsSync(lock));
  assert.equal(git(dir, 'rev-parse', 'work'), sha);
});
