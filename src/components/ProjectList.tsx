import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { flushSync } from 'react-dom';
import { useDisplayName, useProjectAction, type ProjectSummary } from '../api';
import { ProgressBar } from './ProgressBar';
import { TrashDialog } from './TrashDialog';

interface Props { projects: ProjectSummary[]; archived: ProjectSummary[]; selected: string | null; onSelect: (p: string) => void }

// 프로젝트 순서 (WEB-24): 화면 쪽 localStorage에만 저장한다. 실패해도 기본 순서로 동작
const ORDER_KEY = 'work-dash.project-order.v1';
const DRAG_THRESHOLD = 5; // px. 이만큼 움직이기 전에 떼면 클릭(프로젝트 선택)
const SCROLL_EDGE = 36; // px. 목록 위·아래 끝에서 이 안쪽으로 끌면 목록이 스크롤된다
const SCROLL_SPEED = 10; // px/프레임
const SETTLE_MS = 150; // 놓을 때 카드가 내려앉는 시간 (styles.css .drag-ghost.settling과 맞춘다)
function loadOrder(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(ORDER_KEY) ?? '[]');
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch { return []; }
}
function saveOrder(order: string[]) {
  try { localStorage.setItem(ORDER_KEY, JSON.stringify(order)); } catch { /* 저장 실패는 무시 */ }
}
// 저장된 순서대로 놓고, 저장된 적 없는 새 프로젝트는 지금 순서대로 뒤에 붙인다. 사라진 이름은 무시
function applyOrder(projects: ProjectSummary[], order: string[]): ProjectSummary[] {
  const rank = new Map(order.map((n, i) => [n, i]));
  const known = projects.filter((p) => rank.has(p.project)).sort((a, b) => rank.get(a.project)! - rank.get(b.project)!);
  return [...known, ...projects.filter((p) => !rank.has(p.project))];
}

// 사이드바 프로젝트 목록 + 보관함 (WEB-14)
// - 보관: 파일은 그대로 두고 목록에서만 숨긴다 (data/archived-projects.json). 보관함에서 복원
// - 삭제: 파일을 ~/.work-dash/trash/로 옮긴다. 확인 창에서 프로젝트 이름을 입력해야 실행
// - 순서(WEB-24): pointer 이벤트로 끌어서 옮기거나 포커스에서 Alt+↑/↓. (Tauri 창에서 HTML5 DnD가 안 될 수 있어 쓰지 않는다)
export function ProjectList({ projects, archived, selected, onSelect }: Props) {
  const [trashing, setTrashing] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);   // 카드 자리에서 이름을 고치는 중인 프로젝트 (WEB-31)
  const dn = useDisplayName();
  // n: 같은 문구가 연달아 나와도 알림 애니메이션을 다시 시작하려고 key에 섞는다
  const [notice, setNoticeState] = useState({ text: '', n: 0 });
  const setNotice = (text: string) => setNoticeState((s) => ({ text, n: s.n + 1 }));
  const action = useProjectAction({
    onSuccess: (r, v) => setNotice(
      v.action === 'archive' ? `${dn(v.project)} 보관함으로 옮김`
        : v.action === 'unarchive' ? `${dn(v.project)} 복원함`
          : v.action === 'rename' ? (r.displayName && r.displayName !== v.project ? `${v.project} 이름을 "${r.displayName}"(으)로 바꿈` : `${v.project} 이름을 원래대로 되돌림`)
            : `${dn(v.project)} 휴지통으로 옮김 (${r.moved?.length ?? 0}개)`),
    onError: (e, v) => setNotice(`${dn(v.project)}: ${e.message}`),
  });

  const [order, setOrder] = useState(loadOrder);
  const ordered = useMemo(() => applyOrder(projects, order), [projects, order]);
  const orderedRef = useRef(ordered); orderedRef.current = ordered;
  const orderRef = useRef(order); orderRef.current = order;
  const navRef = useRef<HTMLElement>(null);
  const focusAfter = useRef<string | null>(null);

  // 보이는 목록의 새 순서를 저장. 지금 목록에 없는 이름(보관 중인 프로젝트 등)은 뒤에 남겨 둔다
  const commit = (names: string[]) => {
    const next = [...names, ...orderRef.current.filter((n) => !names.includes(n))];
    orderRef.current = next; setOrder(next); saveOrder(next);
  };
  // insertBefore: 옮기기 전 목록 기준으로 "이 번호 앞"에 끼워 넣는다
  const moveTo = (name: string, insertBefore: number) => {
    const names = orderedRef.current.map((p) => p.project);
    const from = names.indexOf(name);
    if (from < 0) return false;
    const to = insertBefore > from ? insertBefore - 1 : insertBefore;
    if (to === from || to < 0 || to >= names.length) return false;
    names.splice(from, 1); names.splice(to, 0, name);
    commit(names);
    return true;
  };
  // 키보드로 옮긴 뒤 같은 버튼에 포커스를 되돌린다 (줄이 옮겨지면 포커스가 풀릴 수 있다)
  useEffect(() => {
    const name = focusAfter.current; focusAfter.current = null;
    if (!name) return;
    navRef.current?.querySelector<HTMLButtonElement>(`.project-row[data-project="${CSS.escape(name)}"] .project`)?.focus();
  }, [ordered]);
  const onKeyDown = (e: ReactKeyboardEvent, name: string) => {
    if (!(e.target as HTMLElement).closest('.project') || !e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
    e.preventDefault();
    const from = orderedRef.current.findIndex((p) => p.project === name);
    focusAfter.current = name;
    if (!moveTo(name, e.key === 'ArrowUp' ? from - 1 : from + 2)) focusAfter.current = null;
  };

  // 끌기 (WEB-24 + 시각 효과): 끄는 동안 React 상태는 건드리지 않고 DOM을 직접 바꾼다.
  // - 줄을 복제한 "떠 있는 카드"(.drag-ghost, body에 fixed)가 포인터를 따라 세로로만 움직인다
  // - 원래 줄은 빈 자리(data-dragging)로 남고, 다른 줄은 놓일 자리만큼 transform으로 비켜 준다
  // - 줄 위치는 시작 때 한 번 재서 "목록 내용 기준 y"로 저장해 두므로, 자동 스크롤 중에도 계산이 어긋나지 않는다
  const busyRef = useRef(false);
  const cleanupRef = useRef<(() => void) | null>(null);
  useEffect(() => () => cleanupRef.current?.(), []);
  const onRowPointerDown = (e: ReactPointerEvent, name: string) => {
    const nav = navRef.current;
    if (busyRef.current || e.button !== 0 || !nav || (e.target as HTMLElement).closest('.row-menu, .project-rename')) return;
    const rowEl = e.currentTarget as HTMLElement;
    const sx = e.clientX, sy = e.clientY;
    const scroller = nav.closest<HTMLElement>('.sidebar-scroll');
    const getScroll = () => (scroller ? scroller.scrollTop : window.scrollY);
    let dragging = false, y = sy, dir = 0, raf = 0, to = 0;
    let rows: HTMLElement[] = [], tops: number[] = [], heights: number[] = [], from = 0, step = 0;
    let ghost: HTMLElement | null = null, offY = 0, minY = -Infinity, maxY = Infinity;
    const reduced = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    // 떠 있는 카드의 화면 y(위쪽 모서리)
    const cardY = () => Math.min(maxY, Math.max(minY, y - offY));
    const place = (cy: number, scale: number) => { if (ghost) ghost.style.transform = `translate3d(0, ${cy}px, 0) scale(${scale})`; };
    // 빈 자리(원래 줄)도 놓일 자리로 같이 옮긴다. 원래 위치에 남겨 두면 비켜 주며 들어오는 줄이 그 밑으로 가려진다
    const shiftRows = (t: number) => {
      rows.forEach((r, i) => {
        const d = i === from ? (t > from ? tops[t] + heights[t] - heights[from] : tops[t]) - tops[from]
          : from < t && i > from && i <= t ? -step : t < from && i >= t && i < from ? step : 0;
        r.style.transform = d ? `translate3d(0, ${d}px, 0)` : '';
      });
    };
    const update = () => {
      const cy = cardY();
      place(cy, 1.03);
      const center = cy + heights[from] / 2 + getScroll(); // 목록 내용 기준 y
      let ins = rows.length;
      // 한 칸 높이만큼 정확히 옮겼을 때(카드 중심 = 옆 줄 중심)도 자리를 바꾼다
      for (let i = 0; i < rows.length; i++) if (center <= tops[i] + heights[i] / 2) { ins = i; break; }
      const t = ins > from ? ins - 1 : ins; // 최종 자리 번호
      if (t !== to) { to = t; shiftRows(to); }
    };
    // 최종 자리의 화면 y
    const slotY = (t: number) => (t > from ? tops[t] + heights[t] - heights[from] : tops[t]) - getScroll();
    const tick = () => {
      if (scroller && dir) scroller.scrollTop += dir * SCROLL_SPEED;
      update();
      raf = requestAnimationFrame(tick);
    };
    const onSelect = (ev: Event) => ev.preventDefault();
    const start = () => {
      dragging = true;
      busyRef.current = true;
      rows = [...nav.querySelectorAll<HTMLElement>('.project-row')];
      from = rows.indexOf(rowEl); to = from;
      const sc = getScroll();
      const rects = rows.map((r) => r.getBoundingClientRect());
      tops = rects.map((r) => r.top + sc); heights = rects.map((r) => r.height);
      step = heights[from] + (parseFloat(getComputedStyle(nav).rowGap) || 0);
      const rect = rects[from];
      offY = sy - rect.top;
      if (scroller) { const sr = scroller.getBoundingClientRect(); minY = sr.top; maxY = sr.bottom - rect.height; }
      ghost = rowEl.cloneNode(true) as HTMLElement;
      ghost.classList.add('drag-ghost'); ghost.removeAttribute('data-project');
      ghost.style.cssText = `left:${rect.left}px;width:${rect.width}px;height:${rect.height}px;`;
      document.body.appendChild(ghost);
      place(cardY(), 1); // 한 프레임 뒤에 들어올리면 살짝 떠오르는 느낌이 난다
      rowEl.dataset.dragging = ''; nav.dataset.dragActive = '';
      document.body.classList.add('dragging-project');
      document.addEventListener('selectstart', onSelect);
      window.getSelection()?.removeAllRanges();
      raf = requestAnimationFrame(() => { if (ghost) ghost.classList.add('lifted'); tick(); });
    };
    const onMove = (ev: PointerEvent) => {
      y = ev.clientY;
      if (!dragging) {
        if (Math.hypot(ev.clientX - sx, ev.clientY - sy) < DRAG_THRESHOLD) return;
        start();
      }
      ev.preventDefault();
      if (scroller) {
        const r = scroller.getBoundingClientRect();
        dir = y < r.top + SCROLL_EDGE ? -1 : y > r.bottom - SCROLL_EDGE ? 1 : 0;
      }
    };
    const teardown = () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
      window.removeEventListener('keydown', onEsc);
      document.removeEventListener('selectstart', onSelect);
      document.body.classList.remove('dragging-project');
      ghost?.remove(); ghost = null;
      rows.forEach((r) => { r.style.transform = ''; });
      delete rowEl.dataset.dragging; delete nav.dataset.dragActive;
      busyRef.current = false; cleanupRef.current = null;
    };
    // 끌기가 끝난 뒤 떠 있는 카드를 최종 자리로 내려앉히고(취소면 원래 자리) 나서 정리한다
    const finish = (cancel: boolean, ev?: PointerEvent) => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
      window.removeEventListener('keydown', onEsc);
      if (!dragging) return;
      cancelAnimationFrame(raf);
      if (ev) y = ev.clientY;
      if (!cancel) update();
      // 끌고 난 뒤 떼면서 생기는 클릭은 프로젝트 선택으로 보지 않는다
      const stop = (ce: Event) => { ce.stopPropagation(); ce.preventDefault(); };
      window.addEventListener('click', stop, { capture: true, once: true });
      setTimeout(() => window.removeEventListener('click', stop, { capture: true }), 0);
      const final = cancel ? from : to;
      const done = () => {
        const commitIt = !cancel;
        // 줄 순서가 바뀌는 순간 transform도 같이 풀려야 깜빡이지 않는다 (flushSync)
        flushSync(() => { teardown(); if (commitIt) moveTo(name, final > from ? final + 1 : final); });
      };
      if (reduced() || !ghost) { done(); return; }
      if (cancel) shiftRows(from);
      ghost.classList.remove('lifted'); ghost.classList.add('settling');
      place(slotY(final), 1);
      cleanupRef.current = done;
      setTimeout(() => { if (cleanupRef.current === done) done(); }, SETTLE_MS + 20);
    };
    const onUp = (ev: PointerEvent) => finish(false, ev);
    const onCancel = () => finish(true);
    const onEsc = (ev: KeyboardEvent) => { if (ev.key === 'Escape') finish(true); };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
    window.addEventListener('keydown', onEsc);
  };

  const run = (project: string, act: 'archive' | 'unarchive') => action.mutate({ project, action: act });

  return (
    <>
      <nav className="project-list" aria-label="프로젝트" ref={navRef}>
        {ordered.map((p) => (
          <div key={p.project} data-project={p.project}
               className={`project-row${p.project === selected ? ' selected' : ''}`}
               onPointerDown={(e) => onRowPointerDown(e, p.project)}
               onKeyDown={(e) => onKeyDown(e, p.project)}>
            {renaming === p.project ? (
              <RenameInput
                p={p}
                onCancel={() => setRenaming(null)}
                onSave={(name) => { setRenaming(null); action.mutate({ project: p.project, action: 'rename', name }); }}
              />
            ) : (
              <ProjectButton p={p} selected={p.project === selected} onSelect={onSelect} />
            )}
            <RowMenu
              project={p.project}
              label={dn(p.project)}
              items={[
                { label: '이름 바꾸기', run: () => setRenaming(p.project) },
                { label: '보관', run: () => run(p.project, 'archive') },
                { label: '삭제…', danger: true, run: () => setTrashing(p.project) },
              ]}
            />
          </div>
        ))}
        {!projects.length && archived.length > 0 && <p className="muted small pad-s">모든 프로젝트가 보관함에 있습니다</p>}
      </nav>

      {notice.text && (
        <p className="sidebar-notice small" role="status" key={notice.n} onAnimationEnd={() => setNoticeState((s) => ({ ...s, text: '' }))}>{notice.text}</p>
      )}

      {archived.length > 0 && (
        <section className="archive">
          <button className="archive-head" onClick={() => setShowArchived((v) => !v)} aria-expanded={showArchived}>
            <span className="fold-icon" aria-hidden>{showArchived ? '▾' : '▸'}</span>
            보관함 <span className="muted">{archived.length}</span>
          </button>
          {showArchived && (
            <ul className="archive-list">
              {archived.map((p) => (
                <li key={p.project} className="archive-row">
                  <span className="archive-name">{dn(p.project)}</span>
                  <button className="mini-button" onClick={() => run(p.project, 'unarchive')} disabled={action.isPending}>복원</button>
                  <button className="mini-button danger" onClick={() => setTrashing(p.project)} disabled={action.isPending}>삭제</button>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {trashing && (
        <TrashDialog
          project={trashing}
          onClose={() => setTrashing(null)}
          onDone={(r) => { setTrashing(null); setNotice(`${dn(r.project)} 휴지통으로 옮김 (${r.moved.length}개)`); }}
        />
      )}
    </>
  );
}

function ProjectButton({ p, selected, onSelect }: { p: ProjectSummary; selected: boolean; onSelect: (p: string) => void }) {
  const pct = p.total ? Math.round((p.done / p.total) * 100) : 0;
  return (
    <button className={`project${selected ? ' selected' : ''}`} onClick={() => onSelect(p.project)} aria-current={selected ? 'page' : undefined}>
      <span className="project-name">{p.displayName || p.project}</span>
      {p.hasRoadmap ? (
        <span className="project-progress">
          <ProgressBar done={p.done} total={p.total} size="sm" />
          <span className="mono muted">{p.done}/{p.total} · {pct}%</span>
        </span>
      ) : (
        <span className="muted small">로드맵 없음</span>
      )}
      <span className="project-chips">
        {p.doing > 0 && <span className="chip chip-doing">진행 중 {p.doing}</span>}
        {p.recentDone > 0 && <span className="chip chip-recent">최근 완료 {p.recentDone}</span>}
        {p.openIssues > 0 && <span className="chip chip-issue">열린 이슈 {p.openIssues}</span>}
      </span>
    </button>
  );
}

// 줄마다 ⋯ 메뉴. 바깥을 누르거나 Esc면 닫힌다
function RowMenu({ project, label, items }: { project: string; label?: string; items: { label: string; danger?: boolean; run: () => void }[] }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [open]);
  return (
    <div className={`row-menu${open ? ' open' : ''}`} ref={ref}>
      <button className="row-menu-button" aria-label={`${label ?? project} 메뉴`} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((v) => !v)}>⋯</button>
      {open && (
        <div className="row-menu-pop" role="menu">
          {items.map((it) => (
            <button key={it.label} role="menuitem" className={it.danger ? 'danger' : ''} onClick={() => { setOpen(false); it.run(); }}>{it.label}</button>
          ))}
        </div>
      )}
    </div>
  );
}

// 카드 자리에서 바로 고치는 이름 입력 (WEB-31). Enter 저장 · Esc 취소 · 포커스를 잃으면 취소. 비우고 저장하면 프로젝트 이름으로 돌아간다.
// 바뀐 게 없으면 요청을 보내지 않는다
function RenameInput({ p, onSave, onCancel }: { p: ProjectSummary; onSave: (name: string) => void; onCancel: () => void }) {
  const done = useRef(false);   // 저장 · 취소를 한 번만 (Enter 뒤 사라지는 입력창이 blur를 내도 취소로 치지 않는다)
  const initial = p.displayName || p.project;
  const finish = (save: boolean, value: string) => {
    if (done.current) return;
    done.current = true;
    const v = value.trim();
    if (save && v !== initial && !(v === '' && initial === p.project)) onSave(v);
    else onCancel();
  };
  return (
    <div className="project project-rename">
      <input
        className="project-rename-input" autoFocus defaultValue={initial} maxLength={60} spellCheck={false} autoComplete="off"
        aria-label={`${p.project} 표시 이름`} placeholder={p.project}
        onFocus={(e) => e.currentTarget.select()}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing) return;   // 한글 조합 중 Enter는 글자 확정
          if (e.key === 'Enter') { e.preventDefault(); finish(true, e.currentTarget.value); }
          else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(false, ''); }
        }}
        onBlur={() => finish(false, '')}
      />
      <span className="muted small">Enter 저장 · Esc 취소 · 비우면 원래 이름</span>
    </div>
  );
}
