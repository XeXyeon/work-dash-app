import type { Issue } from '../api';
import { ISSUE_STATE_LABEL, ago, issueFinished } from '../format';
import { issueHash, routeHash, type View } from '../useHashProject';

interface Props {
  x: Issue;
  now: number;
  project: string;
  view: View;
  flow?: string | null;
  parentTitle?: string;   // 부모 로드맵 항목 제목 (이슈 화면에서만)
  selected?: boolean;     // 이슈 카드 패널에 열린 이슈
}

// 이슈 한 줄 (WEB-4). 줄을 누르면 같은 화면 위에 이슈 카드 패널(?issue=)이 열린다 (WEB-22).
// 예전에는 줄 안에서 세부 줄을 펼쳤지만, 같은 내용을 패널이 보여 주므로 펼치기는 없앴다(한 번 누르면 한 곳에서 본다).
// 부모 항목 ID를 누르면 그 항목의 작업 카드 패널을 연다
export function IssueRow({ x, now, project, view, flow = null, parentTitle, selected = false }: Props) {
  const fin = issueFinished(x.state);
  const when = fin && x.doneAt ? `${x.state === 'closed' ? '닫음' : '해결'} ${ago(x.doneAt, now)}`
    : !fin && x.createdAt ? `발견 ${ago(x.createdAt, now)}` : '';
  return (
    <li className={`issue-row issue-${x.state}${fin ? ' dim' : ''}${selected ? ' selected' : ''}`}>
      <div className="issue-row-line">
        <a className="issue-open" href={issueHash(project, view, flow, x.id)} aria-current={selected ? 'true' : undefined}
           title="이슈 카드 보기">
          <span className={`issue-state s-${x.state}`}>{ISSUE_STATE_LABEL[x.state]}</span>
          <span className={`sev ${fin ? '' : `sev-${x.severity}`}`}>{x.severity}</span>
          <span className="mono issue-id">{x.id}</span>
          {x.kind && <span className="issue-kind">{x.kind}</span>}
          <span className="issue-title">{x.title}</span>
        </a>
        <span className="issue-row-side">
          {x.owner && <span className={`owner owner-${x.owner}`}>@{x.owner}</span>}
          {x.parent && (
            <a className="parent-link mono" href={routeHash(project, view, flow, x.parent)} title={parentTitle ? `${x.parent} ${parentTitle} — 작업 카드 보기` : '작업 카드 보기'}>
              {x.parent}
            </a>
          )}
          {when && <span className="muted small nowrap">{when}</span>}
        </span>
      </div>
    </li>
  );
}
