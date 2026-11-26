#!/usr/bin/env node
// 바뀐 파일을 보고 그 저장소의 확인(타입 검사 · 린트 · 테스트)을 골라 한 번에 돌린다.
// 무엇을 돌릴지는 ~/.work-dash/checks/<저장소 폴더>.json에 있고, 없으면 저장소의 .work-dash-checks.json을 읽는다.
//   check.js            기준 브랜치에 비해 바뀐 파일에 맞는 확인만 돌린다
//   check.js --full     푸시 · PR 직전의 전체 확인
//   check.js --dry      돌릴 명령만 보여 준다
//   check.js --init     이 저장소의 설정 초안을 만든다(--all: config.json의 include에 있는 저장소 모두)
//   check.js --unblock "<명령>" "<이유>"   틀리게 막는 명령을 설정의 fullOnly · serve에서 뺀다
//   check.js --add "<글롭>" "<명령>"        바뀐 파일에 맞춰 돌릴 확인을 설정에 더한다
//   check.js --log [일수]                    훅이 막은 것 · 건너뛴 것의 요약(기본 7일)
// --full이 통과하면 그때의 작업 트리를 기록한다. 설정에 "fullBeforePush": true가 있으면 cmdcheck.js가 pushGate를 불러 기록 없는 커밋의 푸시를 막는다.
// cmdcheck.js는 blockProblem을 불러, 설정의 fullOnly 명령을 직접 치거나 워크트리에서 serve 명령을 띄우면 막는다.
const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const os = require('os');
const { WD, HOME } = require('./paths');
const hooklog = require('./hooklog');

const CLI = 'node ~/.work-dash/app/core/check.js';
const EXAMPLE = '{ "checks": [{ "when": ["src/**"], "run": "npm run typecheck" }], "full": "npm run lint && npm test", "fullOnly": ["npm test"], "serve": ["npm run dev"] }';

function topOf(cwd) {
  let dir = path.resolve(cwd || process.cwd());
  for (;;) {
    let st = null;
    try { st = fs.statSync(path.join(dir, '.git')); } catch {}
    if (st) {
      let worktree = false;
      if (st.isFile()) try { worktree = /\/worktrees\//.test(fs.readFileSync(path.join(dir, '.git'), 'utf8')); } catch {}
      return { top: dir, worktree };
    }
    const up = path.dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

const LOCAL = '.work-dash-checks.json';
const TABLE_RE = /^#{1,4} .*테스트 범위/m;

const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'out', 'target', 'vendor', 'coverage']);
const SERVER_TOOL = /\b(?:vite|next|nuxt|astro|remix|nodemon|webpack-dev-server|webpack serve|react-scripts start|ng serve|http-server|storybook)\b/;

function repoName(top) {
  let main = top;
  try {
    const m = fs.readFileSync(path.join(top, '.git'), 'utf8').match(/^gitdir: (.+)\/\.git\/worktrees\/[^/\n]+\s*$/m);
    if (m) main = path.resolve(top, m[1]);
  } catch {}
  return path.basename(main);
}

const strings = (v) => Array.isArray(v) && v.every((x) => typeof x === 'string' && x.trim());

function loadConfig(top) {
  const name = repoName(top);
  let file = path.join(WD, 'checks', `${name}.json`);
  let shown = `~/.work-dash/checks/${name}.json`;
  let text = null;
  try { text = fs.readFileSync(file, 'utf8'); } catch {}
  if (text == null) {
    try { text = fs.readFileSync(path.join(top, LOCAL), 'utf8'); file = path.join(top, LOCAL); shown = LOCAL; } catch { return { file, shown, config: null }; }
  }
  let c;
  try { c = JSON.parse(text); } catch (e) { return { file, shown, config: null, error: `JSON이 깨졌다(${e.message})` }; }
  if (!c || typeof c !== 'object' || Array.isArray(c)) return { file, shown, config: null, error: '맨 바깥이 객체가 아니다' };
  const checks = c.checks === undefined ? [] : c.checks;
  if (!Array.isArray(checks) || !checks.every((k) => k && strings(k.when) && typeof k.run === 'string' && k.run.trim())) return { file, shown, config: null, error: '`checks`의 원소는 `{ "when": ["<글롭>"], "run": "<명령>" }` 모양이어야 한다' };
  for (const key of ['fullOnly', 'serve']) if (c[key] !== undefined && !strings(c[key])) return { file, shown, config: null, error: `\`${key}\`는 명령 문자열의 배열이어야 한다` };
  if (c.full !== undefined && (typeof c.full !== 'string' || !c.full.trim())) return { file, shown, config: null, error: '`full`은 명령 문자열 하나여야 한다' };
  if (c.fullBeforePush !== undefined && typeof c.fullBeforePush !== 'boolean') return { file, shown, config: null, error: '`fullBeforePush`는 true 또는 false여야 한다' };
  return { file, shown, config: { checks, full: c.full || null, fullOnly: c.fullOnly || [], serve: c.serve || [], fullBeforePush: c.fullBeforePush === true } };
}

function globRe(glob) {
  let re = '';
  let depth = 0;
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === '*' && glob[i + 1] === '*') {
      if (glob[i + 2] === '/') { re += '(?:.*/)?'; i += 2; } else { re += '.*'; i += 1; }
    } else if (ch === '*') re += '[^/]*';
    else if (ch === '?') re += '[^/]';
    else if (ch === '{') { re += '(?:'; depth++; }
    else if (ch === '}' && depth) { re += ')'; depth--; }
    else if (ch === ',' && depth) re += '|';
    else re += ch.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}${')'.repeat(depth)}$`);
}

const quote = (f) => {
  const p = f.startsWith('-') ? `./${f}` : f;
  return /^[\w./@:+-]+$/.test(p) ? p : `'${p.replace(/'/g, "'\\''")}'`;
};

function plan(config, files) {
  const out = [];
  for (const k of config.checks) {
    const res = k.when.map(globRe);
    const hit = files.filter((f) => res.some((r) => r.test(f)));
    if (!hit.length) continue;
    const run = k.run.replace(/\{files\}/g, hit.map(quote).join(' '));
    if (!out.some((o) => o.run === run)) out.push({ run, files: hit });
  }
  return out;
}

function changedFiles(top) {
  const git = (...a) => execFileSync('git', ['-C', top, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 });
  const names = (s) => s.split('\0').filter(Boolean);
  let base = null;
  let head = true;
  try { git('rev-parse', '--verify', '-q', 'HEAD'); } catch { head = false; }
  if (head) {
    for (const ref of [process.env.CHECK_BASE, 'dev', 'origin/dev', 'main', 'origin/main', 'master', 'origin/master'].filter(Boolean)) {
      try { base = git('merge-base', 'HEAD', ref).trim(); break; } catch {}
    }
  }
  const diff = names(head ? git('diff', '-z', '--name-only', '--diff-filter=d', base || 'HEAD') : git('ls-files', '-z'));
  const fresh = names(git('ls-files', '-z', '--others', '--exclude-standard'));
  return { base, head, files: [...new Set([...diff, ...fresh])].filter((f) => fs.existsSync(path.join(top, f))) };
}

const norm = (s) => s.trim().replace(/\s+/g, ' ');

function segments(command) {
  const out = [];
  const text = String(command);
  let cur = '';
  let q = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '\\' && q === '"') { cur += ch + (text[++i] || ''); continue; }
      if (ch === q) q = null;
      cur += ch;
    } else if (ch === '"' || ch === "'") { q = ch; cur += ch; }
    else if (ch === '\\') cur += ch + (text[++i] || '');
    else if (ch === ';' || ch === '\n') { out.push(cur); cur = ''; }
    else if ((ch === '&' || ch === '|') && text[i + 1] === ch) { out.push(cur); cur = ''; i++; }
    else if (ch === '|') { out.push(cur); cur = ''; if (text[i + 1] === '&') i++; }
    else cur += ch;
  }
  out.push(cur);
  return out.map(norm).filter(Boolean);
}

function bare(seg) {
  let s = seg;
  for (let prev = null; prev !== s;) {
    prev = s;
    s = s.replace(/\s*(?:\d*>&\d+|\d*>>?\s*[\w./-]+|&)$/, '').replace(/^\(\s*/, '').replace(/\s*\)$/, '').replace(/^time\s+/, '').replace(/^[A-Za-z_]\w*=(?:"[^"]*"|'[^']*'|[\w./:-]*)\s+/, '');
  }
  return s;
}

function leaves(segs, cwd, top) {
  for (const s of segs) {
    const m = s.match(/^cd(?:\s+(.+))?$/);
    if (!m) continue;
    const to = (m[1] || '~').replace(/^(['"])(.*)\1$/, '$2');
    if (/[$`*~]/.test(to) || to === '-') return true;
    const rel = path.relative(top, path.resolve(cwd, to));
    if (rel.startsWith('..') || path.isAbsolute(rel)) return true;
  }
  return false;
}

function blockProblem(command, cwd) {
  const at = topOf(cwd);
  if (!at) return null;
  const { config } = loadConfig(at.top);
  if (!config) return null;
  const segs = segments(command).map(bare);
  if (leaves(segs, path.resolve(cwd || process.cwd()), at.top)) return null;
  const full = config.fullOnly.map(norm).find((p) => segs.includes(p));
  if (full) return `[work-dash] 명령을 막았다: \`${full}\`은 이 저장소의 전체 확인이라 직접 돌리지 않는다 → 작업 중에는 \`${CLI}\`(바뀐 파일에 맞는 확인만 돌린다), 푸시 · PR 직전에 한 번 \`${CLI} --full\`. 전체 확인이 아닌데 막혔으면 \`${CLI} --unblock "${full}" "<이유>"\`로 설정에서 뺀다`;
  if (at.worktree) {
    const serve = config.serve.map(norm).find((p) => segs.some((s) => s === p || s.startsWith(`${p} `)));
    if (serve) return `[work-dash] 명령을 막았다: \`${serve}\`는 서버 · 앱을 띄운다. 워크트리(병렬 세션)에서는 띄우지 않는다 → 포트를 쓰지 않는 확인은 \`${CLI}\`로 돌리고, 실행 확인이 필요하면 브랜치 · 확인할 동작 · 기대 결과를 지휘 세션에 보낸다. 서버를 띄우는 명령이 아닌데 막혔으면 \`${CLI} --unblock "${serve}" "<이유>"\`로 설정에서 뺀다`;
  }
  return null;
}

const PASS_FILE = path.join(WD, 'data', 'full-pass.json');
const PASS_KEEP = 20;
const gitOut = (top, args, env) => execFileSync('git', ['-C', top, ...args], { encoding: 'utf8', timeout: 60000, stdio: ['ignore', 'pipe', 'ignore'], env: env || process.env }).trim();

function workTree(top, all) {
  const tmp = path.join(os.tmpdir(), `wd-index-${process.pid}-${Date.now()}-${all ? 'a' : 'u'}`);
  try {
    const env = { ...process.env, GIT_INDEX_FILE: tmp };
    try { gitOut(top, ['read-tree', 'HEAD'], env); } catch {}
    gitOut(top, ['add', all ? '-A' : '-u'], env);
    if (!all) {
      const staged = gitOut(top, ['diff', '--cached', '--name-only', '--diff-filter=A', '-z']).split('\0').filter((f) => f && fs.existsSync(path.join(top, f)));
      if (staged.length) gitOut(top, ['add', '--', ...staged], env);
    }
    return gitOut(top, ['write-tree'], env);
  } catch { return null; } finally { fs.rmSync(tmp, { force: true }); }
}

const workTrees = (top) => [workTree(top, true), workTree(top, false)];

function passes() {
  try { const all = JSON.parse(fs.readFileSync(PASS_FILE, 'utf8')); return all && typeof all === 'object' ? all : {}; } catch { return {}; }
}

function recordPass(top, before) {
  const after = workTrees(top);
  if (!before[0] || !after[0]) { console.log('[check] 통과 기록을 남기지 못했다(작업 트리를 git으로 읽지 못함). 푸시가 막히면 `WD_SKIP="<이유>"`로 지나간다'); return; }
  if (before[0] !== after[0]) { console.log('[check] 확인하는 동안 파일이 바뀌어 통과 기록을 남기지 않았다 → 바뀐 것을 확인하고 `--full`을 다시 돌린다'); return; }
  const trees = [...new Set(after.filter(Boolean))];
  const all = passes();
  const name = repoName(top);
  all[name] = [...trees, ...(all[name] || []).filter((t) => !trees.includes(t))].slice(0, PASS_KEEP);
  try { fs.mkdirSync(path.dirname(PASS_FILE), { recursive: true }); save(PASS_FILE, all); } catch { console.log('[check] 통과 기록 파일을 쓰지 못했다'); }
}

const SHOW_COMMITS = 15;

function showUnpushed(top) {
  let out = '';
  try { out = gitOut(top, ['log', '--format=%x00%h %s', '--shortstat', 'HEAD', '--not', '--remotes']); } catch { return; }
  const commits = out.split('\0').filter(Boolean).map((c) => {
    const [title, ...rest] = c.trim().split('\n');
    const files = /(\d+) files? changed/.exec(rest.join(' '));
    return `  ${title}${files ? ` · 파일 ${files[1]}개` : ''}`;
  });
  if (!commits.length) return;
  console.log(`[check] 아직 원격에 없는 커밋 ${commits.length}개:`);
  for (const c of commits.slice(0, SHOW_COMMITS)) console.log(c);
  if (commits.length > SHOW_COMMITS) console.log(`  … 외 ${commits.length - SHOW_COMMITS}개`);
  console.log('[check] 한 커밋에 다른 일이 섞였으면 나눠서 다시 커밋한 뒤 푸시한다');
}

function pushGate(cwd) {
  const at = topOf(cwd);
  if (!at) return null;
  const { config } = loadConfig(at.top);
  if (!config || !config.fullBeforePush || !config.full) return null;
  let tree;
  try { tree = gitOut(at.top, ['rev-parse', 'HEAD^{tree}']); } catch { return null; }
  if ((passes()[repoName(at.top)] || []).includes(tree)) return null;
  return `[work-dash] 푸시를 막았다: 지금 커밋의 내용으로 전체 확인이 통과한 기록이 없다 → \`${CLI} --full\`을 돌려 통과한 뒤 다시 푸시한다(확인한 뒤에 파일을 더 고쳐 커밋했으면 다시 돌린다)`;
}

function runAll(list, top) {
  const failed = [];
  for (const { run } of list) {
    console.log(`\n[check] $ ${run}`);
    const r = spawnSync(run, { cwd: top, shell: true, stdio: 'inherit' });
    if (r.status !== 0) failed.push(run);
  }
  console.log(`\n[check] ${list.length - failed.length}개 통과${failed.length ? ` · ${failed.length}개 실패: ${failed.join(' / ')}` : ''}`);
  if (failed.length) console.log('[check] 내가 바꾼 코드에서 난 실패만 고친다. 남의 변경에서 난 실패는 고치지 않고 실패한 테스트와 원인 추정을 보고한다');
  return failed.length ? 1 : 0;
}

function draft(top) {
  const c = { checks: [], full: null, fullOnly: [], serve: [] };
  const full = [];
  let dirs = [];
  try { dirs = fs.readdirSync(top, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith('.') && !SKIP_DIRS.has(d.name)).map((d) => d.name).sort(); } catch {}
  for (const dir of ['', ...dirs]) {
    const has = (f) => fs.existsSync(path.join(top, dir, f));
    const g = dir ? `${dir}/` : '';
    const pre = dir ? `cd ${quote(dir)} && ` : '';
    const mine = [];
    let scripts = null;
    try { scripts = JSON.parse(fs.readFileSync(path.join(top, dir, 'package.json'), 'utf8')).scripts || {}; } catch {}
    if (scripts) {
      const pm = has('pnpm-lock.yaml') ? 'pnpm' : has('yarn.lock') ? 'yarn' : 'npm';
      const test = scripts.test && !/no test specified/.test(scripts.test) ? scripts.test : null;
      if (scripts.typecheck) { c.checks.push({ when: [`${g}**/*.{ts,tsx}`], run: `${pre}${pm} run typecheck` }); mine.push(`${pm} run typecheck`); }
      if (scripts.lint) { c.checks.push({ when: [`${g}**/*.{js,jsx,ts,tsx,mjs,cjs}`], run: `${pre}${pm} run lint` }); mine.push(`${pm} run lint`); }
      if (test) {
        const exec = pm === 'npm' ? 'npx' : `${pm} exec`;
        const related = dir ? null : /\bvitest\b/.test(test) ? `${exec} vitest related --run {files}` : /\bjest\b/.test(test) ? `${exec} jest --findRelatedTests --passWithNoTests {files}` : null;
        if (related) {
          c.checks.push({ when: ['**/*.{js,jsx,ts,tsx}'], run: related });
          c.fullOnly.push(`${pm} test`, `${pm} run test`);
        }
        mine.push(`${pm} test`);
      }
      if (scripts.build) mine.push(`${pm} run build`);
      for (const name of ['dev', 'start', 'serve', 'preview', 'storybook']) {
        if (typeof scripts[name] !== 'string' || (name !== 'dev' && name !== 'storybook' && !SERVER_TOOL.test(scripts[name]))) continue;
        c.serve.push(`${pm} run ${name}`);
        if (pm !== 'npm' || name === 'start') c.serve.push(`${pm} ${name}`);
      }
    }
    if (has('gradlew')) {
      const android = ['build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts'].some((f) => { try { return /com\.android/.test(fs.readFileSync(path.join(top, dir, f), 'utf8')); } catch { return false; } });
      if (!android) c.checks.push({ when: [`${g}**/*.{java,kt,kts,gradle}`], run: `${pre}./gradlew classes testClasses -q` });
      c.fullOnly.push('./gradlew test', './gradlew build', './gradlew check');
      c.serve.push('./gradlew bootRun');
      mine.push('./gradlew build');
    }
    if (has('Cargo.toml')) {
      const manifest = dir ? ` --manifest-path ${quote(`${dir}/Cargo.toml`)}` : '';
      c.checks.push({ when: [`${g}**/*.rs`, `${g}Cargo.toml`], run: `cargo check${manifest}` });
      full.push(`cargo test${manifest}`);
    }
    if (mine.length) full.push(dir ? `(${pre}${mine.join(' && ')})` : mine.join(' && '));
  }
  if (!c.checks.length && !c.fullOnly.length && !c.serve.length) return null;
  c.full = full.join(' && ') || undefined;
  c.fullOnly = [...new Set(c.fullOnly)];
  c.serve = [...new Set(c.serve)];
  return c;
}

function hasTable(top) {
  return ['AGENTS.md', 'CLAUDE.md'].filter((f) => { try { return TABLE_RE.test(fs.readFileSync(path.join(top, f), 'utf8')); } catch { return false; } });
}

function includedRepos() {
  let include = [];
  try { include = JSON.parse(fs.readFileSync(path.join(WD, 'config.json'), 'utf8')).include; } catch {}
  const out = [];
  for (const p of Array.isArray(include) ? include.filter((x) => typeof x === 'string' && x.trim()) : []) {
    const base = path.resolve(String(p).replace(/\/\*$/, '').replace(/^~(?=\/|$)/, HOME));
    if (!String(p).endsWith('/*')) { out.push(base); continue; }
    try { for (const d of fs.readdirSync(base, { withFileTypes: true })) if (d.isDirectory()) out.push(path.join(base, d.name)); } catch {}
  }
  return out.filter((d) => fs.existsSync(path.join(d, '.git'))).sort();
}

function init(tops, dry) {
  let made = 0;
  for (const top of tops) {
    const name = repoName(top);
    const found = loadConfig(top);
    if (found.config || found.error) { console.log(`[check] ${name}: 설정이 이미 있다(${found.shown})${found.error ? ` — ${found.error}` : ''}. 건너뜀`); continue; }
    const c = draft(top);
    if (!c) { console.log(`[check] ${name}: package.json · gradlew · Cargo.toml을 찾지 못했다. 만들지 않음`); continue; }
    const table = hasTable(top);
    const note = table.length ? ` · ${table.join(' · ')}에 확인 표가 있다 → 표의 내용을 설정으로 옮기고 표는 지운다` : '';
    if (dry) { console.log(`[check] ${name}: 만들 초안${note}\n${JSON.stringify(c, null, 2)}`); continue; }
    try {
      fs.mkdirSync(path.join(WD, 'checks'), { recursive: true });
      fs.writeFileSync(found.file, `${JSON.stringify(c, null, 2)}\n`, { flag: 'wx' });
    } catch (e) { console.log(`[check] ${name}: 초안을 쓰지 못했다(${e.code || e.message}). 건너뜀`); continue; }
    made++;
    console.log(`[check] ${name}: 초안을 만들었다(${found.shown}) — 확인 ${c.checks.length}개 · 직접 치면 막는 명령 ${c.fullOnly.length}개 · 서버 실행 ${c.serve.length}개${note}`);
  }
  if (made) console.log(`[check] 초안은 package.json의 scripts와 gradlew · Cargo.toml이 있는지만 보고 만들었다 → 쓰면서 고친다: 틀리게 막으면 \`${CLI} --unblock "<명령>" "<이유>"\`, 돌릴 확인이 빠졌으면 \`${CLI} --add "<글롭>" "<명령>"\``);
  return 0;
}

function save(file, data) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

function edit(top, flags, args) {
  const found = loadConfig(top);
  if (!found.config) { console.error(`[check] ${found.error ? `${found.shown}: ${found.error}` : `이 저장소의 확인 설정이 없다(${found.shown})`} → \`${CLI} --init\`으로 초안을 만든 뒤 다시 실행한다`); return 2; }
  const raw = JSON.parse(fs.readFileSync(found.file, 'utf8'));
  const inRepo = found.shown === LOCAL ? ` (저장소 안의 파일이라 다음 커밋에 들어간다)` : '';
  if (flags.has('--add')) {
    const [glob, run] = args;
    if (!glob || !run) { console.error(`[check] 글롭과 명령이 필요하다 → \`${CLI} --add "src/**/*.ts" "npx vitest related --run {files}"\`({files}는 바뀐 파일 목록으로 바뀐다)`); return 2; }
    raw.checks = [...(raw.checks || []), { when: [glob], run }];
    save(found.file, raw);
    console.log(`[check] ${found.shown}에 확인을 더했다: ${glob} → ${run}${inRepo}`);
    return 0;
  }
  const [cmd, reason] = args;
  if (!cmd || !reason) { console.error(`[check] 뺄 명령과 이유가 필요하다 → \`${CLI} --unblock "<명령>" "<이유>"\``); return 2; }
  const keep = (list) => (list || []).filter((p) => norm(p) !== norm(cmd));
  const before = (raw.fullOnly || []).length + (raw.serve || []).length;
  raw.fullOnly = keep(raw.fullOnly);
  raw.serve = keep(raw.serve);
  if (before === raw.fullOnly.length + raw.serve.length) { console.error(`[check] ${found.shown}의 fullOnly · serve에 \`${cmd}\`가 없다 → 막는 메시지에 나온 명령을 그대로 적는다`); return 2; }
  save(found.file, raw);
  try {
    hooklog.record({ kind: 'unblock', check: 'block-command', project: repoName(top), text: `설정에서 막는 명령을 뺌: ${cmd}`, reason });
  } catch {}
  console.log(`[check] ${found.shown}에서 \`${cmd}\`를 뺐다. 이제 막지 않는다 — 이유: ${reason}${inRepo}`);
  return 0;
}

function main(argv) {
  const flags = new Set(argv.filter((a) => a.startsWith('--')));
  const args = argv.filter((a) => !a.startsWith('--'));
  if (flags.has('--help')) { console.log(`${CLI} [--full] [--dry] [--init [--all]] [--unblock "<명령>" "<이유>"] [--add "<글롭>" "<명령>"] [--log [일수]] [--read-all "<이유>"]\n  인자 없음: 기준 브랜치에 비해 바뀐 파일에 맞는 확인만 돌린다(CHECK_BASE=<브랜치>로 기준을 바꾼다)\n  --full: 푸시 · PR 직전의 전체 확인\n  --dry: 돌릴 명령만 보여 준다\n  --init: 이 저장소의 설정 초안을 만든다. --all이면 config.json의 include에 있는 저장소 모두(이미 있으면 건너뛴다). --dry와 함께 쓰면 보여 주기만 한다\n  --unblock: 틀리게 막는 명령을 설정의 fullOnly · serve에서 뺀다\n  --add: 바뀐 파일에 맞춰 돌릴 확인을 설정에 더한다\n  설정에 "fullBeforePush": true를 적으면 --full이 통과한 커밋만 푸시된다(훅이 막는다)\n  --read-all "<이유>": 지휘 · 설계처럼 전체를 봐야 하는 세션에서 문서 통째 읽기를 연다(그 세션만, 기록에 남는다)\n  --log: 훅이 막은 것 · 건너뛴 것의 요약(기본 7일). 자주 건너뛰는 검사는 틀리게 막는 검사다\n설정: ~/.work-dash/checks/<저장소 폴더>.json, 없으면 저장소의 ${LOCAL} — ${EXAMPLE}`); return 0; }
  if (flags.has('--read-all')) {
    if (!args[0]) { console.error('[check] 이유가 필요하다 → --read-all "<왜 전체를 봐야 하는지>"'); return 2; }
    console.log('[check] 이 세션에서 로드맵 · 이슈 · 흐름 · 형식 문서를 통째로 읽을 수 있다(훅이 세션에 표시하고 기록했다). 훅이 없는 환경에서는 처음부터 막지 않는다');
    return 0;
  }
  if (flags.has('--log')) { console.log(hooklog.summary(Number(args[0]) > 0 ? Number(args[0]) : 7).join('\n')); return 0; }
  if (flags.has('--init') && flags.has('--all')) return init(includedRepos(), flags.has('--dry'));
  const at = topOf(process.cwd());
  if (!at) { console.error('[check] git 저장소 안이 아니다 → 저장소 폴더에서 실행한다'); return 2; }
  if (flags.has('--init')) return init([at.top], flags.has('--dry'));
  if (flags.has('--unblock') || flags.has('--add')) return edit(at.top, flags, args);
  const project = repoName(at.top);
  const { config, error, shown } = loadConfig(at.top);
  if (error) { console.error(`[check] ${shown}: ${error} → 이 모양으로 고친다: ${EXAMPLE}`); return 2; }
  if (!config) { console.error(`[check] 이 저장소의 확인 설정이 없다(${shown}) → \`${CLI} --init\`으로 초안을 만든 뒤 다시 실행한다`); return 2; }
  const table = hasTable(at.top);
  if (table.length) console.log(`[check] ${table.join(' · ')}에 "테스트 범위" 표가 남아 있다. 확인은 설정(${shown}) 하나만 본다 → 표에만 있는 확인을 설정으로 옮기고 표는 지운다`);
  let list;
  if (flags.has('--full')) {
    if (!config.full) { console.error(`[check] ${shown}에 \`full\`이 없다 → 전체 확인 명령을 \`"full": "<명령>"\`으로 적는다`); return 2; }
    list = [{ run: config.full, files: [] }];
  } else {
    let changed;
    try { changed = changedFiles(at.top); } catch (e) { console.error(`[check] 바뀐 파일을 git에서 읽지 못했다(${String(e.message).split('\n')[0]}) → \`git status\`로 저장소 상태를 확인한다`); return 2; }
    const { base, head, files } = changed;
    console.log(`[check] ${project}: ${base ? `기준 ${base.slice(0, 7)}에 비해` : head ? '마지막 커밋에 비해' : '아직 커밋이 없어 모든 파일을 본다 ·'} 바뀐 파일 ${files.length}개`);
    list = plan(config, files);
    if (!list.length) { console.log(files.length ? '[check] 바뀐 파일에 맞는 확인이 설정에 없다. 돌린 것 없음' : '[check] 바뀐 파일이 없다. 돌린 것 없음'); return 0; }
  }
  if (flags.has('--dry')) { for (const { run, files } of list) console.log(`[check] $ ${run}${files.length ? `   ← ${files.length}개 파일` : ''}`); return 0; }
  const before = flags.has('--full') ? workTrees(at.top) : null;
  const code = runAll(list, at.top);
  if (code === 0 && before) { recordPass(at.top, before); showUnpushed(at.top); }
  return code;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));

module.exports = { main, blockProblem, plan, globRe, loadConfig, segments, bare, draft, pushGate, changedFiles };
