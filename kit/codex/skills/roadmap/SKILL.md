---
name: roadmap
description: 프로젝트 로드맵(~/.work-dash/roadmaps/<프로젝트 이름>.md)을 보고, 만들고(init), 항목을 추가(add)·시작(start)·완료(done)하거나 다음 할 일(next)을 고를 때 사용. 사용자가 "로드맵", "roadmap", "다음 작업", "진행 현황"을 말하거나 로드맵 항목 ID(예: CART-2)를 언급할 때 사용.
metadata:
  short-description: 프로젝트 로드맵 관리 (init | add | start | done | next | 현황)
---

# Roadmap

Claude의 `/roadmap` 커맨드와 같은 로드맵 파일을 함께 쓴다.

1. `init`이 아니면 명령으로 한다: `node ~/.work-dash/app/core/item.js <동작> … --as gpt`(인자 없음 · `next`는 현황, 쓰는 법은 `--help`). `add`는 넣을 마일스톤 번호를 먼저 고른다.
2. 명령이 막으면 `→` 뒤에 적힌 대로 한다. Claude가 `@claude`로 잡고 있는 항목은 사용자가 시킬 때만 건드린다.
3. `init`, 마일스톤을 새로 나누는 일, 메모 줄을 손으로 쓰는 일은 `~/.work-dash/ROADMAP-FORMAT.md`의 해당 절을 읽고 한다.
