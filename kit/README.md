# work-dash-kit

> 이 폴더는 기록 도구의 2026-11-27 시점 사본입니다. 대시보드가 읽을 수 있게 함께 넣었고, 더 고치지 않습니다.

Claude Code · Codex 에이전트와 일한 기록을 **마크다운 파일**로 남기는 도구입니다. 로드맵 · 이슈 · 작업 카드 · 흐름 문서의 형식과, 그 형식대로 쓰게 하는 명령 · 훅이 들어 있습니다.

화면은 들어 있지 않습니다. 기록은 `~/.work-dash` 아래의 파일이라, 어떤 화면(대시보드 · 편집기 플러그인)이든 그 파일을 읽어 보여 주면 됩니다.

## 들어 있는 것

| 폴더 | 내용 |
|---|---|
| `rules/` | 에이전트가 읽는 공통 규칙(`RULES*.md`)과 형식 문서(`*-FORMAT.md`) |
| `core/` | 파서(`roadmap.js` · `issues.js` · `flows.js`), 명령(`item.js` · `check.js` · `cdx.js`), Claude Code · Codex 훅 스크립트 |
| `claude/` · `codex/` | 슬래시 명령과 스킬(`/roadmap` · `/issue` · `/flows` · `/interview`, 세션을 마무리하는 `/end`) |
| `view/` | 화면(대시보드 · 플러그인)이 불러 쓰는 읽기 함수. 프로젝트 · 로드맵 · 이슈 · 작업 카드 · 흐름 · 기획 문서 · 학습 노트 · 개선 기록을 화면용 모양으로 돌려준다 |
| `bin/install.js` | 설치 · 제거 |
| `bin/hooks.js` | 설정 파일에 훅만 맞춰 넣기(닷파일 도구가 설정 파일을 관리할 때) |

## 설치

Node.js 20 이상이 필요합니다.

```bash
node kit/bin/install.js init   # 대시보드 저장소 꼭대기에서. 바꿀 내용을 먼저 보여 주고, 확인하면 적용
```

설치하면 `~/.work-dash/`에 기록 폴더와 규칙 · 형식 문서 링크를 만들고, Claude Code(`~/.claude`)와 Codex(`~/.codex`)에 훅 · 규칙 줄 · 명령 링크를 넣습니다. 고치는 파일은 먼저 `~/.work-dash/backup-init-<시각>/`에 백업하고, `node kit/bin/install.js uninstall`로 넣은 것만 되돌립니다.

## 쓰는 명령

```bash
node ~/.work-dash/app/core/item.js           # 프로젝트 현황. 항목 · 작업 카드 · 이슈를 다룸 (--help)
node ~/.work-dash/app/core/check.js          # 바뀐 파일에 맞는 확인만 골라 돌림 (--full: 전체)
node ~/.work-dash/app/core/cdx.js <항목 ID>  # 항목 하나를 Codex에 넘김
```

## 기록이 놓이는 곳

| 파일 | 내용 | 형식 문서 |
|---|---|---|
| `~/.work-dash/roadmaps/<프로젝트>.md` | 마일스톤 · 항목 · 담당 · 선행 관계 | `ROADMAP-FORMAT.md` |
| `~/.work-dash/issues/<프로젝트>.md` | 작업 중 발견한 문제 | `ISSUES-FORMAT.md` |
| `~/.work-dash/worklogs/<프로젝트>/<ID>.md` | 항목별 작업 카드 | `ROADMAP-FORMAT.md` "작업 카드" |
| `~/.work-dash/flows/<프로젝트>.md` | 동작 흐름 · Mermaid 다이어그램 | `FLOWS-FORMAT.md` |
| `~/.work-dash/improvements/<프로젝트>.md` | 전과 후를 비교할 수 있는 개선 기록 | `IMPROVEMENTS-FORMAT.md` |

내 규칙은 `~/.work-dash/RULES.local.md`에 씁니다. 저장소의 규칙 문서를 올려도 지워지지 않습니다.

## 개발

```bash
npm install
npm test
npm run lint
```

## 라이선스

[MIT](LICENSE)
