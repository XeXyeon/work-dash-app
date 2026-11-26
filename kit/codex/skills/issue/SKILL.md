---
name: issue
description: 작업 중 발견한 문제(버그, 질문, 개선, 설정, 기술 부채)를 이슈 파일(~/.work-dash/issues/<프로젝트 이름>.md)에 추가하고(add), 처리를 시작하고(start), 해결하거나(resolve) 닫을 때(close) 사용. 사용자가 "이슈", "버그", "문제 기록", "issue"를 말하거나 이슈 ID(예: ORD-1#2, ISS-3)를 언급할 때 사용.
metadata:
  short-description: 이슈 관리 (add | start | resolve | close)
---

# Issue

Claude의 `/issue` 커맨드와 같은 파일을 쓴다.

1. 명령으로 한다: `node ~/.work-dash/app/core/item.js issue <동작> … --as gpt`(인자 없으면 열린 이슈, 쓰는 법은 `--help`).
2. 명령이 막으면 `→` 뒤에 적힌 대로 한다. 어느 프로젝트 · 어느 부모에 적을지 애매하면 `~/.work-dash/ISSUES-FORMAT.md`의 "어디에 적나"를 읽는다.
