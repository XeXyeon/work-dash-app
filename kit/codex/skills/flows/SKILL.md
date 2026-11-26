---
name: flows
description: 프로젝트 동작 흐름 문서(~/.work-dash/flows/<프로젝트 이름>.md)를 만들고(init), 특정 흐름을 고치고(update), 코드와 어긋났는지 확인(check)하고, 팀 공유용 한 장짜리 페이지를 만들(share) 때 사용. 사용자가 "동작 흐름", "flows", "흐름 문서", "구조 파악"을 말하거나, 로드맵 항목을 끝내며 흐름이 바뀌었을 때 사용.
metadata:
  short-description: 프로젝트 동작 흐름 문서 관리
---

# Flows

Claude의 `/flows` 커맨드와 같은 파일을 쓴다.

1. 먼저 `~/.work-dash/FLOWS-FORMAT.md`를 읽는다. 파일 위치, 형식, 갱신 규칙, 각 동작이 모두 거기 있다.
2. 그 규칙대로 수행한다. work-dash 앱이 Markdown 원본을 바로 보여 주니 원본만 고친다.
3. `share`는 형식 파일의 `share` 동작대로 데이터 파일을 채우고 `node ~/.work-dash/app/core/tools/flow-share.js <프로젝트>`로 HTML을 만든 뒤 경로를 알려 준다(Codex는 아티팩트 게시를 하지 않는다).
