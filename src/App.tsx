import { useCallback, useEffect, useRef, useState } from 'react';
import { saveFold, useProjects } from './api';
import { useLiveEvents } from './useLiveEvents';
import { routeHash, useHashProject } from './useHashProject';
import { ProjectList } from './components/ProjectList';
import { RoadmapView } from './components/RoadmapView';
import { FlowsView } from './components/FlowsView';
import { IssuesView } from './components/IssuesView';
import { PlansView } from './components/PlansView';
import { NotesView } from './components/NotesView';
import { ImprovementsView } from './components/ImprovementsView';
import { CardPanel } from './components/CardPanel';
import { IssuePanel } from './components/IssuePanel';
import { SectionPopover } from './components/SectionPopover';
import { ViewTabs } from './components/ViewTabs';
import { DocsView } from './components/DocsView';
import { useDocsRoute } from './useDocsRoute';
import { UsagePanel } from './components/UsagePanel';
import { SessionsLink, SessionsView } from './components/SessionsView';
import { isSessionsHash, sessionsHash, useSessionsRoute } from './useSessionsRoute';
import { ResizeHandle, SIDEBAR } from './components/ResizeHandle';
import { SettingsLink, SettingsView } from './components/SettingsView';
import { isSettingsHash, useSettingsRoute } from './settingsApi';

// 프로젝트가 아닌 화면(규칙 · 형식 문서 #docs, 세션 알림 #sessions, 설정 #settings)인지 주소를 직접 본다
const otherHash = () => location.hash.startsWith('#docs') || isSessionsHash() || isSettingsHash();

const LIVE_LABEL = { live: '실시간', connecting: '연결 중…', offline: '서버 연결 끊김' } as const;

export default function App() {
  const live = useLiveEvents();
  const projects = useProjects();
  const [selected, select, view, flow, item, issue] = useHashProject();
  const docsRoute = useDocsRoute();   // undefined면 프로젝트 화면, 아니면 규칙 · 형식 문서 화면 (WEB-16)
  const sessionsRoute = useSessionsRoute();   // 세션 알림 화면 (WEB-18) · 옆 작업 카드 패널 (WEB-19 재설계)
  const inSessions = sessionsRoute.on;
  const inDocs = docsRoute !== undefined;
  const inSettings = useSettingsRoute();   // 설정 · 설치 상태 (WEB-57)
  const inOther = inDocs || inSessions || inSettings;
  // 문서 화면 주소(#docs)에는 탭 정보가 없으므로, 그 전에 보던 탭(로드맵 · 이슈 · 흐름)을 기억해 두고
  // 문서 화면에서 프로젝트를 고르면 그 탭으로 연다
  const lastView = useRef(view);
  const sidebarRef = useRef<HTMLElement>(null);
  // (#docs로 바뀌는 사이 inDocs가 아직 false인 렌더가 한 번 끼므로 주소도 직접 본다)
  if (!inOther && !otherHash()) lastView.current = view;
  const selectProject = useCallback((p: string) => {
    if (inOther) location.hash = routeHash(p, lastView.current);
    else select(p);
  }, [inOther, select]);
  // 접은 상태는 서버가 ui-state.json에 저장한다(CUST-25)
  const [foldOverrides, setFoldOverrides] = useState<Record<string, boolean>>({});
  const toggleFold = useCallback((key: string, folded: boolean) => {
    setFoldOverrides((m) => ({ ...m, [key]: folded }));
    saveFold(key, folded).catch((e) => console.warn('마일스톤 접기 상태 저장 실패', e));
  }, []);

  // 선택이 없거나 없는(또는 보관한) 프로젝트면: 진행 중 항목이 있는 프로젝트 → 첫 프로젝트
  const all = projects.data ?? [];
  const list = all.filter((p) => !p.archived);
  const archived = all.filter((p) => p.archived);
  const summary = selected ? list.find((p) => p.project === selected) : undefined;
  const valid = !!summary;
  useEffect(() => {
    // 주소는 지금 값을 직접 본다: 프로젝트 · 문서 두 훅이 hashchange를 따로 들어서, #docs로 바뀔 때
    // '프로젝트는 없어졌는데 inDocs는 아직 false'인 렌더가 한 번 끼고, 그때 프로젝트로 되돌려 버린다
    if (inOther || otherHash() || !list.length || valid) return;
    const pick = list.find((p) => p.doing > 0 && p.hasRoadmap) ?? list.find((p) => p.hasRoadmap) ?? list[0];
    history.replaceState(null, '', routeHash(pick.project, view));   // 보던 화면(로드맵 · 이슈 · 흐름)은 유지
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  }, [list, valid, view, inOther]);

  // 오른쪽 패널은 하나: 작업 카드(?item=) 또는 이슈 카드(?issue=, WEB-22)
  const panelOpen = valid && !inOther && !!(item || issue);
  // 세션 알림 화면에서 카드를 누르면 연결 항목의 작업 카드 패널 (다른 프로젝트 항목일 수 있다, 보관한 프로젝트 포함)
  const sessionPanel = inSessions && sessionsRoute.project && sessionsRoute.item
    ? all.find((p) => p.project === sessionsRoute.project) : undefined;

  return (
    <div className="app">
      <aside className="sidebar" ref={sidebarRef}>
        <header className="sidebar-head">
          <h1>work-dash</h1>
          <span className="sidebar-head-right">
            <span className={`live live-${live}`} title="파일이 바뀌면 화면이 저절로 갱신됩니다">{LIVE_LABEL[live]}</span>
            <SettingsLink selected={inSettings} />
          </span>
        </header>
        {projects.isPending && <p className="muted pad">불러오는 중…</p>}
        {projects.isError && <p className="error pad">프로젝트 목록을 불러오지 못했습니다: {projects.error.message}</p>}
        <SessionsLink selected={inSessions} />
        {/* 위(제목 · 세션 알림)와 아래(문서 · 사용량)는 고정하고 프로젝트 목록만 스크롤한다 */}
        <div className="sidebar-scroll">
          <ProjectList projects={list} archived={archived} selected={valid && !inOther ? selected : null} onSelect={selectProject} />
        </div>
        {/* 맨 아래 고정: 규칙 · 형식 문서 링크 + 오늘 사용량 */}
        <div className="sidebar-foot">
          <a className={`sidebar-link${inDocs ? ' selected' : ''}`} href="#docs" aria-current={inDocs ? 'page' : undefined}>규칙 · 형식 문서</a>
          <UsagePanel project={valid && !inOther ? selected : null} />
        </div>
      </aside>
      {/* 사이드바 폭 조절 (WEB-23). 760px 이하(사이드바가 위로 가는 배치)에서는 CSS로 숨긴다 */}
      <ResizeHandle storageKey={SIDEBAR.key} cssVar={SIDEBAR.cssVar} def={SIDEBAR.def} min={SIDEBAR.min} max={SIDEBAR.max}
                    edge="right" target={sidebarRef} label="사이드바 폭" className="sidebar-resize" />
      <main className={`main${panelOpen || sessionPanel ? ' with-panel' : ''}`}>
        {inSettings ? <SettingsView /> : inDocs ? <DocsView id={docsRoute} /> : inSessions ? <SessionsView selected={sessionsRoute.session} /> : valid ? <>
          <ViewTabs project={selected!} view={view} summary={summary!} />
          {view === 'flows'
            ? <FlowsView key={selected} project={selected!} summary={summary!} flow={flow} />
            : view === 'plans'
              ? <PlansView key={selected} project={selected!} summary={summary!} doc={flow} />
              : view === 'notes'
                ? <NotesView key={selected} project={selected!} selectedItem={panelOpen ? item : null} />
                : view === 'improve'
                  ? <ImprovementsView key={selected} project={selected!} selectedItem={panelOpen ? item : null} />
                : view === 'issues'
                  ? <IssuesView key={selected} project={selected!} summary={summary!} selected={panelOpen ? issue : null} />
                  : <RoadmapView
                      key={selected}
                      project={selected!}
                      summary={summary!}
                      foldOverrides={foldOverrides}
                      onToggleFold={toggleFold}
                      selectedItem={item}
                      selectedIssue={panelOpen ? issue : null}
                    />}
        </> : null}
      </main>
      {panelOpen && (item
        ? <CardPanel key={`${selected}/${item}`} project={selected!} summary={summary!} id={item} view={view} flow={flow} />
        : <IssuePanel key={`${selected}/issue/${issue}`} project={selected!} summary={summary!} id={issue!} view={view} flow={flow} />)}
      {sessionPanel && (
        <CardPanel key={`sessions/${sessionPanel.project}/${sessionsRoute.item}`} project={sessionPanel.project} summary={sessionPanel}
                   id={sessionsRoute.item!} view="roadmap" flow={null} closeHref={sessionsHash(sessionsRoute.session)} />
      )}
      <SectionPopover />
    </div>
  );
}
