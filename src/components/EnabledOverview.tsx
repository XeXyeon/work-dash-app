import { Fragment, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { docKeys, type EnabledLayer, type EnabledOverview, type EnabledSource } from '../docsApi';

// 프로젝트별 켜진 것 (WEB-43): 전역 설정에 저장소의 .claude 설정을 겹쳐 본 결과. 읽기 전용.
// 표의 숫자는 그 저장소에서 켜지는 전체 개수, '+N'은 그중 저장소가 스스로 더한 것이다.

const SOURCE_LABEL: Record<EnabledSource, string> = { global: '전역', project: '프로젝트', local: '로컬' };
const SOURCE_TITLE: Record<EnabledSource, string> = {
  global: '~/.claude (모든 프로젝트 공통)',
  project: '저장소의 .claude/settings.json · .claude 폴더 · .mcp.json (팀과 공유)',
  local: '저장소의 .claude/settings.local.json · ~/.claude.json의 이 저장소 항목 (내 컴퓨터에만)',
};
const SOURCES: EnabledSource[] = ['local', 'project', 'global'];
const COLS = ['plugins', 'skills', 'commands', 'agents', 'mcp', 'hooks'] as const;
const COL_LABEL: Record<(typeof COLS)[number], string> = { plugins: '플러그인', skills: '스킬', commands: '명령', agents: '에이전트', mcp: 'MCP', hooks: '훅' };

const SourceTag = ({ source }: { source: EnabledSource }) => (
  <span className={`enb-src enb-src-${source}`} title={SOURCE_TITLE[source]}>{SOURCE_LABEL[source]}</span>
);

export function EnabledOverviewPane({ data }: { data: EnabledOverview }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState<Set<string>>(new Set());
  const toggle = (key: string) => setOpen((s) => { const t = new Set(s); if (t.has(key)) t.delete(key); else t.add(key); return t; });
  const rows = data.projects.flatMap((p) => p.repos.map((r) => ({ p, r, key: `${p.project}/${r.repo}` })));

  return (
    <div className="plg">
      {data.errors.map((e) => <p key={e} className="error">{e}</p>)}
      <p className="small muted enb-lead">
        숫자는 그 저장소에서 켜지는 전체 개수이고, <span className="enb-own">+N</span>은 그중 저장소가 스스로 더한 것입니다. 줄을 누르면 무엇이 어디서 왔는지 보입니다.
        <button type="button" className="enb-refresh" onClick={() => qc.invalidateQueries({ queryKey: docKeys.doc('plugins-projects') })}>다시 읽기</button>
      </p>
      <div className="plg-table-wrap">
        <table className="plg-table enb-table">
          <thead>
            <tr><th>프로젝트 · 저장소</th>{COLS.map((c) => <th key={c} className="num">{COL_LABEL[c]}</th>)}<th>전역과 다름</th></tr>
          </thead>
          <tbody>
            <Row label="전역 기본" sub="~/.claude" layer={data.global} isOpen={open.has('')} onToggle={() => toggle('')} isGlobal />
            {rows.map(({ p, r, key }) => (r.found
              ? <Row key={key} label={p.displayName} sub={p.repos.length > 1 || r.repo !== p.displayName ? r.repo : ''} layer={r} isOpen={open.has(key)} onToggle={() => toggle(key)} />
              : (
                <tr key={key} className="plg-row-off">
                  <td><strong>{p.displayName}</strong>{r.repo !== p.displayName && <span className="small muted mono"> {r.repo}</span>}</td>
                  <td colSpan={COLS.length + 1} className="small muted">저장소 폴더를 찾지 못했습니다 (config.json의 include 자리)</td>
                </tr>
              )))}
          </tbody>
        </table>
      </div>
      <p className="small muted plg-sources">
        설정 파일 기준입니다. 앱이 계정 단위로 넣는 스킬 · 커넥터는 파일에 없어서 나오지 않습니다. 훅과 MCP는 이름만 보이고 실행 명령은 내보내지 않습니다.
        저장소 안의 설정을 고친 뒤에는 "다시 읽기"를 누릅니다(전역 설정은 바뀌면 바로 반영됩니다).
      </p>
    </div>
  );
}

function Row({ label, sub, layer, isOpen, onToggle, isGlobal }: { label: string; sub: string; layer: EnabledLayer; isOpen: boolean; onToggle: () => void; isGlobal?: boolean }) {
  const plain = !isGlobal && layer.differs === 0 && COLS.every((c) => layer.own[c] === 0);
  return (
    <Fragment>
      {/* 줄 어디를 눌러도 펼쳐진다. 키보드는 제목 버튼으로 연다 */}
      <tr className={`enb-row${plain ? ' enb-plain' : ''}`} onClick={onToggle}>
        <td>
          <button type="button" className="plg-toggle" aria-expanded={isOpen} onClick={(e) => { e.stopPropagation(); onToggle(); }}>
            <span aria-hidden="true">{isOpen ? '▾' : '▸'}</span> <strong>{label}</strong>
          </button>
          {sub && <span className="small muted mono"> {sub}</span>}
        </td>
        {COLS.map((c) => (
          <td key={c} className="num">
            {layer.counts[c]}
            {!isGlobal && layer.own[c] > 0 && <span className="enb-own" title="이 저장소가 더한 것"> +{layer.own[c]}</span>}
          </td>
        ))}
        <td>
          {isGlobal ? <span className="small muted">기준</span>
            : layer.differs > 0 ? <span className="enb-differs">{layer.differs}개</span>
              : plain ? <span className="small muted">전역 그대로</span> : <span className="small muted">없음</span>}
        </td>
      </tr>
      {isOpen && (
        <tr className="plg-detail">
          <td colSpan={COLS.length + 2}><Detail layer={layer} /></td>
        </tr>
      )}
    </Fragment>
  );
}

function Detail({ layer }: { layer: EnabledLayer }) {
  const bySource = <T extends { source: EnabledSource }>(list: T[], render: (items: T[], source: EnabledSource) => ReactNode) =>
    SOURCES.map((s) => ({ s, items: list.filter((x) => x.source === s) })).filter((g) => g.items.length > 0)
      .map((g) => <Fragment key={g.s}>{render(g.items, g.s)}</Fragment>);
  const names = (list: { name: string }[]) => list.map((x) => <span key={x.name} className="mono enb-name">{x.name}</span>);
  const line = (items: { name: string }[], source: EnabledSource, off = false, note = '') => (
    <div className={`enb-line${off ? ' enb-off' : ''}`}>
      <span className="enb-mark" aria-hidden="true">{off ? '–' : '✓'}</span>
      <span className="enb-names">
        {names(items)}
        <SourceTag source={source} />
        {off && <span className="small muted">꺼짐</span>}
        {note && <span className="small enb-differs">{note}</span>}
      </span>
    </div>
  );
  const onOff = (list: { name: string; source: EnabledSource; on: boolean; differs: boolean }[]) => bySource(list, (items, s) => (
    <>
      {items.filter((x) => x.on && x.differs).map((x) => <Fragment key={x.name}>{line([x], s, false, '전역과 다름 · 이 저장소에서만 켜짐')}</Fragment>)}
      {items.some((x) => x.on && !x.differs) && line(items.filter((x) => x.on && !x.differs), s)}
      {items.filter((x) => !x.on && x.differs).map((x) => <Fragment key={x.name}>{line([x], s, true, '전역과 다름 · 이 저장소에서만 꺼짐')}</Fragment>)}
      {items.some((x) => !x.on && !x.differs) && line(items.filter((x) => !x.on && !x.differs), s, true)}
    </>
  ));
  const group = (title: string, empty: boolean, body: ReactNode) => (
    <section className="enb-group">
      <h4 className="enb-h">{title}</h4>
      {empty ? <p className="small muted">없음</p> : body}
    </section>
  );
  return (
    <div className="enb-detail">
      {'dir' in layer && typeof layer.dir === 'string' && layer.dir && <p className="small muted mono">{layer.dir}</p>}
      {group('플러그인', layer.plugins.length === 0, onOff(layer.plugins))}
      {group('스킬', layer.skills.length === 0, bySource(layer.skills, (items, s) => line(items, s)))}
      {group('명령', layer.commands.length === 0, bySource(layer.commands, (items, s) => line(items, s)))}
      {group('에이전트', layer.agents.length === 0, bySource(layer.agents, (items, s) => line(items, s)))}
      {group('MCP', layer.mcp.length === 0, onOff(layer.mcp))}
      {group('훅', layer.hooks.length === 0, bySource(layer.hooks, (items, s) => line(items.map((h) => ({ name: h.count > 1 ? `${h.event} ×${h.count}` : h.event })), s)))}
      <p className="small muted">세션 목록에 들어가는 스킬 · 명령 설명 {layer.chars.toLocaleString('ko-KR')}자</p>
    </div>
  );
}
