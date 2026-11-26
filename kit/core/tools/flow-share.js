#!/usr/bin/env node
// 흐름 공유 페이지 만들기: templates/flow-map.html + flows/<프로젝트>.share.json → 한 장짜리 HTML
// 사용법: node ~/.work-dash/app/core/tools/flow-share.js <프로젝트> [출력 경로]   (출력 기본값: flows/<프로젝트>.share.html)
// 검사: 모듈 · 선 · 시퀀스 참조가 맞는지, 팀에 보일 페이지에 개인 경로 · 개인 로드맵/이슈 ID · 브랜치 이름이 없는지. 하나라도 걸리면 만들지 않는다.
//
// 데이터 형식 (JSON):
// {
//   "title": "페이지 이름 (탭 · 갤러리 이름, 2~4단어)",
//   "lead": "머리 설명 한두 문장", "basis": "코드 기준 한 줄", "foot": "맨 아래 안내 (선택)",
//   "modes": [{"id":"now","label":"지금"},{"id":"target","label":"목표"}],      // 1개면 토글이 숨는다
//   "modules": {"<id>": {"label":"cart","sub":"부제 (선택)","color":1,"desc":"모듈 설명"}},  // color 1~4 = 내 모듈(색 상자), 없으면 바깥 모듈
//   "layout": {"<id>": [x, y]},                     // 1000×630 지도 안 중심 좌표 (선택, 없으면 자동 배치)
//   "boxes": {"<mode>": [{"label":"cart 스키마","around":["cart"],"color":1,"labelAt":"top|bottom","pad":24}]},  // 스키마 · 배포 경계
//   "edges": {"<mode>": [{"f":"order","t":"cart","k":"sync|sametx|after|broker|broken","label":"짧은 이름","detail":"설명","change":"진행 중 변화 (선택)","status":"done|planned|talk (선택)"}]},
//   "summary": {"<mode>": {"title":"..","sub":"..","points":[".."]}},
//   "kindLabels": {"broker":"Kafka 토픽 (아웃박스 경유)"}, "statusLabels": {"done":"..","planned":"..","talk":".."},
//   "scenarios": [{"id":"personal","name":"개인구매","note":{"<mode>":"한 줄 설명"},
//                  "<mode>": {"parts":[{"id":"B","label":"구매자","mod":"actor|broker|<모듈 id>"}],
//                             "steps":[{"f":"B","t":"C","k":"sync","x":"메시지"},{"note":["C","O"],"tx":true,"x":"트랜잭션 경계 설명"}]}}]
// }
const fs = require('fs');
const path = require('path');

const { WD: ROOT } = require('../paths');   // 데이터(flows · roadmaps · issues)
const TEMPLATES = path.join(__dirname, '..', 'templates');   // 템플릿은 저장소 안
const FDIR = path.join(ROOT, 'flows');
const KINDS = ['sync', 'sametx', 'after', 'broker', 'broken'];

function idsOf(file, re) {
  try { return [...fs.readFileSync(file, 'utf8').matchAll(re)].map((m) => m[1]); } catch { return []; }
}

function check(data, project) {
  const errs = [];
  const mods = data.modules || {};
  const modes = (data.modes && data.modes.length ? data.modes : [{ id: 'now' }]).map((m) => m.id);
  if (!data.title) errs.push('title이 없다');
  if (!Object.keys(mods).length) errs.push('modules가 비었다');
  for (const [id, m] of Object.entries(mods)) if (m.color != null && ![1, 2, 3, 4].includes(m.color)) errs.push(`modules.${id}.color는 1~4`);
  for (const mode of modes) (data.edges?.[mode] || []).forEach((e, i) => {
    const at = `edges.${mode}[${i}]`;
    if (!mods[e.f]) errs.push(`${at}.f "${e.f}" 모듈 없음`);
    if (!mods[e.t]) errs.push(`${at}.t "${e.t}" 모듈 없음`);
    if (!KINDS.includes(e.k)) errs.push(`${at}.k "${e.k}"는 ${KINDS.join(' | ')} 중 하나`);
    if (!e.label) errs.push(`${at}.label 없음`);
  });
  for (const mode of modes) (data.boxes?.[mode] || []).forEach((b, i) => (b.around || []).forEach((id) => { if (!mods[id]) errs.push(`boxes.${mode}[${i}] "${id}" 모듈 없음`); }));
  (data.scenarios || []).forEach((s, si) => modes.forEach((mode) => {
    const d = s[mode]; if (!d) return;
    const parts = new Map((d.parts || []).map((p) => [p.id, p]));
    for (const p of d.parts || []) if (!['actor', 'broker'].includes(p.mod) && !mods[p.mod]) errs.push(`scenarios[${si}].${mode} 참여자 ${p.id}의 mod "${p.mod}"가 actor · broker · 모듈 id가 아님`);
    (d.steps || []).forEach((st, i) => {
      const at = `scenarios[${si}].${mode}.steps[${i}]`;
      const refs = st.note ? st.note : [st.f, st.t];
      for (const r of refs) if (!parts.has(r)) errs.push(`${at} 참여자 "${r}" 없음`);
      if (!st.note && !KINDS.includes(st.k)) errs.push(`${at}.k "${st.k}"`);
    });
  }));
  // 팀에 보일 페이지: 개인 경로 · 개인 로드맵/이슈 ID · 브랜치 · 세션 흔적 금지
  const text = JSON.stringify(data);
  const leaks = [];
  for (const p of ['/Users/', '~/', '.work-dash', 'worklogs', 'claude/', 'worktree-', 'local_']) if (text.includes(p)) leaks.push(p);
  const ids = new Set([
    ...idsOf(path.join(ROOT, 'roadmaps', `${project}.md`), /^\s*- \[[ x~!>-]\] ([A-Z][A-Z0-9]*-\d+)/gm),
    ...idsOf(path.join(ROOT, 'issues', `${project}.md`), /^\s*- \[[ x~-]\] ([A-Z][A-Z0-9]*-\d+(?:#\d+)?)/gm),
  ]);
  for (const id of ids) if (new RegExp(`(^|[^A-Za-z0-9])${id.replace('#', '\\#')}(?![0-9#])`).test(text)) leaks.push(id);
  if (leaks.length) errs.push(`개인용 표기가 들어 있다(팀 공유 페이지에서 빼야 함): ${[...new Set(leaks)].join(', ')}`);
  return errs;
}

function build(project, out) {
  const src = path.join(FDIR, `${project}.share.json`);
  const data = JSON.parse(fs.readFileSync(src, 'utf8'));
  const errs = check(data, project);
  if (errs.length) { console.error(`만들지 않았다 (${src}):\n- ` + errs.join('\n- ')); process.exit(1); }
  const tpl = fs.readFileSync(path.join(TEMPLATES, 'flow-map.html'), 'utf8');
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const json = JSON.stringify(data).replace(/</g, '\\u003c');
  const html = tpl.replace('__TITLE__', esc(data.title)).replace('__DATA__', () => json);
  const stray = ['/Users/', '.work-dash', 'worklogs', 'claude/', 'worktree-'].filter((p) => html.includes(p));
  if (stray.length) { console.error('만들지 않았다: 템플릿 · 데이터에 개인 경로가 남아 있다: ' + stray.join(', ')); process.exit(1); }
  const dest = out || path.join(FDIR, `${project}.share.html`);
  fs.writeFileSync(dest, html);
  return dest;
}

if (require.main === module) {
  const [project, out] = process.argv.slice(2);
  if (!project) { console.error('사용법: node flow-share.js <프로젝트> [출력 경로]'); process.exit(2); }
  console.log(build(project, out));
}
module.exports = { build, check };
