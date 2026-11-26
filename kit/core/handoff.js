#!/usr/bin/env node
// Claude Code hook: 압축할 때 인수인계 메모를 자동으로 남긴다. 사용자는 `/compact`만 치면 된다(자동 압축에도 똑같이 동작한다).
//
// - PreCompact: 압축 요약에 "인수인계 블록"을 넣으라는 지시를 표준 출력으로 낸다(Claude Code가 압축 지시에 덧붙인다).
// - PostCompact: 만들어진 요약(compact_summary)에서 그 블록을 꺼내
//   worklogs/<프로젝트 이름>/인수인계.md 의 `## 지금 상태`로 쓰고, 이전 것은 `## 지난 기록`으로 내린다.
// - work-dash가 관리하지 않는 프로젝트(로드맵도 작업 카드 폴더도 없음)에서는 아무것도 하지 않는다.
// - 어떤 경우에도 압축을 막지 않는다: 항상 exit 0, 오류는 삼킨다.
const fs = require('fs');
const path = require('path');
const { WD } = require('./paths');
const { projectName } = require('./scope');

const ROOT = WD;
const BEGIN = '[인수인계 시작]';
const END = '[인수인계 끝]';
const KEEP = 5;

const SECTIONS = `(한두 문장: 이 세션이 무슨 일을 하는 세션이고 지금 어디까지 왔는지)

### 맡겨 둔 세션 · 에이전트
- 이름, 맡긴 항목 ID, 지금 상태, 받아야 할 결과

### 기다리는 것
- 사용자에게 물어 둔 질문, 사용자가 아직 정하지 않은 선택

### 말로만 정한 것
- 사용자가 대화에서 정했지만 카드 · 규칙에 아직 없는 결정, 하지 않기로 한 것

### 열려 있는 것
- 커밋 전 변경, 푸시 전 브랜치, 병합 전 PR

### 다음에 할 일 · 확인하지 못한 것
- 바로 이어서 할 일, 검증하지 못한 것`;
const SHARED = '로드맵 · 작업 카드에 이미 있는 내용은 옮겨 적지 않고 항목 ID만 가리킨다. 해당 사항이 없는 절은 "- 없음"이라고 쓴다. 한국어로 쓴다.';

const INSTRUCTIONS = `요약의 맨 끝에 아래 블록을 반드시 넣는다. 표시 줄 두 개는 글자 그대로 쓴다. 이 블록은 파일로 저장되어 다음 세션이 읽는다.
${SHARED}

${BEGIN}
${SECTIONS}
${END}`;

function managed(project) {
  return fs.existsSync(path.join(ROOT, 'roadmaps', project + '.md'))
    || fs.existsSync(path.join(ROOT, 'worklogs', project));
}

function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function extract(summary) {
  const s = String(summary || '');
  const a = s.lastIndexOf(BEGIN);
  if (a >= 0) {
    const b = s.indexOf(END, a);
    const body = s.slice(a + BEGIN.length, b >= 0 ? b : undefined).trim();
    if (body) return { body, whole: false };
  }
  const body = s.replace(/<analysis>[\s\S]*?<\/analysis>/g, '').replace(/<\/?summary>/g, '').trim();
  return { body, whole: true };
}

function demote(body) {
  return body.replace(/^(#{1,2}) /gm, '### ');
}

function write(project, body, { trigger, whole }) {
  const dir = path.join(ROOT, 'worklogs', project);
  const file = path.join(dir, '인수인계.md');
  let old = '';
  try { old = fs.readFileSync(file, 'utf8'); } catch {}

  const parts = old.split(/^(?=## )/m);
  const head = parts[0].startsWith('## ') ? '' : parts.shift();
  const past = parts
    .map((p) => p.replace(/^## 지금 상태/, '## 지난 기록').trimEnd())
    .filter(Boolean)
    .slice(0, KEEP);

  const note = `${trigger === 'auto' ? '자동 압축' : '압축'} 때 자동 작성${whole ? ' · 인수인계 블록이 없어 요약 전체를 옮김' : ''}`;
  const now = `## 지금 상태 (${stamp()} · ${note})\n${demote(body)}`;
  const title = head.trim() || `# ${project} 인수인계`;
  const text = [title, now, ...past].join('\n\n') + '\n';

  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
  return file;
}

const CODEX_LIMIT = 70000;
const CODEX_AGAIN = 15000;
const STATE_DIR = path.join(ROOT, 'data', 'handoff');

function codexContext(transcript) {
  try {
    const fd = fs.openSync(transcript, 'r');
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, 400000);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    fs.closeSync(fd);
    const lines = buf.toString('utf8').split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i].includes('"token_count"')) continue;
      try {
        const u = JSON.parse(lines[i]).payload.info.last_token_usage;
        if (u && u.input_tokens) return u.input_tokens;
      } catch {}
    }
  } catch {}
  return 0;
}

function codexPrompt(ev, project) {
  const tokens = codexContext(ev.transcript_path);
  const file = path.join(STATE_DIR, String(ev.session_id || 'unknown').replace(/[^A-Za-z0-9._-]/g, '_') + '.json');
  let last = 0;
  try { last = JSON.parse(fs.readFileSync(file, 'utf8')).at || 0; } catch {}

  if (tokens < CODEX_LIMIT) {
    if (!last) return null;
    try { fs.unlinkSync(file); } catch {}
    return JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: `[work-dash] 이 세션이 압축됐다. 요약에 빠진 것이 있어 보이면 인수인계 메모(~/.work-dash/worklogs/${project}/인수인계.md)의 \`## 지금 상태\` 절만 읽는다.` } });
  }
  if (last && tokens - last < CODEX_AGAIN) return null;

  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ at: tokens }));
  const memo = `~/.work-dash/worklogs/${project}/인수인계.md`;
  const text = `[work-dash] 이 세션의 컨텍스트가 약 ${Math.round(tokens / 10000)}만 토큰이다. 10만에서 자동 압축이 실행된다. `
    + `사용자의 요청을 처리한 뒤, 이번 턴을 마치기 전에 인수인계 메모(${memo})를 갱신한다. `
    + '파일을 덮어쓰지 않는다: 맨 위에 `## 지금 상태 (<날짜 시각>)` 절을 새로 쓰고, 있던 `## 지금 상태` 절은 제목만 `## 지난 기록`으로 바꿔 그 아래에 둔다. '
    + `새 절은 아래 모양으로 쓴다. ${SHARED}\n\n${SECTIONS}\n\n`
    + '사용자에게 압축을 요청하지 않는다. 메모를 갱신했다고 한 줄로만 알린다.';
  return JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: text } });
}

function main(ev) {
  const project = projectName(ev.cwd || process.cwd());
  if (!project || project === '(unknown)' || !managed(project)) return null;
  if (ev.hook_event_name === 'UserPromptSubmit') {
    return /\/\.codex\//.test(String(ev.transcript_path || '')) ? codexPrompt(ev, project) : null;
  }
  if (ev.hook_event_name === 'PreCompact') return INSTRUCTIONS;
  if (ev.hook_event_name === 'PostCompact') {
    const { body, whole } = extract(ev.compact_summary);
    if (!body) return null;
    write(project, body, { trigger: ev.trigger, whole });
  }
  return null;
}

if (require.main === module) {
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (c) => { input += c; });
  process.stdin.on('end', () => {
    try {
      const out = input.trim() ? main(JSON.parse(input)) : null;
      if (out) process.stdout.write(out);
    } catch {}
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 4000);
}

module.exports = { extract, write, main, INSTRUCTIONS };
