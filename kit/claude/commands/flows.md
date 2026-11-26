---
description: 프로젝트 동작 흐름 문서 관리 (init | update <흐름|ID> | check | share | 인자 없으면 현황)
argument-hint: "[init | update <흐름 이름 또는 항목 ID> | check | share]"
---
현재 프로젝트의 동작 흐름 문서를 다룬다. 요청: `$ARGUMENTS`

1. 먼저 `~/.work-dash/FLOWS-FORMAT.md`를 읽는다. 파일 위치, 형식, 갱신 규칙, 각 인자의 동작이 모두 거기 있다.
2. 그 규칙대로 요청을 수행한다. work-dash 앱이 Markdown 원본을 바로 보여 주니 원본만 고친다.
3. `share`는 팀 공유 페이지다. 형식 파일의 `share` 동작대로 데이터 파일을 채우고 `node ~/.work-dash/app/core/tools/flow-share.js`로 만든 HTML을 아티팩트로 게시한다.
