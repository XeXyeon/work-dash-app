import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ITEM = path.join(REPO, 'core', 'item.js');
const DOCLINT = path.join(REPO, 'core', 'doclint.js');

function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wd-item-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const wd = path.join(root, 'data');
  const cwd = path.join(root, 'demo');
  for (const d of ['roadmaps', 'issues', 'worklogs/demo']) fs.mkdirSync(path.join(wd, d), { recursive: true });
  fs.mkdirSync(cwd);
  fs.writeFileSync(path.join(wd, 'roadmaps', 'demo.md'), [
    '# demo 로드맵', '',
    '## M1. 장바구니 공유', '    완료 기준: 공유 링크로 같은 장바구니를 본다',
    '- [x] CART-1 장바구니 엔티티 ✓2026-11-01 10:00',
    '- [ ] CART-2 공유 API (after: CART-1)',
    '- [ ] CART-3 링크 만료 (after: CART-2)',
    '- [~] CART-4 공유 화면 @gpt', '',
    '## M2. 주문 취소', '    완료 기준: 취소하면 재고가 돌아온다',
    '- [x] ORD-1 주문 취소 API ✓2026-11-02 10:00', '',
  ].join('\n'));
  const env = { ...process.env, WORK_DASH_DIR: wd };
  delete env.CLAUDECODE;
  delete env.WORK_DASH_AGENT;
  const node = (script, args) => {
    const r = spawnSync(process.execPath, [script, ...args], { cwd, env, encoding: 'utf8' });
    return { code: r.status, out: r.stdout + r.stderr };
  };
  return {
    wd,
    item: (...args) => node(ITEM, [...args, '--as', 'claude']),
    lint: () => node(DOCLINT, []),
    read: (rel) => fs.readFileSync(path.join(wd, rel), 'utf8'),
    write: (rel, text) => fs.writeFileSync(path.join(wd, rel), text),
  };
}

function fillCard(text) {
  return text.split('\n')
    .filter((l) => !/^### <채울 것/.test(l) && !/^- (쉽게 말하면|정확히는|왜 여기서 필요했나|대안과 비교|우리 코드에서|흔한 함정|스스로 확인할 질문): </.test(l))
    .map((l) => l.replace(/<채울 것: [^>]*>/g, '확인한 내용'))
    .join('\n');
}

test('start는 항목을 잡고 형식에 맞는 카드를 만든다', (t) => {
  const s = setup(t);
  const r = s.item('start', 'CART-2');
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /커밋: 끝에 한 번이 아니라 단위.*하나 끝날 때마다/);
  assert.match(s.read('roadmaps/demo.md'), /^- \[~\] CART-2 공유 API \(after: CART-1\) @claude$/m);
  const card = s.read('worklogs/demo/CART-2.md').split('\n');
  assert.equal(card[0], '# CART-2 공유 API');
  assert.match(card[1], /^- 상태: 진행 중 · @claude · 시작 \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  assert.equal(card[3], '## 계획 (시작할 때 작성)');
  assert.match(card[7], /^- 관련 항목: 선행 CART-1$/);
  assert.equal(s.lint().code, 0, s.lint().out);
});

test('start는 남이 잡은 항목과 선행이 안 끝난 항목을 막는다', (t) => {
  const s = setup(t);
  const before = s.read('roadmaps/demo.md');
  const other = s.item('start', 'CART-4');
  assert.equal(other.code, 1);
  assert.match(other.out, /@gpt가 잡고 있다/);
  const blocked = s.item('start', 'CART-3');
  assert.equal(blocked.code, 1);
  assert.match(blocked.out, /선행 `CART-2`/);
  assert.equal(s.read('roadmaps/demo.md'), before);
  assert.equal(s.item('start', 'CART-3', '--force').code, 0);
  assert.match(s.read('roadmaps/demo.md'), /^- \[~\] CART-3 .* @claude$/m);
});

test('done은 카드가 비어 있으면 막고, 채운 뒤에는 완료로 바꾼다', (t) => {
  const s = setup(t);
  s.item('start', 'CART-2');
  const first = s.item('done', 'CART-2');
  assert.equal(first.code, 1);
  assert.match(first.out, /완료로 바꾸지 않았다/);
  assert.match(s.read('roadmaps/demo.md'), /^- \[~\] CART-2 /m);
  const card = s.read('worklogs/demo/CART-2.md');
  for (const name of ['무엇을 했나', '왜 이렇게 했나', '바뀐 것', '검증', '리뷰 결과', '학습 노트', '주의 · 남은 일']) assert.ok(card.includes(`\n## ${name}\n`), `${name} 절이 없다`);
  assert.equal(s.lint().code, 0, s.lint().out);

  s.write('worklogs/demo/CART-2.md', fillCard(card) + '- 틀의 `<채울 것: …>` 표시를 글로 가리키는 줄은 막지 않는다\n');
  const second = s.item('done', 'CART-2');
  assert.equal(second.code, 0, second.out);
  assert.match(s.read('roadmaps/demo.md'), /^- \[x\] CART-2 공유 API \(after: CART-1\)$/m);
  assert.match(s.read('worklogs/demo/CART-2.md').split('\n')[1], /^- 상태: 검토 대기 · \d{4}-\d{2}-\d{2} \d{2}:\d{2} · @claude · 시작 \d{2}:\d{2} \(약 \d+분\)$/);
  assert.match(second.out, /새로 시작할 수 있는 항목: CART-3/);
  assert.equal(s.lint().code, 0, s.lint().out);

  const third = s.item('done', 'CART-2', '--committed', '--commit', 'a1b2c3d feat: 공유 API');
  assert.equal(third.code, 0, third.out);
  assert.match(s.read('worklogs/demo/CART-2.md').split('\n')[1], /^- 상태: 완료 · /);
  assert.match(s.read('worklogs/demo/CART-2.md'), /\n- 커밋: `a1b2c3d` feat: 공유 API\n/);
  assert.equal(s.lint().code, 0, s.lint().out);
});

test('add · milestone · wait · hold · drop은 정해진 줄을 넣는다', (t) => {
  const s = setup(t);
  const add = s.item('add', 'M1', '공유 취소 (링크 삭제)', '--after', 'CART-2');
  assert.equal(add.code, 0, add.out);
  const lines = s.read('roadmaps/demo.md').split('\n');
  assert.equal(lines[lines.indexOf('- [~] CART-4 공유 화면 @gpt') + 1], '- [ ] CART-5 공유 취소 (링크 삭제) (after: CART-2)');
  const reopen = s.item('add', 'M2', '취소 사유 기록');
  assert.match(reopen.out, /M2을 다시 연다/);
  assert.match(s.read('roadmaps/demo.md'), /^- \[ \] ORD-2 취소 사유 기록$/m);
  assert.equal(s.item('add', 'M9', '없는 곳').code, 1);

  assert.equal(s.item('milestone', '환불', '환불 요청이 결제사에 전달된다', '--due', '12/01').code, 0);
  assert.match(s.read('roadmaps/demo.md'), /\n## M3\. 환불 \(~12\/01\)\n {4}완료 기준: 환불 요청이 결제사에 전달된다\n/);
  assert.equal(s.item('add', 'M3', '환불 API', '--prefix', 'RFD').code, 0);

  assert.equal(s.item('wait', 'CART-5', '결제 담당자 · 환불 API').code, 0);
  assert.equal(s.item('hold', 'ORD-2', '다음 분기로 미룸').code, 0);
  assert.equal(s.item('drop', 'RFD-1', '결제사가 직접 처리').code, 0);
  assert.equal(s.item('wait', 'CART-3').code, 1);
  const text = s.read('roadmaps/demo.md');
  assert.match(text, /^- \[!\] CART-5 .*\n {4}대기: 결제 담당자 · 환불 API$/m);
  assert.match(text, /^- \[>\] ORD-2 .*\n {4}결정\(\d{4}-\d{2}-\d{2}\): 보류 — 다음 분기로 미룸$/m);
  assert.match(text, /^- \[-\] RFD-1 .*\n {4}결정\(\d{4}-\d{2}-\d{2}\): 하지 않음 — 결제사가 직접 처리$/m);
  assert.equal(s.lint().code, 0, s.lint().out);
});

test('section은 정의서 절을 표준 절 앞에 순서대로 넣는다', (t) => {
  const s = setup(t);
  s.item('start', 'CART-2');
  s.item('done', 'CART-2');
  assert.equal(s.item('section', 'CART-2', '확정 사항', '- 링크는 7일 뒤 만료').code, 0);
  assert.equal(s.item('section', 'CART-2', '확정 사항', '- 만료된 링크는 410').code, 0);
  assert.equal(s.item('section', 'CART-2', '막혔던 문제와 해결').code, 0);
  assert.equal(s.item('section', 'CART-2', '회고').code, 1);
  const heads = s.read('worklogs/demo/CART-2.md').split('\n').filter((l) => l.startsWith('## ')).map((l) => l.replace(/\d{2}:\d{2}/, 'HH:MM'));
  assert.deepEqual(heads, [
    '## 계획 (시작할 때 작성)', '## 확정 사항 (HH:MM)', '## 확정 사항 2 (HH:MM)',
    '## 무엇을 했나', '## 왜 이렇게 했나', '## 바뀐 것', '## 막혔던 문제와 해결 (해당할 때만)', '## 검증', '## 리뷰 결과', '## 학습 노트', '## 주의 · 남은 일',
  ]);
  assert.equal(s.lint().code, 0, s.lint().out);
});

test('done은 정의서 카드에 가정 절이 없으면 덧붙이고, 대안이 없는 가정을 알린다', (t) => {
  const s = setup(t);
  const file = 'worklogs/demo/CART-2.md';
  s.item('start', 'CART-2');
  s.item('section', 'CART-2', '제안', '- 링크는 7일 뒤 만료');
  const first = s.item('done', 'CART-2');
  assert.equal(first.code, 1);
  assert.match(first.out, /확인하지 못한 가정/);
  const heads = s.read(file).split('\n').filter((l) => l.startsWith('## '));
  assert.deepEqual(heads.slice(1, 4), ['## 제안', '## 확인하지 못한 가정', '## 무엇을 했나']);
  s.write(file, fillCard(s.read(file)).replace(/(## 확인하지 못한 가정\n)- .*/, '$1- 결제사가 만료 시각을 준다 — 확인: 구현 세션'));
  const second = s.item('done', 'CART-2');
  assert.equal(second.code, 1);
  assert.match(second.out, /틀리면:/);
  s.write(file, s.read(file).replace('확인: 구현 세션', '확인: 구현 세션 / 틀리면: 서버 시각으로 계산'));
  assert.equal(s.item('done', 'CART-2').code, 0);
  assert.equal(s.lint().code, 0, s.lint().out);
});

test('done은 정의 절이 없는 카드에 가정 절을 요구하지 않고, "없음"이라고 적은 가정 절은 지나간다', (t) => {
  const s = setup(t);
  s.item('start', 'CART-2');
  s.item('done', 'CART-2');
  assert.doesNotMatch(s.read('worklogs/demo/CART-2.md'), /확인하지 못한 가정/);
  s.item('start', 'CART-3', '--force');
  s.item('section', 'CART-3', '제안', '- 만료된 링크는 410');
  s.item('section', 'CART-3', '확인하지 못한 가정', '- 없음');
  s.item('done', 'CART-3');
  s.write('worklogs/demo/CART-3.md', fillCard(s.read('worklogs/demo/CART-3.md')));
  const r = s.item('done', 'CART-3');
  assert.equal(r.code, 0, r.out);
});

test('issue add · start · resolve · close는 번호와 세부 줄을 붙인다', (t) => {
  const s = setup(t);
  const a = s.item('issue', 'add', '--parent', 'CART-2', '--sev', '중간', '--kind', '버그', '공유 링크가 두 번 만들어짐', '--detail', '재현: 버튼 두 번 클릭');
  assert.equal(a.code, 0, a.out);
  assert.equal(s.item('issue', 'add', '--parent', 'CART-2', '--sev', '낮음', '--kind', '개선', '만료 문구', '--related', 'CART-3').code, 0);
  assert.equal(s.item('issue', 'add', '--parent', 'ISS', '--sev', '낮음', '--kind', '설정', '설정 키 누락').code, 0);
  assert.equal(s.item('issue', 'add', '--parent', 'NONE-1', '--sev', '낮음', '--kind', '설정', '없는 부모').code, 1);
  assert.equal(s.item('issue', 'add', '--parent', 'ISS', '--sev', '심각', '--kind', '설정', '틀린 심각도').code, 1);

  assert.equal(s.item('issue', 'start', 'CART-2#1').code, 0);
  assert.match(s.read('issues/demo.md'), /^- \[~\] CART-2#1 \[중간\]\[버그\] 공유 링크가 두 번 만들어짐 @claude$/m);
  assert.equal(s.item('issue', 'resolve', 'CART-2#1', '중복 요청을 막음', '--commit', 'a1b2c3d').code, 0);
  assert.equal(s.item('issue', 'close', 'ISS-1', '의도된 동작').code, 0);
  assert.equal(s.item('issue', 'close', 'CART-2#2').code, 1);
  assert.equal(s.read('issues/demo.md'), [
    '# demo 이슈', '',
    '- [x] CART-2#1 [중간][버그] 공유 링크가 두 번 만들어짐',
    '  - 재현: 버튼 두 번 클릭',
    '  - 해결: 중복 요청을 막음',
    '  - 커밋: a1b2c3d',
    '- [ ] CART-2#2 [낮음][개선] 만료 문구 (관련: CART-3)',
    '- [-] ISS-1 [낮음][설정] 설정 키 누락',
    '  - 이유: 의도된 동작', '',
  ].join('\n'));
  const list = s.item('issue');
  assert.match(list.out, /열린 이슈 1개/);
  assert.equal(s.lint().code, 0, s.lint().out);
});

test('인자가 없으면 현황을 보이고, 담당 태그를 모르면 막는다', (t) => {
  const s = setup(t);
  const r = s.item();
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /demo: 2\/5 완료/);
  assert.match(r.out, /시작할 수 있음.*\n {2}CART-2 /);
  assert.match(r.out, /선행 필요.*\n {2}CART-3 .* ← CART-2/);
});

test('데이터 폴더 밖 경로 · 사람 이름 태그 · 취소한 항목은 건드리지 않는다', (t) => {
  const s = setup(t);
  const outside = path.join(s.wd, '..', 'README.md');
  fs.writeFileSync(outside, '# 바깥 문서\n');
  assert.equal(s.item('section', '../../../README', '확정 사항', '- x').code, 1);
  assert.equal(s.item('issue', 'add', '--project', '../../evil', '--parent', 'ISS', '--sev', '낮음', '--kind', '설정', '바깥').code, 1);
  assert.equal(fs.readFileSync(outside, 'utf8'), '# 바깥 문서\n');
  assert.equal(fs.existsSync(path.join(s.wd, '..', 'evil.md')), false);

  s.write('roadmaps/demo.md', s.read('roadmaps/demo.md').replace('- [ ] CART-2 공유 API (after: CART-1)', '- [ ] CART-2 공유 API 담당 @hong'));
  assert.equal(s.item('start', 'CART-2').code, 0);
  assert.match(s.read('roadmaps/demo.md'), /^- \[~\] CART-2 공유 API 담당 @hong @claude$/m);

  assert.equal(s.item('drop', 'CART-3', '하지 않기로 함', '--force').code, 0);
  const dropped = s.read('roadmaps/demo.md');
  assert.equal(s.item('wait', 'CART-3', '누구 · 무엇').code, 1);
  assert.equal(s.read('roadmaps/demo.md'), dropped);
});

test('memo는 정해진 머리말로 메모를 달고, reopen은 대기 항목을 할 일로 되돌린다', (t) => {
  const s = setup(t);
  assert.equal(s.item('memo', 'CART-2', '결정', '링크는 7일 뒤 만료').code, 0);
  assert.equal(s.item('memo', 'CART-2', '연결', '주문 화면이 호출').code, 0);
  assert.equal(s.item('memo', 'CART-2', '메모', '아무 말').code, 1);
  assert.match(s.read('roadmaps/demo.md'), /^- \[ \] CART-2 .*\n {4}결정\(\d{4}-\d{2}-\d{2}\): 링크는 7일 뒤 만료\n {4}연결: 주문 화면이 호출\n- \[ \] CART-3 /m);

  assert.equal(s.item('wait', 'CART-3', '결제 담당자 · 환불 API').code, 0);
  assert.equal(s.item('reopen', 'CART-3').code, 0);
  assert.match(s.read('roadmaps/demo.md'), /^- \[ \] CART-3 링크 만료 \(after: CART-2\)\n {4}대기: 결제 담당자 · 환불 API \(풀림 \d{4}-\d{2}-\d{2}\)$/m);
  assert.equal(s.item('reopen', 'CART-1').code, 1);
  assert.equal(s.lint().code, 0, s.lint().out);
});

test('extra는 완료한 항목의 카드에 추가 작업 절을 붙이고, done이 채웠는지 확인한다', (t) => {
  const s = setup(t);
  assert.match(s.item('extra', 'CART-3').out, /완료한 항목이 아니다 → /);
  assert.match(s.item('extra', 'CART-1').out, /작업 카드가 없다/);
  s.item('start', 'CART-2');
  s.item('done', 'CART-2');
  s.write('worklogs/demo/CART-2.md', fillCard(s.read('worklogs/demo/CART-2.md')));
  s.item('done', 'CART-2');
  s.item('done', 'CART-2', '--committed', '--commit', 'a1b2c3d feat: 공유 API');
  assert.match(s.item('start', 'CART-2').out, /`extra CART-2`/);

  const added = s.item('extra', 'CART-2');
  assert.equal(added.code, 0, added.out);
  const card = s.read('worklogs/demo/CART-2.md');
  const tail = card.slice(card.lastIndexOf('## 추가 작업 ('));
  for (const name of ['무엇을 했나', '바뀐 것', '검증']) assert.ok(tail.includes(`\n## ${name}\n`), `${name} 절이 없다`);
  assert.match(card.split('\n')[1], /^- 상태: 검토 대기 · /);
  assert.match(s.read('roadmaps/demo.md'), /^- \[x\] CART-2 /m);
  assert.equal(s.lint().code, 0, s.lint().out);
  assert.match(s.item('extra', 'CART-2').out, /채우지 않은 `## 추가 작업` 절이 이미 있다/);
  const blocked = s.item('done', 'CART-2', '--committed');
  assert.equal(blocked.code, 1);
  assert.match(blocked.out, /추가 작업 절이 다 채워지지 않았다/);

  s.write('worklogs/demo/CART-2.md', fillCard(card));
  assert.match(s.item('done', 'CART-2').out, /추가 작업 절이 다 채워졌다/);
  const closed = s.item('done', 'CART-2', '--committed', '--commit', 'b2c3d4e fix: 만료 처리');
  assert.equal(closed.code, 0, closed.out);
  assert.match(s.read('worklogs/demo/CART-2.md').split('\n')[1], /^- 상태: 완료 · /);
  assert.equal(s.lint().code, 0, s.lint().out);
  assert.match(s.item('done', 'CART-2', '--committed').out, /카드까지 완료다 → .*`extra CART-2`/);
  assert.equal(s.item('extra', 'CART-2').code, 0);
});

test('show는 항목 · 이슈 · 마일스톤 하나만 보여 준다', (t) => {
  const s = setup(t);
  assert.equal(s.item('start', 'CART-2', '--as', 'claude').code, 0);
  assert.equal(s.item('memo', 'CART-2', '결정', '링크는 7일 뒤 만료').code, 0);
  assert.equal(s.item('issue', 'add', '--parent', 'CART-2', '--sev', '중간', '--kind', '버그', '링크가 두 번 만들어짐', '--detail', '재현: 버튼 두 번 클릭').code, 0);
  const item = s.item('show', 'CART-2');
  assert.equal(item.code, 0, item.out);
  assert.match(item.out, /^roadmaps\/demo\.md:6\n## M1\. 장바구니 공유\n {4}완료 기준: .*\n- \[~\] CART-2 공유 API \(after: CART-1\) @claude\n {4}결정\(\d{4}-\d{2}-\d{2}\): 링크는 7일 뒤 만료\n카드: worklogs\/demo\/CART-2\.md \(\d+줄\)\n {2}- 상태: 진행 중/);
  assert.match(item.out, /\n {2}\d+-\d+ ## 계획 \(시작할 때 작성\)\n/);
  assert.match(item.out, /이슈 1개:\n {2}- \[ \] CART-2#1 \[중간\]\[버그\] 링크가 두 번 만들어짐/);
  assert.doesNotMatch(item.out, /CART-3|ORD-1/);
  assert.match(s.item('show', 'CART-3').out, /카드: 없음/);
  const issue = s.item('show', 'CART-2#1');
  assert.match(issue.out, /^issues\/demo\.md:\d+\n- \[ \] CART-2#1 .*\n {2}- 재현: 버튼 두 번 클릭\n/);
  const ms = s.item('show', 'M2');
  assert.match(ms.out, /^roadmaps\/demo\.md:11\n## M2\. 주문 취소\n {4}완료 기준: .*\n- \[x\] ORD-1 /);
  assert.doesNotMatch(ms.out, /CART-/);
  for (const bad of ['CART-9', 'CART-2#9', 'M9', '../x']) {
    const r = s.item('show', bad);
    assert.equal(r.code, 1, bad);
    assert.match(r.out, /^막았다: .* → /, bad);
  }
});

test('flow는 전체 구조와, 준 경로 · ID가 걸리는 흐름 절만 보여 준다', (t) => {
  const s = setup(t);
  assert.match(s.item('flow').out, /흐름 문서가 없다\(flows\/demo\.md\)/);
  fs.mkdirSync(path.join(s.wd, 'flows'));
  fs.writeFileSync(path.join(s.wd, 'flows', 'demo.md'), [
    '# demo 동작 흐름', '',
    '## 전체 구조', '- 서버와 화면으로 나뉜다', '',
    '## 장바구니 공유', '- 요약: 링크로 장바구니를 연다', '- 관련 파일: `src/cart/ShareService.java`', '- 관련 항목: CART-2', '',
    '## 주문 취소', '- 요약: 취소하면 재고가 돌아온다', '- 관련 파일: `src/order/CancelService.java`', '- 관련 항목: ORD-1', '```', '## 코드 안의 제목', '```', '',
  ].join('\n'));
  const list = s.item('flow').out;
  assert.match(list, /서버와 화면으로 나뉜다[\s\S]*흐름 절 2개:\n- 장바구니 공유 \(6~10줄\)\n- 주문 취소 \(11~18줄\)/);
  const byPath = s.item('flow', 'backend/src/cart/ShareService.java').out;
  assert.match(byPath, /서버와 화면으로 나뉜다[\s\S]*\[flows\/demo\.md 6~10줄\]\n## 장바구니 공유/);
  assert.doesNotMatch(byPath, /주문 취소/);
  assert.match(s.item('flow', 'ORD-1').out, /## 주문 취소[\s\S]*## 코드 안의 제목/);
  assert.match(s.item('flow', 'CART-2', 'CancelService').out, /## 장바구니 공유[\s\S]*## 주문 취소/);
  assert.doesNotMatch(s.item('flow', 'ORD-12').out, /## 주문 취소/);
  assert.match(s.item('flow', 'src/none/Other.java').out, /걸리는 흐름 절이 없다\. 절 목록:\n- 장바구니 공유/);
});
