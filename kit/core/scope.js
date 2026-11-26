const fs = require('fs');
const os = require('os');
const path = require('path');
const { WD } = require('./paths');
const { projectOfFolder } = require('./projects');

const CONFIG = path.join(WD, 'config.json');
let rules = null;
let loadedAt = -1;

function load() {
  let st;
  try { st = fs.statSync(CONFIG); } catch { rules = null; loadedAt = -1; return; }
  if (st.mtimeMs === loadedAt) return;
  try {
    const cfg = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
    rules = (cfg.include || []).map((p) => {
      const children = p.endsWith('/*');
      const base = path.resolve(p.replace(/\/\*$/, '').replace(/^~(?=\/|$)/, os.homedir()));
      return { base, children };
    });
    loadedAt = st.mtimeMs;
  } catch {}
}

function inScope(cwd) {
  load();
  if (!rules) return true;
  cwd = String(cwd || '').replace(/^file:\/\//, '');
  if (!cwd) return false;
  return rules.some(({ base, children }) => cwd.startsWith(base + '/') || (!children && cwd === base));
}

function projectName(cwd) {
  const p = String(cwd || '').replace(/^file:\/\//, '');
  const i = p.indexOf('/.claude/worktrees/');
  const folder = path.basename(i >= 0 ? p.slice(0, i) : p);
  return folder ? projectOfFolder(folder) : '(unknown)';
}

const FALLBACK = [];
function findFolder(name, { git = false } = {}) {
  load();
  if (!name || name !== path.basename(name)) return null;
  for (const { base, children } of rules || FALLBACK) {
    const d = children ? path.join(base, name) : (path.basename(base) === name ? base : null);
    if (!d) continue;
    try { if (fs.statSync(git ? path.join(d, '.git') : d) && fs.statSync(d).isDirectory()) return d; } catch {}
  }
  return null;
}

module.exports = { inScope, projectName, findFolder };
