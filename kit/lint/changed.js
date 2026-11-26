#!/usr/bin/env node
//   npm run lint              dev에 비해 바뀐 파일만 검사한다
//   npm run lint -- --fix     고칠 수 있는 것(주석)을 고친다
//   npm run lint -- --all     모든 파일을 검사한다
//   LINT_BASE=<브랜치>         비교할 브랜치를 바꾼다
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIRS = ['core/', 'bin/', 'view/', 'test/', 'lint/'];
const args = process.argv.slice(2);
const all = args.includes('--all');
const pass = args.filter((a) => a !== '--all');

const git = (...a) => execFileSync('git', a, { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
const lines = (s) => s.split('\n').filter(Boolean);

function base() {
  for (const ref of [process.env.LINT_BASE, 'dev', 'origin/dev', 'main', 'origin/main'].filter(Boolean)) {
    try { return git('merge-base', 'HEAD', ref).trim(); } catch {}
  }
  return null;
}

function changed() {
  const b = base();
  if (!b) { console.error('[lint] 비교할 브랜치(dev · main)를 찾지 못했다 → `LINT_BASE=<브랜치> npm run lint` 또는 `npm run lint -- --all`'); process.exit(2); }
  const files = new Set([...lines(git('diff', '--name-only', '--diff-filter=d', b)), ...lines(git('ls-files', '--others', '--exclude-standard'))]);
  return [...files].filter((f) => f.endsWith('.js') && (f === 'eslint.config.js' || DIRS.some((d) => f.startsWith(d))) && fs.existsSync(path.join(REPO, f)));
}

const targets = all ? ['.'] : changed();
if (!targets.length) { console.log('[lint] 바뀐 파일이 없다'); process.exit(0); }
const r = spawnSync(process.execPath, [path.join(REPO, 'node_modules', 'eslint', 'bin', 'eslint.js'), ...pass, ...targets], { cwd: REPO, stdio: 'inherit' });
if (r.status === 0 && !all) console.log(`[lint] 바뀐 파일 ${targets.length}개 통과`);
process.exit(r.status ?? 1);
