// 플러그인 · 스킬 개요 (WEB-42): 모든 세션의 목록에 이름 · 설명이 들어가는 것을 한곳에 모은다. 읽기 전용.
// - 설치 기록: ~/.claude/plugins/installed_plugins.json (installPath 아래 skills/*/SKILL.md)
// - 켜짐 여부: ~/.claude/settings.json의 enabledPlugins만 꺼낸다(다른 설정은 서버 밖으로 내보내지 않는다)
// - 직접 둔 것: ~/.claude/skills/*/SKILL.md, ~/.claude/commands/*.md
// - 메모: ~/.work-dash/PLUGINS.md (## 묶음, ### 항목, `- 키: 값` 줄). 켜짐 여부는 여기 적지 않는다.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { WD } from './workdash.js';

const HOME = os.homedir();
const CLAUDE = path.join(HOME, '.claude');
export const INSTALLED = path.join(CLAUDE, 'plugins', 'installed_plugins.json');
export const SETTINGS = path.join(CLAUDE, 'settings.json');
export const USER_SKILLS = path.join(CLAUDE, 'skills');
export const USER_COMMANDS = path.join(CLAUDE, 'commands');
export const PLUGINS_MD = path.join(WD, 'PLUGINS.md');
const MAX_BYTES = 256 * 1024;

export const tilde = (p) => (p === HOME || p.startsWith(HOME + path.sep) ? '~' + p.slice(HOME.length) : p);
export const readText = (file) => {
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || st.size > MAX_BYTES) return null;
    return fs.readFileSync(file, 'utf8');
  } catch { return null; }
};
const mtimeOf = (file) => { try { return fs.statSync(file).mtimeMs; } catch { return 0; } };
export const listDir = (dir) => { try { return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => !e.name.startsWith('.')); } catch { return []; } };

// --- 앞머리(frontmatter): 이름 · 설명에 필요한 만큼만 읽는다 ---
// key: 값 / "따옴표" / '따옴표' / 블록(| >) / 들여쓴 이어지는 줄을 다룬다.
export function parseFrontmatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return { meta: {}, body: text };
  const meta = {};
  const lines = m[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const kv = lines[i].match(/^([\w.-]+):\s*(.*)$/);
    if (!kv) continue;
    let value = kv[2].trim();
    // 이어지는 들여쓴 줄
    const cont = [];
    while (i + 1 < lines.length && (/^\s+\S/.test(lines[i + 1]) || (lines[i + 1].trim() === '' && /^\s+\S/.test(lines[i + 2] ?? '')))) cont.push(lines[++i].trim());
    if (/^[|>][+-]?$/.test(value)) value = cont.join(value.startsWith('|') ? '\n' : ' ').trim();
    else {
      if (cont.length) value = [value, ...cont].join(' ');
      if (/^".*"$/s.test(value)) { try { value = JSON.parse(value); } catch { value = value.slice(1, -1); } }
      else if (/^'.*'$/s.test(value)) value = value.slice(1, -1).replace(/''/g, "'");
    }
    meta[kv[1]] = value;
  }
  return { meta, body: text.slice(m[0].length) };
}

const truthy = (v) => v === true || v === 'true';

// SKILL.md 하나 → { name, description, chars, listed }
function readSkill(file, fallbackName) {
  const text = readText(file);
  if (text == null) return null;
  const { meta } = parseFrontmatter(text);
  const description = typeof meta.description === 'string' ? meta.description : '';
  // disable-model-invocation: true인 스킬은 모델용 목록에 들어가지 않는다
  const listed = !truthy(meta['disable-model-invocation']);
  return { name: meta.name || fallbackName, description, chars: description.length, listed };
}

export function skillsIn(dir) {
  return listDir(dir)
    .filter((e) => e.isDirectory() || e.isSymbolicLink())
    .map((e) => readSkill(path.join(dir, e.name, 'SKILL.md'), e.name))
    .filter(Boolean)
    .sort((a, b) => a.name.localeCompare(b.name));
}

// 슬래시 명령 하나 → 설명이 없으면 본문 첫 줄이 쓰인다
function readCommand(file, name) {
  const text = readText(file);
  if (text == null) return null;
  const { meta, body } = parseFrontmatter(text);
  let description = typeof meta.description === 'string' ? meta.description : '';
  if (!description) description = body.split(/\r?\n/).map((l) => l.trim()).find(Boolean) || '';
  const listed = !truthy(meta['disable-model-invocation']);
  return { name: `/${name}`, description, chars: description.length, listed };
}

export function commandsIn(dir) {
  return listDir(dir)
    .filter((e) => (e.isFile() || e.isSymbolicLink()) && e.name.endsWith('.md'))
    .map((e) => readCommand(path.join(dir, e.name), e.name.slice(0, -3)))
    .filter(Boolean)
    .sort((a, b) => a.name.localeCompare(b.name));
}

// --- PLUGINS.md ---
// → { intro, sections: [{ title, intro, items: [{ name, fields: [[키, 값]], extra }] }] }
export function parsePluginsMd(text) {
  const out = { intro: '', sections: [] };
  let section = null;
  let item = null;
  const intro = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, '');
    if (/^# /.test(line)) continue;
    let m;
    if ((m = line.match(/^## (.+)$/))) {
      section = { title: m[1].trim(), intro: '', items: [] };
      out.sections.push(section);
      item = null;
      continue;
    }
    if (section && (m = line.match(/^### (.+)$/))) {
      item = { name: m[1].trim(), fields: [], extra: '' };
      section.items.push(item);
      continue;
    }
    if (item) {
      const kv = line.match(/^- ([^:`]{1,30}):\s*(.*)$/);
      if (kv) item.fields.push([kv[1].trim(), kv[2]]);
      else if (/^\s+\S/.test(line) && item.fields.length) item.fields[item.fields.length - 1][1] += ' ' + line.trim();
      else if (line.trim()) item.extra += (item.extra ? '\n' : '') + line;
      continue;
    }
    if (section) section.intro += (section.intro ? '\n' : '') + line;
    else intro.push(line);
  }
  out.intro = intro.join('\n').trim();
  for (const s of out.sections) s.intro = s.intro.trim();
  return out;
}

const sum = (skills) => skills.filter((s) => s.listed).reduce((n, s) => n + s.chars, 0);

// GET /api/docs/plugins 의 plugins 필드
export function getPluginsOverview() {
  const errors = [];
  let installed = {};
  const installedText = readText(INSTALLED);
  if (installedText != null) {
    try { installed = JSON.parse(installedText).plugins || {}; } catch (e) { errors.push(`installed_plugins.json 해석 실패: ${e.message}`); }
  }
  let enabled = {};
  const settingsText = readText(SETTINGS);
  if (settingsText != null) {
    try {
      const v = JSON.parse(settingsText).enabledPlugins;
      if (v && typeof v === 'object') enabled = Object.fromEntries(Object.entries(v).filter(([, x]) => typeof x === 'boolean'));
    } catch (e) { errors.push(`settings.json 해석 실패: ${e.message}`); }
  }

  const plugins = Object.entries(installed).map(([key, records]) => {
    const rec = (Array.isArray(records) ? records : [])[0] || {};
    const at = key.lastIndexOf('@');
    const name = at > 0 ? key.slice(0, at) : key;
    const marketplace = at > 0 ? key.slice(at + 1) : '';
    const skills = rec.installPath ? skillsIn(path.join(rec.installPath, 'skills')) : [];
    const status = key in enabled ? (enabled[key] ? 'on' : 'off') : 'unset';
    return {
      key, name, marketplace, version: rec.version || '', scope: rec.scope || '',
      installPath: rec.installPath ? tilde(rec.installPath) : '', updatedAt: rec.lastUpdated || rec.installedAt || '',
      status, skills, chars: sum(skills), listedCount: skills.filter((s) => s.listed).length,
    };
  }).sort((a, b) => a.name.localeCompare(b.name));

  const userSkills = skillsIn(USER_SKILLS);
  const commands = commandsIn(USER_COMMANDS);

  let notes = { intro: '', sections: [] };
  const mdText = readText(PLUGINS_MD);
  if (mdText != null) notes = parsePluginsMd(mdText);

  // 합계: 켜진 플러그인 + 직접 둔 스킬 · 명령 / 설치된 전체
  const local = [...userSkills, ...commands];
  const total = (list) => ({
    count: list.reduce((n, s) => n + (s.listed ? 1 : 0), 0),
    chars: sum(list),
  });
  const onSkills = plugins.filter((p) => p.status !== 'off').flatMap((p) => p.skills);
  const allSkills = plugins.flatMap((p) => p.skills);

  return {
    sources: [INSTALLED, SETTINGS, USER_SKILLS, USER_COMMANDS, PLUGINS_MD].map((f) => ({ path: tilde(f), exists: fs.existsSync(f) })),
    plugins,
    userSkills,
    commands,
    notes,
    notesExists: mdText != null,
    totals: { enabled: total([...onSkills, ...local]), all: total([...allSkills, ...local]) },
    errors,
  };
}

// 개요가 기대는 파일 중 가장 최근 수정 시각
export const pluginsMtime = () => Math.max(0, ...[INSTALLED, SETTINGS, PLUGINS_MD].map(mtimeOf));
