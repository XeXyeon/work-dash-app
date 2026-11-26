import { useMemo } from 'react';
import { ApiError, useIssues, useRoadmap, type Issue, type ProjectSummary } from '../api';
import { ISSUE_STATE_LABEL, ago, fmtFull, issueFinished } from '../format';
import { useNow } from '../useNow';
import { routeHash, type View } from '../useHashProject';
import { linkRefsPlain, useRefResolver, type RefResolver } from '../refLinks';
import { SidePanel } from './SidePanel';

interface Props {
  project: string;
  summary: ProjectSummary;
  id: string;        // 이슈 ID (예: WEB-10#1, ISS-5)
  view: View;
  flow: string | null;
}

// 이슈 카드 패널 (WEB-22): 작업 카드 패널과 같은 자리 · 모양. 주소의 ?issue=로 열린다.
// 데이터는 이슈 화면과 같은 /api/issues/:project 캐시라, 이슈 파일이 바뀌면 SSE 무효화로 함께 갱신된다
export function IssuePanel({ project, summary, id, view, flow }: Props) {
  const q = useIssues(project, summary.hasIssues);
  const roadmap = useRoadmap(project, summary.hasRoadmap);   // 부모 항목 제목
  const now = useNow();
  const refs = useRefResolver(project, view, flow, id);   // 세부 줄의 항목 · 이슈 ID는 링크로 (WEB-38)
  const x = useMemo(() => q.data && (q.data.issues.find((i) => i.id === id) ?? q.data.common.find((i) => i.id === id)), [q.data, id]);
  const parentTitle = useMemo(() => {
    if (!x?.parent) return undefined;
    for (const ms of roadmap.data?.milestones ?? []) for (const it of ms.items) if (it.id === x.parent) return it.title;
    return undefined;
  }, [roadmap.data, x?.parent]);
  const missing = !summary.hasIssues || (q.isError && q.error instanceof ApiError && q.error.status === 404);

  return (
    <SidePanel label={`${id} 이슈 카드`} closeHref={routeHash(project, view, flow)} focusKey={`issue:${id}`} title={<>
      <span className="mono item-id">{id}</span> <span className="muted small">이슈</span>
      <h2>{x?.title ?? ''}</h2>
    </>}>
      {missing && <p className="muted small">이슈 파일이 없습니다.</p>}
      {!missing && q.isPending && <p className="muted">불러오는 중…</p>}
      {!missing && q.isError && <p className="error">이슈를 불러오지 못했습니다: {q.error.message}</p>}
      {q.data && !x && <p className="muted small">이슈 파일에 이 이슈가 없습니다. 지워졌거나 ID가 바뀌었을 수 있습니다.</p>}
      {x && <IssueBody x={x} now={now} parentHref={x.parent ? routeHash(project, view, flow, x.parent) : ''} parentTitle={parentTitle} refs={refs} />}
    </SidePanel>
  );
}

function IssueBody({ x, now, parentHref, parentTitle, refs }: { x: Issue; now: number; parentHref: string; parentTitle?: string; refs: RefResolver | null }) {
  const linked = (s: string) => ({ __html: linkRefsPlain(s, refs) });
  const fin = issueFinished(x.state);
  const time = (label: string, t?: number) => t
    ? <div><dt>{label}</dt><dd><span className="mono">{fmtFull(t)}</span> <span className="muted small">{ago(t, now)}</span></dd></div>
    : null;
  return (
    <>
      <dl className="card-meta">
        <div><dt>상태</dt><dd><span className={`issue-state s-${x.state}`}>{ISSUE_STATE_LABEL[x.state]}</span></dd></div>
        <div><dt>심각도</dt><dd><span className={`sev ${fin ? '' : `sev-${x.severity}`}`}>{x.severity}</span></dd></div>
        {x.kind && <div><dt>종류</dt><dd>{x.kind}</dd></div>}
        {x.owner && <div><dt>담당</dt><dd><span className={`owner owner-${x.owner}`}>@{x.owner}</span></dd></div>}
        <div><dt>항목</dt><dd>
          {x.parent
            ? <><a className="parent-link mono" href={parentHref} title="작업 카드 보기">{x.parent}</a>{parentTitle && <> {parentTitle}</>}</>
            : <span className="muted">공통 이슈 (부모 항목 없음)</span>}
        </dd></div>
        {time('발견 시각', x.createdAt)}
        {time('시작', x.startedAt)}
        {time(x.state === 'closed' ? '닫음' : '해결', x.doneAt)}
        {x.from && <div><dt>발견</dt><dd className="pre" dangerouslySetInnerHTML={linked(x.from)} /></div>}
        {x.related.length > 0 && <div><dt>관련</dt><dd dangerouslySetInnerHTML={linked(x.related.join(', '))} /></div>}
        {x.github && <div><dt>GitHub</dt><dd>{x.github}</dd></div>}
      </dl>

      <section className="card-sec">
        <h3 className="card-sec-head">세부 <span className="muted">{x.details.length}</span></h3>
        {x.details.length === 0
          ? <p className="muted small">세부 줄이 없습니다.</p>
          : (
            <dl className="issue-detail">
              {x.details.map((d, i) => <div key={i}><dt>{d.key}</dt><dd dangerouslySetInnerHTML={linked(d.value)} /></div>)}
            </dl>
          )}
      </section>
    </>
  );
}
