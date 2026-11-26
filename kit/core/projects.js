// 프로젝트 설정: config.json의 "projects" (WEB-28 정의서)
//
//   "projects": {
//     "ShopBack": { "name": "Shop", "folders": ["ShopFront"], "key": "SH" }
//   }
//
// - 키(프로젝트 이름)는 로드맵 · 이슈 · 흐름 파일 이름이자 작업 카드 폴더 이름이다. 바꾸지 않는다.
// - name: 대시보드에 보이는 이름 (없으면 프로젝트 이름)
// - folders: 이 프로젝트에 함께 묶는 작업 폴더 이름. 그 폴더에서 일해도 이 프로젝트의 로드맵을 쓴다
// - key: 다른 로드맵에서 이 프로젝트의 항목을 가리킬 때 쓰는 짧은 접두어. (after: BE:MAT-11)
const fs = require('fs');
const path = require('path');
const { WD } = require('./paths');

const CONFIG = path.join(WD, 'config.json');
let cache = {};
let loadedAt = -1;

function readProjects() {
  let st;
  try { st = fs.statSync(CONFIG); } catch { cache = {}; loadedAt = -1; return cache; }
  if (st.mtimeMs === loadedAt) return cache;
  try {
    const p = JSON.parse(fs.readFileSync(CONFIG, 'utf8')).projects;
    cache = isPlain(p) ? p : {};
  } catch {}   // 잘못된 JSON이면 직전 값을 유지
  loadedAt = st.mtimeMs;   // 실패해도 기록해 둔다: 파일이 다시 바뀔 때까지 매번 읽지 않게
  return cache;
}

const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
const isPlain = (o) => !!o && typeof o === 'object' && !Array.isArray(o);
// 프로젝트 이름이 __proto__ · constructor 같은 것이어도 물려받은 속성을 읽지 않게 자기 속성만 본다
const entryOf = (ps, id) => (Object.prototype.hasOwnProperty.call(ps, id) && isPlain(ps[id]) ? ps[id] : undefined);

// 작업 폴더 이름 → 프로젝트 이름. 묶인 폴더가 아니면 폴더 이름 그대로
function projectOfFolder(folder) {
  for (const [id, p] of Object.entries(readProjects())) {
    if (Array.isArray(p?.folders) && p.folders.includes(folder)) return id;
  }
  return folder;
}

// 프로젝트 이름 → 그 프로젝트에 속한 작업 폴더 이름 전부 (자기 이름 포함, 중복 없음)
function foldersOf(id) {
  const f = entryOf(readProjects(), id)?.folders;
  return [...new Set([id, ...(Array.isArray(f) ? f.filter((x) => typeof x === 'string' && x) : [])])];
}

// 대시보드에 보일 이름
function displayName(id) {
  const n = entryOf(readProjects(), id)?.name;
  return typeof n === 'string' && n.trim() ? n.trim() : id;
}

// 교차 참조 접두어 → 프로젝트 이름. key가 먼저, 없으면 프로젝트 이름 자체와 비교한다 (대소문자 무시).
// ids: 지금 있는 프로젝트 이름 목록 (설정에 없는 프로젝트도 이름으로 가리킬 수 있게)
function projectOfKey(key, ids = []) {
  const ps = readProjects();
  for (const [id, p] of Object.entries(ps)) if (p?.key && same(p.key, key)) return id;
  return ids.find((id) => same(id, key)) || Object.keys(ps).find((id) => same(id, key)) || null;
}

// 표시 이름을 저장한다. 빈 이름이거나 프로젝트 이름과 같으면 name을 지운다.
// config.json의 다른 키와 순서는 그대로 두고, 임시 파일에 쓴 뒤 바꿔치기한다.
function setDisplayName(id, name) {
  const next = String(name ?? '').trim();
  if (!id || typeof id !== 'string') throw new Error('프로젝트 이름이 없다');
  if (next.length > 60 || /[\r\n]/.test(next)) throw new Error('표시 이름은 한 줄, 60자 이하');
  if (['__proto__', 'constructor', 'prototype'].includes(id)) throw new Error('쓸 수 없는 프로젝트 이름');
  // 읽고 고쳐 쓰는 사이에 다른 프로세스가 끼어들지 않게 잠근다 (lib.js는 scope.js → 이 파일을 부르므로 여기서 늦게 불러온다)
  const { withLock } = require('./lib');
  return withLock('config', () => {
    let cfg = {};
    try { cfg = JSON.parse(fs.readFileSync(CONFIG, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw new Error('config.json을 읽을 수 없다: ' + e.message); }
    if (!isPlain(cfg)) throw new Error('config.json의 최상위가 객체가 아니다');
    const ps = isPlain(cfg.projects) ? cfg.projects : {};
    const entry = entryOf(ps, id) || {};
    if (next && next !== id) entry.name = next; else delete entry.name;
    if (Object.keys(entry).length) ps[id] = entry; else delete ps[id];
    if (Object.keys(ps).length) cfg.projects = ps; else delete cfg.projects;
    const tmp = `${CONFIG}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2) + '\n');
      fs.renameSync(tmp, CONFIG);
    } catch (e) {
      try { fs.unlinkSync(tmp); } catch {}
      throw e;
    }
    loadedAt = -1;
    return displayName(id);
  });
}

module.exports = { CONFIG, readProjects, projectOfFolder, foldersOf, displayName, projectOfKey, setDisplayName };
