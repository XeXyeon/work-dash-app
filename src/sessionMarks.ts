// 세션 알림 카드의 읽음 · 치우기 상태 (WEB-18). 앱 하나만 쓰므로 화면 쪽 localStorage에 둔다.
// - seen[id] = 읽은 알림의 eventAt. 그보다 새 알림 변화가 오면 다시 안 읽음
// - dismissed[id] = 치운 알림의 eventAt. 다음 알림 변화(eventAt이 커짐)까지 숨긴다
// - initAt = 처음 쓴 시각. 그 전에 있던 알림은 읽은 것으로 본다 (처음 열 때 수십 장이 안 읽음으로 뜨지 않게)
// localStorage를 못 쓰면(막힘 · 비공개 창) 메모리에서만 기억한다.
import { useSyncExternalStore } from 'react';
import type { SessionCard } from './sessionsApi';

const KEY = 'work-dash.session-marks.v1';
interface Marks { initAt: number; seen: Record<string, number>; dismissed: Record<string, number> }

function load(): Marks {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const j = JSON.parse(raw);
      if (j && typeof j.initAt === 'number') return { initAt: j.initAt, seen: j.seen || {}, dismissed: j.dismissed || {} };
    }
  } catch { /* 못 읽으면 새로 */ }
  const fresh = { initAt: Date.now(), seen: {}, dismissed: {} };
  save(fresh);
  return fresh;
}
function save(m: Marks) {
  try { localStorage.setItem(KEY, JSON.stringify(m)); } catch { /* 메모리에만 */ }
}

let marks: Marks = load();
const listeners = new Set<() => void>();
const emit = () => { for (const f of listeners) f(); };
const update = (fn: (m: Marks) => Marks) => { marks = fn(marks); save(marks); emit(); };

// 다른 창에서 바꾼 것도 따라간다
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key !== KEY && e.key !== null) return;
    if (e.newValue == null) { save(marks); return; }   // 다른 창에서 지웠으면 지금 값을 다시 쓴다 (initAt이 바뀌어 알림이 모두 읽음이 되지 않게)
    marks = load(); emit();
  });
}

const subscribe = (f: () => void) => { listeners.add(f); return () => { listeners.delete(f); }; };
export const useSessionMarks = () => useSyncExternalStore(subscribe, () => marks);

// 치운 뒤 새 알림 변화가 없으면 숨긴다. 작업 중(event null)이면 eventAt이 서버 재시작으로 커져도 숨김을 유지한다
export const isHidden = (s: SessionCard, m: Marks) => {
  const d = m.dismissed[s.id];
  return d !== undefined && (d >= s.eventAt || s.event === null);
};
export const isUnread = (s: SessionCard, m: Marks) =>
  s.event !== null && s.eventAt > Math.max(m.seen[s.id] ?? 0, m.initAt) && !isHidden(s, m);

export const markSeen = (s: SessionCard) => {
  if ((marks.seen[s.id] ?? 0) >= s.eventAt) return;
  update((m) => ({ ...m, seen: { ...m.seen, [s.id]: s.eventAt } }));
};
export const dismiss = (s: SessionCard) => update((m) => ({ ...m, dismissed: { ...m.dismissed, [s.id]: s.eventAt }, seen: { ...m.seen, [s.id]: s.eventAt } }));
// 여러 장을 한 번에 치운다 (저장 · 다시 그리기는 한 번)
export const dismissAll = (list: SessionCard[]) => {
  if (!list.length) return;
  const at = Object.fromEntries(list.map((s) => [s.id, s.eventAt]));
  update((m) => ({ ...m, dismissed: { ...m.dismissed, ...at }, seen: { ...m.seen, ...at } }));
};
// 여러 장을 한 번에 읽음으로 (카드는 그대로 두고 안 읽음 표시만 지운다)
export const markAllSeen = (list: SessionCard[]) => {
  if (!list.length) return;
  update((m) => ({ ...m, seen: { ...m.seen, ...Object.fromEntries(list.map((s) => [s.id, s.eventAt])) } }));
};
export const restoreDismissed = () => update((m) => ({ ...m, dismissed: {} }));

// 목록에서 사라진 세션(7일 지난 기록)의 표시는 지우고, 치운 뒤 새 알림 변화가 온 카드는 치움을 푼다
// (풀지 않으면 그 카드가 다시 작업 중(event null)이 될 때 isHidden이 또 숨겨 버린다)
export const prune = (list: SessionCard[]) => {
  const byId = new Map(list.map((s) => [s.id, s]));
  const seen = Object.fromEntries(Object.entries(marks.seen).filter(([k]) => byId.has(k)));
  const dismissed = Object.fromEntries(Object.entries(marks.dismissed).filter(([k, d]) => {
    const s = byId.get(k);
    return s && !(s.event !== null && s.eventAt > d);
  }));
  if (Object.keys(seen).length === Object.keys(marks.seen).length && Object.keys(dismissed).length === Object.keys(marks.dismissed).length) return;
  update((m) => ({ ...m, seen, dismissed }));
};
