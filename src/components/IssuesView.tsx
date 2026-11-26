import { useMemo, useState } from 'react';
import { ApiError, useDisplayName, useIssues, useRoadmap, type Issue, type ProjectSummary } from '../api';
import { useNow } from '../useNow';
import { IssueRow } from './IssueRow';

interface Props { project: string; summary: ProjectSummary; selected: string | null }   // selected: 이슈 카드 패널에 열린 이슈 (WEB-22)

// 이슈 화면 (WEB-4): 처리 중 → 열림 → 해결 · 닫음(접힘) 순으로 묶는다. 묶음 안은 서버 순서(심각도 → ID)
export function IssuesView({ project, summary, selected }: Props) {
  const q = useIssues(project, summary.hasIssues);
  const dn = useDisplayName();
  const roadmap = useRoadmap(project, summary.hasRoadmap);   // 부모 항목 제목 (로드맵 화면과 같은 캐시)
  const now = useNow();
  const [filter, setFilter] = useState('');
  const [showDone, setShowDone] = useState(false);

  const titles = useMemo(() => {
    const m = new Map<string, string>();
    for (const ms of roadmap.data?.milestones ?? []) for (const it of ms.items) if (it.id) m.set(it.id, it.title);
    return m;
  }, [roadmap.data]);

  const shown = useMemo(() => {
    const k = filter.trim().toLowerCase();
    const all = q.data?.issues ?? [];
    if (!k) return all;
    return all.filter((x) => [x.id, x.title, x.kind, x.parent, x.owner, titles.get(x.parent) ?? '', ...x.details.map((d) => d.value)]
      .some((s) => s.toLowerCase().includes(k)));
  }, [q.data, filter, titles]);

  const missing = !summary.hasIssues || (q.isError && q.error instanceof ApiError && q.error.status === 404);
  if (missing) {
    return (
      <section className="issues">
        <h2 className="roadmap-title">{dn(project)}</h2>
        <p className="muted">이슈 파일이 없습니다.</p>
        <p className="muted small"><code>~/.work-dash/issues/{project}.md</code>가 생기면 여기에 바로 나타납니다. 프로젝트 폴더에서 <code>/issue add …</code>로 적을 수 있습니다.</p>
      </section>
    );
  }
  if (q.isPending) return <p className="muted pad">불러오는 중…</p>;
  if (q.isError) return <p className="error pad">이슈를 불러오지 못했습니다: {q.error.message}</p>;

  const all = q.data.issues;
  const by = (st: Issue['state'][]) => shown.filter((x) => st.includes(x.state));
  const doing = by(['doing']), open = by(['open']), fin = by(['done', 'closed']);
  const count = (st: Issue['state']) => all.filter((x) => x.state === st).length;
  const searching = filter.trim() !== '';
  // 패널에 연 이슈가 해결 · 닫음 묶음에 있으면 그 묶음도 펼쳐 줄을 보이게 한다
  const finOpen = showDone || (searching && fin.length > 0) || fin.some((x) => x.id === selected);
  const rows = (list: Issue[]) => (
    <ul className="issue-list">
      {list.map((x) => <IssueRow key={x.id} x={x} now={now} project={project} view="issues" parentTitle={titles.get(x.parent)} selected={x.id === selected} />)}
    </ul>
  );

  return (
    <section className="issues">
      <header className="roadmap-head">
        <h2 className="roadmap-title">{dn(project)}</h2>
        <span className="issue-counts muted">
          <span>처리 중 <b className="t-doing">{count('doing')}</b></span>
          <span>열림 <b className="s-open">{count('open')}</b></span>
          <span>해결 <b>{count('done')}</b></span>
          {count('closed') > 0 && <span>닫음 <b>{count('closed')}</b></span>}
          <span>공통 {q.data.common.length}</span>
        </span>
      </header>
      {all.length > 0 && (
        <input className="flow-filter issue-filter" placeholder="이슈 찾기 (ID · 제목 · 항목 · 내용)" value={filter}
               onChange={(e) => setFilter(e.target.value)} aria-label="이슈 찾기" />
      )}
      {!all.length && <p className="muted">이슈가 없습니다.</p>}
      {searching && !shown.length && <p className="muted">맞는 이슈가 없습니다.</p>}

      {doing.length > 0 && <div className="issue-group"><h3 className="issue-group-head">처리 중 <span className="muted">{doing.length}</span></h3>{rows(doing)}</div>}
      {open.length > 0 && <div className="issue-group"><h3 className="issue-group-head">열림 <span className="muted">{open.length}</span></h3>{rows(open)}</div>}
      {fin.length > 0 && (
        <div className="issue-group">
          <h3 className="issue-group-head">
            <button className="link-button" onClick={() => setShowDone((v) => !v)} aria-expanded={finOpen} disabled={searching}>
              <span className="fold-icon" aria-hidden>{finOpen ? '▾' : '▸'}</span> 해결 · 닫음 <span className="muted">{fin.length}</span>
            </button>
          </h3>
          {finOpen && rows(fin)}
        </div>
      )}
    </section>
  );
}
