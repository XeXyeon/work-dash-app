import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WD } from './workdash.js';
import { getPluginsOverview, pluginsMtime, INSTALLED, PLUGINS_MD, USER_SKILLS } from './plugins.js';
import { getEnabledOverview } from './enabled.js';
import { core, corePath, view } from './kit.js';
const { redact, redactText } = await view('redact.js');

const { HOME } = core('paths.js');
const CLAUDE = path.join(HOME, '.claude');
const CODEX = process.env.CODEX_HOME || path.join(HOME, '.codex');
const TEMPLATES = corePath('templates');
const MAX_BYTES = 1024 * 1024;
const RETRY_MS = 5000;
const AGENT_NAMES = ['roadmap', 'issue', 'flows', 'interview'];

const tilde = (p) => (p === HOME || p.startsWith(HOME + path.sep) ? '~' + p.slice(HOME.length) : p);
const kindOf = (file) => ({ '.md': 'markdown', '.json': 'json', '.html': 'html' })[path.extname(file)] || 'text';

const S_RULES = 'work-dash 규칙';
const S_SESSION = '세션에 들어가는 것';
const S_SETTINGS = '설정';

function namesIn(dir, keep) {
  try {
    const root = fs.realpathSync(dir);
    return fs.readdirSync(dir).filter((n) => {
      if (n.startsWith('.')) return false;
      try { return path.dirname(fs.realpathSync(path.join(dir, n))) === root && keep(n); } catch { return false; }
    }).sort();
  } catch { return []; }
}

function defs() {
  const list = [
    { id: 'rules', group: '공통 규칙', title: 'RULES.md', file: path.join(WD, 'RULES.md'), note: 'Claude · GPT 공통 작업 규칙' },
    { id: 'rules-commit', group: '공통 규칙', title: 'RULES-COMMIT.md', file: path.join(WD, 'RULES-COMMIT.md'), note: '커밋 · PR (커밋 · PR 직전에 읽는다)' },
    { id: 'rules-delegate', group: '공통 규칙', title: 'RULES-DELEGATE.md', file: path.join(WD, 'RULES-DELEGATE.md'), note: '위임할 때 브리핑 (맡기기 직전에 읽는다)' },
    { id: 'claude-md', group: '공통 규칙', title: 'CLAUDE.md', file: path.join(CLAUDE, 'CLAUDE.md'), note: 'Claude 전역 지침 (RULES.md를 불러온다)' },
    { id: 'claude-delegate', group: '공통 규칙', title: 'CLAUDE-DELEGATE.md', file: path.join(CLAUDE, 'CLAUDE-DELEGATE.md'), note: 'Claude 모델 선택 (맡기기 직전에 읽는다)' },
    { id: 'claude-milestone', group: '공통 규칙', title: 'CLAUDE-MILESTONE.md', file: path.join(CLAUDE, 'CLAUDE-MILESTONE.md'), note: 'Claude 마일스톤 세션의 모델 (세션을 만들 때 읽는다)' },
    { id: 'claude-implement', group: '공통 규칙', title: 'CLAUDE-IMPLEMENT.md', file: path.join(CLAUDE, 'CLAUDE-IMPLEMENT.md'), note: 'Claude 구현 세션의 규칙 (Sonnet 세션이 처음 항목을 시작할 때 훅이 보여 준다)' },
    { id: 'codex-delegate', group: '공통 규칙', title: 'AGENTS-DELEGATE.md', file: path.join(CODEX, 'AGENTS-DELEGATE.md'), note: 'Codex 하위 에이전트 모델 선택 (맡기기 직전에 읽는다)' },
    { id: 'codex-milestone', group: '공통 규칙', title: 'AGENTS-MILESTONE.md', file: path.join(CODEX, 'AGENTS-MILESTONE.md'), note: 'Codex 마일스톤 배정 (배정하기 전에 읽는다)' },
    { id: 'format-roadmap', group: '형식', title: 'ROADMAP-FORMAT.md', file: path.join(WD, 'ROADMAP-FORMAT.md'), note: '로드맵 · 작업 카드' },
    { id: 'format-issues', group: '형식', title: 'ISSUES-FORMAT.md', file: path.join(WD, 'ISSUES-FORMAT.md'), note: '이슈' },
    { id: 'format-flows', group: '형식', title: 'FLOWS-FORMAT.md', file: path.join(WD, 'FLOWS-FORMAT.md'), note: '동작 흐름 문서' },
    { id: 'format-improvements', group: '형식', title: 'IMPROVEMENTS-FORMAT.md', file: path.join(WD, 'IMPROVEMENTS-FORMAT.md'), note: '개선 기록' },
    { id: 'format-interview', group: '형식', title: 'INTERVIEW-FORMAT.md', file: path.join(WD, 'INTERVIEW-FORMAT.md'), note: '예상 면접 질문' },
    {
      id: 'plugins', section: S_SESSION, group: '플러그인 · 스킬', title: '개요', kind: 'plugins', virtual: true, file: PLUGINS_MD,
      note: '모든 세션의 목록에 이름 · 설명이 들어가는 플러그인 · 스킬 · 명령과 그 크기. 메모는 ~/.work-dash/PLUGINS.md',
    },
    {
      id: 'plugins-projects', section: S_SESSION, group: '플러그인 · 스킬', title: '프로젝트별', kind: 'enabled', virtual: true, file: PLUGINS_MD,
      note: '프로젝트(저장소)마다 실제로 켜지는 플러그인 · 스킬 · 명령 · 에이전트 · MCP · 훅. 전역 설정에 저장소의 .claude 설정을 겹쳐서 본다',
    },
    ...AGENT_NAMES.map((n) => ({ id: `cmd-${n}`, section: S_SESSION, group: 'Claude 명령', title: `/${n}`, file: path.join(CLAUDE, 'commands', `${n}.md`) })),
    ...namesIn(USER_SKILLS, (n) => fs.existsSync(path.join(USER_SKILLS, n, 'SKILL.md')))
      .map((n) => ({ id: `uskill-${n}`, section: S_SESSION, group: 'Claude 스킬', title: n, file: path.join(USER_SKILLS, n, 'SKILL.md') })),
    ...AGENT_NAMES.map((n) => ({ id: `skill-${n}`, section: S_SESSION, group: 'Codex 스킬', title: n, file: path.join(CODEX, 'skills', n, 'SKILL.md') })),
    { id: 'config', group: '설정', title: 'config.json', file: path.join(WD, 'config.json'), note: 'work-dash 기록 범위 · 표시 설정' },
    {
      id: 'claude-hooks', group: '설정', title: 'Claude 훅', file: path.join(CLAUDE, 'settings.json'), kind: 'json',
      note: 'settings.json 중 work-dash를 부르는 hooks만 (env 등 다른 설정은 표시하지 않음)', extract: workDashHooks,
    },
  ];
  const templates = namesIn(TEMPLATES, () => true).map((n) => ({ id: `tpl-${n}`, group: '템플릿', title: n, file: path.join(TEMPLATES, n) }));
  list.splice(list.findIndex((d) => d.id === 'plugins'), 0, ...templates);

  const agents = path.join(CODEX, 'AGENTS.md');
  const real = (p) => { try { return fs.realpathSync(p); } catch { return null; } };
  const agentsReal = real(agents);
  if (agentsReal && agentsReal === real(list[0].file)) list[0].aliases = [tilde(agents)];
  else if (agentsReal) list.splice(2, 0, { id: 'codex-agents', group: '공통 규칙', title: 'AGENTS.md', file: agents, note: 'Codex 전역 지침' });

  return list.map((d) => ({ kind: kindOf(d.file), section: d.group === '설정' ? S_SETTINGS : S_RULES, ...d }));
}

const redactCommand = (c) => c.replace(/\b([A-Za-z0-9_]*(?:TOKEN|SECRET|KEY|PASSWORD|PASSWD|AUTH)[A-Za-z0-9_]*)=("[^"]*"|'[^']*'|\S+)/gi, '$1=••••');

function workDashHooks(text) {
  const all = JSON.parse(text).hooks || {};
  const out = {};
  for (const [event, groups] of Object.entries(all)) {
    if (!Array.isArray(groups)) continue;
    const kept = groups
      .map((g) => ({
        ...(typeof g.matcher === 'string' ? { matcher: g.matcher } : {}),
        hooks: (g.hooks || [])
          .filter((h) => typeof h.command === 'string' && h.command.includes('.work-dash'))
          .map((h) => ({ type: h.type, command: redactCommand(h.command), ...(typeof h.timeout === 'number' ? { timeout: h.timeout } : {}) })),
      }))
      .filter((g) => g.hooks.length);
    if (kept.length) out[event] = kept;
  }
  return JSON.stringify({ hooks: out }, null, 2);
}

function stat(file) {
  try { const st = fs.statSync(file); return st.isFile() ? st : null; } catch { return null; }
}

const meta = (d, st) => ({
  id: d.id, section: d.section, group: d.group, title: d.title, kind: d.kind, note: d.note || '', aliases: d.aliases || [],
  path: tilde(d.file), exists: !!st, mtime: st?.mtimeMs || 0, size: st?.size || 0,
  ...(d.virtual ? { exists: true, mtime: pluginsMtime() } : {}),
});

export function getDocs() {
  return defs().map((d) => meta(d, stat(d.file)));
}

export function getDoc(id) {
  const d = defs().find((x) => x.id === id);
  if (!d) return null;
  const st = stat(d.file);
  if (d.kind === 'enabled') return { ...meta(d, st), path: '~/.claude · <저장소>/.claude', content: '', truncated: false, enabled: getEnabledOverview() };
  if (d.virtual) return { ...meta(d, st), content: '', truncated: false, plugins: getPluginsOverview() };
  if (!st) return { ...meta(d, st), content: '', truncated: false };
  let content;
  let truncated = false;
  try {
    const buf = fs.readFileSync(d.file);
    truncated = buf.length > MAX_BYTES;
    content = buf.subarray(0, MAX_BYTES).toString('utf8');
    const filtered = d.extract || d.kind === 'json';
    if (filtered && truncated) return { ...meta(d, st), content: '', truncated, error: '파일이 너무 커서(1MB 초과) 표시하지 않습니다' };
    if (d.extract) content = d.extract(content);
    else if (d.kind === 'json') content = JSON.stringify(redact(JSON.parse(content)), null, 2);
  } catch (e) {
    const filtered = d.extract || d.kind === 'json';
    return { ...meta(d, st), content: filtered ? '' : content ?? '', truncated, error: filtered ? 'JSON 해석 실패 — 비밀 값이 있을 수 있어 원문을 표시하지 않습니다' : `읽기 실패: ${e.message}` };
  }
  return { ...meta(d, st), content, truncated };
}

export function watchDocs(onChange) {
  const pending = new Set();
  let timer = null;
  const push = (id) => {
    pending.add(id);
    if (!timer) timer = setTimeout(() => { timer = null; const ids = [...pending]; pending.clear(); onChange(ids.map((file) => ({ kind: 'docs', file }))); }, 150);
  };
  const byFile = new Map(defs().filter((d) => d.group !== '템플릿' && !d.id.startsWith('uskill-')).map((d) => [d.file, d.id]));
  const isTemp = (n) => !n || n.endsWith('.tmp') || n.endsWith('.lock') || path.basename(n).startsWith('.');

  const watchers = new Set();
  const retries = new Set();
  let closed = false;
  const watch = (dir, opts, handler) => {
    const retry = (why) => {
      if (closed) return;
      console.warn(`[docs] ${tilde(dir)} 감시 실패: ${why} — ${RETRY_MS / 1000}초 뒤 다시 시도`);
      const t = setTimeout(() => { retries.delete(t); watch(dir, opts, handler); }, RETRY_MS);
      retries.add(t);
    };
    let w;
    try { w = fs.watch(dir, opts, handler); } catch (e) { return retry(e.message); }
    watchers.add(w);
    w.on('error', (e) => { w.close(); watchers.delete(w); retry(e.message); });
  };

  const pluginFiles = new Set([INSTALLED, path.join(CLAUDE, 'settings.json'), PLUGINS_MD]);
  const commandsDir = path.join(CLAUDE, 'commands');
  for (const dir of [WD, CLAUDE, commandsDir, CODEX, path.dirname(INSTALLED)]) {
    watch(dir, {}, (_ev, name) => {
      if (isTemp(name)) return;
      const file = path.join(dir, name);
      const id = byFile.get(file);
      if (id) push(id);
      if (pluginFiles.has(file) || dir === commandsDir) { push('plugins'); push('plugins-projects'); }
    });
  }
  watch(USER_SKILLS, { recursive: true }, (_ev, name) => {
    if (isTemp(name)) return;
    push(`uskill-${name.split(path.sep)[0]}`);
    push('plugins');
    push('plugins-projects');
  });
  watch(path.join(CODEX, 'skills'), { recursive: true }, (_ev, name) => {
    if (isTemp(name)) return;
    const id = byFile.get(path.join(CODEX, 'skills', name));
    if (id) push(id);
  });
  watch(TEMPLATES, {}, (_ev, name) => { if (!isTemp(name)) push(`tpl-${name}`); });

  return () => { closed = true; clearTimeout(timer); for (const t of retries) clearTimeout(t); for (const w of watchers) w.close(); };
}
