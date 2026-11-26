import { useEffect, useId, useState } from 'react';
import { ApiError, useDisplayName, useRoadmap, type Issue, type Item, type Milestone, type ProjectSummary } from '../api';
import { ISSUE_STATE_LABEL, ago, issueBadgeTone, issueFinished, itemStatus } from '../format';
import { useNow } from '../useNow';
import { issueHash, routeHash } from '../useHashProject';
import { ProgressBar } from './ProgressBar';

interface Props {
  project: string;
  summary: ProjectSummary;
  foldOverrides: Record<string, boolean>;
  onToggleFold: (key: string, folded: boolean) => void;
  selectedItem: string | null;   // 카드 패널에 열린 항목 (WEB-4)
  selectedIssue: string | null;  // 이슈 카드 패널에 열린 이슈 (WEB-22)
}

export function RoadmapView({ project, summary, foldOverrides, onToggleFold, selectedItem, selectedIssue }: Props) {
  const q = useRoadmap(project, summary.hasRoadmap);
  const dn = useDisplayName();
  const now = useNow();
  // 다른 화면(세션 알림 · 작업 카드 ID)에서 항목으로 왔을 때 그 줄이 보이게 한다.
  // 로드맵이 그려지고 배치가 자리 잡은 뒤에 한 번, 이미 보이면 움직이지 않는다
  const loaded = !!q.data;
  useEffect(() => {
    if (!selectedItem || !loaded) return;
    const t = setTimeout(() => {
      const el = document.querySelector('li.item.selected');
      if (!el) return;
      const r = el.getBoundingClientRect();
      if (r.top < 0 || r.bottom > window.innerHeight) el.scrollIntoView({ block: 'center' });
    }, 120);
    return () => clearTimeout(t);
  }, [selectedItem, loaded, project]);

  const missing = !summary.hasRoadmap || (q.isError && q.error instanceof ApiError && q.error.status === 404);
  if (missing) {
    return (
      <section className="roadmap">
        <h2 className="roadmap-title">{dn(project)}</h2>
        <p className="muted">
          로드맵 파일이 없습니다.
          {summary.hasIssues && <> 이슈만 있는 프로젝트입니다 — <a href={routeHash(project, 'issues')}>이슈 보기</a></>}
        </p>
      </section>
    );
  }
  if (q.isPending) return <p className="muted pad">불러오는 중…</p>;
  if (q.isError) return <p className="error pad">로드맵을 불러오지 못했습니다: {q.error.message}</p>;

  const r = q.data;
  const pct = r.total ? Math.round((r.done / r.total) * 100) : 0;
  const items = r.milestones.flatMap((m) => m.items);
  const ids = (st: Item['state']) => items.filter((i) => i.state === st).map((i) => i.id || i.title);
  const doing = ids('doing'), ready = ids('ready'), blocked = ids('blocked'), awaiting = ids('await');

  return (
    <section className="roadmap">
      <header className="roadmap-head">
        <h2 className="roadmap-title">{dn(r.project)}</h2>
        <div className="roadmap-progress">
          <ProgressBar done={r.done} total={r.total} />
          <span className="mono muted">{r.done}/{r.total} · {pct}%</span>
        </div>
      </header>
      {/* 여러 작업 폴더를 묶은 프로젝트면 어느 폴더들이 연결돼 있는지 제목 아래에 보인다 */}
      {summary.folders?.length > 1 && (
        <p className="roadmap-folders">묶인 폴더 <span className="mono">{summary.folders.join(' · ')}</span></p>
      )}
      <p className="roadmap-summary">
        {doing.length > 0 && <span>진행 중 <b className="t-doing mono">{doing.join(', ')}</b></span>}
        {ready.length > 0 && <span>진행 가능 <b className="t-ready mono">{ready.join(', ')}</b></span>}
        {blocked.length > 0 && <span>선행 필요 <b className="t-blocked">{blocked.length}개</b></span>}
        {awaiting.length > 0 && <span>외부 대기 <b className="t-await">{awaiting.length}개</b></span>}
        {r.recentDone > 0 && <span>최근 완료 <b className="t-recent">{r.recentDone}개</b></span>}
      </p>

      {r.milestones.map((ms) => {
        // 주소로 연 이슈 카드의 이슈가 (기본으로) 접힌 마일스톤 안에 있으면 펼쳐서 선택 줄을 보이게 한다 (WEB-22).
        // 사용자가 직접 접거나 편 마일스톤은 그 선택을 따른다(펼침을 강제하면 접기 버튼이 먹지 않는다)
        const hasSelected = !!selectedIssue && ms.items.some((it) => it.issues.some((x) => x.id === selectedIssue));
        const folded = ms.key in foldOverrides ? foldOverrides[ms.key] : hasSelected ? false : ms.folded;
        return <MilestoneCard key={ms.key} ms={ms} folded={folded} now={now} project={project} selected={selectedItem} selectedIssue={selectedIssue} onToggle={() => onToggleFold(ms.key, !folded)} />;
      })}

      {r.commonIssues.length > 0 && (
        <p className="muted common-note">
          공통 이슈 {r.commonIssues.length}개 (열림 {r.commonIssues.filter((x) => !issueFinished(x.state)).length}) — <a href={routeHash(project, 'issues')}>이슈 화면에서 보기</a>
        </p>
      )}
    </section>
  );
}

function MilestoneCard({ ms, folded, now, project, selected, selectedIssue, onToggle }: { ms: Milestone; folded: boolean; now: number; project: string; selected: string | null; selectedIssue: string | null; onToggle: () => void }) {
  const count = (st: Item['state']) => ms.items.filter((i) => i.state === st).length;
  // 접힌 마일스톤은 진행 중 · 진행 가능 · 열린 이슈를 헤더에 요약한다 (예전 TUI와 같은 방식)
  const note = folded
    ? [count('doing') && `진행 중 ${count('doing')}`, count('ready') && `진행 가능 ${count('ready')}`, count('await') && `외부 대기 ${count('await')}`, count('hold') && `보류 ${count('hold')}`, ms.openIssues && `열린 이슈 ${ms.openIssues}`].filter(Boolean).join(' · ')
    : '';
  const bodyId = useId();   // ms.key에는 공백·한글이 있어 id로 쓰지 않는다
  return (
    <div className={`milestone${folded ? ' folded' : ''}`}>
      <button className="milestone-head" onClick={onToggle} aria-expanded={!folded} aria-controls={bodyId}>
        <span className="fold-icon" aria-hidden>{folded ? '▸' : '▾'}</span>
        <span className="milestone-name">{ms.name}</span>
        {ms.due && <span className="milestone-due mono">~{ms.due}</span>}
        {note && <span className="milestone-note">{note}</span>}
        <span className="milestone-progress">
          <ProgressBar done={ms.done} total={ms.total} size="sm" />
          <span className="mono muted">{ms.done}/{ms.total}</span>
        </span>
      </button>
      {!folded && (
        <ul className="items" id={bodyId}>
          {ms.items.map((it, i) => <ItemRow key={it.id || `${i}:${it.title}`} it={it} now={now} project={project} selected={selected === (it.id || it.title)} selectedIssue={selectedIssue} />)}
        </ul>
      )}
    </div>
  );
}

function ItemRow({ it, now, project, selected, selectedIssue }: { it: Item; now: number; project: string; selected: boolean; selectedIssue: string | null }) {
  const st = itemStatus(it, now);
  const openIssues = it.issues.filter((x) => !issueFinished(x.state));
  const dim = (it.state === 'done' && !openIssues.length && st.tone === 'old') || it.state === 'hold' || it.state === 'dropped';
  return (
    <li className={`item item-${it.state} tone-${st.tone}${dim ? ' dim' : ''}${selected ? ' selected' : ''}`}>
      <div className="item-line">
        <span className={`item-status t-${st.tone}`} title={st.title}>{st.text}</span>
        <span className="item-main">
          {/* 항목을 누르면 오른쪽에 작업 카드 상세 (WEB-4) */}
          <a className="item-link" href={routeHash(project, 'roadmap', null, it.id || it.title)} aria-current={selected ? 'true' : undefined}>
            {it.id && <span className="item-id mono">{it.id}</span>}
            <span className="item-title">{it.title}</span>
          </a>
          {it.owner && <span className={`owner owner-${it.owner}`}>@{it.owner}</span>}
          {it.state === 'blocked' && it.waiting.length > 0 && <span className="t-blocked small">← {it.waiting.join(', ')} 대기</span>}
          {it.unknown.length > 0 && <span className="error small">? {it.unknown.join(', ')} 없음</span>}
          {it.issues.length > 0 && (
            <span className={`issue-badge badge-${issueBadgeTone(it.issues)}`}>
              이슈 {it.issues.length}{openIssues.length ? ` (열림 ${openIssues.length})` : ''}
            </span>
          )}
          {it.hasCard && <span className="card-mark" title="작업 카드 있음">카드</span>}
        </span>
      </div>
      {it.issues.length > 0 && <IssueLines issues={it.issues} now={now} project={project} selected={selectedIssue} />}
    </li>
  );
}

// 열림 · 처리 중 이슈는 모두, 해결 · 닫음은 한 줄로 접어 둔다 (예전 TUI와 같은 방식)
function IssueLines({ issues, now, project, selected }: { issues: Issue[]; now: number; project: string; selected: string | null }) {
  const [showDoneRaw, setShowDone] = useState(false);
  const live = issues.filter((x) => !issueFinished(x.state));
  const fin = issues.filter((x) => issueFinished(x.state));
  // 이슈 카드 패널에 연 이슈가 접힌 해결 줄에 있으면 펼쳐 보인다 (WEB-22)
  const showDone = showDoneRaw || fin.some((x) => x.id === selected);
  const line = (x: Issue) => <IssueLine key={x.id} x={x} now={now} project={project} selected={x.id === selected} />;
  return (
    <ul className="issue-lines">
      {live.map(line)}
      {showDone && fin.map(line)}
      {fin.length > 0 && (
        <li>
          <button className="link-button muted small" onClick={() => setShowDone((v) => !v)} aria-expanded={showDone}>
            해결 {fin.length}개 {showDone ? '▾ 접기' : '▸'}
          </button>
        </li>
      )}
    </ul>
  );
}

// 이슈 줄을 누르면 이슈 카드 패널(?issue=)이 열린다 (WEB-22)
function IssueLine({ x, now, project, selected }: { x: Issue; now: number; project: string; selected: boolean }) {
  const fin = issueFinished(x.state);
  const notes = [x.owner && `@${x.owner}`, x.from && `출처 ${x.from}`, x.github && `GitHub ${x.github}`,
    fin && x.doneAt ? ago(x.doneAt, now) : !fin && x.createdAt ? `발견 ${ago(x.createdAt, now)}` : ''].filter(Boolean);
  return (
    <li className={`issue-line issue-${x.state}${fin ? ' dim' : ''}${selected ? ' selected' : ''}`}>
      <a className="issue-line-link" href={issueHash(project, 'roadmap', null, x.id)} aria-current={selected ? 'true' : undefined} title="이슈 카드 보기">
        <span className={`issue-state s-${x.state}`}>{ISSUE_STATE_LABEL[x.state]}</span>
        <span className={`sev ${fin ? '' : `sev-${x.severity}`}`}>{x.severity}</span>
        <span className="mono">{x.id}</span>
        <span className="issue-title">{x.title}</span>
      </a>
      {notes.length > 0 && <span className="muted small">{notes.join(' · ')}</span>}
    </li>
  );
}
