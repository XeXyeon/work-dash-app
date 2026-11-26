import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type RefObject } from 'react';

interface Props {
  storageKey: string;               // localStorage 키 (예: work-dash.panel-width.v1)
  cssVar: string;                   // 폭을 넣을 CSS 변수 (예: --panel-w). <html>에 둔다
  def: number;                      // 기본 폭 (더블클릭하면 이 값)
  min: number;
  max: () => number;                // 창 크기에 따라 바뀌므로 함수
  edge: 'left' | 'right';           // 대상의 어느 가장자리에 있는지 (패널은 왼쪽, 사이드바는 오른쪽)
  target: RefObject<HTMLElement | null>;   // 폭을 재는 대상 (드래그 시작 폭)
  label: string;
  className?: string;
}

const STEP = 16, BIG_STEP = 64;

// 이번 실행 동안의 폭. 패널은 항목을 바꿀 때마다 다시 마운트되므로, localStorage가 막혀도 폭이 유지되게 메모리에도 둔다
const memory = new Map<string, number>();
function load(key: string, def: number) {
  if (memory.has(key)) return memory.get(key)!;
  try {
    const n = Number(localStorage.getItem(key));
    return Number.isFinite(n) && n > 0 ? n : def;
  } catch { return def; }   // 막힌 저장소 · 비공개 창: 기본값으로 동작
}
function save(key: string, n: number, def: number) {
  memory.set(key, n);
  try {
    if (n === def) localStorage.removeItem(key);
    else localStorage.setItem(key, String(n));
  } catch { /* 기억은 못 해도 이번 실행 동안은 동작 */ }
}

// 폭 조절 손잡이 (WEB-23): 끌기 · ←/→ 키 · 더블클릭(기본 폭). 폭은 CSS 변수로만 바꿔 다른 화면을 다시 그리지 않는다
export function ResizeHandle({ storageKey, cssVar, def, min, max, edge, target, label, className = '' }: Props) {
  // 저장값이 손상됐거나 범위를 벗어나도(예: 5px) 그대로 쓰지 않는다
  const [width, setWidth] = useState(() => Math.round(Math.min(Math.max(load(storageKey, def), min), Math.max(min, max()))));
  const [dragging, setDragging] = useState(false);
  const drag = useRef<{ x: number; w: number; last: number } | null>(null);
  const clamp = (n: number) => Math.round(Math.min(Math.max(n, min), Math.max(min, max())));

  useLayoutEffect(() => { document.documentElement.style.setProperty(cssVar, `${width}px`); }, [cssVar, width]);
  // 끄는 중에 패널이 닫히는 등 손잡이가 사라져도 커서 · 글자 선택 막기를 풀어 둔다
  useEffect(() => () => document.body.classList.remove('col-resizing'), []);

  // 화면에 실제로 보이는 폭(CSS가 창 크기로 줄였을 수 있다)에서 시작한다
  const current = () => clamp(target.current?.getBoundingClientRect().width ?? width);
  const sign = edge === 'left' ? -1 : 1;   // 왼쪽 가장자리는 왼쪽으로 끌수록 넓어진다

  const commit = (n: number) => { setWidth(n); save(storageKey, n, def); };

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();   // 글자 선택 시작 막기
    e.currentTarget.setPointerCapture(e.pointerId);
    const w = current();
    drag.current = { x: e.clientX, w, last: w };
    setDragging(true);
    document.body.classList.add('col-resizing');
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    const n = clamp(d.w + sign * (e.clientX - d.x));
    if (n === d.last) return;
    d.last = n;
    setWidth(n);
  };
  const end = () => {
    const d = drag.current;
    if (!d) return;
    drag.current = null;
    setDragging(false);
    document.body.classList.remove('col-resizing');
    if (d.last !== d.w) save(storageKey, d.last, def);   // 누르기만 했으면(더블클릭의 첫 누름 등) 저장하지 않는다
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? BIG_STEP : STEP;
    let n: number;
    if (e.key === 'ArrowLeft') n = current() - sign * step;
    else if (e.key === 'ArrowRight') n = current() + sign * step;
    else if (e.key === 'Home') n = min;
    else if (e.key === 'End') n = max();
    else if (e.key === 'Enter') n = def;
    else return;
    e.preventDefault();
    commit(clamp(n));
  };

  return (
    <div
      className={`resize-handle${dragging ? ' dragging' : ''} ${className}`}
      role="separator" aria-orientation="vertical" aria-label={label}
      aria-valuenow={clamp(width)} aria-valuemin={min} aria-valuemax={Math.max(min, max())}
      tabIndex={0}
      title={`${label} — 끌어서 폭 조절 · 두 번 누르면 기본 폭`}
      onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={end} onPointerCancel={end} onLostPointerCapture={end}
      onDoubleClick={() => commit(def)}
      onKeyDown={onKeyDown}
    />
  );
}

// 폭 범위. 나란히 배치(1400px 이상)에서 패널은 가운데 목록이 최소 480px 남도록 줄인다 (styles.css의 같은 식과 맞춘다)
export const SIDEBAR = { key: 'work-dash.sidebar-width.v1', cssVar: '--sidebar-w', def: 300, min: 200, max: () => Math.min(480, window.innerWidth - 400) };
export const PANEL = {
  key: 'work-dash.panel-width.v1', cssVar: '--panel-w', def: 640, min: 360,
  max: () => {
    const vw = window.innerWidth;
    if (vw < 1400) return Math.min(1400, vw - 40);
    const side = document.querySelector('.sidebar')?.getBoundingClientRect().width ?? SIDEBAR.def;
    return Math.min(1400, vw - side - 480);
  },
};
