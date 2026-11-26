import { useMemo, useState } from 'react';
import { useDisplayName } from '../api';
import { useImprovements, type ImprovementRecord, type SolvedProblem } from '../improvementsApi';
import { markdownToHtml } from '../docsRender';
import { fmtFull } from '../format';
import { linkRefsHtml, useRefResolver, type RefResolver } from '../refLinks';
import { routeHash } from '../useHashProject';

const PAGE = 40;
const MEASURED = { measured: '측정', estimate: '어림' } as const;

// 개선 기록 화면 (WEB-41): 전후를 비교할 수 있는 변화를 모아 보여 준다.
// 위: improvements/<프로젝트>.md에 직접 쓴 기록(전 → 후 숫자). 아래: 작업 카드의 `## 막혔던 문제와 해결`을 자동으로 모은 것
export function ImprovementsView({ project, selectedItem }: { project: string; selectedItem: string | null }) {
  const q = useImprovements(project);
  const dn = useDisplayName();
  const refs = useRefResolver(project, 'improve', null);
  const [filter, setFilter] = useState('');
  const [limit, setLimit] = useState(PAGE);
  const k = filter.trim().toLowerCase();
  const records = useMemo(() => (q.data?.records ?? []).filter((r) => !k || `${r.title}\n${r.body}`.toLowerCase().includes(k)), [q.data, k]);
  const solved = useMemo(() => (q.data?.solved ?? []).filter((s) => !k || `${s.item} ${s.cardTitle}\n${s.body}`.toLowerCase().includes(k)), [q.data, k]);

  if (q.isPending) return <p className="muted pad">불러오는 중…</p>;
  if (q.isError) return <p className="error pad">개선 기록을 불러오지 못했습니다: {q.error.message}</p>;
  const all = q.data.records;
  const measured = all.filter((r) => r.measured === 'measured').length;
  return (
    <section className="notes improve">
      <header className="flows-head">
        <h2 className="roadmap-title">{dn(project)} 개선 기록</h2>
        <span className="muted small">기록 {all.length}건{all.length > 0 && ` (측정 ${measured} · 어림 ${all.filter((r) => r.measured === 'estimate').length})`} · 작업 카드의 문제 해결 {q.data.solved.length}건</span>
      </header>
      <input className="note-filter" placeholder="제목 · 본문 찾기" value={filter} aria-label="개선 기록 찾기"
             onChange={(e) => { setFilter(e.target.value); setLimit(PAGE); }} />

      <h3 className="improve-group">기록 <span className="muted small">전과 후를 비교할 수 있는 변화</span></h3>
      {!all.length && (
        <p className="muted">
          {q.data.hasFile ? '기록이 없습니다.' : <>아직 기록 파일이 없습니다. <code>~/.work-dash/improvements/{project}.md</code>에 <code>## 날짜 제목</code>으로 적으면 여기에 보입니다.</>}
          {' '}형식은 <a href="#docs/format-improvements">IMPROVEMENTS-FORMAT.md</a>에 있습니다.
        </p>
      )}
      {all.length > 0 && !records.length && <p className="muted">맞는 기록이 없습니다.</p>}
      <div className="note-list">
        {records.map((r) => <RecordCard key={r.key} rec={r} refs={refs} />)}
      </div>

      <h3 className="improve-group">작업 카드에서 모은 문제 해결 <span className="muted small">카드의 "막혔던 문제와 해결" 절</span></h3>
      {!q.data.solved.length && <p className="muted">작업 카드에 <code>## 막혔던 문제와 해결</code> 절이 아직 없습니다.</p>}
      {q.data.solved.length > 0 && !solved.length && <p className="muted">맞는 문제 해결이 없습니다.</p>}
      <div className="note-list">
        {solved.slice(0, limit).map((s) => <SolvedCard key={s.item} s={s} project={project} selected={s.item === selectedItem} open={!!k && solved.length <= 5} refs={refs} />)}
      </div>
      {solved.length > limit && <button className="link-button note-more" onClick={() => setLimit(limit + PAGE)}>더 보기 ({solved.length - limit}개 남음)</button>}
    </section>
  );
}

function RecordCard({ rec, refs }: { rec: ImprovementRecord; refs: RefResolver | null }) {
  const [open, setOpen] = useState(false);
  // 전 → 후 줄 끝의 (측정) · (어림)은 배지로 따로 보이므로 숫자 줄에서는 뗀다
  const metric = rec.metric?.replace(/\s*\((측정|어림)\)\s*$/, '');
  return (
    <article className="note-card improve-card">
      <header className="note-head">
        <button className="note-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
          <span className="note-caret" aria-hidden>{open ? '▾' : '▸'}</span>
          <h3 className="note-name">{rec.title}</h3>
        </button>
        {rec.kind && <span className="chip">{rec.kind}</span>}
        {rec.date != null && <span className="muted small mono">{fmtFull(rec.date).slice(0, 10)}</span>}
      </header>
      {metric && (
        <p className="improve-metric">
          <span className="md" dangerouslySetInnerHTML={{ __html: linkRefsHtml(markdownToHtml(metric), refs) }} />
          {rec.measured && <span className={`chip improve-${rec.measured}`} title={rec.measured === 'measured' ? '직접 잰 값' : '파일 크기 등으로 계산한 어림값'}>{MEASURED[rec.measured]}</span>}
        </p>
      )}
      {open && <div className="md note-entry" dangerouslySetInnerHTML={{ __html: linkRefsHtml(markdownToHtml(rec.body), refs) }} />}
    </article>
  );
}

function SolvedCard({ s, project, selected, open, refs }: { s: SolvedProblem; project: string; selected: boolean; open: boolean; refs: RefResolver | null }) {
  const [toggled, setToggled] = useState<boolean | null>(null);
  const isOpen = toggled ?? open;
  return (
    <article className="note-card">
      <header className="note-head">
        <button className="note-toggle" aria-expanded={isOpen} onClick={() => setToggled(!isOpen)}>
          <span className="note-caret" aria-hidden>{isOpen ? '▾' : '▸'}</span>
          <h3 className="note-name">{s.cardTitle || s.item}</h3>
        </button>
        <span className="note-ids">
          <a className={`mono item-id item-id-link${selected ? ' selected' : ''}`} href={routeHash(project, 'improve', null, s.item)} title="작업 카드 열기">{s.item}</a>
        </span>
        <span className="muted small mono">{fmtFull(s.date).slice(0, 10)}</span>
      </header>
      {isOpen && <div className="md note-entry" dangerouslySetInnerHTML={{ __html: linkRefsHtml(markdownToHtml(s.body), refs) }} />}
    </article>
  );
}
