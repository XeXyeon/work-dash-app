import { useMemo } from 'react';
import { ApiError, useCard, useDisplayName, useItemDetail, useRoadmap, type Item, type ItemDetail, type ProjectSummary } from '../api';
import { ago, fmtFull, itemStatus } from '../format';
import { mdToHtml } from '../flowsMarkdown';
import { linkRefsHtml, useRefResolver } from '../refLinks';
import { useNow } from '../useNow';
import { routeHash, type View } from '../useHashProject';
import { IssueRow } from './IssueRow';
import { SidePanel } from './SidePanel';

interface Props {
  project: string;
  summary: ProjectSummary;
  id: string;        // 항목 ID (ID가 없는 항목은 제목)
  view: View;
  flow: string | null;
  closeHref?: string;   // 닫으면 갈 주소. 기본은 같은 프로젝트 화면 (세션 알림 화면에서 열면 #sessions, WEB-19 재설계)
}

// 작업 카드 상세 패널 (WEB-4): 항목 정보 · 항목 이슈 · 작업 카드 · 작업 내역(detail.js)
// 주소의 ?item=으로 열리므로 어느 화면 위에서든 같은 패널이 뜨고, 뒤로 가기로 닫힌다. 틀(Esc · 포커스 · 머리)은 SidePanel
export function CardPanel({ project, summary, id, view, flow, closeHref: closeTo }: Props) {
  const roadmap = useRoadmap(project, summary.hasRoadmap);
  const card = useCard(project, id);
  const dn = useDisplayName();
  const now = useNow();
  const item = useMemo(
    () => roadmap.data?.milestones.flatMap((m) => m.items).find((it) => (it.id ? it.id === id : it.title === id)),
    [roadmap.data, id],
  );
  const milestone = roadmap.data?.milestones.find((m) => m.items.includes(item!))?.name;
  const closeHref = closeTo ?? routeHash(project, view, flow);

  // 본문의 항목 · 이슈 ID는 링크로 (WEB-38)
  const refs = useRefResolver(project, view, flow, id);
  const html = useMemo(() => (card.data ? linkRefsHtml(mdToHtml(card.data.markdown.replace(/^# .*\n?/, ''), { card: true }), refs) : ''), [card.data, refs]);
  const noCard = card.isError && card.error instanceof ApiError && card.error.status === 404;
  const title = item?.title ?? (card.data?.markdown.match(/^# (.*)/)?.[1].replace(new RegExp(`^${escRe(id)}\\s*`), '') || '');

  return (
    <SidePanel label={`${id} 작업 카드`} closeHref={closeHref} focusKey={`item:${id}`} title={<>
      {/* ID를 누르면 그 프로젝트의 로드맵으로 가서 이 항목을 보여 준다 (세션 알림 · 다른 탭에서 열었을 때) */}
      {item?.id !== '' && (
        <a className="mono item-id item-id-link" href={routeHash(project, 'roadmap', null, id)} title={`${dn(project)} 로드맵에서 보기`}>{id}</a>
      )}
      <h2>{title || (item ? '' : id)}</h2>
    </>}>
      {item && <ItemMeta item={item} milestone={milestone} now={now} project={project} view={view} flow={flow} />}
      {!item && summary.hasRoadmap && roadmap.data && <p className="muted small">로드맵에 이 항목이 없습니다.</p>}

      {item && item.issues.length > 0 && (
        <section className="card-sec">
          <h3 className="card-sec-head">이슈 <span className="muted">{item.issues.length}</span></h3>
          <ul className="issue-list">
            {item.issues.map((x) => <IssueRow key={x.id} x={x} now={now} project={project} view={view} flow={flow} />)}
          </ul>
        </section>
      )}

      <section className="card-sec">
        <h3 className="card-sec-head">
          작업 카드
          {card.data && <span className="muted small" title={fmtFull(card.data.mtime)}> · 수정 {ago(card.data.mtime, now)}</span>}
        </h3>
        {card.isPending && <p className="muted">불러오는 중…</p>}
        {noCard && <p className="muted small">작업 카드가 없습니다. <code>~/.work-dash/worklogs/{project}/{id}.md</code>가 생기면 바로 나타납니다.</p>}
        {card.isError && !noCard && <p className="error">작업 카드를 불러오지 못했습니다: {card.error.message}</p>}
        {card.data && <div className="md card-md" dangerouslySetInnerHTML={{ __html: html }} />}
      </section>

      {item && <WorkHistory project={project} id={id} />}
    </SidePanel>
  );
}

const escRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function ItemMeta({ item, milestone, now, project, view, flow }: { item: Item; milestone?: string; now: number; project: string; view: View; flow: string | null }) {
  const st = itemStatus(item, now);
  const dn = useDisplayName();
  return (
    <dl className="card-meta">
      <div><dt>상태</dt><dd><span className={`t-${st.tone}`}>{item.state === 'done' ? '완료' : st.text}</span>
        {item.owner && <span className={`owner owner-${item.owner}`}> @{item.owner}</span>}</dd></div>
      {milestone && <div><dt>마일스톤</dt><dd>{milestone}</dd></div>}
      {item.after.length > 0 && (
        <div><dt>선행</dt><dd>
          {item.after.map((a, i) => {
            // 다른 프로젝트 항목을 가리키는 선행('BE:MAT-11')은 그 프로젝트의 항목으로 연결한다 (WEB-31). 파서가 xrefs를 주지 않으면 지금처럼 이 프로젝트
            const x = item.xrefs?.[a];
            const href = x ? routeHash(x.project, 'roadmap', null, x.id) : routeHash(project, view, flow, a);
            return <span key={a}>{i > 0 && ', '}<a className="mono" href={href} title={x ? `${dn(x.project)} · ${x.id}${x.found ? '' : ' (찾지 못함)'}` : undefined}>{a}</a>{item.waiting.includes(a) && <span className="t-blocked small"> 대기</span>}</span>;
          })}
        </dd></div>
      )}
      {item.startedAt && <div><dt>시작</dt><dd className="mono">{fmtFull(item.startedAt)}</dd></div>}
      {item.doneAt && <div><dt>완료</dt><dd className="mono">{item.estimated ? '~' : ''}{fmtFull(item.doneAt)}</dd></div>}
    </dl>
  );
}

// 작업 내역: 항목이 진행된 시간대(또는 ID가 언급된) 대화 기록 · 커밋 · 바뀐 파일 (core/detail.js)
function WorkHistory({ project, id }: { project: string; id: string }) {
  const q = useItemDetail(project, id);
  return (
    <section className="card-sec">
      <h3 className="card-sec-head">
        작업 내역
        <button className="link-button muted small refresh" onClick={() => q.refetch()} disabled={q.isFetching}>
          {q.isFetching ? '읽는 중…' : '다시 읽기'}
        </button>
      </h3>
      {q.isPending && <p className="muted small">세션 기록과 커밋을 읽는 중…</p>}
      {q.isError && <p className="error small">작업 내역을 읽지 못했습니다: {q.error.message}</p>}
      {q.data && <HistoryBody d={q.data} />}
    </section>
  );
}

function HistoryBody({ d }: { d: ItemDetail }) {
  const range = d.mode === 'window'
    ? `${fmtFull(d.from!)} ~ ${fmtFull(d.to!)} 사이 기록`
    : '시작 시각 기록이 없어 ID가 언급된 기록만';
  const empty = !d.commits.length && !d.files.length && !d.asks.length && !d.agents.length;
  return (
    <div className="history">
      <p className="muted small">{range}</p>
      {empty && <p className="muted small">찾은 기록이 없습니다.</p>}
      {d.commits.length > 0 && (
        <>
          <h4>커밋 <span className="muted">{d.commits.length}</span></h4>
          <ul className="history-list">
            {d.commits.map((c, i) => (
              <li key={i}><span className="mono muted">{fmtFull(c.t)}</span> {c.subject} <span className="diffstat mono"><span className="add">+{c.add}</span> <span className="del">−{c.del}</span></span></li>
            ))}
          </ul>
        </>
      )}
      {d.files.length > 0 && (
        <details>
          <summary>바뀐 파일 <span className="muted">{d.files.length}</span></summary>
          <ul className="history-list mono small">
            {d.files.map((f) => (
              <li key={f.path}>{f.path}{f.add != null && <span className="diffstat"> <span className="add">+{f.add}</span> <span className="del">−{f.del}</span></span>}</li>
            ))}
          </ul>
        </details>
      )}
      {d.asks.length > 0 && (
        <details>
          <summary>요청 <span className="muted">{d.asksTotal}{d.asksTotal > d.asks.length ? ` (최근 ${d.asks.length}개)` : ''}</span></summary>
          <ul className="history-list asks">
            {d.asks.map((a, i) => (
              <li key={i}><span className="mono muted small">{fmtFull(a.t)} · {a.source === 'gpt' ? 'GPT' : 'Claude'}</span><div className="ask-text">{a.text}</div></li>
            ))}
          </ul>
        </details>
      )}
      {d.agents.length > 0 && (
        <details>
          <summary>서브에이전트 <span className="muted">{d.agents.length}</span></summary>
          <ul className="history-list small">{d.agents.map((a) => <li key={a}>{a}</li>)}</ul>
        </details>
      )}
    </div>
  );
}
