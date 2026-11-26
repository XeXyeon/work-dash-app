#!/usr/bin/env node
// 문서 린터: ~/.work-dash의 로드맵 · 이슈 · 작업 카드 형식 검사
//
//   node core/doclint.js                 모든 로드맵 · 이슈 · 작업 카드를 검사한다
//   node core/doclint.js <파일> …        그 파일만 검사한다
//   node core/doclint.js --summary       규칙별 개수와 파일별 개수만 보인다
//
// 위반이 있으면 종료 코드 1, 파서가 읽지 못한 문서가 있으면 2.
const fs = require('fs');
const path = require('path');
const { WD } = require('./paths');
const roadmapParser = require('./roadmap');
const issueParser = require('./issues');
const { projectOfKey } = require('./projects');

const RDIR = path.join(WD, 'roadmaps');
const IDIR = path.join(WD, 'issues');
const CDIR = path.join(WD, 'worklogs');

const ID_RE = /^[A-Z][A-Z0-9]*-\d+$/;
const AGENT = '(claude|gpt)';
const DT = '\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}';
const SLACK_MS = 2 * 60e3;
const PREFIX_MIN_MILESTONES = 5;

const ROADMAP_ITEM = /^- \[(.)\] (\S+)(?: (.*))?$/;
const MILESTONE = /^## M\d+\. (\S.*?)(?: \(~[^)\s]+\))?$/;
const MEMO_PREFIX = [
  /^결정\(\d{4}-\d{2}-\d{2}\): /,
  /^재설계\(\d{4}-\d{2}-\d{2}[^)]*\): /,
  /^[A-Z][A-Z0-9]*-\d+에서 교체: /,
  /^대기: /, /^협의: /, /^확인 필요: /, /^연결: /, /^리뷰 반영: /,
];
const ROADMAP_STATES = ' x~!>-';

const ISSUE_LINE = /^- \[(.)\] (\S+) (.*)$/;
const ISSUE_ID = /^([A-Z][A-Z0-9]*-\d+#\d+|ISS-\d+)$/;
const SEVERITY = ['높음', '중간', '낮음'];
const KINDS = ['버그', '질문', '개선', '설정', '기술부채'];
const ISSUE_STATES = ' x~-';

const STD_SECTIONS = ['무엇을 했나', '왜 이렇게 했나', '바뀐 것', 'API · 스키마 상세', '막혔던 문제와 해결', '검증', '리뷰 결과', '학습 노트', '주의 · 남은 일'];
const DEF_SECTIONS = ['코드에서 확인한 사실', '제안', '정의서', '확인하지 못한 가정', '열린 질문', '확정 사항', '방향 전환'];

const STAMP = /\s+✓~?\d{4}-\d{2}-\d{2} \d{2}:\d{2}\s*$/;
const TAG = /\s+@([A-Za-z][\w-]*)\s*$/;
const REF_RE = /(?<![\w:./#-])(?:([A-Za-z][A-Za-z0-9_]*):)?([A-Z][A-Z0-9]*-\d+)(#\d+)?(?![\w-])/g;

function stripTail(text) {
  let rest = text, owner = '', stamp = false, t;
  while ((t = rest.match(TAG)) || (t = rest.match(STAMP))) {
    if (t[0].includes('✓')) stamp = true; else owner = t[1];
    rest = rest.slice(0, t.index);
  }
  return { rest, owner, stamp };
}

const listMd = (dir) => { try { return fs.readdirSync(dir).filter((n) => n.endsWith('.md')).sort(); } catch { return []; } };
const read = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return null; } };

function buildIndex() {
  const projects = new Map();
  const get = (p) => projects.get(p) || projects.set(p, { items: new Set(), issues: new Set(), prefixes: new Set() }).get(p);
  for (const n of listMd(RDIR)) {
    const p = get(n.replace(/\.md$/, ''));
    for (const line of (read(path.join(RDIR, n)) || '').split('\n')) {
      const m = line.match(/^- \[.\] ([A-Z][A-Z0-9]*-\d+)\b/);
      if (m) { p.items.add(m[1]); p.prefixes.add(m[1].split('-')[0]); }
    }
  }
  for (const n of listMd(IDIR)) {
    const p = get(n.replace(/\.md$/, ''));
    for (const line of (read(path.join(IDIR, n)) || '').split('\n')) {
      const m = line.match(/^- \[.\] (\S+)/);
      if (m && ISSUE_ID.test(m[1])) { p.issues.add(m[1]); if (m[1].startsWith('ISS-')) p.prefixes.add('ISS'); }
    }
  }
  return projects;
}

function refProblem(index, project, key, id, hash) {
  let target = project;
  if (key) {
    target = projectOfKey(key, [...index.keys()]);
    if (!target || !index.has(target)) return null;
  }
  const p = index.get(target);
  if (!p) return null;
  const prefix = id.split('-')[0];
  if (!p.prefixes.has(prefix)) return null;
  const where = key ? `${target} 로드맵` : '이 프로젝트 로드맵';
  if (prefix === 'ISS' || hash) {
    const full = id + (hash || '');
    if (!p.issues.has(full)) return `없는 이슈 ID \`${key ? key + ':' : ''}${full}\`를 가리킨다 → ${key ? target : '이 프로젝트'} 이슈 파일에 있는 ID로 고치거나, 이슈를 먼저 적은 뒤 가리킨다`;
    return null;
  }
  if (!p.items.has(id)) return `없는 항목 ID \`${key ? key + ':' : ''}${id}\`를 가리킨다 → ${where}에 있는 ID로 고치거나, 항목을 먼저 로드맵에 잡은 뒤 가리킨다(로드맵에 없는 큰 작업은 사용자에게 물어 추가한다)`;
  return null;
}

const TECH_NAMES = new Set(['UTF', 'SHA', 'AES', 'RSA', 'ISO', 'RFC', 'HTTP', 'TLS', 'SSL', 'MD', 'GPT', 'CVE', 'ES', 'H']);
const SCHEME_MIN = 3;

function checkScheme(out, index, project, lines) {
  const known = (index.get(project) || {}).prefixes;
  if (!known) return;
  const found = new Map();
  let fence = false;
  lines.forEach((line, i) => {
    if (/^\s*```/.test(line)) { fence = !fence; return; }
    if (fence || i === 0) return;
    for (const m of line.replace(/`[^`]*`/g, '').matchAll(REF_RE)) {
      if (m[1] || m[3]) continue;
      const [prefix, num] = m[2].split('-');
      if (known.has(prefix) || prefix === 'ISS' || TECH_NAMES.has(prefix)) continue;
      if (!found.has(prefix)) found.set(prefix, { nums: new Set(), lines: new Set() });
      found.get(prefix).nums.add(num);
      found.get(prefix).lines.add(i + 1);
    }
  });
  for (const [prefix, f] of found) {
    if (f.nums.size < SCHEME_MIN) continue;
    for (const line of f.lines) out.push({ line, rule: 'id-scheme', message: `로드맵에 없는 접두어 \`${prefix}-\`로 번호를 ${f.nums.size}개 매겼다 → 번호 체계를 새로 만들지 않는다. 결정 · 문제는 번호 없이 카드 절 안에 쓰고, 가리킬 때는 로드맵 항목 ID나 이슈 ID를 쓴다. 다른 프로젝트의 항목이면 \`<접두어>:<ID>\`로, 제품 · 규격 이름이면 백틱으로 감싼다` });
  }
}

const MD_LINK_RE = /\[([^\]`]+)\]\((?![A-Za-z][\w+.-]*:|\/\/|[\d\/.-]+\))([^)\s]*(?:\/|\.md|#)[^)\s]*)\)/g;
const CARD_PATH_RE = /(?<![\w.~\/-])(?:[\w.~-]*\/)*worklogs\/[^\s"'`)<\/]+\/([A-Z][A-Z0-9]*-\d+)\.md/g;

function checkPointers(out, text) {
  let fence = false;
  text.split('\n').forEach((raw, i) => {
    if (/^\s*```/.test(raw)) { fence = !fence; return; }
    if (fence) return;
    const line = raw.replace(/`[^`]*`/g, '');
    for (const m of line.matchAll(MD_LINK_RE)) out.push({ line: i + 1, rule: 'pointer-link', message: `Markdown 링크 \`[${m[1]}](${m[2]})\`로 다른 문서를 가리킨다 → 링크를 지우고 정해진 모양으로 쓴다: 항목 · 이슈는 ID, 저장소 문서는 저장소 기준 경로(\`docs/erd.md\`). 대시보드가 그 모양을 링크로 바꾼다` });
    for (const m of line.matchAll(CARD_PATH_RE)) out.push({ line: i + 1, rule: 'pointer-link', message: `작업 카드를 파일 경로 \`${m[0]}\`로 가리킨다 → 경로를 지우고 항목 ID \`${m[1]}\`만 쓴다` });
  });
}

function checkRefs(out, index, project, lineNo, text, skip = new Set()) {
  const seen = new Set();
  for (const m of text.matchAll(REF_RE)) {
    const token = m[0];
    if (seen.has(token) || skip.has(token)) continue;
    seen.add(token);
    const msg = refProblem(index, project, m[1], m[2], m[3]);
    if (msg) out.push({ line: lineNo, rule: 'id-ref', message: msg });
  }
}

function lintRoadmap(text, project, index) {
  const out = [];
  const lines = text.split('\n');
  const ids = new Map();
  const byPrefix = new Map();
  let milestones = 0;
  let lastItem = null;
  const finishItem = () => {
    if (!lastItem) return;
    const { state, memos, line } = lastItem;
    if (state === '!' && !memos.some((m) => m.startsWith('대기: ')))
      out.push({ line, rule: 'roadmap-wait-memo', message: '외부 대기 `[!]` 항목에 `대기:` 메모가 없다 → 항목 바로 아래에 4칸 들여 `    대기: <누구> · <무엇>`을 단다' });
    if ((state === '>' || state === '-') && !memos.some((m) => /^결정\(\d{4}-\d{2}-\d{2}\): /.test(m)))
      out.push({ line, rule: 'roadmap-decision-memo', message: `${state === '>' ? '보류 `[>]`' : '취소 `[-]`'} 항목에 결정 메모가 없다 → 항목 바로 아래에 \`    결정(YYYY-MM-DD): ${state === '>' ? '보류' : '하지 않음'} — <이유>\`를 단다(사용자가 정한 것만)` });
    lastItem = null;
  };
  let afterHeading = null;
  lines.forEach((line, i) => {
    const n = i + 1;
    if (afterHeading && line.trim() !== '') {
      if (!/^    완료 기준: \S/.test(line))
        out.push({ line: afterHeading, rule: 'roadmap-criteria', message: '마일스톤 제목 바로 아래에 완료 기준 줄이 없다 → 제목 다음 줄에 `    완료 기준: <해 볼 동작 · 통과할 명령>` 한 줄을 둔다' });
      afterHeading = null;
      if (/^    완료 기준: /.test(line)) return;
    }
    if (/^## /.test(line)) {
      finishItem();
      milestones++;
      if (!MILESTONE.test(line))
        out.push({ line: n, rule: 'roadmap-heading', message: '마일스톤 제목 모양이 틀렸다 → `## M<번호>. <결과 이름>` 또는 `## M<번호>. <결과 이름> (~<마감>)`으로 쓴다. 제목에 `~`를 쓰지 않는다' });
      else if (MILESTONE.exec(line)[1].includes('~'))
        out.push({ line: n, rule: 'roadmap-heading', message: '마일스톤 제목 안에 `~`가 있다 → `~`는 마감 표기로 읽히니 제목에서 뺀다' });
      afterHeading = n;
      return;
    }
    if (/^\s*[-*]\s+\[/.test(line)) {
      finishItem();
      if (/^\s/.test(line) || /^\*/.test(line)) {
        out.push({ line: n, rule: 'roadmap-item', message: '항목 줄은 들여쓰지 않고 `- [ ]`로 시작한다 → 줄 맨 앞을 `- [<상태>] <ID> …`로 고친다' });
        return;
      }
      const { rest, owner } = stripTail(line);
      const m = rest.match(ROADMAP_ITEM);
      if (!m || !ROADMAP_STATES.includes(m[1])) {
        out.push({ line: n, rule: 'roadmap-item', message: '항목의 상태 기호가 틀렸다 → `[ ]` 할 일 · `[~]` 진행 중 · `[x]` 완료 · `[!]` 외부 대기 · `[>]` 보류 · `[-]` 취소 가운데 하나로 쓴다' });
        return;
      }
      const [, state, id, body = ''] = m;
      if (!ID_RE.test(id)) {
        out.push({ line: n, rule: 'roadmap-item', message: `항목에 ID가 없다(\`${id}\`) → 상태 기호 뒤에 \`<접두어>-<번호>\`를 쓴다. 번호는 그 접두어의 최댓값 + 1` });
        return;
      }
      if (ids.has(id)) out.push({ line: n, rule: 'roadmap-dup-id', message: `ID \`${id}\`가 ${ids.get(id)}번 줄에도 있다 → 한 번 붙인 ID는 바꾸지 않으니, 새로 쓴 쪽에 그 접두어의 최댓값 + 1을 붙인다` });
      else ids.set(id, n);
      const prefix = id.split('-')[0];
      if (!byPrefix.has(prefix)) byPrefix.set(prefix, { all: [], todo: [] });
      byPrefix.get(prefix).all.push(n);
      if (state === ' ') byPrefix.get(prefix).todo.push(n);
      if (state === '~' && !/^(claude|gpt)$/.test(owner))
        out.push({ line: n, rule: 'roadmap-owner', message: /\s@(claude|gpt)\b/.test(body) ? '담당 태그가 줄 끝이 아니라 중간에 있다 → `(after: …)` 뒤, 줄 맨 끝으로 옮긴다' : '진행 중 `[~]` 항목 줄 끝에 담당 태그가 없다 → 줄 맨 끝에 `@claude` 또는 `@gpt`를 붙인다' });
      if (state !== '~' && owner)
        out.push({ line: n, rule: 'roadmap-owner', message: `진행 중이 아닌 항목에 담당 태그 \`@${owner}\`가 있다 → 완료 · 대기 · 보류 · 취소로 바꿀 때 태그를 지운다` });
      const after = body.match(/\((?:after|선행)\s*:\s*([^)]*)\)\s*$/);
      const afterTokens = new Set();
      if (after) {
        for (const tok of after[1].split(/[,\s]+/).filter(Boolean)) {
          afterTokens.add(tok);
          const x = tok.match(/^(?:([A-Za-z][A-Za-z0-9_]*):)?([A-Z][A-Z0-9]*-\d+)$/);
          if (!x) { out.push({ line: n, rule: 'roadmap-after', message: `선행 표기 \`${tok}\`를 읽을 수 없다 → \`(after: ID, <접두어>:ID)\` 모양으로 쓴다` }); continue; }
          const msg = refProblem(index, project, x[1], x[2], '') || (!x[1] && !index.get(project)?.items.has(x[2]) ? `선행 \`${x[2]}\`가 이 로드맵에 없다 → 있는 항목 ID로 고친다. 다른 로드맵의 항목이면 \`<접두어>:${x[2]}\`로 쓴다` : null);
          if (msg) out.push({ line: n, rule: 'roadmap-after', message: msg });
        }
      }
      checkRefs(out, index, project, n, body.replace(/\((?:after|선행)\s*:[^)]*\)\s*$/, ''), afterTokens);
      lastItem = { state, line: n, memos: [] };
      return;
    }
    if (/^    \S/.test(line)) {
      const memo = line.slice(4);
      if (!lastItem) {
        out.push({ line: n, rule: 'roadmap-memo', message: '메모 줄이 항목 밑에 있지 않다 → 항목 바로 아래로 옮기거나, 마일스톤 완료 기준이면 제목 바로 아래 한 줄로 둔다' });
      } else {
        lastItem.memos.push(memo);
        if (/^완료 기준: /.test(memo))
          out.push({ line: n, rule: 'roadmap-memo', message: '`완료 기준:`은 마일스톤 제목 바로 아래에만 쓴다 → 항목의 조건이면 `결정(날짜):`이나 `확인 필요:`로 쓴다' });
        else if (!MEMO_PREFIX.some((re) => re.test(memo)))
          out.push({ line: n, rule: 'roadmap-memo', message: '메모 줄이 정해진 머리말로 시작하지 않는다 → `결정(YYYY-MM-DD):` · `재설계(YYYY-MM-DD, 새 ID):` · `<새 ID>에서 교체:` · `대기:` · `협의:` · `확인 필요:` · `연결:` · `리뷰 반영:` 가운데 하나로 시작한다. 긴 근거는 작업 카드에 둔다' });
      }
      checkRefs(out, index, project, n, memo);
      return;
    }
    if (line.trim() && !/^# /.test(line)) finishItem();
  });
  finishItem();
  if (milestones >= PREFIX_MIN_MILESTONES) {
    const total = [...byPrefix.values()].reduce((a, p) => a + p.all.length, 0);
    for (const [prefix, p] of byPrefix) {
      if (p.all.length * 2 <= total) continue;
      out.push({
        line: p.all[0], notice: true, hookLines: p.todo, rule: 'roadmap-prefix-share',
        message: `(알림) 접두어 \`${prefix}\`가 항목 ${total}개 중 ${p.all.length}개로 절반을 넘는다. 접두어가 무엇에 관한 일인지 알려 주지 못한다 → 기존 ID는 고치지 않는다. 새 항목이면 더 좁은 주제의 접두어를 쓰고, 기존 접두어를 나눌지는 사용자에게 묻는다`,
      });
    }
  }
  return out;
}

function lintIssues(text, project, index) {
  const out = [];
  const ids = new Map();
  let inIssue = false;
  text.split('\n').forEach((line, i) => {
    const n = i + 1;
    if (/^\s*[-*]\s+\[/.test(line) && !/^\s{2,}/.test(line)) {
      inIssue = true;
      const { rest, owner } = stripTail(line);
      const m = rest.match(ISSUE_LINE);
      if (!m || !ISSUE_STATES.includes(m[1])) {
        out.push({ line: n, rule: 'issue-line', message: '이슈 줄의 상태 기호가 틀렸다 → `[ ]` 열림 · `[~]` 처리 중 · `[x]` 해결 · `[-]` 닫음 가운데 하나로 `- [<상태>] <ID> [심각도][종류] 제목`처럼 쓴다' });
        return;
      }
      const [, state, id, body] = m;
      if (!ISSUE_ID.test(id)) {
        out.push({ line: n, rule: 'issue-id', message: `이슈 ID \`${id}\`의 모양이 틀렸다 → 로드맵 항목에서 생긴 이슈는 \`<항목 ID>#<번호>\`, 공통 이슈는 \`ISS-<번호>\`로 쓴다` });
        return;
      }
      if (ids.has(id)) out.push({ line: n, rule: 'issue-dup-id', message: `이슈 ID \`${id}\`가 ${ids.get(id)}번 줄에도 있다 → 새로 쓴 쪽에 그 부모 ID의 최댓값 + 1을 붙인다` });
      else ids.set(id, n);
      const lead = [...((body.match(/^(?:\[[^\]]+\]\s*)+/) || [''])[0].matchAll(/\[([^\]]+)\]/g))].map((t) => t[1]);
      if (!lead.some((t) => SEVERITY.includes(t)))
        out.push({ line: n, rule: 'issue-severity', message: 'ID 뒤에 심각도가 없다 → `[높음]` · `[중간]` · `[낮음]` 가운데 하나를 ID 바로 뒤에 쓴다' });
      const kind = lead.find((t) => !SEVERITY.includes(t));
      if (!kind || !KINDS.includes(kind))
        out.push({ line: n, rule: 'issue-kind', message: `종류${kind ? ` \`[${kind}]\`` : ''}가 ${kind ? '정해진 것이 아니다' : '없다'} → 심각도 뒤에 \`[버그]\` · \`[질문]\` · \`[개선]\` · \`[설정]\` · \`[기술부채]\` 가운데 하나를 쓴다` });
      if (state === '~' && !/^(claude|gpt)$/.test(owner))
        out.push({ line: n, rule: 'issue-owner', message: '처리 중 `[~]` 이슈 줄 끝에 담당 태그가 없다 → 줄 맨 끝에 `@claude` 또는 `@gpt`를 붙인다' });
      if (state !== '~' && owner)
        out.push({ line: n, rule: 'issue-owner', message: `처리 중이 아닌 이슈에 담당 태그 \`@${owner}\`가 있다 → 해결하거나 닫을 때 태그를 지운다` });
      if (id.includes('#')) {
        const parent = id.split('#')[0];
        if (!index.get(project)?.items.has(parent))
          out.push({ line: n, rule: 'issue-parent', message: `부모 항목 \`${parent}\`가 이 프로젝트 로드맵에 없다 → 고칠 곳의 로드맵 항목 ID를 부모로 쓰고, 맞는 항목이 없으면 \`ISS-<번호>\`로 적는다` });
      }
      checkRefs(out, index, project, n, body);
      return;
    }
    if (inIssue && /^\s{2,}\S/.test(line)) { checkRefs(out, index, project, n, line); return; }
    if (line.trim()) inIssue = false;
  });
  return out;
}

const normSection = (t) => t.replace(/\s*\(.*$/, '').replace(/\s*·\s*/g, ' · ').replace(/(API) · (스키마)/, '$1 · $2').replace(/\s+\d+$/, '').trim();

function parseDt(s) { const d = new Date(s.replace(' ', 'T')); return isNaN(d) ? null : d.getTime(); }

function lintCard(text, project, id, index, now) {
  const out = [];
  const lines = text.split('\n');
  const h = (lines[0] || '').match(/^# (\S+)(?: (.*))?$/);
  if (!h || !h[2]) out.push({ line: 1, rule: 'card-title', message: '첫 줄이 카드 제목이 아니다 → 첫 줄을 `# <ID> <제목>`으로 쓴다' });
  else if (h[1] !== id) out.push({ line: 1, rule: 'card-title', message: `제목의 ID \`${h[1]}\`가 파일 이름 \`${id}\`와 다르다 → 제목을 \`# ${id} <제목>\`으로 고치거나 파일 이름을 그 ID로 바꾼다` });

  const statusAt = lines.findIndex((l) => /^- 상태:/.test(l));
  if (statusAt !== 1) {
    out.push({ line: statusAt > 0 ? statusAt + 1 : 2, rule: 'card-status', message: '둘째 줄이 상태 줄이 아니다 → 제목 바로 아래에 `- 상태: 진행 중 · @claude · 시작 YYYY-MM-DD HH:MM`을 둔다' });
  }
  if (statusAt >= 0) checkStatus(out, lines[statusAt], statusAt + 1, now);

  let order = -1, phase = 'start', fence = false;
  lines.forEach((line, i) => {
    const n = i + 1;
    if (/^\s*```/.test(line)) { fence = !fence; return; }
    if (fence) return;
    if (i > 0) checkRefs(out, index, project, n, line, new Set(i === 0 ? [id] : []));
    const s = line.match(/^## (.+?)\s*$/);
    if (!s) return;
    const name = normSection(s[1]);
    if (name === '추가 작업') { order = -1; phase = 'extra'; return; }
    if (name === '계획') {
      if (phase !== 'start') out.push({ line: n, rule: 'card-section-order', message: '`## 계획`이 다른 절 뒤에 있다 → 상태 줄 바로 아래 첫 절로 옮긴다. 나중에 더한 계획은 `## 추가 작업 (<날짜>)` 아래에 쓴다' });
      phase = 'plan';
      return;
    }
    if (DEF_SECTIONS.includes(name)) {
      if (order >= 0) out.push({ line: n, rule: 'card-section-order', message: `\`## ${s[1]}\`이 표준 절(\`${STD_SECTIONS[order]}\`) 뒤에 있다 → 정의서 절은 \`계획\`과 \`무엇을 했나\` 사이에 진행 순서대로 둔다. 완료 뒤에 이어 쓰면 \`## 추가 작업 (<날짜>)\` 아래에 둔다` });
      phase = 'def';
      return;
    }
    const k = STD_SECTIONS.indexOf(name);
    if (k < 0) {
      out.push({ line: n, rule: 'card-section', message: `정해지지 않은 절 \`## ${s[1]}\` → 내용을 표준 절(${STD_SECTIONS.join(' · ')}) 가운데 맞는 곳에 넣는다. 정의서 카드면 ${DEF_SECTIONS.join(' · ')} 가운데 맞는 것을 쓴다. 작은 제목이 필요하면 \`###\`로 그 절 안에 둔다` });
      return;
    }
    if (k < order) out.push({ line: n, rule: 'card-section-order', message: `\`## ${STD_SECTIONS[k]}\`이 \`## ${STD_SECTIONS[order]}\` 뒤에 있다 → 순서는 ${STD_SECTIONS.join(' → ')}이다` });
    else order = k;
  });
  checkScheme(out, index, project, lines);
  return out;
}

function checkStatus(out, line, n, now) {
  const m = line.match(/^- 상태: (진행 중|검토 대기|완료|취소) · (.*?)\s*$/);
  if (!m) {
    out.push({ line: n, rule: 'card-status', message: '상태 줄의 상태가 틀렸다 → `진행 중` · `검토 대기` · `완료` 가운데 하나를 `- 상태: ` 바로 뒤에 쓰고 ` · `로 잇는다' });
    return;
  }
  const [, state, rest] = m;
  let end = null, start = null, startRaw = null;
  if (state === '진행 중') {
    const r = rest.match(new RegExp(`^@${AGENT} · 시작 (${DT})(?: \\(.*\\))?$`));
    if (!r) { out.push({ line: n, rule: 'card-status', message: '진행 중 상태 줄 모양이 틀렸다 → `- 상태: 진행 중 · @claude · 시작 YYYY-MM-DD HH:MM`으로 쓴다. 시각은 `date "+%Y-%m-%d %H:%M"`로 확인한 실제 시각이다' }); return; }
    start = parseDt(r[2]);
  } else {
    const r = rest.match(new RegExp(`^(${DT}) · @${AGENT} · 시작 ((?:\\d{4}-\\d{2}-\\d{2} )?\\d{2}:\\d{2})(?: \\(.*\\))?$`));
    if (!r) { out.push({ line: n, rule: 'card-status', message: `${state} 상태 줄 모양이 틀렸다 → \`- 상태: ${state} · YYYY-MM-DD HH:MM · @claude · 시작 HH:MM\`으로 쓴다(날을 넘겼으면 \`시작 YYYY-MM-DD HH:MM\`). 시각은 \`date "+%Y-%m-%d %H:%M"\`로 확인한 실제 시각이다` }); return; }
    end = parseDt(r[1]);
    startRaw = r[3];
    start = parseDt(startRaw.length > 5 ? startRaw : `${r[1].slice(0, 10)} ${startRaw}`);
  }
  const fix = '`date "+%Y-%m-%d %H:%M"`로 지금 시각을 확인해 실제 시각으로 고친다';
  if (end != null && end > now + SLACK_MS) out.push({ line: n, rule: 'card-time', message: `${state} 시각이 지금보다 뒤다 → ${fix}` });
  if (start != null && start > now + SLACK_MS) out.push({ line: n, rule: 'card-time', message: `시작 시각이 지금보다 뒤다 → ${fix}` });
  if (end != null && start != null && start > end)
    out.push({ line: n, rule: 'card-time', message: `시작 시각이 ${state} 시각보다 뒤다 → 두 시각을 실제 시각으로 고친다. 날을 넘겨 끝났으면 \`시작 YYYY-MM-DD HH:MM\`처럼 시작에 날짜를 붙인다` });
}

function kindOf(file) {
  const rel = path.relative(WD, file);
  const parts = rel.split(path.sep);
  if (parts.length === 2 && parts[0] === 'roadmaps' && parts[1].endsWith('.md')) return { kind: 'roadmap', project: parts[1].slice(0, -3) };
  if (parts.length === 2 && parts[0] === 'issues' && parts[1].endsWith('.md')) return { kind: 'issues', project: parts[1].slice(0, -3) };
  if (parts.length === 3 && parts[0] === 'worklogs' && parts[2].endsWith('.md')) {
    const id = parts[2].slice(0, -3);
    return ID_RE.test(id) ? { kind: 'card', project: parts[1], id } : null;
  }
  return null;
}

function resolveInWd(file) {
  const abs = path.resolve(file);
  let real = abs;
  try { real = path.join(fs.realpathSync(path.dirname(abs)), path.basename(abs)); } catch {}
  let wd = WD;
  try { wd = fs.realpathSync(WD); } catch {}
  return real.startsWith(wd + path.sep) ? path.join(WD, path.relative(wd, real)) : abs;
}

function parserProblems(kind, text, project) {
  const lines = text.split('\n');
  try {
    if (kind === 'roadmap') {
      const r = roadmapParser.parse(text, project);
      const parsed = new Set(r.milestones.flatMap((m) => m.items.map((it) => it.id)).filter(Boolean));
      return lines.flatMap((l, i) => {
        const m = l.match(/^- \[[ x~!>-]\] ([A-Z][A-Z0-9]*-\d+)\b/);
        return m && !parsed.has(m[1]) ? [{ line: i + 1, message: `파서가 항목 \`${m[1]}\`를 읽지 못했다` }] : [];
      });
    }
    if (kind === 'issues') {
      const r = issueParser.parse(text, project);
      const parsed = new Set(r.issues.map((x) => x.id));
      return lines.flatMap((l, i) => {
        const m = l.match(/^- \[[ x~-]\] ([A-Z][A-Z0-9]*-\d+#\d+|ISS-\d+) /);
        return m && !parsed.has(m[1]) ? [{ line: i + 1, message: `파서가 이슈 \`${m[1]}\`를 읽지 못했다` }] : [];
      });
    }
  } catch (e) {
    return [{ line: 0, message: `파서가 예외를 냈다: ${e.message}` }];
  }
  return [];
}

function lintFile(file, { text, index, now = Date.now() } = {}) {
  const abs = resolveInWd(file);
  const k = kindOf(abs);
  if (!k) return null;
  if (!index) index = buildIndex();
  if (text == null) text = read(abs);
  if (text == null) return { file: abs, ...k, problems: [], parser: [{ line: 0, message: '파일을 읽지 못했다' }] };
  let problems;
  if (k.kind === 'roadmap') problems = lintRoadmap(text, k.project, index);
  else if (k.kind === 'issues') problems = lintIssues(text, k.project, index);
  else problems = lintCard(text, k.project, k.id, index, now);
  checkPointers(problems, text);
  problems.sort((a, b) => a.line - b.line);
  return { file: abs, ...k, problems, parser: parserProblems(k.kind, text, k.project) };
}

function allFiles() {
  const files = [];
  for (const n of listMd(RDIR)) files.push(path.join(RDIR, n));
  for (const n of listMd(IDIR)) files.push(path.join(IDIR, n));
  let dirs = [];
  try { dirs = fs.readdirSync(CDIR, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort(); } catch {}
  for (const d of dirs) for (const n of listMd(path.join(CDIR, d))) files.push(path.join(CDIR, d, n));
  return files;
}

const format = (r, p) => `${path.relative(WD, r.file)}:${p.line} [${p.rule}] ${p.message}`;

function main(argv) {
  const summary = argv.includes('--summary');
  const args = argv.filter((a) => !a.startsWith('--'));
  const index = buildIndex();
  const files = args.length ? args : allFiles();
  const results = [];
  let skipped = 0;
  for (const f of files) {
    const r = lintFile(f, { index });
    if (r) results.push(r); else skipped++;
  }
  const problems = results.flatMap((r) => r.problems.map((p) => ({ r, p })));
  const parser = results.flatMap((r) => r.parser.map((p) => ({ r, p })));
  if (summary) {
    const byRule = {}, byFile = {};
    for (const { r, p } of problems) {
      byRule[p.rule] = (byRule[p.rule] || 0) + 1;
      const key = `${r.kind}:${r.project}`;
      byFile[key] = (byFile[key] || 0) + 1;
    }
    console.log(`검사한 파일 ${results.length}개 · 건너뜀 ${skipped}개 · 위반 ${problems.length}건 · 파서 문제 ${parser.length}건`);
    for (const [k, v] of Object.entries(byRule).sort((a, b) => b[1] - a[1])) console.log(`  ${k}\t${v}`);
    console.log('');
    for (const [k, v] of Object.entries(byFile).sort((a, b) => b[1] - a[1])) console.log(`  ${k}\t${v}`);
  } else {
    for (const { r, p } of problems) console.log(format(r, p));
  }
  for (const { r, p } of parser) console.log(`[파서] ${path.relative(WD, r.file)}:${p.line} ${p.message}`);
  return parser.length ? 2 : problems.some(({ p }) => !p.notice) ? 1 : 0;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = {
  lintFile, buildIndex, kindOf, resolveInWd, format, normSection,
  ROADMAP_ITEM, MILESTONE, ISSUE_LINE, ISSUE_ID, SEVERITY, KINDS, STD_SECTIONS, DEF_SECTIONS, STAMP, TAG, DT,
};
