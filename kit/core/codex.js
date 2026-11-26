// Codex(GPT) 세션 로그(~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl)를 읽어 work-dash 세션 형식으로 바꾼다.
// Codex 설정은 건드리지 않고 로그만 읽는다. 로그 형식은 공식 문서가 없으므로
// 모르는 레코드가 보이면 warnings에 세어 두고 대시보드가 경고를 띄운다.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { WD } = require('./paths');
const { inScope, projectName } = require('./scope');

const ROOT = path.join(os.homedir(), '.codex', 'sessions');
const HIDDEN = path.join(WD, 'data', 'hidden-gpt.json');
const KEEP_DAYS = 7;
const STALE_MS = 15 * 60e3;   // 이만큼 기록이 없으면 '작업 중'을 '대기'로 본다 (앱이 꺼진 경우 등)
const KNOWN = new Set(['session_meta', 'turn_context', 'response_item', 'event_msg', 'token_usage_record', 'world_state', 'compacted']);

const cache = new Map();   // 파일 경로 → { offset, rest, s }

const base = (p) => path.basename(String(p || '').replace(/^file:\/\//, ''));
const decode = (t) => String(t || '')
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"');

function newState(file, mtime) {
  return {
    id: 'gpt-' + base(file).replace(/^rollout-|\.jsonl$/g, ''), source: 'gpt',
    cwd: '', project: '(unknown)', title: '', lastPrompt: '', status: 'idle',
    startedAt: mtime, updatedAt: 0, tasks: [], agents: [], activity: [],
    model: '', ctx: 0, ctxLimit: 0, hasItems: false, lines: 0, unknown: 0, sawMeta: false,
  };
}

function setCwd(s, cwd) {
  cwd = String(cwd || '').replace(/^file:\/\//, '');
  if (cwd && !s.cwd) { s.cwd = cwd; s.project = projectName(cwd); }
}
function setPrompt(s, text) {
  text = decode(text).trim();
  // <environment_context> 같은 시스템 주입 메시지와, 대화 앞에 자동으로 들어가는 AGENTS.md 지침은 요청으로 보지 않는다
  if (!text || text.startsWith('<') || /^# AGENTS\.md instructions/.test(text)) return;
  s.lastPrompt = text.slice(0, 300);
  if (!s.title) s.title = text.split('\n')[0].slice(0, 80);
}
function act(s, verb, detail, at) {
  s.activity.push({ verb, detail: String(detail || '').slice(0, 200), who: '', at });
  if (s.activity.length > 6) s.activity.shift();
}
const norm = (st) => (st === 'completed' || st === 'in_progress' ? st : 'pending');
function parseArgs(a) { try { return typeof a === 'string' ? JSON.parse(a) : a || {}; } catch { return {}; } }

function apply(s, j) {
  s.lines++;
  if (!KNOWN.has(j.type)) { s.unknown++; return; }
  const p = j.payload || {};
  const at = Date.parse(j.timestamp) || 0;
  if (at > s.updatedAt) s.updatedAt = at;

  if (j.type === 'session_meta') {
    s.sawMeta = true;
    setCwd(s, p.cwd);
    // 포크된 하위 에이전트 기록에는 부모의 session_meta가 뒤에 다시 들어 있어서, 첫 session_meta(자기 자신)만 쓴다
    if (p.id && !s.threadId) s.threadId = String(p.id);
    const spawn = p.source && p.source.subagent && p.source.subagent.thread_spawn;
    if (spawn && spawn.parent_thread_id && !s.parentThreadId && String(p.id || '') === s.threadId) {
      s.parentThreadId = String(spawn.parent_thread_id);
      s.agentName = String(p.agent_nickname || spawn.agent_nickname || spawn.agent_path || '').slice(0, 60);
      // 맡긴 일의 본문은 암호화되어 있어 읽을 수 없다 → 부모가 붙인 작업 이름(agent_path 끝, 예: be_local_dev_scout)을 쓴다
      s.agentTask = String(spawn.agent_path || p.agent_path || '').split('/').pop().slice(0, 80);
    }
    s.startedAt = Date.parse(p.timestamp) || s.startedAt;
  } else if (j.type === 'turn_context') {
    setCwd(s, p.cwd);
    if (p.model) s.model = p.model;
  } else if (j.type === 'event_msg') {
    switch (p.type) {
      case 'task_started': s.status = 'working'; if (p.model_context_window) s.ctxLimit = p.model_context_window; break;
      case 'task_complete': case 'turn_aborted': if (s.status !== 'waiting') s.status = 'idle'; break;
      case 'token_count':
        if (p.info) {
          s.ctx = p.info.last_token_usage?.input_tokens || s.ctx;
          s.ctxLimit = p.info.model_context_window || s.ctxLimit;
        }
        break;
      case 'thread_settings_applied':
        if (p.thread_settings?.model) s.model = p.thread_settings.model;
        setCwd(s, p.thread_settings?.cwd);
        break;
      case 'user_message': setPrompt(s, p.message); break;
      case 'item_completed': {
        s.hasItems = true;
        const it = p.item || {};
        if (it.type !== 'Reasoning' && it.type !== 'AgentMessage' && s.status === 'waiting') { s.status = 'working'; delete s.waitReason; }
        if (it.type === 'UserMessage') setPrompt(s, (it.content || []).map((c) => c.text || '').join(' '));
        else if (it.type === 'CommandExecution') {
          const cmd = Array.isArray(it.command) ? it.command[it.command.length - 1] : it.command;
          act(s, '실행', String(cmd || '').split('\n')[0], at);
        } else if (it.type === 'FileChange') for (const f of Object.keys(it.changes || {})) act(s, '수정', base(f), at);
        else if (it.type === 'McpToolCall') act(s, 'MCP', it.tool, at);
        else if (it.type === 'WebSearch' || it.type === 'Extension') act(s, '웹', it.query || it.kind, at);
        break;
      }
    }
  } else if (j.type === 'response_item') {
    if (p.type === 'function_call') {
      const args = parseArgs(p.arguments);
      if (/^request_user_input/.test(p.name)) { s.status = 'waiting'; s.waitReason = '질문에 답변 대기'; }
      else if (p.name === 'update_plan' && Array.isArray(args.plan)) {
        s.tasks = args.plan.map((x, i) => ({ id: String(i + 1), content: x.step, status: norm(x.status) }));
      } else if (p.name === 'exec_command' && !s.hasItems) {
        act(s, '실행', String(args.cmd || '').split('\n')[0], at);
      }
    } else if (p.type === 'custom_tool_call' && p.name === 'apply_patch' && !s.hasItems) {
      for (const m of String(p.input || '').matchAll(/^\*\*\* (?:Update|Add|Delete) File: (.+)$/gm)) act(s, '수정', base(m[1]), at);
    } else if (p.type === 'message' && p.role === 'user' && !s.hasItems) {
      setPrompt(s, (p.content || []).map((c) => c.text || '').join(' '));
    } else if (p.type === 'message' && p.role === 'assistant' && s.parentThreadId) {
      // 하위 에이전트의 마지막 답변 첫 줄 (세션 알림 카드를 펼쳐 볼 때 무엇을 했는지 보여 준다)
      const text = decode((p.content || []).map((c) => c.text || '').join(' ')).trim().split('\n')[0];
      if (text) s.lastReply = text.slice(0, 200);
    }
  }
}

// 로그는 세션이 시작된 날짜 폴더에 계속 이어 쓰이므로, 날짜 폴더가 아니라 파일 수정 시각으로 거른다
const ls = (d) => { try { return fs.readdirSync(d); } catch { return []; } };
function recentFiles() {
  const out = [];
  const cutoff = Date.now() - KEEP_DAYS * 86400e3;
  for (const y of ls(ROOT)) for (const m of ls(path.join(ROOT, y))) for (const d of ls(path.join(ROOT, y, m))) {
    const dir = path.join(ROOT, y, m, d);
    for (const n of ls(dir)) {
      if (!n.endsWith('.jsonl')) continue;
      const f = path.join(dir, n);
      try { const st = fs.statSync(f); if (st.mtimeMs >= cutoff) out.push([f, st]); } catch {}
    }
  }
  return out;
}

// 파일마다 마지막으로 읽은 위치를 기억해 두고, 새로 붙은 부분만 읽는다
function readNew(file, st) {
  let c = cache.get(file);
  if (!c || st.size < c.offset) { c = { offset: 0, rest: '', s: newState(file, st.mtimeMs) }; cache.set(file, c); }
  if (st.size === c.offset) return c.s;
  const fd = fs.openSync(file, 'r');
  try {
    const len = st.size - c.offset;
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, c.offset);
    c.offset = st.size;
    const text = c.rest + buf.toString('utf8');
    const lines = text.split('\n');
    c.rest = lines.pop();
    for (const l of lines) {
      if (!l.trim()) continue;
      try { apply(c.s, JSON.parse(l)); } catch { c.s.lines++; c.s.unknown++; }
    }
  } finally { fs.closeSync(fd); }
  return c.s;
}

function hidden() { try { return new Set(JSON.parse(fs.readFileSync(HIDDEN, 'utf8'))); } catch { return new Set(); } }
function hide(id) {
  const h = hidden(); h.add(id);
  fs.mkdirSync(path.dirname(HIDDEN), { recursive: true });
  fs.writeFileSync(HIDDEN, JSON.stringify([...h].slice(-500)));
}

// { sessions, warning } — warning은 형식이 바뀐 것으로 보이면 설명 문자열
function loadCodex() {
  const h = hidden();
  const sessions = [];
  let lines = 0, unknown = 0, noMeta = 0;
  for (const [f, st] of recentFiles()) {
    let s;
    try { s = readNew(f, st); } catch { continue; }
    lines += s.lines; unknown += s.unknown;
    if (s.lines > 0 && !s.sawMeta) noMeta++;
    if (h.has(s.id) || !s.lines || !inScope(s.cwd)) continue;   // 기록 범위 밖 세션은 표시하지 않는다
    const view = { ...s, updatedAt: s.updatedAt || st.mtimeMs };
    if (view.status === 'working' && Date.now() - view.updatedAt > STALE_MS) view.status = 'idle';
    sessions.push(view);
  }
  let warning = '';
  if (noMeta) warning = `세션 정보가 없는 로그 ${noMeta}개`;
  else if (lines && unknown / lines > 0.05) warning = `모르는 레코드 ${unknown}/${lines}줄`;
  return { sessions, warning };
}

module.exports = { loadCodex, hide };
