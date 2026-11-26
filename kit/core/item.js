#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { WD } = require('./paths');
const { changedFiles } = require('./check');
const roadmapParser = require('./roadmap');
const { projectName } = require('./scope');
const lint = require('./doclint');
const flowfind = require('./flowfind');

const { ROADMAP_ITEM, ISSUE_LINE, ISSUE_ID, SEVERITY, KINDS, STD_SECTIONS, DEF_SECTIONS, STAMP, TAG, DT, normSection } = lint;

const USAGE = `로드맵 항목 · 작업 카드 · 이슈를 형식대로 바꾼다. 프로젝트는 현재 폴더로 찾는다.

  item.js                                  진행률 · 진행 중 · 시작할 수 있는 항목 · 막힌 항목 (next도 같다)
  item.js show <ID|이슈 ID|M번호>           항목(메모 · 카드의 절과 줄 번호 · 딸린 이슈) · 이슈 하나 · 마일스톤 하나만 보여 준다
  item.js flow [<파일 경로|ID|낱말>…]       흐름 문서의 전체 구조와, 준 경로 · ID가 걸리는 흐름 절만 보여 준다(없이 부르면 절 목록)
  item.js start <ID> [--force]             항목을 [~] + 담당 태그로 바꾸고 작업 카드를 만든다
  item.js done <ID> [--committed [--commit "<해시> <제목>"]] [--note "<괄호 안 말>"]
                                           카드에 빠진 절을 덧붙이고, 다 채워졌으면 [x] · 검토 대기(커밋했으면 완료)로 바꾼다
  item.js add <M번호> "<이름 (범위)>" [--prefix <접두어>] [--after <ID,ID>]
  item.js milestone "<결과 이름>" "<완료 기준>" [--due <마감>]
  item.js wait <ID> "<누구 · 무엇>"         외부 대기 [!]
  item.js hold <ID> "<이유>"               보류 [>]  (사용자가 정했을 때만)
  item.js drop <ID> "<이유>"               취소 [-]  (사용자가 정했을 때만)
  item.js reopen <ID>                      외부 대기 · 보류 항목을 할 일 [ ]로 되돌린다
  item.js extra <ID>                       완료한 항목의 카드에 추가 작업 절과 틀을 붙인다(항목은 [x] 그대로). 채운 뒤 done <ID>로 확인한다
  item.js memo <ID> <머리말> "<한 줄>"      항목 아래에 메모 줄을 단다. 상세 근거는 카드에 두고 한두 줄 요약만 올린다
                                           머리말: 결정(사용자가 확정한 것) | 대기(누구 · 무엇) | 협의(다른 사람과 맞출 것)
                                                   확인 필요(아직 확인 못 한 사실) | 연결(이 항목을 쓰는 쪽) | 리뷰 반영(리뷰에서 바꾼 것)
  item.js section <ID> <절> ["<줄>" …] [--by <누구>]
                                           카드에 절을 순서에 맞게 덧붙인다
                                           절: ${[...DEF_SECTIONS, 'API · 스키마 상세', '막혔던 문제와 해결'].join(' | ')}
  item.js issue                            열린 · 처리 중 이슈
  item.js issue add --parent <항목 ID|ISS> --sev <${SEVERITY.join('|')}> --kind <${KINDS.join('|')}> "<제목>"
                    [--found <접두어:ID>] [--related <ID,ID>] [--github <번호>] [--detail "<재현|원인|해결 방향>: …"]…
  item.js issue start <ID>
  item.js issue resolve <ID> "<무엇을 바꿨는지>" [--commit "<해시>"]
  item.js issue close <ID> "<이유>"
                                           다른 프로젝트에서 고칠 문제는 --project <이름>으로 그 프로젝트에 적는다. 팀원 코드 문제는 팀 GitHub Issues에 올리고 번호만 남긴다(--github)
                                           어디에 적을지 애매하면 ~/.work-dash/ISSUES-FORMAT.md의 "어디에 적나"를 읽는다

  공통: --as <claude|gpt> 담당 태그 · --project <이름> 다른 프로젝트의 파일`;

const VALUE_FLAGS = new Set(['as', 'project', 'prefix', 'after', 'note', 'by', 'parent', 'sev', 'kind', 'found', 'related', 'github', 'commit', 'due']);
const MULTI_FLAGS = new Set(['detail']);
const BOOL_FLAGS = new Set(['force', 'committed', 'help']);
const TODO = '<채울 것: ';
const UNFILLED = /<채울 것: (?!…>)/;
const AGENT_TAG = /\s+@(claude|gpt)\s*$/;
const ITEM_ID = /^[A-Z][A-Z0-9]*-\d+$/;
const ALWAYS = ['무엇을 했나', '왜 이렇게 했나', '바뀐 것', '검증', '리뷰 결과', '학습 노트', '주의 · 남은 일'];
const EXTRA_ALWAYS = ['무엇을 했나', '바뀐 것', '검증'];
const OPTIONAL = ['API · 스키마 상세', '막혔던 문제와 해결'];
const ASSUME = '확인하지 못한 가정';
const MEMO_HEADS = ['결정', '대기', '협의', '확인 필요', '연결', '리뷰 반영'];
const DETAIL_KEYS = ['재현', '원인', '해결 방향', '해결', '이유', '커밋'];

const fill = (t) => `${TODO}${t}>`;
const PLAN = (after) => [
  '## 계획 (시작할 때 작성)',
  `- 할 일: ${fill('무엇을 하는지 한두 문장')}`,
  `- 범위 밖: ${fill('이번에 하지 않는 것. 없으면 "없음"')}`,
  `- 완료 기준: ${fill('해 볼 동작 · 통과할 명령')}`,
  `- 관련 항목: ${after.length ? `선행 ${after.join(' · ')}` : fill('선행 · 이어지는 항목 ID. 없으면 "없음"')}`,
];
const BODY = {
  '무엇을 했나': [fill('사용자나 API를 쓰는 쪽에서 무엇이 가능해졌는지 2~4문장')],
  '왜 이렇게 했나': [
    `- **결정:** ${fill('무엇을 어떻게 하기로 했는지')}`,
    `  - 이유: ${fill('요구사항 · 제약 · 팀 규칙 · 기존 코드 구조')}`,
    `  - 버린 대안: ${fill('다른 방법과 쓰지 않은 이유. 없으면 이 줄을 지운다')}`,
  ],
  '바뀐 것': [
    '| 파일 | 변경 | 왜 |',
    '|---|---|---|',
    `| ${fill('파일 경로')} | ${fill('무엇을 바꿨나')} | ${fill('왜')} |`,
    `- 커밋: ${fill('해시와 제목(여러 개면 모두). 커밋 전이면 "커밋 전", 코드 변경이 없으면 표를 지우고 "코드 변경 없음"')}`,
  ],
  'API · 스키마 상세': [
    `- ${fill('요청 · 응답 예시 JSON, 에러 코드와 상황')}`,
    `- ${fill('테이블 · 컬럼 · 엔티티 변경 전후')}`,
  ],
  '막혔던 문제와 해결': [
    `- 증상: ${fill('어떤 에러 · 현상')}`,
    `- 시도 1: ${fill('무엇을 바꿨나 → 결과. 실패할 때마다 한 줄씩, 같은 증상에 두 줄이면 세 번째를 하지 않고 보고한다')}`,
    `- 원인: ${fill('왜 그랬는지. 아직 모르면 가설')}`,
    `- 해결: ${fill('무엇을 바꿔서 풀었는지. 아직이면 이 줄을 지운다')}`,
  ],
  '검증': [
    `- 실행: ${fill('돌린 명령 → 결과')}`,
    `- 범위: ${fill('돌린 범위와 일부러 돌리지 않은 범위')}`,
    `- 직접 확인하지 못한 것: ${fill('없으면 "없음"')}`,
  ],
  '리뷰 결과': [
    `- 리뷰: ${fill('reviewer 에이전트 / 사용자 / 없음(이유). 없으면 스스로 점검한 것(엣지케이스 · 보안 · 기존 호출부 영향)')}`,
    `- 지적: ${fill('[높음] 파일:줄 — 문제 → 반영함 / 반영 안 함(이유). 없으면 이 줄을 지운다')}`,
  ],
  '학습 노트': [
    fill('처음 보거나 이번에 처음 제대로 써 본 개념 1~3개를 아래 틀로 쓴다. 뻔한 개념은 쓰지 않는다. 없으면 틀을 지우고 "없음"과 이유'),
    '',
    `### ${fill('개념 이름')}`,
    `- 쉽게 말하면: ${fill('주니어 개발자에게 — 무엇인지 한 문장 → 이미 아는 것에 빗댄 비유 → 왜 중요한지')}`,
    `- 정확히는: ${fill('정확한 정의')}`,
    `- 왜 여기서 필요했나: ${fill('이 작업의 어떤 문제 때문에')}`,
    `- 대안과 비교: ${fill('다른 방법과 고르지 않은 이유')}`,
    `- 우리 코드에서: ${fill('함수 · 클래스 이름')}`,
    `- 흔한 함정: ${fill('실수하기 쉬운 점')}`,
    `- 스스로 확인할 질문: ${fill('답해 보면 이해했는지 알 수 있는 질문')}`,
  ],
  '주의 · 남은 일': [
    `- ${fill('알려진 한계 · 후속 작업(항목 ID) · 알려야 할 것. 없으면 이 줄을 지운다')}`,
    `- ${fill('"흐름 문서 갱신: <흐름 이름>" 또는 "흐름 변화 없음"')}`,
  ],
  '코드에서 확인한 사실': [`- ${fill('지금 코드 · DB가 어떤지. 파일 · 클래스 근거를 붙인다')}`],
  '제안': [fill('용어 표 · 규칙 · 테이블과 API 모양. 표를 쓴다')],
  '정의서': [fill('용어 표 · 규칙 · 테이블과 API 모양. 표를 쓴다')],
  '확인하지 못한 가정': [`- ${fill('가정 — 확인: 누가 · 언제 / 틀리면: 대안(정할 수 없으면 "재기획 필요"). 대안은 사용자 확정을 받는다. 가정이 없으면 이 줄을 "없음"으로 바꾼다')}`],
  '열린 질문': [`1. ${fill('질문 — 선택지 / 선택지')}`],
  '확정 사항': [`- ${fill('사용자가 고른 답')}`],
  '방향 전환': [`- ${fill('무엇이 왜 바뀌었는지와 다시 물을 질문')}`],
};

class Stop extends Error {}
const stop = (m) => { throw new Stop(m); };
const out = [];
const say = (s) => out.push(s);

const pad2 = (n) => String(n).padStart(2, '0');
const stamp = (d = new Date()) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
const toMs = (s) => new Date(s.replace(' ', 'T')).getTime();

function parseArgs(argv) {
  const flags = { detail: [] }, rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { rest.push(a); continue; }
    const [name, inline] = a.slice(2).split(/=(.*)/s);
    if (BOOL_FLAGS.has(name)) { flags[name] = true; continue; }
    if (!VALUE_FLAGS.has(name) && !MULTI_FLAGS.has(name)) stop(`모르는 옵션 \`--${name}\` → \`item.js --help\`로 쓸 수 있는 옵션을 본다`);
    const v = inline != null ? inline : argv[++i];
    if (v == null) stop(`\`--${name}\`에 값이 없다`);
    if (/[\r\n]/.test(v)) stop(`\`--${name}\` 값에 줄바꿈이 있다 → 한 줄로 준다`);
    if (MULTI_FLAGS.has(name)) flags[name].push(v); else flags[name] = v;
  }
  return { flags, rest };
}

function agentOf(flags) {
  const a = flags.as || process.env.WORK_DASH_AGENT || (process.env.CLAUDECODE ? 'claude' : '');
  if (!/^(claude|gpt)$/.test(a)) stop('담당 태그를 알 수 없다 → `--as claude` 또는 `--as gpt`를 붙인다');
  return a;
}

const crlf = new Set();
function readLines(f) {
  let text;
  try { text = fs.readFileSync(f, 'utf8'); } catch { return null; }
  if (text.includes('\r\n')) crlf.add(f);
  return text.replace(/\r\n/g, '\n').split('\n');
}
const touched = new Set();
function writeLines(f, lines) {
  if (!path.resolve(f).startsWith(path.resolve(WD) + path.sep)) stop(`데이터 폴더 밖의 파일은 고치지 않는다(\`${f}\`)`);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, lines.join(crlf.has(f) ? '\r\n' : '\n'));
  touched.add(f);
}
const endIndex = (lines) => { let i = lines.length; while (i > 0 && lines[i - 1].trim() === '') i--; return i; };
function append(lines, block, gap = true) {
  const at = endIndex(lines);
  lines.splice(at, lines.length - at, ...(gap && at > 0 ? [''] : []), ...block, '');
}

function splitTail(line) {
  let rest = line, owner = '', done = '', t;
  while ((t = rest.match(AGENT_TAG)) || (t = rest.match(STAMP))) {
    if (t[0].includes('✓')) done = t[0].trim(); else owner = t[1];
    rest = rest.slice(0, t.index);
  }
  return { rest, owner, done };
}
const joinTail = (head, owner, done) => `${head}${owner ? ` @${owner}` : ''}${done ? ` ${done}` : ''}`;

function itemAt(lines, i) {
  const { rest, owner, done } = splitTail(lines[i]);
  const m = rest.match(ROADMAP_ITEM);
  if (!m) return null;
  const body = m[3] || '';
  const after = body.match(/\((?:after|선행)\s*:\s*([^)]*)\)\s*$/);
  return {
    i, state: m[1], id: m[2], body, owner, done,
    title: body.replace(/\s*\((?:after|선행)\s*:[^)]*\)\s*$/, ''),
    after: after ? after[1].split(/[,\s]+/).filter(Boolean) : [],
  };
}
const itemLine = (it) => joinTail(`- [${it.state}] ${it.id}${it.body ? ` ${it.body}` : ''}`, it.owner, it.done);
function memoEnd(lines, i) { let j = i + 1; while (j < lines.length && /^    \S/.test(lines[j])) j++; return j; }

function openRoadmap(project) {
  const file = path.join(roadmapParser.RDIR, `${project}.md`);
  const lines = readLines(file);
  if (!lines) stop(`로드맵 파일이 없다(\`roadmaps/${project}.md\`) → 사용자와 초안을 정해 \`init\`으로 먼저 만든다. 다른 프로젝트면 \`--project <이름>\``);
  return { file, lines };
}
function findItem(lines, id) {
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith('- [')) continue;
    const it = itemAt(lines, i);
    if (it && it.id === id) return it;
  }
  return stop(`\`${id}\`가 이 로드맵에 없다 → ID를 확인한다. 새 항목이면 \`add\`로 만든다`);
}
function milestonesOf(lines) {
  const list = [];
  lines.forEach((l, i) => {
    const m = l.match(/^## M(\d+)\. /);
    if (m) list.push({ no: Number(m[1]), i, items: [] });
    else if (l.startsWith('- [') && list.length) { const it = itemAt(lines, i); if (it) list[list.length - 1].items.push(it); }
  });
  list.forEach((ms, k) => { ms.end = k + 1 < list.length ? list[k + 1].i : lines.length; });
  return list;
}

function linked(project) {
  return roadmapParser.linkRoadmaps(roadmapParser.readFiles()).find((r) => r.project === project) || { milestones: [], total: 0, done: 0 };
}
const flat = (r) => r.milestones.flatMap((m) => m.items);
const readyIds = (r) => new Set(flat(r).filter((i) => i.state === 'ready').map((i) => i.id));

const cardFile = (project, id) => path.join(WD, 'worklogs', project, `${id}.md`);
function headings(lines) {
  const list = [];
  let fence = false;
  lines.forEach((l, i) => {
    if (/^\s*```/.test(l)) { fence = !fence; return; }
    if (fence) return;
    const m = l.match(/^## (.+?)\s*$/);
    if (m) list.push({ i, raw: m[1], name: normSection(m[1]) });
  });
  return list;
}
function todoLines(lines, from = 0) {
  const list = [];
  let fence = false;
  lines.forEach((l, i) => {
    if (/^\s*```/.test(l)) { fence = !fence; return; }
    if (!fence && i >= from && UNFILLED.test(l)) list.push(i + 1);
  });
  return list;
}
function cardStatus(lines) {
  const m = (lines[1] || '').match(/^- 상태: (진행 중|검토 대기|완료|취소) · (.*?)\s*$/);
  if (!m) return null;
  const doing = m[2].match(new RegExp(`^@(claude|gpt) · 시작 (${DT})`));
  if (m[1] === '진행 중') return doing ? { state: m[1], owner: doing[1], start: doing[2] } : null;
  const r = m[2].match(new RegExp(`^(${DT}) · @(claude|gpt) · 시작 ((?:\\d{4}-\\d{2}-\\d{2} )?\\d{2}:\\d{2})(.*)$`));
  if (!r) return null;
  return { state: m[1], owner: r[2], end: r[1], start: r[3].length > 5 ? r[3] : `${r[1].slice(0, 10)} ${r[3]}`, tail: r[4] };
}
function spent(startMs, endMs) {
  const min = Math.max(0, Math.round((endMs - startMs) / 60e3));
  return min < 60 ? `약 ${min}분` : `약 ${Math.floor(min / 60)}시간${min % 60 ? ` ${min % 60}분` : ''}`;
}
function insertStd(lines, name, from) {
  const k = STD_SECTIONS.indexOf(name);
  const next = headings(lines).find((h) => h.i > from && STD_SECTIONS.indexOf(h.name) > k);
  const title = OPTIONAL.includes(name) ? `## ${name} (해당할 때만)` : `## ${name}`;
  if (next) lines.splice(next.i, 0, title, ...BODY[name], '');
  else append(lines, [title, ...BODY[name]]);
}

function recordCommit(card, text) {
  const heads = headings(card);
  const k = heads.map((h) => h.name).lastIndexOf('바뀐 것');
  if (k < 0) return false;
  const end = k + 1 < heads.length ? heads[k + 1].i : endIndex(card);
  const line = `- 커밋: ${text.replace(/^([0-9a-f]{7,40})(?=\s|$)/, '`$1`')}`;
  let last = -1;
  for (let i = heads[k].i + 1; i < end; i++) if (/^- 커밋: /.test(card[i])) last = i;
  if (last >= 0 && /^- 커밋: 커밋 전\s*$/.test(card[last])) card[last] = line;
  else if (last >= 0) card.splice(last + 1, 0, line);
  else { let at = end; while (at > heads[k].i + 1 && card[at - 1].trim() === '') at--; card.splice(at, 0, line); }
  return true;
}

function cmdStatus(project) {
  const r = linked(project);
  if (!r.milestones.length) stop(`로드맵 파일이 없거나 비었다(\`roadmaps/${project}.md\`) → 사용자와 초안을 정해 \`init\`으로 만든다`);
  say(`${project}: ${r.done}/${r.total} 완료`);
  const rows = { doing: [], ready: [], blocked: [], await: [] };
  r.milestones.forEach((ms, k) => {
    const active = ms.items.some((i) => i.state === 'doing');
    for (const it of ms.items) if (rows[it.state]) rows[it.state].push({ it, ms: ms.name, order: (active ? 0 : 1e6) + k });
  });
  rows.ready.sort((a, b) => a.order - b.order);
  const show = (label, list, extra) => {
    if (!list.length) return;
    say(`${label} ${list.length}개`);
    for (const { it, ms } of list.slice(0, 12)) say(`  ${it.id} ${it.title}${extra(it)} — ${ms}`);
    if (list.length > 12) say(`  … ${list.length - 12}개 더`);
  };
  show('진행 중', rows.doing, (it) => (it.owner ? ` @${it.owner}` : ''));
  show('시작할 수 있음(위에서부터 추천)', rows.ready, () => '');
  show('선행 필요', rows.blocked, (it) => ` ← ${it.waiting.join(', ')}`);
  show('외부 대기', rows.await, () => '');
}

function cmdStart(project, id, flags) {
  const me = agentOf(flags);
  const { file, lines } = openRoadmap(project);
  const it = findItem(lines, id);
  if (it.state === 'x' || it.state === '-') stop(`\`${id}\`는 이미 ${it.state === 'x' ? '완료' : '취소'}된 항목이다 → 다시 열지 않는다. 이 항목 안의 작은 추가 작업이면 \`extra ${id}\`로 카드에 절을 붙이고, 후속 작업이면 \`add\`로 새 항목을 만든다`);
  if (it.state === '~' && it.owner && it.owner !== me) stop(`\`${id}\`는 @${it.owner}가 잡고 있다 → 시작하지 말고 사용자에게 알린다`);
  const item = flat(linked(project)).find((x) => x.id === id);
  if (item && item.waiting.length && !flags.force) stop(`선행 ${item.waiting.map((x) => `\`${x}\``).join(' · ')}가 끝나지 않았다 → 사용자에게 진행할지 묻고, 진행하면 \`--force\`를 붙인다`);
  const was = it.state;
  if (was !== '~' || it.owner !== me) {
    it.state = '~'; it.owner = me;
    lines[it.i] = itemLine(it);
    if (was === '!') {
      for (let j = it.i + 1; j < memoEnd(lines, it.i); j++) if (/^    대기: /.test(lines[j]) && !/\(풀림 /.test(lines[j])) lines[j] += ` (풀림 ${stamp().slice(0, 10)})`;
    }
    writeLines(file, lines);
    say(`로드맵: ${lines[it.i]}`);
  } else say(`로드맵: 이미 내가 잡은 항목이다 — ${lines[it.i]}`);

  const cf = cardFile(project, id);
  const card = readLines(cf);
  const now = stamp();
  const statusLine = `- 상태: 진행 중 · @${me} · 시작 ${now}`;
  if (!card) {
    writeLines(cf, [`# ${id} ${it.title || id}`, statusLine, '', ...PLAN(it.after), '']);
    say(`카드: 만들었다 — worklogs/${project}/${id}.md`);
  } else {
    const st = cardStatus(card);
    if (st && st.state === '진행 중') { say(`카드: 이미 있다(진행 중) — worklogs/${project}/${id}.md`); return; }
    if (/^- 상태:/.test(card[1] || '')) card[1] = statusLine; else card.splice(1, 0, statusLine);
    append(card, [`## 추가 작업 (${now.slice(0, 10)})`, ...PLAN(it.after).slice(1)]);
    writeLines(cf, card);
    say(`카드: 있던 카드에 \`## 추가 작업\`을 이어 붙였다 — worklogs/${project}/${id}.md`);
  }
  say('커밋: 끝에 한 번이 아니라 단위(스키마 · 로직과 그 시험 · API · 설정)가 하나 끝날 때마다 한다. 리팩터링 · 이름 변경 · 파일 이동은 기능 변경과 따로 커밋한다');
  say(`다음: 카드의 \`${TODO}…>\` 줄을 채우고 작업을 시작한다. 정의 · 설계 항목이면 \`section ${id} "코드에서 확인한 사실"\`처럼 절을 더한다`);
}

function cmdDone(project, id, flags) {
  const me = agentOf(flags);
  const { file, lines } = openRoadmap(project);
  const it = findItem(lines, id);
  const cf = cardFile(project, id);
  const card = readLines(cf);
  if (!card) stop(`작업 카드가 없다(\`worklogs/${project}/${id}.md\`) → \`start ${id}\`로 카드를 만들고 한 일을 적은 뒤 다시 실행한다`);
  const st = cardStatus(card);
  if (!st) stop('카드 둘째 줄이 상태 줄이 아니다 → `- 상태: 진행 중 · @claude · 시작 YYYY-MM-DD HH:MM`으로 고친 뒤 다시 실행한다');
  const now = stamp();

  if (it.state === 'x') {
    const last = headings(card).filter((h) => h.name === '추가 작업').pop();
    const left = last ? todoLines(card, last.i) : [];
    if (left.length) stop(`추가 작업 절이 다 채워지지 않았다 — \`${TODO}…>\`가 남은 줄: ${left.slice(0, 30).join(', ')} → worklogs/${project}/${id}.md를 직접 확인한 것으로 채우고(해당 없는 줄은 지운다) 다시 \`done ${id}\`를 실행한다`);
    if (last && !flags.committed && st.state === '검토 대기') { say(`카드: 추가 작업 절이 다 채워졌다 — worklogs/${project}/${id}.md. 커밋한 뒤 \`done ${id} --committed\``); return; }
    if (!(flags.committed && st.state === '검토 대기')) stop(st.state === '완료' ? `\`${id}\`는 카드까지 완료다 → 더 할 일이 있으면 \`extra ${id}\`로 추가 작업 절을 붙인다` : `\`${id}\`는 이미 완료다 → 커밋한 뒤 카드를 \`완료\`로 바꾸려면 \`done ${id} --committed\``);
    card[1] = `- 상태: 완료 · ${now} · @${st.owner} · 시작 ${st.start.slice(0, 10) === now.slice(0, 10) ? st.start.slice(11) : st.start}${st.tail}`;
    const wrote = flags.commit && recordCommit(card, flags.commit);
    writeLines(cf, card);
    say(`카드: ${card[1]}`);
    say(wrote ? `카드: 바뀐 것에 커밋 \`${flags.commit}\`을 적었다` : '다음: 카드 `바뀐 것`에 커밋 해시와 제목을 적는다(`--commit "<해시> <제목>"`을 주면 명령이 적는다)');
    return;
  }
  if (it.state !== '~') stop(`\`${id}\`는 진행 중이 아니다 → \`start ${id}\`로 잡은 항목만 완료한다`);
  if (it.owner !== me && !flags.force) stop(`\`${id}\`는 @${it.owner || '?'}가 잡고 있다 → 사용자가 시켰을 때만 \`--force\`로 바꾼다`);

  const heads = headings(card);
  const extra = heads.filter((h) => h.name === '추가 작업').pop();
  const from = extra ? extra.i : 0;
  const present = new Set(heads.filter((h) => h.i > from || !extra).map((h) => h.name));
  const missing = (extra ? EXTRA_ALWAYS : ALWAYS).filter((n) => !present.has(n));
  const isDef = !extra && heads.some((h) => DEF_SECTIONS.includes(h.name));
  if (isDef && !present.has(ASSUME)) {
    const firstStd = heads.find((h) => STD_SECTIONS.includes(h.name));
    const block = [`## ${ASSUME}`, ...BODY[ASSUME]];
    if (firstStd) card.splice(firstStd.i, 0, ...block, '');
    else append(card, block);
    missing.unshift(ASSUME);
  }
  if (missing.length) {
    for (const n of missing) if (n !== ASSUME) insertStd(card, n, from);
    writeLines(cf, card);
  }
  const empty = [];
  const hs = headings(card);
  hs.forEach((h, k) => {
    const end = k + 1 < hs.length ? hs[k + 1].i : card.length;
    if (h.i >= from && !card.slice(h.i + 1, end).some((l) => l.trim())) empty.push(h.raw);
  });
  const todo = todoLines(card, from);
  const noPlan = [];
  if (isDef) hs.forEach((h, k) => {
    if (h.name !== ASSUME) return;
    const end = k + 1 < hs.length ? hs[k + 1].i : card.length;
    for (let i = h.i + 1; i < end; i++) if (/^- /.test(card[i]) && !card[i].includes(TODO) && !/틀리면\s*:/.test(card[i]) && !/^- 없음/.test(card[i])) noPlan.push(i + 1);
  });
  if (missing.length || empty.length || todo.length || noPlan.length) {
    const why = [];
    if (missing.length) why.push(`빠진 절 ${missing.length}개를 틀과 함께 덧붙였다(${missing.join(' · ')})`);
    if (empty.length) why.push(`내용이 없는 절: ${empty.join(' · ')}`);
    if (noPlan.length) why.push(`\`${ASSUME}\`에 \`틀리면:\`이 없는 줄: ${noPlan.join(', ')}(틀렸을 때 갈 대안을 적는다. 정할 수 없으면 \`틀리면: 재기획 필요\`)`);
    if (todo.length) why.push(`\`${TODO}…>\`가 남은 줄: ${todo.slice(0, 30).join(', ')}${todo.length > 30 ? ' …' : ''}`);
    stop(`카드가 다 채워지지 않아 완료로 바꾸지 않았다 — ${why.join(' / ')} → worklogs/${project}/${id}.md를 직접 확인한 것으로 채우고(해당 없는 줄은 지운다) 다시 \`done ${id}\`를 실행한다`);
  }

  const before = readyIds(linked(project));
  it.state = 'x'; it.owner = '';
  lines[it.i] = itemLine(it);
  writeLines(file, lines);
  const state = flags.committed ? '완료' : '검토 대기';
  const note = flags.note || spent(toMs(st.start), toMs(now));
  card[1] = `- 상태: ${state} · ${now} · @${me} · 시작 ${st.start.slice(0, 10) === now.slice(0, 10) ? st.start.slice(11) : st.start} (${note})`;
  if (flags.committed && flags.commit) recordCommit(card, flags.commit);
  writeLines(cf, card);
  say(`로드맵: ${lines[it.i]}`);
  say(`카드: ${card[1]}`);

  const after = linked(project);
  const freed = flat(after).filter((x) => x.state === 'ready' && !before.has(x.id));
  if (freed.length) say(`새로 시작할 수 있는 항목: ${freed.map((x) => `${x.id} ${x.title}`).join(' / ')}`);
  const ms = milestonesOf(lines).find((m) => m.items.some((x) => x.id === id));
  if (ms && !ms.items.some((x) => x.state === ' ' || x.state === '~')) {
    const left = ms.items.filter((x) => x.state === '!' || x.state === '>').map((x) => `${x.id}(${x.state === '!' ? '외부 대기' : '보류'})`);
    say(`M${ms.no}이 닫혔다 → 사용자에게 알린다${left.length ? `. 남은 항목: ${left.join(', ')}` : ''}`);
  }
  const flows = touchedFlows(project);
  if (flows.length) say(`바뀐 파일이 걸리는 흐름 절: ${flows.join(' · ')} → 흐름이 바뀌었으면 그 절만 고친다(\`flow <경로>\`로 본다. 형식은 \`~/.work-dash/FLOWS-FORMAT.md\`)`);
  if (!flags.committed) say(`다음: 커밋한 뒤 \`done ${id} --committed\`로 카드를 완료로 바꾼다`);
}

function touchedFlows(project) {
  try {
    const top = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8', timeout: 4000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const files = changedFiles(top).files.filter((f) => !/(^|\/)(test|tests|__tests__)\//.test(f)).slice(0, 60);
    if (!files.length) return [];
    return (flowfind.related(project, files) || []).map((s) => s.name).slice(0, 8);
  } catch { return []; }
}

function cmdAdd(project, [mArg, text], flags) {
  if (!mArg || !text) stop('쓰는 법: `add <M번호> "<이름 (범위)>" [--prefix <접두어>] [--after <ID,ID>]`');
  if (/\n/.test(text) || TAG.test(text) || /\((?:after|선행)\s*:/.test(text)) stop('항목 이름에 줄바꿈 · 담당 태그 · `(after: …)`를 넣지 않는다 → 선행은 `--after`로 준다');
  const { file, lines } = openRoadmap(project);
  const list = milestonesOf(lines);
  const no = Number(String(mArg).replace(/^M/i, ''));
  const ms = list.find((m) => m.no === no);
  if (!ms) stop(`마일스톤 M${mArg.replace(/^M/i, '')}이 없다(있는 것: ${list.map((m) => `M${m.no}`).join(' ')}) → 번호를 고치거나, 새 결과면 사용자와 정한 뒤 \`milestone "<결과 이름>" "<완료 기준>"\`으로 만든다`);
  const all = lines.map((l, i) => (l.startsWith('- [') ? itemAt(lines, i) : null)).filter(Boolean);
  let prefix = flags.prefix;
  if (!prefix) {
    const count = {};
    for (const x of ms.items) { const p = x.id.split('-')[0]; count[p] = (count[p] || 0) + 1; }
    prefix = Object.keys(count).sort((a, b) => count[b] - count[a])[0];
    if (!prefix) stop(`M${no}에 항목이 없어 접두어를 정할 수 없다 → \`--prefix <접두어>\`를 준다`);
  }
  if (!/^[A-Z][A-Z0-9]*$/.test(prefix)) stop(`접두어 \`${prefix}\`의 모양이 틀렸다 → 영문 대문자로 시작하는 대문자 · 숫자`);
  const after = (flags.after || '').split(/[,\s]+/).filter(Boolean);
  for (const a of after) if (!a.includes(':') && !all.some((x) => x.id === a)) stop(`선행 \`${a}\`가 이 로드맵에 없다 → 있는 ID로 고친다. 다른 로드맵의 항목이면 \`<접두어>:${a}\``);
  const max = Math.max(0, ...all.filter((x) => x.id.startsWith(`${prefix}-`)).map((x) => Number(x.id.split('-')[1])));
  const id = `${prefix}-${max + 1}`;
  const line = `- [ ] ${id} ${text.trim()}${after.length ? ` (after: ${after.join(', ')})` : ''}`;
  let at;
  if (ms.items.length) at = memoEnd(lines, ms.items[ms.items.length - 1].i);
  else at = ms.i + (/^    완료 기준: /.test(lines[ms.i + 1] || '') ? 2 : 1);
  lines.splice(at, 0, line);
  writeLines(file, lines);
  say(`로드맵 M${no}: ${line}`);
  if (ms.items.length && !ms.items.some((x) => x.state === ' ' || x.state === '~')) say(`닫혀 있던 M${no}을 다시 연다 → 사용자에게 한 줄로 알린다`);
}

function cmdMilestone(project, [name, criteria], flags) {
  if (!name || !criteria) stop('쓰는 법: `milestone "<결과 이름>" "<완료 기준>" [--due <마감>]`');
  if (name.includes('~')) stop('마일스톤 이름에 `~`를 쓰지 않는다 → 마감은 `--due`로 준다');
  const { file, lines } = openRoadmap(project);
  const no = Math.max(0, ...milestonesOf(lines).map((m) => m.no)) + 1;
  const block = [`## M${no}. ${name.trim()}${flags.due ? ` (~${flags.due})` : ''}`, `    완료 기준: ${criteria.trim()}`];
  append(lines, block);
  writeLines(file, lines);
  block.forEach((l) => say(`로드맵: ${l}`));
  say(`다음: \`add M${no} "<이름 (범위)>" --prefix <접두어>\`로 항목을 넣는다`);
}

function cmdPark(project, kind, [id, reason], flags) {
  if (!id || !reason || !reason.trim()) stop(`쓰는 법: \`${kind} <ID> "<${kind === 'wait' ? '누구 · 무엇' : '이유'}>"\``);
  const { file, lines } = openRoadmap(project);
  const it = findItem(lines, id);
  if (it.state === 'x' || it.state === '-') stop(`\`${id}\`는 이미 ${it.state === 'x' ? '완료' : '취소'}된 항목이다 → 상태를 바꾸지 않는다`);
  if (it.state === '~' && it.owner && it.owner !== agentOf(flags) && !flags.force) stop(`\`${id}\`는 @${it.owner}가 잡고 있다 → 사용자가 시켰을 때만 \`--force\`로 바꾼다`);
  const today = stamp().slice(0, 10);
  const memo = kind === 'wait' ? `    대기: ${reason.trim()}` : `    결정(${today}): ${kind === 'hold' ? '보류' : '하지 않음'} — ${reason.trim()}`;
  it.state = { wait: '!', hold: '>', drop: '-' }[kind]; it.owner = '';
  lines[it.i] = itemLine(it);
  lines.splice(memoEnd(lines, it.i), 0, memo);
  writeLines(file, lines);
  say(`로드맵: ${lines[it.i]}`);
  say(`로드맵: ${memo}`);
}

function cmdReopen(project, id) {
  const { file, lines } = openRoadmap(project);
  const it = findItem(lines, id);
  if (it.state !== '!' && it.state !== '>') stop(`\`${id}\`는 외부 대기 · 보류 항목이 아니다 → \`reopen\`은 \`[!]\` · \`[>]\`만 되돌린다. 바로 시작하려면 \`start ${id}\``);
  const today = stamp().slice(0, 10);
  if (it.state === '!') {
    for (let j = it.i + 1; j < memoEnd(lines, it.i); j++) if (/^    대기: /.test(lines[j]) && !/\(풀림 /.test(lines[j])) lines[j] += ` (풀림 ${today})`;
  }
  it.state = ' ';
  lines[it.i] = itemLine(it);
  writeLines(file, lines);
  say(`로드맵: ${lines[it.i]}`);
}

function cmdExtra(project, id) {
  const { lines } = openRoadmap(project);
  const it = findItem(lines, id);
  if (it.state !== 'x') stop(`\`${id}\`는 완료한 항목이 아니다 → \`extra\`는 완료 \`[x]\` 항목의 카드에만 절을 붙인다. ${it.state === '~' ? '진행 중이면 카드의 해당 절에 이어 쓴다' : `시작하려면 \`start ${id}\``}`);
  const cf = cardFile(project, id);
  const card = readLines(cf);
  if (!card) stop(`작업 카드가 없다(\`worklogs/${project}/${id}.md\`) → 카드 없이 끝난 항목이다. 후속 작업은 \`add\`로 새 항목을 만든다`);
  const st = cardStatus(card);
  if (!st) stop('카드 둘째 줄이 상태 줄이 아니다 → `- 상태: 검토 대기 · YYYY-MM-DD HH:MM · @claude · 시작 HH:MM`으로 고친 뒤 다시 실행한다');
  const last = headings(card).filter((h) => h.name === '추가 작업').pop();
  if (last && todoLines(card, last.i).length) stop(`채우지 않은 \`## 추가 작업\` 절이 이미 있다(${last.i + 1}번 줄) → 그 절을 채운다. 새 절은 그 뒤에 붙인다`);
  append(card, [`## 추가 작업 (${stamp().slice(0, 10)})`, `- 할 일: ${fill('무엇을 하는지 한두 문장')}`, `- 범위: ${fill('이번에 하는 것과 하지 않는 것')}`]);
  const from = headings(card).filter((h) => h.name === '추가 작업').pop().i;
  for (const n of EXTRA_ALWAYS) insertStd(card, n, from);
  if (st.state === '완료') card[1] = card[1].replace('- 상태: 완료 · ', '- 상태: 검토 대기 · ');
  writeLines(cf, card);
  say(`카드: \`## 추가 작업\` 절과 틀을 붙였다 — worklogs/${project}/${id}.md(${from + 1}번 줄부터)${st.state === '완료' ? '. 상태를 검토 대기로 되돌렸다' : ''}`);
  say(`다음: \`${TODO}…>\` 줄을 채우고 \`done ${id}\`로 확인한다. 로드맵 항목은 \`[x]\` 그대로다`);
}

function cmdMemo(project, [id, head, text]) {
  if (!MEMO_HEADS.includes(head) || !text || !text.trim()) stop(`쓰는 법: \`memo <ID> <머리말> "<한 줄>"\`. 머리말은 ${MEMO_HEADS.join(' | ')} 가운데 하나다. 앞선 결정을 뒤집는 \`재설계(날짜, 새 ID):\`와 \`<새 ID>에서 교체:\`는 손으로 쓴다`);
  const { file, lines } = openRoadmap(project);
  const it = findItem(lines, id);
  const memo = `    ${head === '결정' ? `결정(${stamp().slice(0, 10)})` : head}: ${text.trim()}`;
  lines.splice(memoEnd(lines, it.i), 0, memo);
  writeLines(file, lines);
  say(`로드맵: ${lines[it.i]}`);
  say(`로드맵: ${memo}`);
}

function cmdSection(project, [id, nameArg, ...body], flags) {
  const name = normSection(nameArg || '');
  const allowed = [...DEF_SECTIONS, ...OPTIONAL];
  if (!id || !allowed.includes(name)) stop(`쓰는 법: \`section <ID> <절> ["<줄>" …]\`. 절은 ${allowed.join(' | ')} 가운데 하나다. 다른 내용은 표준 절 안에 \`###\` 작은 제목으로 쓴다`);
  const cf = cardFile(project, id);
  const card = readLines(cf);
  if (!card) stop(`작업 카드가 없다(\`worklogs/${project}/${id}.md\`) → \`start ${id}\`로 먼저 만든다`);
  const heads = headings(card);
  const extra = heads.filter((h) => h.name === '추가 작업').pop();
  if (OPTIONAL.includes(name)) {
    if (heads.some((h) => h.name === name && (!extra || h.i > extra.i))) stop(`\`## ${name}\` 절이 이미 있다 → 그 절에 이어 쓴다`);
    insertStd(card, name, extra ? extra.i : 0);
    if (body.length) { const h = headings(card).filter((x) => x.name === name).pop(); card.splice(h.i + 1, BODY[name].length, ...body); }
  } else {
    const hm = stamp().slice(11);
    const n = heads.filter((h) => h.name === name).length;
    if (name === '방향 전환' && !flags.by) stop('`방향 전환`에는 누가 제안했는지가 필요하다 → `--by 사용자`처럼 준다');
    const title = {
      '코드에서 확인한 사실': '코드에서 확인한 사실', '제안': '제안', '정의서': '정의서 (초안)', [ASSUME]: ASSUME,
      '열린 질문': '열린 질문 (사용자 확정 대기)',
      '확정 사항': `확정 사항${n ? ` ${n + 1}` : ''} (${hm})`,
      '방향 전환': `방향 전환 (${hm}, ${flags.by} 제안)`,
    }[name];
    const block = [`## ${title}`, ...(body.length ? body : BODY[name])];
    if (body.some((l) => /^#{1,2} /.test(l))) stop('절 본문 줄을 `# ` · `## `로 시작하지 않는다 → 작은 제목은 `###`로 쓴다');
    const firstStd = heads.find((h) => STD_SECTIONS.includes(h.name) && (!extra || h.i > extra.i));
    if (firstStd) card.splice(firstStd.i, 0, ...block, '');
    else append(card, block);
  }
  writeLines(cf, card);
  say(`카드: \`## ${name}\` 절을 더했다 — worklogs/${project}/${id}.md`);
  if (!body.length) say(`다음: \`${TODO}…>\` 줄을 채운다. 이미 적은 절은 고쳐 쓰지 않고 아래에 이어 쓴다`);
}

const issueFile = (project) => path.join(WD, 'issues', `${project}.md`);
function issueAt(lines, i) {
  if (!/^- \[/.test(lines[i])) return null;
  const { rest, owner, done } = splitTail(lines[i]);
  const m = rest.match(ISSUE_LINE);
  return m && ISSUE_ID.test(m[2]) ? { i, state: m[1], id: m[2], body: m[3], owner, done } : null;
}
const issueLine = (x) => joinTail(`- [${x.state}] ${x.id} ${x.body}`, x.owner, x.done);
function issuesOf(lines) { const list = []; lines.forEach((_, i) => { const x = issueAt(lines, i); if (x) list.push(x); }); return list; }
function detailEnd(lines, i) { let j = i + 1; while (j < lines.length && /^\s{2,}\S/.test(lines[j])) j++; return j; }
function findIssue(project, id) {
  const file = issueFile(project);
  const lines = readLines(file);
  const x = lines && issuesOf(lines).find((y) => y.id === id);
  if (!x) stop(`이슈 \`${id}\`가 \`issues/${project}.md\`에 없다 → ID를 확인한다. 다른 프로젝트의 이슈면 \`--project <이름>\``);
  return { file, lines, x };
}

function cmdIssueList(project) {
  const lines = readLines(issueFile(project)) || [];
  const open = issuesOf(lines).filter((x) => x.state === ' ' || x.state === '~');
  const rank = (x) => { const k = SEVERITY.findIndex((s) => x.body.includes(`[${s}]`)); return k < 0 ? 9 : k; };
  say(`${project}: 열린 이슈 ${open.length}개`);
  for (const x of open.sort((a, b) => rank(a) - rank(b))) say(`  ${issueLine(x)}`);
}

function cmdIssueAdd(project, [title], flags) {
  const { parent, sev, kind } = flags;
  if (!title || !parent || !SEVERITY.includes(sev) || !KINDS.includes(kind))
    stop(`쓰는 법: \`issue add --parent <항목 ID|ISS> --sev <${SEVERITY.join('|')}> --kind <${KINDS.join('|')}> "<제목>"\`. 심각도: 높음은 기능이 안 되거나 데이터 · 보안 문제, 중간은 일부가 잘못 동작, 낮음은 불편 · 표시 문제`);
  if (/\n/.test(title) || TAG.test(title)) stop('제목에 줄바꿈이나 담당 태그를 넣지 않는다');
  const details = flags.detail.map((d) => {
    const m = d.match(/^([^:]+):\s*(\S.*)$/s);
    if (!m || !DETAIL_KEYS.includes(m[1].trim())) stop(`세부 줄 \`${d}\`를 읽을 수 없다 → \`--detail "<${DETAIL_KEYS.join('|')}>: <내용>"\``);
    return `  - ${m[1].trim()}: ${m[2].replace(/\s*\n\s*/g, ' ')}`;
  });
  if (parent !== 'ISS') {
    const road = readLines(path.join(roadmapParser.RDIR, `${project}.md`)) || [];
    if (!road.some((l, i) => l.startsWith('- [') && (itemAt(road, i) || {}).id === parent))
      stop(`부모 항목 \`${parent}\`가 \`${project}\` 로드맵에 없다 → 고칠 곳의 로드맵 항목 ID를 쓴다. 맞는 항목이 없으면 \`--parent ISS\`, 다른 프로젝트에서 고칠 문제면 \`--project <이름>\``);
  }
  const file = issueFile(project);
  const lines = readLines(file) || [`# ${project} 이슈`, ''];
  const all = issuesOf(lines);
  const head = parent === 'ISS' ? 'ISS-' : `${parent}#`;
  const same = all.filter((x) => x.id.startsWith(head));
  const id = `${head}${Math.max(0, ...same.map((x) => Number(x.id.slice(head.length)))) + 1}`;
  const tail = [flags.found && `(발견: ${flags.found})`, flags.related && `(관련: ${flags.related.split(/[,\s]+/).filter(Boolean).join(', ')})`, flags.github && `(GitHub: #${String(flags.github).replace(/^#/, '')})`].filter(Boolean);
  const line = `- [ ] ${id} [${sev}][${kind}] ${title.trim()}${tail.length ? ` ${tail.join(' ')}` : ''}`;
  append(lines, [line, ...details], !all.length);
  writeLines(file, lines);
  say(`이슈: ${line}`);
  const open = same.filter((x) => x.state === ' ' || x.state === '~');
  if (open.length) {
    say('같은 부모의 열린 이슈(같은 문제면 방금 것을 지운다):');
    open.forEach((x) => say(`  ${issueLine(x)}`));
  }
}

function cmdIssueStart(project, [id], flags) {
  const me = agentOf(flags);
  const { file, lines, x } = findIssue(project, id);
  if (x.state === '~' && x.owner && x.owner !== me) stop(`\`${id}\`는 @${x.owner}가 처리 중이다 → 사용자가 시킬 때만 바꾼다`);
  if (x.state === 'x' || x.state === '-') stop(`\`${id}\`는 이미 ${x.state === 'x' ? '해결' : '닫은'} 이슈다 → 다시 생긴 문제면 \`issue add\`로 새로 적는다`);
  x.state = '~'; x.owner = me;
  lines[x.i] = issueLine(x);
  writeLines(file, lines);
  say(`이슈: ${lines[x.i]}`);
}

function cmdIssueEnd(project, kind, [id, text], flags) {
  if (!id || !text || !text.trim()) stop(kind === 'resolve' ? '쓰는 법: `issue resolve <ID> "<무엇을 바꿨는지>" [--commit "<해시>"]`' : '쓰는 법: `issue close <ID> "<이유>"`');
  const { file, lines, x } = findIssue(project, id);
  if (x.state === 'x' || x.state === '-') stop(`\`${id}\`는 이미 ${x.state === 'x' ? '해결' : '닫은'} 이슈다`);
  if (x.state === '~' && x.owner && x.owner !== agentOf(flags) && !flags.force) stop(`\`${id}\`는 @${x.owner}가 처리 중이다 → 사용자가 시켰을 때만 \`--force\`로 바꾼다`);
  x.state = kind === 'resolve' ? 'x' : '-'; x.owner = '';
  lines[x.i] = issueLine(x);
  const add = [`  - ${kind === 'resolve' ? '해결' : '이유'}: ${text.trim().replace(/\s*\n\s*/g, ' ')}`];
  if (kind === 'resolve' && flags.commit) add.push(`  - 커밋: ${flags.commit}`);
  lines.splice(detailEnd(lines, x.i), 0, ...add);
  writeLines(file, lines);
  say(`이슈: ${lines[x.i]}`);
  add.forEach((l) => say(`이슈: ${l}`));
}

function cmdShow(project, id) {
  const rel = (f) => path.relative(WD, f);
  if (/^M\d+$/.test(id)) {
    const { file, lines } = openRoadmap(project);
    const ms = milestonesOf(lines).find((m) => m.no === Number(id.slice(1)));
    if (!ms) stop(`마일스톤 \`${id}\`가 이 로드맵에 없다 → \`grep -n '^## ' ${rel(file)}\`로 번호를 확인한다`);
    say(`${rel(file)}:${ms.i + 1}`);
    for (let k = ms.i; k < ms.end; k++) if (lines[k].trim()) say(lines[k]);
    return;
  }
  if (id.includes('#') || id.startsWith('ISS-')) {
    if (!ISSUE_ID.test(id)) stop(`ID \`${id}\`의 모양이 틀렸다 → \`<항목 ID>#<번호>\` 또는 \`ISS-<번호>\``);
    const { file, lines, x } = findIssue(project, id);
    say(`${rel(file)}:${x.i + 1}`);
    for (let k = x.i; k < detailEnd(lines, x.i); k++) say(lines[k]);
    return;
  }
  if (!ITEM_ID.test(id)) stop(`ID \`${id}\`의 모양이 틀렸다 → 항목 ID(\`CART-2\`) · 이슈 ID(\`CART-2#1\`, \`ISS-3\`) · 마일스톤(\`M3\`) 가운데 하나`);
  const { file, lines } = openRoadmap(project);
  const it = findItem(lines, id);
  const ms = milestonesOf(lines).filter((m) => m.i < it.i).pop();
  say(`${rel(file)}:${it.i + 1}`);
  if (ms) { say(lines[ms.i]); if (/^\s+완료 기준:/.test(lines[ms.i + 1] || '')) say(lines[ms.i + 1]); }
  for (let k = it.i; k < memoEnd(lines, it.i); k++) say(lines[k]);
  const card = cardFile(project, id);
  const cl = readLines(card);
  if (!cl) say('카드: 없음');
  else {
    say(`카드: ${rel(card)} (${cl.length}줄)`);
    if (cl[1]) say(`  ${cl[1]}`);
    const hs = headings(cl);
    hs.forEach((h, k) => say(`  ${h.i + 1}-${(k + 1 < hs.length ? hs[k + 1].i : endIndex(cl))} ## ${h.raw}`));
    say('  절 하나만 읽는다: Read에 offset · limit을 준다');
  }
  const il = readLines(issueFile(project)) || [];
  const mine = issuesOf(il).filter((x) => x.id.startsWith(`${id}#`));
  if (mine.length) { say(`이슈 ${mine.length}개:`); for (const x of mine) say(`  ${issueLine(x)}`); }
}

function report() {
  const problems = [];
  const index = touched.size ? lint.buildIndex() : null;
  for (const f of touched) {
    const r = lint.lintFile(f, { index });
    if (!r) continue;
    for (const p of r.problems) if (!p.notice) problems.push(lint.format(r, p));
    for (const p of r.parser) problems.push(`[파서] ${path.relative(WD, r.file)}:${p.line} ${p.message}`);
  }
  if (!problems.length) return;
  say(`고친 파일에 형식 위반 ${problems.length}건(전부터 있던 것 포함):`);
  problems.slice(0, 10).forEach((p) => say(`  ${p}`));
  if (problems.length > 10) say(`  … ${problems.length - 10}건 더 — \`node ${path.join(WD, 'app', 'core', 'doclint.js')} <파일>\``);
}

function run(argv, cwd = process.cwd()) {
  const { flags, rest } = parseArgs(argv);
  const [cmd, ...args] = rest;
  if (flags.help || cmd === 'help') { say(USAGE); return; }
  if (rest.some((a) => /[\r\n]/.test(a))) stop('인자에 줄바꿈이 있다 → 한 줄로 준다. 여러 줄은 인자를 나눠 준다');
  const project = flags.project || projectName(cwd);
  if (!/^[\w.-]+$/.test(project) || /^\.+$/.test(project)) stop(`프로젝트 이름 \`${project}\`의 모양이 틀렸다 → 폴더 이름만 준다(경로 아님)`);
  const idArg = cmd === 'issue' ? (args[0] !== 'add' ? args[1] : undefined) : (['start', 'done', 'wait', 'hold', 'drop', 'section', 'reopen', 'memo', 'extra'].includes(cmd) ? args[0] : undefined);
  if (idArg != null && !(cmd === 'issue' ? ISSUE_ID : ITEM_ID).test(idArg)) stop(`ID \`${idArg}\`의 모양이 틀렸다 → ${cmd === 'issue' ? '`<항목 ID>#<번호>` 또는 `ISS-<번호>`' : '`<접두어>-<번호>`'}`);
  if (flags.parent && flags.parent !== 'ISS' && !ITEM_ID.test(flags.parent)) stop(`부모 \`${flags.parent}\`의 모양이 틀렸다 → 로드맵 항목 ID 또는 \`ISS\``);
  if (!cmd || cmd === 'status' || cmd === 'next') cmdStatus(project);
  else if (cmd === 'show') { if (!args[0]) stop('쓰는 법: `show <ID|이슈 ID|M번호>`'); cmdShow(project, args[0]); }
  else if (cmd === 'flow') flowfind.show(project, args).forEach(say);
  else if (cmd === 'start') { if (!args[0]) stop('쓰는 법: `start <ID>`'); cmdStart(project, args[0], flags); }
  else if (cmd === 'done') { if (!args[0]) stop('쓰는 법: `done <ID>`'); cmdDone(project, args[0], flags); }
  else if (cmd === 'add') cmdAdd(project, args, flags);
  else if (cmd === 'milestone') cmdMilestone(project, args, flags);
  else if (cmd === 'wait' || cmd === 'hold' || cmd === 'drop') cmdPark(project, cmd, args, flags);
  else if (cmd === 'extra') { if (!args[0]) stop('쓰는 법: `extra <ID>`'); cmdExtra(project, args[0]); }
  else if (cmd === 'reopen') { if (!args[0]) stop('쓰는 법: `reopen <ID>`'); cmdReopen(project, args[0]); }
  else if (cmd === 'memo') cmdMemo(project, args);
  else if (cmd === 'section') cmdSection(project, args, flags);
  else if (cmd === 'issue') {
    const [sub, ...a] = args;
    if (!sub) cmdIssueList(project);
    else if (sub === 'add') cmdIssueAdd(project, a, flags);
    else if (sub === 'start') { if (!a[0]) stop('쓰는 법: `issue start <ID>`'); cmdIssueStart(project, a, flags); }
    else if (sub === 'resolve' || sub === 'close') cmdIssueEnd(project, sub, a, flags);
    else stop(`모르는 이슈 동작 \`${sub}\` → add | start | resolve | close`);
  } else stop(`모르는 동작 \`${cmd}\` → \`item.js --help\``);
}

if (require.main === module) {
  let code = 0;
  try { run(process.argv.slice(2)); } catch (e) {
    if (!(e instanceof Stop)) throw e;
    say(`막았다: ${e.message}`);
    code = 1;
  }
  report();
  process.stdout.write(`${out.join('\n')}\n`);
  process.exitCode = code;
}

module.exports = { run, USAGE };
