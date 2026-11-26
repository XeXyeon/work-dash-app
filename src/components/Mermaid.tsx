import { useEffect, useRef, useState } from 'react';

// Mermaid는 크므로(수 MB) 흐름 화면에서 처음 쓸 때만 불러온다. CDN이 아니라 번들에서 — 오프라인에서도 그려진다.
type MermaidApi = typeof import('mermaid').default;
let loader: Promise<MermaidApi> | null = null;
let theme = '';
const dark = () => matchMedia('(prefers-color-scheme: dark)').matches;
async function getMermaid(): Promise<MermaidApi> {
  loader ??= import('mermaid').then((m) => m.default);
  const mermaid = await loader;
  const want = dark() ? 'dark' : 'default';
  if (theme !== want) {
    // securityLevel strict: 문서 안 HTML · 클릭 핸들러를 막는다 (생성 HTML과 같은 설정)
    // useMaxWidth false: 칸 폭에 맞춰 줄이지 않고 원래 크기로 그린 뒤 .mermaid-svg가 가로 스크롤한다.
    // 시퀀스만 끄면 경계 지도(flowchart) · 상태 그림이 칸 폭(약 450px)으로 줄어 글자가 안 보인다
    const natural = { useMaxWidth: false };
    mermaid.initialize({ startOnLoad: false, theme: want, securityLevel: 'strict', fontFamily: 'inherit', sequence: natural, flowchart: natural, state: natural, class: natural, er: natural });
    theme = want;
  }
  return mermaid;
}

let seq = 0;
// 같은 다이어그램을 동시에 여러 번 그리면 Mermaid가 꼬이므로 한 줄로 세운다
let queue: Promise<unknown> = Promise.resolve();

export function Mermaid({ code }: { code: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [error, setError] = useState('');
  const [themeKey, setThemeKey] = useState(dark);

  // 시스템 다크 모드가 바뀌면 다시 그린다
  useEffect(() => {
    const mq = matchMedia('(prefers-color-scheme: dark)');
    const on = () => setThemeKey(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const id = `mmd-${++seq}`;
    const job = queue.then(async () => {
      if (cancelled) return;
      try {
        const mermaid = await getMermaid();
        const { svg } = await mermaid.render(id, code);
        if (!cancelled && ref.current) { ref.current.innerHTML = svg; setError(''); }
      } catch (e) {
        document.getElementById(id)?.remove();   // 실패하면 Mermaid가 body에 남기는 임시 요소
        document.getElementById(`d${id}`)?.remove();
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    });
    queue = job.catch(() => {});
    return () => { cancelled = true; };
  }, [code, themeKey]);

  return (
    <div className="mermaid-box">
      {/* 갱신 중에는 이전 그림을 그대로 두어 깜빡이지 않게 한다 */}
      <div ref={ref} className="mermaid-svg" hidden={!!error} />
      {error && (
        <div className="mermaid-error">
          <p className="error small">다이어그램을 그리지 못했습니다: {error}</p>
          <pre className="md-code">{code}</pre>
        </div>
      )}
    </div>
  );
}
