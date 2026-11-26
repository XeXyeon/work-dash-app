// 로드맵 항목 하나의 작업 내역: 그 항목이 시작~완료된 시간 범위의 대화 기록에서
// 사용자 요청, 에이전트 답변, 바꾼 파일, 서브에이전트를 모은다. (로컬 기록만 읽으므로 토큰을 쓰지 않는다)
// 시작 시각 기록이 없으면 항목 ID가 언급된 대화만 모은다.
const fs = require('fs');
const { execFileSync } = require('child_process');
const { foldersOf } = require('./projects');
const { findFolder } = require('./scope');
const os = require('os');
const path = require('path');

const HOME = os.homedir();
const CLAUDE = path.join(HOME, '.claude', 'projects');
const CODEX = path.join(HOME, '.codex', 'sessions');
const MARGIN = 2 * 60e3;   // 시작 직전의 요청도 잡도록 앞쪽에 2분 여유

const ls = (d, opts) => { try { return fs.readdirSync(d, opts); } catch { return []; } };
const enc = (p) => p.replace(/[^a-zA-Z0-9]/g, '-');

// 이 프로젝트의 Claude 세션 기록 파일 (worktree 포함, 서브에이전트 내부 기록 제외)
function claudeFiles(project) {
  const keys = foldersOf(project).map((f) => '-' + enc(f));
  const out = [];
  for (const d of ls(CLAUDE)) {
    if (!keys.some((key) => d.endsWith(key) || d.includes(key + '--claude-worktrees'))) continue;
    for (const f of ls(path.join(CLAUDE, d))) if (f.endsWith('.jsonl')) out.push(path.join(CLAUDE, d, f));
  }
  return out;
}

// 이 프로젝트에서 연 Codex 세션 기록 파일
const codexCwd = new Map();   // 파일 → cwd (첫 줄만 읽어 캐시)
function codexFiles(project) {
  const folders = foldersOf(project);
  const out = [];
  for (const y of ls(CODEX)) for (const m of ls(path.join(CODEX, y))) for (const d of ls(path.join(CODEX, y, m))) {
    for (const f of ls(path.join(CODEX, y, m, d))) {
      if (!f.endsWith('.jsonl')) continue;
      const p = path.join(CODEX, y, m, d, f);
      if (!codexCwd.has(p)) {
        let cwd = '';
        try {
          const fd = fs.openSync(p, 'r'); const b = Buffer.alloc(8192); const n = fs.readSync(fd, b, 0, 8192, 0); fs.closeSync(fd);
          cwd = JSON.parse(b.toString('utf8', 0, n).split('\n')[0]).payload?.cwd || '';
        } catch {}
        codexCwd.set(p, cwd);
      }
      if (folders.includes(path.basename(codexCwd.get(p) || ''))) out.push(p);
    }
  }
  return out;
}

const clean = (t) => String(t || '').replace(/\s+\n/g, '\n').trim();
const isNoise = (t) => !t || t.startsWith('<') || t.startsWith('[Request interrupted');

// 기록 한 파일 → 시간순 이벤트 { t, kind: 'ask'|'answer'|'file'|'agent', text, source }
function claudeEvents(file) {
  const ev = [];
  let text; try { text = fs.readFileSync(file, 'utf8'); } catch { return ev; }
  const sub = file.includes(`${path.sep}subagents${path.sep}`);   // 서브에이전트 기록: 바꾼 파일과 언급 여부만 쓴다
  for (const l of text.split('\n')) {
    if (!l.startsWith('{"') || l.length < 20) continue;
    let j; try { j = JSON.parse(l); } catch { continue; }
    if (j.isMeta || (j.isSidechain && !sub)) continue;
    const t = Date.parse(j.timestamp); if (!t) continue;
    const c = j.message?.content;
    if (j.type === 'user') {
      const s = typeof c === 'string' ? c : Array.isArray(c) ? c.filter((x) => x.type === 'text').map((x) => x.text).join('\n') : '';
      if (!isNoise(clean(s))) ev.push({ t, kind: 'ask', text: clean(s), source: 'claude' });
    } else if (j.type === 'assistant' && Array.isArray(c)) {
      for (const x of c) {
        if (x.type === 'text' && clean(x.text)) ev.push({ t, kind: 'answer', text: clean(x.text), source: 'claude' });
        else if (x.type === 'tool_use') {
          const i = x.input || {};
          if (/^(Edit|Write|MultiEdit|NotebookEdit)$/.test(x.name) && i.file_path) ev.push({ t, kind: 'file', text: i.file_path, source: 'claude' });
          else if (x.name === 'Agent' || x.name === 'Task') ev.push({ t, kind: 'agent', text: `${i.description || '(subagent)'} · ${i.subagent_type || 'general-purpose'}`, source: 'claude' });
          else ev.push({ t, kind: 'tool', text: `${x.name} ${JSON.stringify(i).slice(0, 300)}`, source: 'claude' });
        }
      }
    }
  }
  return sub ? ev.filter((e) => e.kind === 'file' || e.kind === 'ask' ? true : e.kind === 'tool').map((e) => (e.kind === 'ask' ? { ...e, kind: 'subask' } : e)) : ev;
}

// 메인 세션 기록 → 그 세션의 서브에이전트 기록들
const subagentFiles = (main) => ls(path.join(main.replace(/\.jsonl$/, ''), 'subagents')).filter((f) => f.endsWith('.jsonl'))
  .map((f) => path.join(main.replace(/\.jsonl$/, ''), 'subagents', f));

function codexEvents(file) {
  const ev = [];
  let text; try { text = fs.readFileSync(file, 'utf8'); } catch { return ev; }
  for (const l of text.split('\n')) {
    if (!l.includes('item_completed')) continue;
    let j; try { j = JSON.parse(l); } catch { continue; }
    const t = Date.parse(j.timestamp); const it = j.payload?.item || {};
    const txt = (arr) => clean((arr || []).map((x) => x.text || '').join('\n'));
    if (it.type === 'UserMessage' && !isNoise(txt(it.content))) ev.push({ t, kind: 'ask', text: txt(it.content), source: 'gpt' });
    else if (it.type === 'AgentMessage' && txt(it.content)) ev.push({ t, kind: 'answer', text: txt(it.content), source: 'gpt' });
    else if (it.type === 'FileChange') for (const f of Object.keys(it.changes || {})) ev.push({ t, kind: 'file', text: f, source: 'gpt' });
    else if (it.type === 'CommandExecution') ev.push({ t, kind: 'tool', text: [].concat(it.command).join(' ').slice(0, 300), source: 'gpt' });
  }
  return ev;
}

// 파일별 이벤트 캐시 (파일이 바뀌었을 때만 다시 읽는다)
const cache = new Map();
function eventsOf(file, reader) {
  let m; try { m = fs.statSync(file).mtimeMs; } catch { return []; }
  const c = cache.get(file);
  if (c && c.m === m) return c.ev;
  const ev = reader(file);
  cache.set(file, { m, ev });
  return ev;
}

// 프로젝트 git 커밋: 시간 범위 안의 커밋, 또는 메시지에 ID가 들어간 커밋 (도구와 상관없이 실제로 바뀐 파일을 알 수 있다)
// 묶인 폴더가 여럿이면 git 저장소 폴더도 여럿이다 (폴더마다 하나씩)
function projectDirs(project) {
  const out = [];
  for (const name of foldersOf(project)) {
    const d = findFolder(name, { git: true });
    if (d) out.push(d);
  }
  return out;
}
// 폴더마다 조회한 커밋을 시간순(최신 먼저)으로 합친다. 파일 경로는 저장소 기준이라 폴더끼리 같은 경로가 섞일 수 있다.
function commits(project, q) {
  const dirs = projectDirs(project);
  if (dirs.length === 1) return commitsIn(dirs[0], q);
  return dirs.flatMap((d) => commitsIn(d, q)).sort((a, b) => b.t - a.t);
}
function commitsIn(dir, { from, to, id }) {
  // 병합 커밋과 팀원 커밋은 빼고, 이 저장소에 설정된 내 계정(user.email)의 커밋만 본다
  let me = '';
  try { me = execFileSync('git', ['-C', dir, 'config', 'user.email'], { encoding: 'utf8', timeout: 2000 }).trim(); } catch {}
  const args = ['-C', dir, 'log', '--all', '--no-merges', '--numstat', '--format=%x00%ct%x09%s'];
  if (me) args.push(`--author=${me}`);
  if (from) args.push(`--since=@${Math.floor(from / 1000)}`, `--until=@${Math.ceil(to / 1000)}`);
  else if (id) args.push('-i', `--grep=\\b${id}\\b`, '-E');
  else return [];
  let out = '';
  try { out = execFileSync('git', args, { encoding: 'utf8', maxBuffer: 20e6, timeout: 5000 }); } catch { return []; }
  // --numstat: "추가<TAB>삭제<TAB>경로" (바이너리는 "-")
  return out.split('\0').filter((x) => x.trim()).map((chunk) => {
    const [head, ...rows] = chunk.trim().split('\n');
    const [t, ...subj] = head.split('\t');
    const stats = rows.filter(Boolean).map((r) => {
      const [a, d, ...p] = r.split('\t');
      return { path: p.join('\t'), add: Number(a) || 0, del: Number(d) || 0 };
    });
    return { t: Number(t) * 1000, subject: subj.join('\t'), files: stats.map((x) => x.path), stats };
  });
}

// item: roadmap.js가 만든 항목 (id, title, state, startedAt, doneAt, owner)
function itemDetail(project, item) {
  const id = item.id;
  const mentions = (e) => id && e.text.toUpperCase().includes(id);
  const files = [...claudeFiles(project).map((f) => [f, claudeEvents]), ...codexFiles(project).map((f) => [f, codexEvents])];

  let mode, from, to;
  if (item.startedAt) {
    mode = 'window';
    from = item.startedAt - MARGIN;
    to = item.state === 'done' && item.doneAt > item.startedAt ? item.doneAt + 60e3 : Date.now();
  } else {
    mode = 'mention';
  }

  const picked = [];
  const subFiles = (e) => e.kind === 'file';
  for (const [f, reader] of files) {
    const all = eventsOf(f, reader);
    const subs = reader === claudeEvents ? subagentFiles(f).map((sf) => eventsOf(sf, claudeEvents)) : [];
    if (mode === 'window') {
      const inWin = all.filter((e) => e.t >= from && e.t <= to);
      // 같은 시간에 같은 프로젝트에서 다른 일을 한 세션은 빼고, 이 항목 ID가 언급된 세션만 쓴다
      if (inWin.length && (!id || inWin.some(mentions))) {
        picked.push(...inWin);
        for (const se of subs) picked.push(...se.filter((e) => subFiles(e) && e.t >= from && e.t <= to));
      }
    } else if (id) {
      picked.push(...all.filter(mentions));
      // ID가 언급된 서브에이전트가 바꾼 파일
      for (const se of subs) if (se.some(mentions)) picked.push(...se.filter(subFiles));
    }
  }
  picked.sort((a, b) => a.t - b.t);

  const uniq = (arr) => [...new Set(arr)];
  const cm = commits(project, mode === 'window' ? { from, to } : { id });
  const dirs = projectDirs(project);
  return {
    mode, from, to,
    asks: picked.filter((e) => e.kind === 'ask'),
    answers: picked.filter((e) => e.kind === 'answer'),
    commits: cm,
    // 바뀐 파일별 추가/삭제 줄 수 (커밋 기준. 커밋에 없는 파일은 대화 기록에서만 알 수 있어 줄 수가 없다)
    stats: (() => {
      const m = new Map();
      for (const c of cm) for (const f of c.stats) {
        const x = m.get(f.path) || { add: 0, del: 0 };
        x.add += f.add; x.del += f.del; m.set(f.path, x);
      }
      return m;
    })(),
    files: uniq([
      ...cm.flatMap((c) => c.files),
      ...picked.filter((e) => e.kind === 'file').map((e) => (() => { const dir = dirs.find((d) => e.text.startsWith(d + '/')); return dir ? e.text.slice(dir.length + 1) : e.text; })()),
    ]),
    agents: uniq(picked.filter((e) => e.kind === 'agent').map((e) => e.text)),
  };
}

module.exports = { itemDetail };
