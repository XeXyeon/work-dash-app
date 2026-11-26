import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DOCLINT = path.join(REPO, 'core', 'doclint.js');

const road = (...items) => ['# demo 로드맵', '', '## M1. 장바구니 공유 (~10/25)', '    완료 기준: 공유 링크로 같은 장바구니를 본다', ...items, ''].join('\n');
const issues = (...lines) => ['# demo 이슈', '', ...lines, ''].join('\n');
const card = (id, status, ...body) => [`# ${id} 공유 API`, status, '', '## 계획 (시작할 때 작성)', '- 할 일: 공유 API', '', ...body, ''].join('\n');

const GOOD = {
  'roadmaps/demo.md': road(
    '- [x] CART-1 장바구니 엔티티 ✓2026-11-01 10:00',
    '- [~] CART-2 공유 API (after: CART-1) @claude',
    '    결정(2026-11-01): 링크는 7일 뒤 만료',
    '    연결: 주문 화면이 호출',
    '- [!] CART-3 환불 요청',
    '    대기: 결제 담당자 · 환불 API',
    '- [>] CART-4 푸시 알림',
    '    결정(2026-11-01): 보류 — 운영해 본 뒤 정한다',
    '- [-] CART-5 문자 알림',
    '    결정(2026-11-01): 하지 않음 — 비용',
    '- [ ] CART-6 링크 만료 (after: CART-2)',
  ),
  'issues/demo.md': issues(
    '- [~] CART-2#1 [중간][버그] 링크가 두 번 만들어짐 (관련: CART-1) @claude',
    '  - 재현: 버튼 두 번 클릭',
    '- [x] ISS-1 [낮음][설정] 설정 키 누락 ✓2026-11-01 10:00',
    '- [-] ISS-2 [낮음][질문] 의도된 동작',
    '  - 이유: 팀 규칙',
  ),
  'worklogs/demo/CART-2.md': card('CART-2', '- 상태: 진행 중 · @claude · 시작 2026-11-01 10:00',
    '## 코드에서 확인한 사실', '- CART-1의 엔티티를 쓴다. 관련 이슈 CART-2#1', '',
    '## 확정 사항 (10:30)', '- 7일 뒤 만료', '',
    '```markdown', '## 코드 블록 안의 제목은 절이 아니다', '```', '',
    '## 무엇을 했나', '공유 링크를 만든다.', '',
    '## 검증', '- 실행: 시험 통과. UTF-8 · SHA-256 · SHA-1 · SHA-512를 쓴다. 한 번 나온 X-1과 `D-1` · `D-2` · `D-3`은 걸리지 않는다',
    '- 참고: [공식 문서](https://example.com/a/b.md), 응답 [id](seller 정산 없음), 흐름은 ~/.work-dash/flows/demo.md, `[예시](docs/a.md)`, 비율 [x](1/2) · [날짜](2026/11/20) · [파일](file:///a/b.md) · [문서](HTTPS://example.com/a)'),
  'worklogs/demo/CART-1.md': card('CART-1', '- 상태: 완료 · 2026-11-02 00:10 · @claude · 시작 2026-11-01 23:00 (약 1시간 10분)',
    '## 무엇을 했나', '엔티티를 만들었다.', '',
    '## 추가 작업 (2026-11-03)', '- 할 일: 필드 추가', '',
    '## 무엇을 했나', '필드를 더했다.'),
};

function run(files) {
  const wd = fs.mkdtempSync(path.join(os.tmpdir(), 'wd-doclint-'));
  try {
    for (const [rel, text] of Object.entries({ ...GOOD, ...files })) {
      fs.mkdirSync(path.dirname(path.join(wd, rel)), { recursive: true });
      fs.writeFileSync(path.join(wd, rel), text);
    }
    const r = spawnSync(process.execPath, [DOCLINT], { env: { ...process.env, WORK_DASH_DIR: wd }, encoding: 'utf8' });
    return { code: r.status, out: r.stdout + r.stderr };
  } finally {
    fs.rmSync(wd, { recursive: true, force: true });
  }
}

test('형식에 맞는 로드맵 · 이슈 · 카드는 통과한다', () => {
  const r = run({});
  assert.equal(r.out, '');
  assert.equal(r.code, 0);
});

const CASES = [
  ['roadmap-wait-memo', 'roadmaps/demo.md', 5, road('- [!] CART-1 환불 요청')],
  ['roadmap-decision-memo', 'roadmaps/demo.md', 5, road('- [>] CART-1 푸시 알림', '    대기: 누구 · 무엇')],
  ['roadmap-decision-memo', 'roadmaps/demo.md', 5, road('- [-] CART-1 문자 알림')],
  ['roadmap-criteria', 'roadmaps/demo.md', 3, '# demo 로드맵\n\n## M1. 장바구니 공유\n- [ ] CART-1 엔티티\n'],
  ['roadmap-heading', 'roadmaps/demo.md', 6, road('- [ ] CART-1 엔티티', '## 2단계 주문', '    완료 기준: 주문한다')],
  ['roadmap-item', 'roadmaps/demo.md', 5, road('- [?] CART-1 엔티티')],
  ['roadmap-item', 'roadmaps/demo.md', 5, road('- [ ] 엔티티 설계')],
  ['roadmap-item', 'roadmaps/demo.md', 5, road('  - [ ] CART-1 엔티티')],
  ['roadmap-dup-id', 'roadmaps/demo.md', 6, road('- [ ] CART-1 엔티티', '- [ ] CART-1 공유 API')],
  ['roadmap-owner', 'roadmaps/demo.md', 5, road('- [~] CART-1 엔티티')],
  ['roadmap-owner', 'roadmaps/demo.md', 6, road('- [x] CART-1 엔티티', '- [~] CART-2 공유 API @claude (after: CART-1)')],
  ['roadmap-owner', 'roadmaps/demo.md', 5, road('- [ ] CART-1 엔티티 @gpt')],
  ['roadmap-after', 'roadmaps/demo.md', 5, road('- [ ] CART-1 엔티티 (after: CART-99)')],
  ['roadmap-memo', 'roadmaps/demo.md', 6, road('- [ ] CART-1 엔티티', '    나중에 다시 본다')],
  ['roadmap-memo', 'roadmaps/demo.md', 6, road('- [ ] CART-1 엔티티', '    완료 기준: 저장된다')],
  ['id-ref', 'roadmaps/demo.md', 6, road('- [ ] CART-1 엔티티', '    연결: CART-99가 쓴다')],
  ['issue-line', 'issues/demo.md', 3, issues('- [?] ISS-1 [낮음][설정] 키 누락')],
  ['issue-id', 'issues/demo.md', 3, issues('- [ ] BUG1 [낮음][버그] 키 누락')],
  ['issue-dup-id', 'issues/demo.md', 4, issues('- [ ] ISS-1 [낮음][설정] 키 누락', '- [ ] ISS-1 [낮음][설정] 또 누락')],
  ['issue-severity', 'issues/demo.md', 3, issues('- [ ] ISS-1 [버그] 키 누락')],
  ['issue-kind', 'issues/demo.md', 3, issues('- [ ] ISS-1 [낮음][메모] 키 누락')],
  ['issue-kind', 'issues/demo.md', 3, issues('- [ ] ISS-1 [낮음] 키 누락')],
  ['issue-owner', 'issues/demo.md', 3, issues('- [~] ISS-1 [낮음][버그] 키 누락')],
  ['issue-owner', 'issues/demo.md', 3, issues('- [x] ISS-1 [낮음][버그] 키 누락 @claude')],
  ['issue-parent', 'issues/demo.md', 3, issues('- [ ] ZZZ-1#1 [낮음][버그] 없는 부모')],
  ['id-ref', 'issues/demo.md', 3, issues('- [ ] ISS-1 [낮음][버그] 키 누락 (관련: CART-99)')],
  ['card-title', 'worklogs/demo/CART-2.md', 1, card('CART-9', '- 상태: 진행 중 · @claude · 시작 2026-11-01 10:00')],
  ['card-title', 'worklogs/demo/CART-2.md', 1, '공유 API 작업\n- 상태: 진행 중 · @claude · 시작 2026-11-01 10:00\n'],
  ['card-status', 'worklogs/demo/CART-2.md', 2, card('CART-2', '- 상태: 하는 중 · @claude')],
  ['card-status', 'worklogs/demo/CART-2.md', 2, card('CART-2', '- 상태: 진행 중 · 시작 오늘 아침')],
  ['card-status', 'worklogs/demo/CART-2.md', 2, card('CART-2', '- 상태: 완료 · @claude · 2026-11-01 10:00')],
  ['card-status', 'worklogs/demo/CART-2.md', 3, '# CART-2 공유 API\n\n- 상태: 진행 중 · @claude · 시작 2026-11-01 10:00\n'],
  ['card-time', 'worklogs/demo/CART-2.md', 2, card('CART-2', '- 상태: 진행 중 · @claude · 시작 2099-01-01 10:00')],
  ['card-time', 'worklogs/demo/CART-2.md', 2, card('CART-2', '- 상태: 완료 · 2026-11-01 10:00 · @claude · 시작 11:00')],
  ['card-section', 'worklogs/demo/CART-2.md', 7, card('CART-2', '- 상태: 진행 중 · @claude · 시작 2026-11-01 10:00', '## 회고', '- 잘했다')],
  ['card-section-order', 'worklogs/demo/CART-2.md', 10, card('CART-2', '- 상태: 진행 중 · @claude · 시작 2026-11-01 10:00', '## 검증', '- 통과', '', '## 무엇을 했나', '만들었다')],
  ['card-section-order', 'worklogs/demo/CART-2.md', 10, card('CART-2', '- 상태: 진행 중 · @claude · 시작 2026-11-01 10:00', '## 무엇을 했나', '만들었다', '', '## 제안', '- 표')],
  ['id-ref', 'worklogs/demo/CART-2.md', 8, card('CART-2', '- 상태: 진행 중 · @claude · 시작 2026-11-01 10:00', '## 무엇을 했나', 'CART-99를 고쳤다')],
  ['pointer-link', 'worklogs/demo/CART-2.md', 8, card('CART-2', '- 상태: 진행 중 · @claude · 시작 2026-11-01 10:00', '## 무엇을 했나', '[설계](docs/design.md)를 따른다')],
  ['pointer-link', 'worklogs/demo/CART-2.md', 8, card('CART-2', '- 상태: 진행 중 · @claude · 시작 2026-11-01 10:00', '## 무엇을 했나', '앞 작업은 ~/.work-dash/worklogs/demo/CART-1.md 참고')],
  ['pointer-link', 'worklogs/demo/CART-2.md', 8, card('CART-2', '- 상태: 진행 중 · @claude · 시작 2026-11-01 10:00', '## 무엇을 했나', '앞 작업은 /Users/someone/.work-dash/worklogs/demo/CART-1.md 참고')],
  ['pointer-link', 'roadmaps/demo.md', 6, road('- [ ] CART-1 엔티티', '    연결: [카드](../worklogs/demo/CART-1.md)')],
  ['pointer-link', 'issues/demo.md', 4, issues('- [ ] ISS-1 [낮음][버그] 키 누락', '  - 재현: [절차](#재현-절차)')],
  ['id-scheme', 'worklogs/demo/CART-2.md', 9, card('CART-2', '- 상태: 진행 중 · @claude · 시작 2026-11-01 10:00', '## 무엇을 했나', 'D-1과 D-2를 따른다', 'D-3은 미룬다')],
];

for (const [rule, rel, line, text] of CASES) {
  test(`${rule}: ${text.split('\n')[line - 1] || '(빈 줄)'}`, () => {
    const r = run({ [rel]: text });
    assert.ok(r.out.includes(`${rel}:${line} [${rule}]`), `기대한 위반이 없다: ${rel}:${line} [${rule}]\n${r.out}`);
    assert.equal(r.code, 1);
    for (const l of r.out.trim().split('\n')) assert.match(l, / → /, `고칠 방법(→)이 없는 문장: ${l}`);
  });
}

test('접두어 하나가 절반을 넘으면 알리되 실패로 치지 않는다', () => {
  const lines = ['# demo 로드맵', ''];
  for (let m = 1; m <= 5; m++) lines.push(`## M${m}. 결과 ${m}`, '    완료 기준: 된다', `- [ ] CART-${m} 일 ${m}`, '');
  const many = run({ 'roadmaps/demo.md': lines.join('\n'), 'issues/demo.md': issues(), 'worklogs/demo/CART-2.md': GOOD['worklogs/demo/CART-2.md'].replace(/ 관련 이슈 CART-2#1/, '') });
  assert.match(many.out, /roadmaps\/demo\.md:5 \[roadmap-prefix-share\]/);
  assert.equal(many.code, 0);
  const few = run({ 'roadmaps/demo.md': lines.slice(0, 14).join('\n'), 'issues/demo.md': issues(), 'worklogs/demo/CART-2.md': GOOD['worklogs/demo/CART-2.md'].replace(/ 관련 이슈 CART-2#1/, '') });
  assert.doesNotMatch(few.out, /roadmap-prefix-share/);
});
