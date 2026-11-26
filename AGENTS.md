# work-dash-app — 에이전트 안내

## 확인
- 작업 중: `node ~/.work-dash/app/core/check.js` — 바뀐 파일을 보고 맞는 확인(타입 검사 · 문법 검사 · 린트 · 테스트)만 골라 돌린다. 무엇을 돌리는지는 `.work-dash-checks.json`에 있고, 확인을 더하거나 바꿀 때는 그 파일만 고친다.
- 원격에 푸시 · PR 하기 직전: `node ~/.work-dash/app/core/check.js --full` (통과한 기록이 없는 커밋은 푸시가 막힌다)
- 명령이 돌리지 않는 확인:
  - `server/`의 API를 바꿨으면 바꾼 API를 `curl localhost:4949/api/…`로 호출한다.
  - `~/.work-dash` 파서(`roadmap.js` · `issues.js` …, 저장소 밖)를 바꿨으면 그 파서를 `node -e`로 불러 실제 파일을 읽혀 본다.
- 린트가 잡은 주석은 `npm run lint -- --fix`로 지운다. 테스트는 임시 홈과 빈 포트를 쓴다.
