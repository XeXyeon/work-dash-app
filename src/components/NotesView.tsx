import { useMemo, useState } from 'react';
import { useDisplayName } from '../api';
import { useNotes, type Note } from '../notesApi';
import { markdownToHtml } from '../docsRender';
import { fmtFull } from '../format';
import { linkRefsHtml, useRefResolver, type RefResolver } from '../refLinks';
import { routeHash } from '../useHashProject';

const PAGE = 60;

// 학습 노트 화면 (WEB-35): 작업 카드의 `## 학습 노트`를 개념별로 모아 최근 카드 순으로 보여 준다.
// 같은 개념이 여러 카드에 나오면 한 묶음이고, 항목 ID를 누르면 같은 화면 오른쪽에 그 작업 카드 패널이 열린다
export function NotesView({ project, selectedItem }: { project: string; selectedItem: string | null }) {
  const q = useNotes(project);
  const dn = useDisplayName();
  const refs = useRefResolver(project, 'notes', null);   // 본문의 항목 · 이슈 ID는 링크로 (WEB-38)
  const [filter, setFilter] = useState('');
  const [limit, setLimit] = useState(PAGE);
  const k = filter.trim().toLowerCase();
  const shown = useMemo(
    () => (q.data?.notes ?? []).filter((n) => !k || n.name.toLowerCase().includes(k) || n.entries.some((e) => e.body.toLowerCase().includes(k))),
    [q.data, k],
  );

  if (q.isPending) return <p className="muted pad">불러오는 중…</p>;
  if (q.isError) return <p className="error pad">학습 노트를 불러오지 못했습니다: {q.error.message}</p>;
  const total = q.data.notes.length;
  return (
    <section className="notes">
      <header className="flows-head">
        <h2 className="roadmap-title">{dn(project)} 학습 노트</h2>
        <span className="muted small">개념 {total}개 · 작업 카드 {q.data.cards}개에서 모음</span>
      </header>
      <input className="note-filter" placeholder="개념 이름 · 본문 찾기" value={filter} aria-label="학습 노트 찾기"
             onChange={(e) => { setFilter(e.target.value); setLimit(PAGE); }} />
      {!total && <p className="muted">학습 노트가 없습니다. 작업 카드의 <code>## 학습 노트</code> 아래 <code>### 개념</code>이 여기에 모입니다.</p>}
      {total > 0 && !shown.length && <p className="muted">맞는 노트가 없습니다.</p>}
      <div className="note-list">
        {shown.slice(0, limit).map((n) => (
          <NoteCard key={n.key} note={n} project={project} selectedItem={selectedItem} open={!!k && shown.length <= 5} refs={refs} />
        ))}
      </div>
      {shown.length > limit && <button className="link-button note-more" onClick={() => setLimit(limit + PAGE)}>더 보기 ({shown.length - limit}개 남음)</button>}
    </section>
  );
}

function NoteCard({ note, project, selectedItem, open, refs }: { note: Note; project: string; selectedItem: string | null; open: boolean; refs: RefResolver | null }) {
  const [toggled, setToggled] = useState<boolean | null>(null);   // 묶음 전체의 펼침 상태
  const isOpen = toggled ?? open;
  return (
    <article className="note-card">
      <header className="note-head">
        <button className="note-toggle" aria-expanded={isOpen} onClick={() => setToggled(!isOpen)}>
          <span className="note-caret" aria-hidden>{isOpen ? '▾' : '▸'}</span>
          <h3 className="note-name">{note.name}</h3>
        </button>
        <span className="note-ids">
          {note.entries.map((e, i) => (
            <a key={`${e.item}-${i}`} className={`mono item-id item-id-link${e.item === selectedItem ? ' selected' : ''}`} href={routeHash(project, 'notes', null, e.item)}
               title={`${e.cardTitle || e.item} · ${fmtFull(e.date)}`}>{e.item}</a>
          ))}
        </span>
        <span className="muted small mono">{fmtFull(note.latest).slice(0, 10)}</span>
      </header>
      {isOpen && note.entries.map((e, i) => (
        <div key={`${e.item}-${i}`} className="note-entry">
          {note.entries.length > 1 && (
            <p className="muted small note-entry-head">
              <a className="mono" href={routeHash(project, 'notes', null, e.item)}>{e.item}</a> {e.cardTitle} · {fmtFull(e.date)}
            </p>
          )}
          <div className="md" dangerouslySetInnerHTML={{ __html: linkRefsHtml(markdownToHtml(e.body), refs) }} />
        </div>
      ))}
    </article>
  );
}
