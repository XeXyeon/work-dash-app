import fs from 'node:fs';
import path from 'node:path';
import { getProjects } from './workdash.js';
import { INSTALLED, SETTINGS, USER_SKILLS, USER_COMMANDS, skillsIn, commandsIn, listDir, tilde } from './plugins.js';
import { core, HOME } from './kit.js';

const { findFolder } = core('scope.js');
const CLAUDE_JSON = path.join(HOME, '.claude.json');
const USER_AGENTS = path.join(HOME, '.claude', 'agents');
const MAX_JSON = 8 * 1024 * 1024;

function readJson(file, errors) {
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || st.size > MAX_JSON) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    if (e.code !== 'ENOENT' && e.code !== 'ENOTDIR') errors?.push(`${tilde(file)} 해석 실패: ${e.message}`);
    return null;
  }
}

const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
const flags = (settings) => Object.fromEntries(Object.entries(obj(obj(settings).enabledPlugins)).filter(([, x]) => typeof x === 'boolean'));
const hooksOf = (settings, source) => Object.entries(obj(obj(settings).hooks)).map(([event, groups]) => ({
  event, source,
  count: (Array.isArray(groups) ? groups : []).reduce((n, g) => n + (Array.isArray(g?.hooks) ? g.hooks.length : 0), 0),
}));
const agentsIn = (dir) => listDir(dir)
  .filter((e) => (e.isFile() || e.isSymbolicLink()) && e.name.endsWith('.md'))
  .map((e) => e.name.slice(0, -3)).sort();
const tag = (list, source) => list.map((s) => ({ name: s.name, source, listed: s.listed, chars: s.chars }));
const sumChars = (list) => list.reduce((n, s) => n + (s.listed ? s.chars : 0), 0);

const findDir = (folder) => findFolder(folder);

function layer(g, dir, errors) {
  const cdir = dir ? path.join(dir, '.claude') : null;
  const proj = cdir ? readJson(path.join(cdir, 'settings.json'), errors) : null;
  const local = cdir ? readJson(path.join(cdir, 'settings.local.json'), errors) : null;
  const pf = flags(proj), lf = flags(local);

  const plugins = [];
  for (const key of new Set([...Object.keys(g.installed), ...Object.keys(g.flags), ...Object.keys(pf), ...Object.keys(lf)])) {
    const records = Array.isArray(g.installed[key]) ? g.installed[key] : [];
    const userScope = records.some((r) => r.scope === 'user');
    const source = key in lf ? 'local' : key in pf ? 'project' : key in g.flags ? 'global' : userScope ? 'global' : null;
    if (!source) continue;
    const on = key in lf ? lf[key] : key in pf ? pf[key] : key in g.flags ? g.flags[key] : true;
    const globalOn = key in g.flags ? g.flags[key] : userScope;
    const rec = records.find((r) => r.projectPath === dir) || records[0];
    const skills = on && rec?.installPath ? skillsIn(path.join(rec.installPath, 'skills')) : [];
    const at = key.lastIndexOf('@');
    plugins.push({
      key, name: at > 0 ? key.slice(0, at) : key, on, source, installed: records.length > 0,
      differs: source !== 'global' && on !== globalOn,
      skillCount: skills.filter((s) => s.listed).length, chars: sumChars(skills),
    });
  }
  plugins.sort((a, b) => Number(b.on) - Number(a.on) || a.name.localeCompare(b.name));

  const skills = [...tag(g.skills, 'global'), ...(cdir ? tag(skillsIn(path.join(cdir, 'skills')), 'project') : [])];
  const commands = [...tag(g.commands, 'global'), ...(cdir ? tag(commandsIn(path.join(cdir, 'commands')), 'project') : [])];
  const agents = [...g.agents.map((name) => ({ name, source: 'global' })), ...(cdir ? agentsIn(path.join(cdir, 'agents')).map((name) => ({ name, source: 'project' })) : [])];

  const entry = dir ? obj(obj(g.claudeJson.projects)[dir]) : {};
  const off = new Set([...(Array.isArray(entry.disabledMcpServers) ? entry.disabledMcpServers : []), ...(Array.isArray(entry.disabledMcpjsonServers) ? entry.disabledMcpjsonServers : [])]);
  const mcpNames = [
    ...g.mcp.map((name) => ({ name, source: 'global' })),
    ...(dir ? Object.keys(obj(obj(readJson(path.join(dir, '.mcp.json'), errors)).mcpServers)).map((name) => ({ name, source: 'project' })) : []),
    ...Object.keys(obj(entry.mcpServers)).map((name) => ({ name, source: 'local' })),
  ];
  const mcp = mcpNames.map((m) => ({ ...m, on: !off.has(m.name), differs: off.has(m.name) }));

  const hooks = [...g.hooks, ...hooksOf(proj, 'project'), ...hooksOf(local, 'local')];

  const onPlugins = plugins.filter((p) => p.on);
  const own = (list) => list.filter((x) => x.source !== 'global').length;
  return {
    plugins, skills, commands, agents, mcp, hooks,
    counts: {
      plugins: onPlugins.length,
      skills: skills.filter((s) => s.listed).length + onPlugins.reduce((n, p) => n + p.skillCount, 0),
      commands: commands.length, agents: agents.length, mcp: mcp.filter((m) => m.on).length, hooks: hooks.length,
    },
    own: { plugins: own(plugins), skills: own(skills), commands: own(commands), agents: own(agents), mcp: own(mcp), hooks: own(hooks) },
    differs: plugins.filter((p) => p.differs).length + mcp.filter((m) => m.differs).length,
    chars: sumChars(skills) + sumChars(commands) + onPlugins.reduce((n, p) => n + p.chars, 0),
  };
}

export function getEnabledOverview() {
  const errors = [];
  const settings = readJson(SETTINGS, errors);
  const claudeJson = obj(readJson(CLAUDE_JSON, errors));
  const g = {
    installed: obj(obj(readJson(INSTALLED, errors)).plugins),
    flags: flags(settings),
    skills: skillsIn(USER_SKILLS),
    commands: commandsIn(USER_COMMANDS),
    agents: agentsIn(USER_AGENTS),
    mcp: Object.keys(obj(claudeJson.mcpServers)),
    hooks: hooksOf(settings, 'global'),
    claudeJson,
  };
  const projects = getProjects().filter((p) => !p.archived).map((p) => ({
    project: p.project,
    displayName: p.displayName,
    repos: p.folders.map((folder) => {
      const dir = findDir(folder);
      return dir ? { repo: folder, dir: tilde(dir), found: true, ...layer(g, dir, errors) } : { repo: folder, dir: '', found: false };
    }),
  }));
  return { global: layer(g, null, errors), projects, errors };
}
