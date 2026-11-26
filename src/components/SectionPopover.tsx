import { useEffect, useMemo, useRef, useState } from 'react';
import { usePlanSection } from '../plansApi';
import { markdownToHtml } from '../docsRender';
import { routeHash } from '../useHashProject';

interface Target { project: string; num: string; x: number; top: number; bottom: number }
const WIDTH = 560;
const MAX_H = 420;

// 절 참조 상자 (WEB-39): 본문의 §4.7(refLinks가 만든 .sec-ref 버튼)을 누르면 그 자리에 절 내용을 보여 준다.
// 본문은 dangerouslySetInnerHTML로 들어가므로 버튼마다 핸들러를 달 수 없어 문서 전체에서 클릭을 듣는다.
export function SectionPopover() {
  const [t, setT] = useState<Target | null>(null);
  const [pick, setPick] = useState(0);   // 같은 번호가 여러 문서에 있을 때 고른 문서
  const box = useRef<HTMLDivElement>(null);
  const q = usePlanSection(t?.project ?? null, t?.num ?? null);

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      const el = (e.target as HTMLElement | null)?.closest?.<HTMLElement>('.sec-ref');
      if (el?.dataset.project && el.dataset.sec) {
        const r = el.getBoundingClientRect();
        setPick(0);
        setT((cur) => (cur && cur.project === el.dataset.project && cur.num === el.dataset.sec && cur.top === r.top
          ? null   // 같은 참조를 다시 누르면 닫는다
          : { project: el.dataset.project!, num: el.dataset.sec!, x: r.left, top: r.top, bottom: r.bottom }));
        return;
      }
      if (!box.current?.contains(e.target as Node)) setT(null);
    };
    // Esc는 카드 패널보다 먼저 받아 상자만 닫는다 (SidePanel도 window에서 Esc를 듣는다)
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || !box.current) return;
      e.stopImmediatePropagation();
      setT(null);
    };
    const close = () => setT(null);
    document.addEventListener('click', onClick);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('hashchange', close);
    window.addEventListener('resize', close);
    return () => {
      document.removeEventListener('click', onClick);
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('hashchange', close);
      window.removeEventListener('resize', close);
    };
  }, []);

  const m = q.data?.matches ?? [];
  const cur = m[Math.min(pick, Math.max(m.length - 1, 0))];
  const html = useMemo(() => (cur ? markdownToHtml(cur.content) : ''), [cur]);
  if (!t) return null;

  // 참조 아래에 띄우고, 아래 자리가 모자라면 위에 띄운다
  const width = Math.min(WIDTH, window.innerWidth - 24);
  const left = Math.max(12, Math.min(t.x, window.innerWidth - width - 12));
  const below = window.innerHeight - t.bottom - 16;
  const up = below < 220 && t.top > below;
  const maxHeight = Math.min(MAX_H, Math.max(160, (up ? t.top : below) - 8));
  const pos = up ? { bottom: window.innerHeight - t.top + 6 } : { top: t.bottom + 6 };

  return (
    <div ref={box} className="sec-pop" role="dialog" aria-label={`§${t.num} 절 내용`} style={{ left, width, maxHeight, ...pos }}>
      <header className="sec-pop-head">
        <span className="mono sec-pop-num">§{t.num}</span>
        <span className="sec-pop-title">{cur ? cur.title.replace(/^§?\s*[\d.]+[.)]?\s*/, '').replace(/[`*]/g, '') : ''}</span>
        <button type="button" className="card-close sec-pop-close" onClick={() => setT(null)} aria-label="닫기" title="닫기 (Esc)">✕</button>
      </header>
      {q.isPending && <p className="muted small">찾는 중…</p>}
      {q.isError && <p className="error small">절을 읽지 못했습니다: {q.error.message}</p>}
      {q.data && !cur && <p className="muted small">이 프로젝트의 <code>docs/</code> 문서에서 제목이 <code>{t.num}</code>로 시작하는 절을 찾지 못했습니다.</p>}
      {cur && (
        <>
          <p className="sec-pop-meta small muted">
            <a href={routeHash(t.project, 'plans', cur.id)} title="기획 탭에서 문서 열기"><span className="mono">{cur.repo}/docs/{cur.path}</span> 열기</a>
            {m.length > 1 && m.map((x, i) => (
              <button key={x.id} type="button" className={`link-button small${x === cur ? ' selected' : ''}`} onClick={() => setPick(i)} title={`${x.repo}/docs/${x.path}`}>
                {x.path.split('/').pop()}
              </button>
            ))}
          </p>
          {cur.content
            ? <div className="md sec-pop-body" dangerouslySetInnerHTML={{ __html: html }} />
            : <p className="muted small">제목만 있고 내용이 없는 절입니다.</p>}
          {cur.truncated && <p className="muted small">절이 길어 앞부분만 보여 줍니다.</p>}
        </>
      )}
    </div>
  );
}
