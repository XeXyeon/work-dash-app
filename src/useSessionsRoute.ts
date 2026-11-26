import { useEffect, useState } from 'react';

// 세션 알림 화면 주소 (WEB-18). 프로젝트 주소(#/<프로젝트>)와 겹치지 않게 '/'로 시작하지 않는다
//   #sessions                                              카드 목록
//   #sessions?session=<세션 ID>                             카드 하나 선택 (연결 항목 없음)
//   #sessions?session=<세션 ID>&project=<프로젝트>&item=<항목 ID>  + 오른쪽에 그 항목의 작업 카드 패널 (WEB-19 재설계)
// 항목의 프로젝트는 세션 폴더와 다를 수 있어 따로 둔다. 각 값은 URLSearchParams가 인코딩하므로 '/' · '#'이 들어 있어도 안전하다
export const SESSIONS_HASH = '#sessions';
export const isSessionsHash = (h = location.hash) => h === SESSIONS_HASH || h.startsWith(`${SESSIONS_HASH}?`);

export interface SessionsRoute { on: boolean; session: string | null; project: string | null; item: string | null }
const OFF: SessionsRoute = { on: false, session: null, project: null, item: null };

const read = (): SessionsRoute => {
  if (!isSessionsHash()) return OFF;
  const q = new URLSearchParams(location.hash.slice(SESSIONS_HASH.length + 1));
  const project = q.get('project') || null, item = q.get('item') || null;
  return { on: true, session: q.get('session') || null, project: project && item ? project : null, item: project && item ? item : null };
};

export const sessionsHash = (session?: string | null, item?: { project: string; id: string } | null) => {
  if (!session) return SESSIONS_HASH;
  const q = new URLSearchParams({ session });
  if (item) { q.set('project', item.project); q.set('item', item.id); }
  return `${SESSIONS_HASH}?${q}`;
};

export function useSessionsRoute(): SessionsRoute {
  const [route, setRoute] = useState(read);
  useEffect(() => {
    const f = () => setRoute(read());
    window.addEventListener('hashchange', f);
    return () => window.removeEventListener('hashchange', f);
  }, []);
  return route;
}
