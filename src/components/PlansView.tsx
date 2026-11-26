import { Fragment, useMemo } from 'react';
import { ApiError } from '../api';
import { usePlan, usePlans, type Plan, type PlanMeta, type PlansList } from '../plansApi';
import { jsonToHtml, markdownParts } from '../docsRender';
import { ago, fmtFull } from '../format';
import { useNow } from '../useNow';
import { routeHash } from '../useHashProject';
import type { ProjectSummary } from '../api';
import { useDisplayName } from '../api';
import { Mermaid } from './Mermaid';

interface Props { project: string; summary: ProjectSummary; doc: string | null }

// 기획 화면 (WEB-34): 묶인 저장소의 docs/ 문서. 왼쪽 목록(저장소별) · 오른쪽 본문. 읽기 전용, 파일이 바뀌면 SSE로 갱신된다
export function PlansView({ project, summary, doc }: Props) {
  const q = usePlans(project, summary.hasPlans);
  const dn = useDisplayName();
  const repos = useMemo(() => (q.data?.repos ?? []).filter((r) => r.docs.length > 0), [q.data]);

  // 비었는지는 불러온 목록으로 판단한다 (hasPlans가 아직 true여도 목록이 비면 빈 상태)
  const loaded = !q.isPending && !q.isError && repos.length === 0;
  if ((!summary.hasPlans && !repos.length) || loaded) {
    return (
      <section className="flows-empty">
        <h2 className="roadmap-title">{dn(project)}</h2>
        <p className="muted">기획 문서가 없습니다.</p>
        <p className="muted small">프로젝트 저장소의 <code>docs/</code> 아래에 <code>.md</code> 등 문서를 두면 여기에 바로 나타납니다.</p>
      </section>
    );
  }
  if (q.isPending) return <p className="muted pad">불러오는 중…</p>;
  if (q.isError) return <p className="error pad">기획 문서 목록을 불러오지 못했습니다: {q.error.message}</p>;
  return <PlansList project={project} data={q.data} repos={repos} doc={doc} />;
}

const all = (repos: PlansList['repos']) => repos.flatMap((r) => r.docs);

function PlansList({ project, data, repos, doc }: { project: string; data: PlansList; repos: PlansList['repos']; doc: string | null }) {
  const list = all(repos);
  // 주소에 문서가 없거나 목록에 없으면: 첫 저장소의 README.md → 첫 문서. 주소는 바꾸지 않는다 (새 문서가 목록 갱신보다 먼저 주소로 올 수 있다)
  const first = repos[0]?.docs.find((d) => d.path.toLowerCase() === 'readme.md') ?? repos[0]?.docs[0];
  const current = doc && list.some((d) => d.id === doc) ? doc : first?.id ?? null;
  const grouped = repos.length > 1;

  return (
    <div className="docs">
      <nav className="docs-list" aria-label="기획 문서">
        <h2 className="docs-heading">기획</h2>
        <p className="muted small docs-sub">저장소 docs/ 문서 (읽기 전용)</p>
        {repos.map((r) => (
          <section key={r.repo} className="docs-group">
            {grouped && <h3>{r.repo}</h3>}
            {r.docs.map((d) => <PlanLink key={d.id} project={project} d={d} selected={d.id === current} />)}
          </section>
        ))}
      </nav>
      <div className="docs-body">{current && <PlanPane key={current} project={project} id={current} list={data.repos} />}</div>
    </div>
  );
}

function PlanLink({ project, d, selected }: { project: string; d: PlanMeta; selected: boolean }) {
  const i = d.path.lastIndexOf('/');
  return (
    <a href={routeHash(project, 'plans', d.id)} className={`docs-link${selected ? ' selected' : ''}`} aria-current={selected ? 'page' : undefined} title={`${d.repo}/docs/${d.path}`}>
      <span className="docs-link-title">{i >= 0 && <span className="muted">{d.path.slice(0, i + 1)}</span>}{d.path.slice(i + 1)}</span>
    </a>
  );
}

// 문서끼리의 상대 링크(`redesign/02-x.md`, `../architecture.md#절`)를 같은 저장소의 목록 문서로 푼다. 목록에 없는 링크는 null(글자만)
function linkResolver(project: string, from: PlanMeta, repos: PlansList['repos']) {
  const byPath = new Map(all(repos).map((d) => [`${d.repo}/${d.path}`, d.id]));
  return (href: string): string | null => {
    if (!href || href.startsWith('#') || href.startsWith('/') || /^[a-z][a-z0-9+.-]*:/i.test(href)) return null;
    let rel: string;
    try { rel = decodeURIComponent(href.split(/[?#]/)[0]); } catch { return null; }
    const out = from.path.split('/').slice(0, -1);
    for (const seg of rel.split('/')) {
      if (seg === '' || seg === '.') continue;
      if (seg === '..') { if (!out.length) return null; out.pop(); } else out.push(seg);
    }
    const id = byPath.get(`${from.repo}/${out.join('/')}`);
    return id ? routeHash(project, 'plans', id) : null;
  };
}

function PlanPane({ project, id, list }: { project: string; id: string; list: PlansList['repos'] }) {
  const q = usePlan(project, id);
  const now = useNow();
  if (q.isPending) return <p className="muted">불러오는 중…</p>;
  if (q.isError) {
    return q.error instanceof ApiError && q.error.status === 404
      ? <p className="muted">문서를 찾을 수 없습니다. 목록에서 사라졌을 수 있습니다.</p>
      : <p className="error">문서를 불러오지 못했습니다: {q.error.message}</p>;
  }
  const d = q.data;
  return (
    <article className="doc">
      <header className="doc-head">
        <h2 className="doc-title">{d.path.split('/').pop()}</h2>
        <p className="doc-meta small muted">
          <span className="mono">{d.repo}/docs/{d.path}</span>
          <span title={fmtFull(d.mtime)}>· 수정 {ago(d.mtime, now)}</span>
        </p>
      </header>
      {d.error && <p className="error">{d.error}</p>}
      {d.truncated && !d.error && <p className="error small">파일이 커서 앞부분(1MB)만 표시합니다.</p>}
      {!d.error && <PlanContent project={project} doc={d} list={list} />}
    </article>
  );
}

function PlanContent({ project, doc, list }: { project: string; doc: Plan; list: PlansList['repos'] }) {
  const parts = useMemo(
    () => (doc.kind === 'markdown' ? markdownParts(doc.content, linkResolver(project, doc, list)) : []),
    [doc, list, project],
  );
  if (doc.kind === 'markdown') {
    return (
      <>
        {parts.map((p, i) => (
          <Fragment key={i}>
            {p.t === 'mermaid' ? <Mermaid code={p.code} /> : <div className="md" dangerouslySetInnerHTML={{ __html: p.html }} />}
          </Fragment>
        ))}
      </>
    );
  }
  if (doc.kind === 'json') return <pre className="doc-code doc-json" dangerouslySetInnerHTML={{ __html: jsonToHtml(doc.content) }} />;
  return <pre className="doc-code">{doc.content}</pre>;
}
