// hook 이벤트 → 세션 상태 변환과 세션 파일 입출력 (push.js가 씀)
const fs = require('fs');
const path = require('path');
const { WD } = require('./paths');
const { inScope, projectName } = require('./scope');

const DIR = path.join(WD, 'data', 'sessions');
const KEEP_DAYS = 7;

const safeId = (id) => String(id || 'unknown').replace(/[^\w.-]/g, '_');
const fileOf = (id) => path.join(DIR, `${safeId(id)}.json`);
const norm = (st) => (st === 'completed' || st === 'in_progress' ? st : 'pending');

function newSession(ev) {
  return {
    id: ev.session_id || 'unknown', cwd: ev.cwd || '', project: projectName(ev.cwd),
    title: '', lastPrompt: '', status: 'idle',
    startedAt: Date.now(), updatedAt: Date.now(), tasks: [], agents: [],
  };
}

// 데스크톱 앱 Code 탭의 작업 목록(update_plan) 델타 적용
function applyPlan(s, input) {
  if (Array.isArray(input.items)) {
    s.tasks = input.items.map((it, i) => ({ id: String(i + 1), content: it.content, status: norm(it.status) }));
    return;
  }
  const t = s.tasks;
  if (input.advance) {
    const cur = t.findIndex((x) => x.status === 'in_progress');
    if (cur >= 0) t[cur].status = 'completed';
    const next = t.findIndex((x, i) => i > cur && x.status === 'pending');
    if (next >= 0) t[next].status = 'in_progress';
  }
  for (const n of input.done || []) if (t[n - 1]) t[n - 1].status = 'completed';
  if (input.start && t[input.start - 1]) {
    t.forEach((x) => { if (x.status === 'in_progress') x.status = 'pending'; });
    t[input.start - 1].status = 'in_progress';
  }
}

// 메인 에이전트 활동 피드에 남길 도구 → 한 줄 요약. 작업 목록·서브에이전트 도구는 따로 표시하므로 제외
const QUIET = /^(Agent|Task|TodoWrite|TaskCreate|TaskUpdate|TaskList|TaskGet|ToolSearch)$|update_plan$|wrap_up$/;
function describe(name, input) {
  const base = (p) => path.basename(String(p || ''));
  const first = (t) => String(t || '').split('\n')[0];
  switch (name) {
    case 'Read': return ['읽기', base(input.file_path)];
    case 'Edit': case 'MultiEdit': return ['수정', base(input.file_path)];
    case 'Write': return ['작성', base(input.file_path)];
    case 'NotebookEdit': return ['수정', base(input.notebook_path)];
    case 'Bash': return ['실행', first(input.command)];
    case 'Grep': return ['검색', input.pattern];
    case 'Glob': return ['찾기', input.pattern];
    case 'WebFetch': return ['웹', input.url];
    case 'WebSearch': return ['웹검색', input.query];
    case 'Skill': return ['스킬', input.skill];
  }
  const m = name.match(/^mcp__(.+?)__(.+)$/);
  return m ? ['MCP', m[2]] : [name, ''];
}

function recordActivity(s, ev) {
  const name = ev.tool_name || '';
  if (QUIET.test(name)) return;
  const [verb, detail] = describe(name, ev.tool_input || {});
  // 서브에이전트 내부 도구 호출이면 표시해 둔다 (지원하는 버전에서만 agent 정보가 온다)
  const who = ev.agent_type || (ev.agent_id ? 'subagent' : '');
  s.activity = [...(s.activity || []), { verb, detail: String(detail || '').slice(0, 200), who, at: Date.now() }].slice(-6);
  // 하위 에이전트의 마지막 활동을 그 에이전트 기록에 남긴다 (세션 알림 카드를 펼쳐 볼 때 쓴다)
  if (ev.agent_id) {
    const a = (s.agents || []).find((x) => x.agentId === ev.agent_id);
    if (a) { a.lastAt = Date.now(); a.lastActivity = `${verb}${detail ? ' ' + String(detail).slice(0, 120) : ''}`; }
  }
}

function handleTool(s, ev, phase) {
  const name = ev.tool_name || '';
  const input = ev.tool_input || {};
  const resp = ev.tool_response || {};

  // 서브에이전트
  if (name === 'Agent' || name === 'Task') {
    const key = ev.tool_use_id || `${input.description}-${s.agents.length}`;
    let a = s.agents.find((x) => x.id === key);
    if (!a) {
      a = { id: key, description: input.description || '(subagent)',
        type: input.subagent_type || 'general-purpose', status: 'running', startedAt: Date.now() };
      s.agents.push(a);
    }
    if (phase === 'post') {
      // 결과에 하위 에이전트 id가 있으면 남겨 두고(그 에이전트의 도구 사용과 잇는다),
      // 백그라운드로 띄운 경우("Async agent launched")는 아직 끝나지 않았으므로 done으로 바꾸지 않는다
      // 결과는 객체로 온다: { isAsync, status: 'async_launched', agentId, ... } (예전 버전은 글로 올 수 있어 둘 다 본다)
      const obj = resp && typeof resp === 'object' ? resp : {};
      const text = typeof resp === 'string' ? resp : '';
      const id = obj.agentId || (text.match(/agentId:\s*([A-Za-z0-9_-]+)/) || [])[1];
      if (id) a.agentId = String(id);
      if (obj.isAsync || obj.status === 'async_launched' || /Async agent launched/i.test(text)) a.status = 'background';
      else { a.status = 'done'; a.endedAt = Date.now(); }
    }
    s.agents = s.agents.slice(-30);
    return;
  }
  if (phase !== 'post') return;

  if (name === 'TodoWrite' && Array.isArray(input.todos)) {
    s.tasks = input.todos.map((t, i) => ({ id: String(i + 1), content: t.content, status: norm(t.status) }));
  } else if (name === 'TaskCreate') {
    const id = String(resp?.task?.id ?? resp?.id ?? s.tasks.length + 1);
    if (!s.tasks.some((t) => t.id === id)) s.tasks.push({ id, content: input.subject || input.description || '(task)', status: 'pending' });
  } else if (name === 'TaskUpdate') {
    const id = String(input.taskId ?? input.id);
    const t = s.tasks.find((x) => x.id === id);
    if (t) {
      if (input.status === 'deleted') s.tasks = s.tasks.filter((x) => x !== t);
      else {
        if (input.status) t.status = norm(input.status);
        if (input.subject) t.content = input.subject;
      }
    }
  } else if (/update_plan$/.test(name)) {
    applyPlan(s, input);
  } else if (/wrap_up$/.test(name)) {
    s.tasks.forEach((t) => { if (t.status === 'in_progress') t.status = 'completed'; });
  }
}

const WAIT_TOOLS = { AskUserQuestion: '질문에 답변 대기', ExitPlanMode: '계획 승인 대기' };

function apply(s, ev) {
  if (ev.cwd && !s.cwd) { s.cwd = ev.cwd; s.project = projectName(ev.cwd); }
  if (ev.transcript_path) s.transcript = ev.transcript_path;
  s.updatedAt = Date.now();
  switch (ev.hook_event_name) {
    case 'SessionStart': if (s.status === 'ended') s.status = 'idle'; break;
    case 'UserPromptSubmit':
      delete s.waitReason;
      s.lastPrompt = String(ev.prompt || '')
        .replace(/<bash-input>([\s\S]*?)<\/bash-input>[\s\S]*/, '! $1')  // 입력창의 ! 명령
        .slice(0, 300);
      if (!s.title) s.title = s.lastPrompt.split('\n')[0].slice(0, 80);
      s.status = 'working';
      break;
    case 'PreToolUse': {
      // 하위 에이전트(agent_id 있음)의 도구 사용은 활동 기록만 남기고 메인 세션 상태는 그대로 둔다.
      // 메인이 응답을 끝낸 뒤에도 백그라운드 하위 에이전트가 돌면서 '작업 중'으로 되돌려 알림이 꼬이지 않게 한다
      if (ev.agent_id) { recordActivity(s, ev); handleTool(s, ev, 'pre'); break; }
      // 사용자 답을 기다리는 도구는 '입력 대기'로 표시한다
      const ask = WAIT_TOOLS[ev.tool_name];
      if (ask) { s.status = 'waiting'; s.waitReason = ask; } else { s.status = 'working'; delete s.waitReason; }
      recordActivity(s, ev); handleTool(s, ev, 'pre');
      break;
    }
    case 'PostToolUse':
      if (!ev.agent_id) { s.status = 'working'; delete s.waitReason; }
      handleTool(s, ev, 'post');
      break;
    case 'Notification': {
      // 권한 요청만 입력 대기로 본다 (응답을 마친 뒤 '다음 입력 기다림' 알림은 대기 상태가 아니다)
      const msg = String(ev.message || '');
      if (/permission/i.test(`${ev.notification_type || ''} ${msg}`)) {
        const tool = msg.replace(/^Claude needs your permission to use\s*/i, '').trim();
        s.status = 'waiting';
        s.waitReason = WAIT_TOOLS[tool] || `권한 요청: ${tool}`.slice(0, 120);   // 질문·계획 승인은 권한 요청이 아니라 답을 기다리는 것
      }
      break;
    }
    case 'Stop': s.status = 'idle'; delete s.waitReason; break;
    // 하위 에이전트가 끝남 (훅에 SubagentStop이 연결돼 있을 때만 온다). 메인 상태는 그대로 두고 그 에이전트만 완료로
    case 'SubagentStop': {
      const a = ev.agent_id && (s.agents || []).find((x) => x.agentId === ev.agent_id);
      if (a) { a.status = 'done'; a.endedAt = Date.now(); }
      break;
    }
    case 'SessionEnd': s.status = 'ended'; break;
  }
  return s;
}

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// 같은 세션에 hook이 동시에 들어와도 덮어쓰지 않도록 mkdir 잠금
function withLock(id, fn) {
  const lock = fileOf(id) + '.lock';
  for (let i = 0; i < 80; i++) {
    try { fs.mkdirSync(lock); break; } catch {
      try { if (Date.now() - fs.statSync(lock).mtimeMs > 2000) fs.rmdirSync(lock); } catch {}
      sleep(25);
    }
  }
  try { return fn(); } finally { try { fs.rmdirSync(lock); } catch {} }
}

function record(ev) {
  if (!inScope(ev.cwd)) return;   // 기록 범위 밖(config.json include)의 세션은 남기지 않는다
  fs.mkdirSync(DIR, { recursive: true });
  withLock(ev.session_id, () => {
    const file = fileOf(ev.session_id);
    let s;
    try { s = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { s = newSession(ev); }
    apply(s, ev);
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(s));
    fs.renameSync(tmp, file);
  });
}

function loadAll() {
  const out = [];
  const cutoff = Date.now() - KEEP_DAYS * 86400e3;
  let names = [];
  try { names = fs.readdirSync(DIR); } catch { return out; }
  for (const n of names) {
    if (!n.endsWith('.json')) continue;
    const file = path.join(DIR, n);
    try {
      const s = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (s.updatedAt < cutoff || !inScope(s.cwd)) { fs.unlinkSync(file); continue; }
      out.push(s);
    } catch {}
  }
  return out;
}

function remove(id) { try { fs.unlinkSync(fileOf(id)); } catch {} }

module.exports = { DIR, record, loadAll, remove, withLock };
