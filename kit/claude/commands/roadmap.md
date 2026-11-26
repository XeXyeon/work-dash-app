---
description: 프로젝트 로드맵 관리 (init | add <설명> | start <ID> | done <ID> | next | 인자 없으면 현황)
argument-hint: "[init | add <설명> | start <ID> | done <ID> | next]"
---
현재 프로젝트의 로드맵을 다룬다. 요청: `$ARGUMENTS`

1. `init`이 아니면 명령으로 한다: `node ~/.work-dash/app/core/item.js <동작> …`(인자 없음 · `next`는 현황, 쓰는 법은 `--help`). `add`는 넣을 마일스톤 번호를 먼저 고른다.
2. 명령이 막으면 `→` 뒤에 적힌 대로 한다.
3. `init`, 마일스톤을 새로 나누는 일, 메모 줄을 손으로 쓰는 일은 `~/.work-dash/ROADMAP-FORMAT.md`의 해당 절을 읽고 한다.
