import { useEffect, useRef, type ReactNode } from 'react';
import { PANEL, ResizeHandle } from './ResizeHandle';

interface Props {
  label: string;        // 스크린 리더용 이름 (예: "WEB-4 작업 카드")
  closeHref: string;    // ✕ · Esc로 갈 주소 (패널 쿼리를 뺀 같은 화면)
  focusKey: string;     // 바뀌면 포커스를 옮기고 맨 위로 (다른 항목 · 이슈로 바뀔 때)
  title: ReactNode;     // 머리 왼쪽 (ID · 제목)
  children: ReactNode;
}

// 오른쪽 패널 틀 (WEB-22): 작업 카드 패널 · 이슈 카드 패널이 같은 자리 · 모양 · 닫기 동작을 쓴다.
// 넓은 창(1400px 이상)은 목록 옆에 나란히, 좁으면 위에 덮는다 (styles.css .card-panel).
// 왼쪽 가장자리 손잡이로 폭을 바꾼다 (WEB-23). 손잡이가 스크롤에 따라 움직이지 않도록 바깥(aside)은 고정, 안쪽 div가 스크롤한다
export function SidePanel({ label, closeHref, focusKey, title, children }: Props) {
  const panelRef = useRef<HTMLElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Esc로 닫기. 입력창(이슈 · 흐름 찾기)에서 누른 Esc는 닫지 않는다
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || (e.target as HTMLElement | null)?.closest?.('input, textarea, select')) return;
      location.hash = closeHref;
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [closeHref]);
  // 열리거나 내용이 바뀌면 패널로 포커스를 옮겨 키보드 · 스크린 리더가 바로 읽게 한다
  useEffect(() => { scrollRef.current?.focus(); scrollRef.current?.scrollTo({ top: 0 }); }, [focusKey]);

  return (
    <aside className="card-panel" ref={panelRef} aria-label={label}>
      <ResizeHandle storageKey={PANEL.key} cssVar={PANEL.cssVar} def={PANEL.def} min={PANEL.min} max={PANEL.max}
                    edge="left" target={panelRef} label="카드 패널 폭" className="panel-resize" />
      <div className="card-panel-scroll" ref={scrollRef} tabIndex={-1}>
        <header className="card-panel-head">
          <div className="card-panel-title">{title}</div>
          <a className="card-close" href={closeHref} aria-label="닫기" title="닫기 (Esc)">✕</a>
        </header>
        {children}
      </div>
    </aside>
  );
}
