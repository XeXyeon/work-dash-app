import { useCallback, useEffect, useState } from 'react';

// 선택한 프로젝트와 화면을 주소 해시에 둔다: 새로고침 · 뒤로 가기 · 북마크가 그대로 동작한다
//   #/<프로젝트>                  로드맵
//   #/<프로젝트>/issues           이슈 (WEB-4)
//   #/<프로젝트>/flows            흐름 문서 (기본: 전체 구조 또는 첫 흐름)
//   #/<프로젝트>/flows/<흐름 이름>  흐름 하나 (이름을 쓰는 이유: 앞에 흐름이 추가돼도 같은 흐름을 가리킨다)
//   #/<프로젝트>/plans            기획: 묶인 저장소 docs/ 문서 (WEB-34)
//   #/<프로젝트>/plans/<문서 id>   문서 하나 (서버가 만든 목록 id, base64url이라 '/'가 없다). 아래 `flow` 자리를 함께 쓴다
//   #/<프로젝트>/notes            학습 노트 (WEB-35)
//   #/<프로젝트>/improve          개선 기록 (WEB-41)
//   …?item=<항목 ID>              어느 화면에서든 오른쪽에 작업 카드 상세 패널 (WEB-4)
//   …?issue=<이슈 ID>             같은 자리에 이슈 카드 패널 (WEB-22). 패널은 하나라 item과 함께 오면 item을 쓴다
export type View = 'roadmap' | 'issues' | 'flows' | 'plans' | 'notes' | 'improve';
export interface HashRoute { project: string | null; view: View; flow: string | null; item: string | null; issue: string | null }

const EMPTY: HashRoute = { project: null, view: 'roadmap', flow: null, item: null, issue: null };
const read = (): HashRoute => {
  const m = location.hash.match(/^#\/([^?]+)(?:\?(.*))?$/);
  if (!m) return EMPTY;
  try {
    const [project, view, flow] = m[1].split('/').map(decodeURIComponent);
    const q = new URLSearchParams(m[2] || '');
    const item = q.get('item') || null;
    const issue = item ? null : q.get('issue') || null;
    const v: View = view === 'flows' || view === 'issues' || view === 'plans' || view === 'notes' || view === 'improve' ? view : 'roadmap';
    return { project, view: v, flow: (v === 'flows' || v === 'plans') && flow ? flow : null, item, issue };
  } catch { return EMPTY; }
};

export const routeHash = (project: string, view: View = 'roadmap', flow?: string | null, item?: string | null) =>
  `#/${encodeURIComponent(project)}${view === 'roadmap' ? '' : `/${view}`}${(view === 'flows' || view === 'plans') && flow ? `/${encodeURIComponent(flow)}` : ''}`
  + (item ? `?item=${encodeURIComponent(item)}` : '');

// 같은 화면 위에 이슈 카드 패널을 여는 주소 (WEB-22)
export const issueHash = (project: string, view: View, flow: string | null, issue: string) =>
  `${routeHash(project, view, flow)}?issue=${encodeURIComponent(issue)}`;

export function useHashRoute(): HashRoute {
  const [route, setRoute] = useState(read);
  useEffect(() => {
    const on = () => setRoute(read());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return route;
}

// 프로젝트를 바꿔도 지금 보던 화면(로드맵 · 이슈 · 흐름)은 유지한다. 카드 패널은 닫는다
export function useHashProject(): [string | null, (p: string) => void, View, string | null, string | null, string | null] {
  const { project, view, flow, item, issue } = useHashRoute();
  const select = useCallback((p: string) => { location.hash = routeHash(p, view); }, [view]);
  return [project, select, view, flow, item, issue];
}
