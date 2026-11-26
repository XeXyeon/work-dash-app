import { Fragment, useState } from 'react';
import type { PluginInfo, PluginNoteItem, PluginsOverview, PluginStatus, SkillInfo } from '../docsApi';
import { docsHash } from '../useDocsRoute';
import { inlineMarkdownToHtml, markdownToHtml } from '../docsRender';

// 플러그인 · 스킬 개요 (WEB-42): 모든 세션의 목록에 들어가는 것과 그 크기, PLUGINS.md 메모. 읽기 전용.
// 켜짐 여부는 PLUGINS.md가 아니라 Claude Code의 설치 기록 · settings.json에서 온다(서버가 읽는다).

const n = (v: number) => v.toLocaleString('ko-KR');

type Status = PluginStatus | 'missing';
const STATUS_LABEL: Record<Status, string> = { on: '켜짐', off: '꺼짐', unset: '설정에 없음', missing: '설치 안 됨' };
const STATUS_TITLE: Record<Status, string> = {
  on: 'settings.json enabledPlugins: true',
  off: 'settings.json enabledPlugins: false',
  unset: 'settings.json enabledPlugins에 이 플러그인이 없습니다',
  missing: 'installed_plugins.json에 없습니다',
};
const StatusBadge = ({ status }: { status: Status }) => (
  <span className={`plg-status plg-${status}`} title={STATUS_TITLE[status]}>{STATUS_LABEL[status]}</span>
);

const findPlugin = (plugins: PluginInfo[], name: string) => plugins.find((p) => p.name === name || p.key === name);

export function PluginsOverviewPane({ data }: { data: PluginsOverview }) {
  const { plugins, userSkills, commands, notes, totals } = data;
  return (
    <div className="plg">
      {data.errors.map((e) => <p key={e} className="error">{e}</p>)}

      <div className="plg-totals">
        <div className="plg-total">
          <div className="small muted">켜진 것 기준</div>
          <div className="plg-total-num">{n(totals.enabled.chars)}<span className="small muted">자</span></div>
          <div className="small muted">스킬 · 명령 {n(totals.enabled.count)}개</div>
        </div>
        <div className="plg-total">
          <div className="small muted">설치된 것 전체</div>
          <div className="plg-total-num">{n(totals.all.chars)}<span className="small muted">자</span></div>
          <div className="small muted">스킬 · 명령 {n(totals.all.count)}개</div>
        </div>
      </div>
      <p className="small muted">
        세션 목록에 들어가는 설명(description)의 글자 수입니다. <span className="mono">disable-model-invocation</span> 스킬은 목록에 들어가지 않아 세지 않습니다.
        플러그인의 명령 · 에이전트는 세지 않습니다.
      </p>

      <h3 className="plg-h">설치된 것</h3>
      <InstalledTable data={data} />

      {!data.notesExists && <p className="muted">~/.work-dash/PLUGINS.md가 없습니다.</p>}
      {notes.intro && <div className="md plg-intro" dangerouslySetInnerHTML={{ __html: markdownToHtml(notes.intro) }} />}
      {notes.sections.map((s) => (
        <section key={s.title}>
          <h3 className="plg-h">{s.title}</h3>
          {s.intro && <div className="md" dangerouslySetInnerHTML={{ __html: markdownToHtml(s.intro) }} />}
          {s.items.length === 0 && !s.intro && <p className="muted small">항목 없음</p>}
          <div className="plg-notes">
            {s.items.map((it) => <NoteCard key={it.name} item={it} plugin={findPlugin(plugins, it.name)} />)}
          </div>
        </section>
      ))}

      <p className="small muted plg-sources">
        읽는 곳: {data.sources.map((s, i) => (
          <Fragment key={s.path}>{i > 0 && ' · '}<span className={`mono${s.exists ? '' : ' plg-gone'}`}>{s.path}</span></Fragment>
        ))}
      </p>
      {userSkills.length + commands.length === 0 && <p className="small muted">직접 둔 스킬 · 명령이 없습니다.</p>}
    </div>
  );
}

function InstalledTable({ data }: { data: PluginsOverview }) {
  const [open, setOpen] = useState<Set<string>>(new Set());
  const toggle = (key: string) => setOpen((s) => { const t = new Set(s); if (t.has(key)) t.delete(key); else t.add(key); return t; });
  const usage = (name: string) => data.notes.sections.flatMap((s) => s.items).find((it) => it.name === name)?.fields.find(([k]) => k === '용도')?.[1];

  return (
    <div className="plg-table-wrap">
      <table className="plg-table">
        <thead>
          <tr><th>이름</th><th>종류</th><th>마켓 · 버전</th><th>상태</th><th className="num">스킬</th><th className="num">설명 길이</th></tr>
        </thead>
        <tbody>
          {data.plugins.map((p) => {
            const isOpen = open.has(p.key);
            const use = usage(p.name);
            return (
              <Fragment key={p.key}>
                <tr className={p.status === 'off' ? 'plg-row-off' : undefined}>
                  <td>
                    <button type="button" className="plg-toggle" aria-expanded={isOpen} onClick={() => toggle(p.key)}>
                      <span aria-hidden="true">{isOpen ? '▾' : '▸'}</span> <strong>{p.name}</strong>
                    </button>
                    {use && <div className="small muted plg-use" dangerouslySetInnerHTML={{ __html: inlineMarkdownToHtml(use) }} />}
                  </td>
                  <td className="plg-kind">플러그인</td>
                  <td><span className="mono small">{p.marketplace}</span>{p.version && <span className="small muted"> · {p.version}</span>}</td>
                  <td><StatusBadge status={p.status} /></td>
                  <td className="num" title={`목록에 들어가는 스킬 ${p.listedCount}개 / 전체 ${p.skills.length}개`}>
                    {p.listedCount}{p.listedCount !== p.skills.length && <span className="muted"> / {p.skills.length}</span>}
                  </td>
                  <td className="num">{n(p.chars)}자</td>
                </tr>
                {isOpen && (
                  <tr className="plg-detail">
                    <td colSpan={6}>
                      {p.installPath && <p className="small muted mono">{p.installPath}</p>}
                      <SkillList skills={p.skills} />
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
          {data.userSkills.map((s) => (
            <LocalRow key={`s-${s.name}`} skill={s} kind="직접 둔 스킬" href={docsHash(`uskill-${s.name}`)} />
          ))}
          {data.commands.map((s) => (
            <LocalRow key={`c-${s.name}`} skill={s} kind="직접 둔 명령" href={docsHash(`cmd-${s.name.slice(1)}`)} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function LocalRow({ skill, kind, href }: { skill: SkillInfo; kind: string; href: string }) {
  return (
    <tr>
      <td><a href={href} className="plg-local" title={skill.description}>{skill.name}</a></td>
      <td className="plg-kind">{kind}</td>
      <td className="small muted">~/.claude</td>
      <td>{skill.listed ? <span className="plg-status plg-on" title="직접 둔 것은 늘 목록에 들어갑니다">항상</span> : <span className="plg-status plg-off">목록 제외</span>}</td>
      <td className="num">{skill.listed ? 1 : 0}</td>
      <td className="num">{n(skill.listed ? skill.chars : 0)}자</td>
    </tr>
  );
}

function SkillList({ skills }: { skills: SkillInfo[] }) {
  if (!skills.length) return <p className="small muted">skills 폴더에 스킬이 없습니다.</p>;
  return (
    <ul className="plg-skills">
      {skills.map((s) => (
        <li key={s.name} className={s.listed ? undefined : 'plg-unlisted'}>
          <span className="mono">{s.name}</span>
          <span className="small muted">{s.listed ? `${n(s.chars)}자` : `목록 제외 (${n(s.chars)}자)`}</span>
          <span className="small plg-desc">{s.description}</span>
        </li>
      ))}
    </ul>
  );
}

function NoteCard({ item, plugin }: { item: PluginNoteItem; plugin?: PluginInfo }) {
  return (
    <article className="plg-note">
      <header className="plg-note-head">
        <strong>{item.name}</strong>
        <StatusBadge status={plugin ? plugin.status : 'missing'} />
        {plugin && <span className="small muted">{n(plugin.chars)}자 · 스킬 {plugin.listedCount}개</span>}
      </header>
      {item.fields.length > 0 && (
        <dl className="plg-fields">
          {item.fields.map(([k, v], i) => (
            <div key={`${k}-${i}`}>
              <dt>{k}</dt>
              <dd dangerouslySetInnerHTML={{ __html: inlineMarkdownToHtml(v) }} />
            </div>
          ))}
        </dl>
      )}
      {item.extra && <div className="md small" dangerouslySetInnerHTML={{ __html: markdownToHtml(item.extra) }} />}
    </article>
  );
}
