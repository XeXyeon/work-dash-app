import { useEffect, useState } from 'react';

// 규칙 · 형식 문서 화면 주소: #docs (첫 문서) · #docs/<문서 id>
// 프로젝트 주소(#/<프로젝트>)와 겹치지 않게 '/'로 시작하지 않는다.
// 반환: 문서 화면이 아니면 undefined, 문서 화면이면 id(없으면 null)
const read = (): string | null | undefined => {
  const m = location.hash.match(/^#docs(?:\/(.+))?$/);
  if (!m) return undefined;
  if (!m[1]) return null;
  try { return decodeURIComponent(m[1]); } catch { return null; }
};

export const docsHash = (id?: string | null) => `#docs${id ? `/${encodeURIComponent(id)}` : ''}`;

export function useDocsRoute(): string | null | undefined {
  const [route, setRoute] = useState(read);
  useEffect(() => {
    const on = () => setRoute(read());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return route;
}
