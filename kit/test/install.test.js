import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const INSTALL = path.join(REPO, 'bin', 'install.js');

function tempHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wd-install-'));
  fs.mkdirSync(path.join(home, '.claude'));
  fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify({
    env: { KEEP: '1' },
    hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo mine' }] }] },
  }, null, 2) + '\n');
  fs.writeFileSync(path.join(home, '.claude', 'CLAUDE.md'), '# 내 규칙\n');
  return home;
}

function run(home, ...args) {
  const env = { ...process.env, HOME: home };
  delete env.WORK_DASH_DIR;
  delete env.CODEX_HOME;
  return execFileSync(process.execPath, [INSTALL, ...args], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function snapshot(home) {
  const out = {};
  const walk = (dir) => {
    for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, d.name);
      const rel = path.relative(home, p);
      if (/(^|\/)backup-init-/.test(rel)) continue;
      if (d.isSymbolicLink()) out[rel] = `link:${fs.readlinkSync(p)}`;
      else if (d.isDirectory()) walk(p);
      else out[rel] = crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
    }
  };
  walk(home);
  return out;
}

const hookCommands = (home) => {
  const s = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8'));
  return Object.values(s.hooks || {}).flat().flatMap((g) => g.hooks.map((h) => h.command));
};

test('init → 다시 init → uninstall이면 처음 상태로 돌아간다', (t) => {
  const home = tempHome();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const before = snapshot(home);

  run(home, 'init', '--yes');
  const cmds = hookCommands(home);
  for (const script of ['push.js', 'stuck.js', 'handoff.js', 'doccheck.js', 'cmdcheck.js', 'readcheck.js', 'editcheck.js']) {
    assert.ok(cmds.some((c) => c.includes(`.work-dash/app/core/${script}`)), `${script} 훅이 등록되지 않았다`);
  }
  assert.ok(cmds.includes('echo mine'), '원래 있던 훅이 사라졌다');
  assert.equal(fs.realpathSync(path.join(home, '.work-dash', 'app')), fs.realpathSync(REPO));
  assert.equal(JSON.parse(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8')).env.KEEP, '1');
  const installed = snapshot(home);

  const again = run(home, 'init', '--yes');
  assert.match(again, /바꿀 것이 없다/);
  assert.deepEqual(snapshot(home), installed, '두 번째 init이 파일을 바꿨다');

  run(home, 'uninstall', '--yes');
  assert.deepEqual(snapshot(home), before, 'uninstall 뒤 처음 상태와 다르다');
});

test('Codex 폴더가 있으면 명령 훅 · 문서 훅 · 인수인계 훅을 걸고, uninstall이면 되돌린다', (t) => {
  const home = tempHome();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.mkdirSync(path.join(home, '.codex'));
  const file = path.join(home, '.codex', 'hooks.json');
  fs.writeFileSync(file, JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo mine' }] }] } }, null, 2) + '\n');
  const before = snapshot(home);

  run(home, 'init', '--yes');
  const hooks = JSON.parse(fs.readFileSync(file, 'utf8')).hooks;
  const of = (event) => (hooks[event] || []).map((g) => `${g.matcher || ''} ${g.hooks.map((h) => h.command).join(' ')}`);
  assert.ok(of('PreToolUse').some((s) => s.startsWith('Bash ') && s.includes('core/cmdcheck.js')));
  assert.ok(of('PostToolUse').some((s) => s.startsWith('apply_patch ') && s.includes('core/doccheck.js')));
  assert.ok(of('PreToolUse').some((s) => s.startsWith('apply_patch ') && s.includes('core/editcheck.js')));
  assert.ok(of('UserPromptSubmit').some((s) => s.includes('core/handoff.js')));
  assert.ok(of('Stop').some((s) => s.includes('echo mine')), '원래 있던 훅이 사라졌다');

  run(home, 'uninstall', '--yes');
  assert.deepEqual(snapshot(home), before, 'uninstall 뒤 처음 상태와 다르다');
});

test('init --links는 폴더 · 링크만 만들고 설정 파일과 규칙 줄은 건드리지 않는다', (t) => {
  const home = tempHome();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const settings = fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8');

  run(home, 'init', '--yes', '--links');
  assert.equal(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8'), settings);
  assert.equal(fs.readFileSync(path.join(home, '.claude', 'CLAUDE.md'), 'utf8'), '# 내 규칙\n');
  assert.ok(fs.lstatSync(path.join(home, '.work-dash', 'RULES.md')).isSymbolicLink());
  assert.ok(fs.lstatSync(path.join(home, '.claude', 'commands', 'roadmap.md')).isSymbolicLink());
});

test('전에 init이 만든 명령 링크는 묻지 않고 지금 저장소로 바꾸고, 남이 만든 링크는 건너뛴다', (t) => {
  const home = tempHome();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  run(home, 'init', '--yes', '--links');

  const mine = path.join(home, '.claude', 'commands', 'roadmap.md');
  const theirs = path.join(home, '.claude', 'commands', 'issue.md');
  const manifestFile = path.join(home, '.work-dash', 'data', 'install.json');
  const m = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  const key = Object.keys(m.links).find((k) => k.endsWith(path.join('commands', 'roadmap.md')));
  fs.unlinkSync(mine); fs.symlinkSync('/old/repo/roadmap.md', mine);
  m.links[key].target = '/old/repo/roadmap.md';
  fs.writeFileSync(manifestFile, JSON.stringify(m));
  fs.unlinkSync(theirs); fs.symlinkSync('/someone/else/issue.md', theirs);

  run(home, 'init', '--yes', '--links');
  assert.equal(fs.realpathSync(mine), fs.realpathSync(path.join(REPO, 'claude', 'commands', 'roadmap.md')));
  assert.equal(fs.readlinkSync(theirs), '/someone/else/issue.md');
});
