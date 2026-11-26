---
name: interview
description: 작업 카드(~/.work-dash/worklogs)를 바탕으로 예상 면접 질문, 답변 뼈대, 꼬리 질문을 만들 때 사용. 사용자가 "면접 질문", "interview", "포트폴리오 정리", "이번 마일스톤 정리"를 말할 때 사용.
metadata:
  short-description: 작업 카드로 면접 질문 만들기
---

# Interview

Claude의 `/interview` 커맨드와 같은 파일을 쓴다.

1. 먼저 `~/.work-dash/INTERVIEW-FORMAT.md`를 읽는다. 입력, 출력 위치와 형식, 규칙이 모두 거기 있다.
2. 사용자가 마일스톤이나 항목 ID를 말하면 그것만, 아니면 가장 최근에 끝난 마일스톤으로 만든다.
