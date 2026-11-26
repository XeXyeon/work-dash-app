import type { ProjectSummary } from '../api';
import { routeHash, type View } from '../useHashProject';

// 프로젝트 안의 화면 전환: 로드맵 · 이슈(WEB-4) · 흐름(WEB-9) · 기획(WEB-34) · 학습 노트(WEB-35). 링크라서 새 탭으로 열기 · 뒤로 가기가 된다
export function ViewTabs({ project, view, summary }: { project: string; view: View; summary: ProjectSummary }) {
  const tab = (v: View, label: string, note?: string) => (
    <a className={`view-tab${view === v ? ' selected' : ''}`} href={routeHash(project, v)} aria-current={view === v ? 'page' : undefined}>
      {label}{note && <span className="view-tab-note">{note}</span>}
    </a>
  );
  return (
    <nav className="view-tabs" aria-label="화면">
      {tab('roadmap', '로드맵', summary.hasRoadmap ? undefined : '없음')}
      {tab('issues', '이슈', summary.hasIssues ? (summary.openIssues ? `열림 ${summary.openIssues}` : undefined) : '없음')}
      {tab('flows', '흐름', summary.hasFlows ? undefined : '없음')}
      {tab('plans', '기획', summary.hasPlans ? undefined : '없음')}
      {tab('notes', '학습 노트')}
      {tab('improve', '개선 기록')}
    </nav>
  );
}
