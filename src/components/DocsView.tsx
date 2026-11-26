import { useEffect, useMemo } from 'react';
import { useDoc, useDocs, type Doc, type DocMeta } from '../docsApi';
import { docsHash } from '../useDocsRoute';
import { jsonToHtml, markdownToHtml, splitFrontmatter } from '../docsRender';
import { ago, fmtFull } from '../format';
import { useNow } from '../useNow';
import { PluginsOverviewPane } from './PluginsOverview';
import { EnabledOverviewPane } from './EnabledOverview';

// 규칙 · 형식 문서 화면 (WEB-16): 왼쪽 문서 목록(묶음별) · 오른쪽 본문. 읽기 전용, 파일이 바뀌면 SSE로 갱신된다.
export function DocsView({ id }: { id: string | null }) {
  const docs = useDocs();
  const list = docs.data ?? [];
  const current = id;

  // 주소에 문서가 없으면(#docs) 첫 문서로. 모르는 id는 옮기지 않고 '없음'을 보여 준다
  // (새 템플릿 파일처럼 목록 갱신보다 주소가 먼저 올 수 있다)
  useEffect(() => {
    if (!list.length || current) return;
    history.replaceState(null, '', docsHash(list[0].id));
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  }, [list, current]);

  // 큰 덩어리(section) → 묶음(group) → 문서. 덩어리와 이름이 같은 묶음(설정)은 묶음 제목을 따로 달지 않는다
  const sections = useMemo(() => {
    const m = new Map<string, Map<string, DocMeta[]>>();
    for (const d of list) {
      const g = m.get(d.section) ?? new Map<string, DocMeta[]>();
      g.set(d.group, [...(g.get(d.group) ?? []), d]);
      m.set(d.section, g);
    }
    return [...m].map(([section, g]) => [section, [...g]] as const);
  }, [list]);

  return (
    <div className="docs">
      <nav className="docs-list" aria-label="문서">
        <h2 className="docs-heading">규칙 · 형식 문서</h2>
        <p className="muted small docs-sub">에이전트가 읽는 문서와 설정 (읽기 전용)</p>
        {docs.isPending && <p className="muted">불러오는 중…</p>}
        {docs.isError && <p className="error">문서 목록을 불러오지 못했습니다: {docs.error.message}</p>}
        {sections.map(([section, groups]) => (
          <section key={section} className="docs-section">
            <h3 className="docs-section-title">{section}</h3>
            {groups.map(([group, items]) => (
              <div key={group} className="docs-group">
                {group !== section && <h4>{group}</h4>}
                {items.map((d) => (
                  <a
                    key={d.id}
                    href={docsHash(d.id)}
                    className={`docs-link${d.id === current ? ' selected' : ''}${d.exists ? '' : ' missing'}`}
                    aria-current={d.id === current ? 'page' : undefined}
                    title={d.path}
                  >
                    <span className="docs-link-title">{d.title}</span>
                    {!d.exists && <span className="small muted">없음</span>}
                  </a>
                ))}
              </div>
            ))}
          </section>
        ))}
      </nav>
      <div className="docs-body">{current && <DocPane key={current} id={current} />}</div>
    </div>
  );
}

function DocPane({ id }: { id: string }) {
  const doc = useDoc(id);
  const now = useNow();
  if (doc.isPending) return <p className="muted">불러오는 중…</p>;
  if (doc.isError) return <p className="error">문서를 불러오지 못했습니다: {doc.error.message}</p>;
  const d = doc.data;
  return (
    <article className="doc">
      <header className="doc-head">
        <h2 className="doc-title">{d.title}</h2>
        {d.note && <p className="muted">{d.note}</p>}
        <p className="doc-meta small muted">
          <span className="mono">{d.path}</span>
          {d.aliases.length > 0 && <span>· 링크: <span className="mono">{d.aliases.join(', ')}</span></span>}
          {d.exists && <span title={fmtFull(d.mtime)}>· 수정 {ago(d.mtime, now)}</span>}
        </p>
      </header>
      {!d.exists ? <p className="muted">파일이 없습니다.</p>
        : <>
          {d.error && <p className="error">{d.error}</p>}
          {d.truncated && <p className="error small">파일이 커서 앞부분(1MB)만 표시합니다.</p>}
          <DocContent doc={d} />
        </>}
    </article>
  );
}

function DocContent({ doc }: { doc: Doc }) {
  if (doc.kind === 'plugins') return doc.plugins ? <PluginsOverviewPane data={doc.plugins} /> : null;
  if (doc.kind === 'enabled') return doc.enabled ? <EnabledOverviewPane data={doc.enabled} /> : null;
  return <TextContent doc={doc} />;
}

function TextContent({ doc }: { doc: Doc }) {
  const html = useMemo(() => {
    if (doc.kind === 'markdown') {
      const { meta, body } = splitFrontmatter(doc.content);
      return { meta, body: markdownToHtml(body) };
    }
    if (doc.kind === 'json' && !doc.error && !doc.truncated) return { meta: [], body: `<pre class="doc-code doc-json">${jsonToHtml(doc.content)}</pre>` };
    return { meta: [], body: null };
  }, [doc]);

  return (
    <>
      {html.meta.length > 0 && (
        <dl className="doc-front">
          {html.meta.map(([k, v]) => <div key={k}><dt className="mono">{k}</dt><dd>{v}</dd></div>)}
        </dl>
      )}
      {html.body !== null
        ? <div className={doc.kind === 'markdown' ? 'md' : undefined} dangerouslySetInnerHTML={{ __html: html.body }} />
        : <pre className="doc-code">{doc.content}</pre>}
    </>
  );
}
