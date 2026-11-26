import { useMemo, useState } from 'react';
import { ApiError, useDisplayName, useFlows, type Flow, type FlowPart, type FlowsDoc, type ProjectSummary } from '../api';
import { autoSequence, inline, mdToHtml } from '../flowsMarkdown';
import { routeHash } from '../useHashProject';
import { Mermaid } from './Mermaid';

interface Props { project: string; summary: ProjectSummary; flow: string | null }

// 흐름 문서 화면 (WEB-9): 왼쪽 흐름 목록 · 오른쪽 선택한 흐름(또는 전체 구조)
export function FlowsView({ project, summary, flow }: Props) {
  const q = useFlows(project, summary.hasFlows);
  const dn = useDisplayName();
  const missing = !summary.hasFlows || (q.isError && q.error instanceof ApiError && q.error.status === 404);

  if (missing) {
    return (
      <section className="flows-empty">
        <h2 className="roadmap-title">{dn(project)}</h2>
        <p className="muted">흐름 문서가 없습니다.</p>
        <p className="muted small">
          <code>~/.work-dash/flows/{project}.md</code>를 만들면 여기에 바로 나타납니다. 프로젝트 폴더에서 <code>/flows init</code>으로 초안을 만들 수 있습니다.
        </p>
      </section>
    );
  }
  if (q.isPending) return <p className="muted pad">불러오는 중…</p>;
  if (q.isError) return <p className="error pad">흐름 문서를 불러오지 못했습니다: {q.error.message}</p>;
  return <FlowsDocView doc={q.data} selected={flow} />;
}

function FlowsDocView({ doc, selected }: { doc: FlowsDoc; selected: string | null }) {
  const [filter, setFilter] = useState('');
  const hasIntro = doc.intro.some((p) => p.t === 'mermaid' || p.text.trim());
  // 첫 화면 = `## 전체 구조`(머리말 포함). 전체 구조 절이 없고 머리말만 있으면 머리말을 그 자리에 둔다
  const overview = doc.overview
    ? { name: doc.overview.name, parts: [...doc.intro, ...doc.overview.items] }
    : hasIntro ? { name: '머리말', parts: doc.intro } : null;
  const overviewName = overview?.name ?? null;
  // 선택이 없거나 없는 흐름이면: 전체 구조 → 첫 흐름
  const current = selected && (selected === overviewName || doc.flows.some((f) => f.name === selected))
    ? selected
    : overviewName ?? doc.flows[0]?.name ?? null;
  const f = doc.flows.find((x) => x.name === current);
  const shown = useMemo(() => {
    const k = filter.trim().toLowerCase();
    return k ? doc.flows.filter((x) => x.name.toLowerCase().includes(k) || (x.summary || '').toLowerCase().includes(k)) : doc.flows;
  }, [doc.flows, filter]);
  const href = (name: string) => routeHash(doc.project, 'flows', name);

  return (
    <section className="flows">
      <header className="flows-head">
        <h2 className="roadmap-title">{doc.title}</h2>
        <span className="muted small">
          {doc.updated && <>마지막 갱신 {doc.updated} · </>}흐름 {doc.flows.length}개
        </span>
      </header>
      <div className="flows-body">
        <nav className="flow-nav" aria-label="흐름">
          {doc.flows.length > 6 && (
            <input className="flow-filter" placeholder="흐름 찾기" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="흐름 찾기" />
          )}
          {overview && (
            <a className={`flow-link flow-link-overview${current === overviewName ? ' selected' : ''}`} href={href(overview.name)}
               aria-current={current === overviewName ? 'page' : undefined}>
              {overview.name}
            </a>
          )}
          {shown.map((x) => (
            <a key={x.slug} className={`flow-link${x.name === current ? ' selected' : ''}`} href={href(x.name)}
               aria-current={x.name === current ? 'page' : undefined}>
              <span className="flow-link-name">{x.name}</span>
              {(x.diagrams.length > 0) && <span className="flow-link-mark" title="다이어그램 있음">◇</span>}
            </a>
          ))}
          {!shown.length && <p className="muted small pad-s">{doc.flows.length ? '맞는 흐름이 없습니다' : '흐름 절이 없습니다'}</p>}
        </nav>
        <div className="flow-content">
          {current === overviewName && overview
            ? <Parts key="overview" title={overview.name} parts={overview.parts} />
            : f ? <FlowDetail key={f.name} f={f} /> : <p className="muted">흐름 절(## …)이 없습니다.</p>}
        </div>
      </div>
    </section>
  );
}

// 머리말 · 전체 구조: Markdown과 Mermaid가 섞인 원문을 순서대로
function Parts({ title, parts }: { title: string; parts: FlowPart[] }) {
  return (
    <article className="flow-card">
      <h3 className="flow-name">{title}</h3>
      {parts.map((p, i) => p.t === 'mermaid'
        ? <Mermaid key={i} code={p.code} />
        : <div key={i} className="md" dangerouslySetInnerHTML={{ __html: mdToHtml(p.text) }} />)}
    </article>
  );
}

const Rich = ({ text, as: Tag = 'span' }: { text: string; as?: 'span' | 'div' | 'li' | 'p' }) =>
  <Tag dangerouslySetInnerHTML={{ __html: inline(text) }} />;

function FlowDetail({ f }: { f: Flow }) {
  const auto = !f.diagrams.length ? autoSequence(f) : '';
  const diagrams = f.diagrams.length ? f.diagrams : auto ? [{ title: '', code: auto }] : [];
  const info = ([['진입점', f.entry], ['상태 변화', f.state], ['예외', f.errors], ['관련 파일', f.files], ['관련 항목', f.items], ['마지막 갱신', f.updated]] as const)
    .filter(([, v]) => v);
  return (
    <article className="flow-card">
      <h3 className="flow-name">{f.name}</h3>
      {f.summary && <Rich as="p" text={f.summary} />}
      {f.steps.length > 0 && (
        <>
          <h4 className="flow-sec">{f.stepsLabel}</h4>
          <ol className="flow-steps">{f.steps.map((s, i) => <Rich key={i} as="li" text={s} />)}</ol>
        </>
      )}
      {info.length > 0 && (
        <>
          <h4 className="flow-sec">정보</h4>
          <dl className="flow-kv">
            {info.map(([k, v]) => <div key={k}><dt>{k}</dt><dd dangerouslySetInnerHTML={{ __html: inline(v!) }} /></div>)}
          </dl>
        </>
      )}
      {f.extra.length > 0 && (
        <>
          <h4 className="flow-sec">메모</h4>
          {/* 파서는 `- 키: 값`이 아닌 줄을 그대로(앞의 `- ` 포함) 넘기므로 목록 기호를 떼고 보여 준다 */}
          <ul className="flow-extra">{f.extra.map((x, i) => <Rich key={i} as="li" text={x.replace(/^[-*]\s+/, '')} />)}</ul>
        </>
      )}
      {diagrams.map((d, i) => (
        <div key={`${i}:${d.title}`}>
          <h4 className="flow-sec">
            {d.title || '시퀀스'}{auto && <span className="muted small"> (단계로 자동 생성)</span>}
          </h4>
          <Mermaid code={d.code} />
        </div>
      ))}
    </article>
  );
}
