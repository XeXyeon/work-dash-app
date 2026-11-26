---
description: 이슈 관리 (add <설명> | start <ID> | resolve <ID> | close <ID> <이유> | 인자 없으면 열린 이슈)
argument-hint: "[add <설명> | start <ID> | resolve <ID> | close <ID> <이유>]"
---
현재 프로젝트의 이슈를 다룬다. 요청: `$ARGUMENTS`

1. 명령으로 한다: `node ~/.work-dash/app/core/item.js issue <동작> …`(인자 없으면 열린 이슈, 쓰는 법은 `--help`).
2. 명령이 막으면 `→` 뒤에 적힌 대로 한다. 어느 프로젝트 · 어느 부모에 적을지 애매하면 `~/.work-dash/ISSUES-FORMAT.md`의 "어디에 적나"를 읽는다.
