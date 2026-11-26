import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const url = (f) => pathToFileURL(path.join(REPO, 'view', f)).href;

test('화면용 읽기 함수는 기록이 없는 홈에서도 빈 결과를 준다', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wd-view-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const code = `
    const w = await import(${JSON.stringify(url('workdash.js'))});
    const n = await import(${JSON.stringify(url('notes.js'))});
    const i = await import(${JSON.stringify(url('improvements.js'))});
    const p = await import(${JSON.stringify(url('plans.js'))});
    const r = await import(${JSON.stringify(url('redact.js'))});
    console.log(JSON.stringify({
      wd: w.WD,
      projects: w.getProjects(),
      roadmap: w.getRoadmap('none'),
      notes: n.getNotes('none'),
      improvements: i.getImprovements('none'),
      plans: p.getPlans('none'),
      redacted: r.redact({ apiKey: 'x', name: 'y' }),
    }));`;
  const env = { ...process.env, HOME: home };
  delete env.WORK_DASH_DIR;
  const out = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', code], { env, encoding: 'utf8' }));
  assert.equal(fs.realpathSync(path.dirname(out.wd)), fs.realpathSync(home));
  assert.ok(Array.isArray(out.projects));
  assert.deepEqual(out.redacted, { apiKey: '••••', name: 'y' });
});
