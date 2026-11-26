// 기획 탭 API (WEB-34). 모양은 server/plans.js를 따른다.
import { useQuery } from '@tanstack/react-query';
import { getJson } from './api';

export type PlanKind = 'markdown' | 'json' | 'text';

export interface PlanMeta {
  id: string;      // 서버가 만든 목록 id (저장소 + docs 기준 상대 경로, base64url)
  repo: string;
  path: string;    // docs/ 기준 상대 경로 ('redesign/README.md')
  kind: PlanKind;
  size: number;
  mtime: number;
}
export interface PlanRepo { repo: string; hasDocs: boolean; docs: PlanMeta[] }
export interface PlansList { project: string; repos: PlanRepo[] }
export interface Plan extends PlanMeta { content: string; truncated: boolean; error?: string }

// SSE changed(kind: 'plans', project)가 오면 그 프로젝트의 ['plans', project] 전체를 무효화한다 (useLiveEvents)
export const planKeys = {
  all: ['plans'] as const,
  project: (project: string) => ['plans', project] as const,
  list: (project: string) => ['plans', project, 'list'] as const,
  doc: (project: string, id: string) => ['plans', project, 'doc', id] as const,
};

export const usePlans = (project: string, enabled = true) =>
  useQuery({ queryKey: planKeys.list(project), queryFn: () => getJson<PlansList>(`/api/plans/${encodeURIComponent(project)}`), enabled });

export const usePlan = (project: string, id: string | null) =>
  useQuery({
    queryKey: planKeys.doc(project, id ?? ''),
    queryFn: () => getJson<Plan>(`/api/plans/${encodeURIComponent(project)}/${encodeURIComponent(id!)}`),
    enabled: !!id,
  });

// 절 참조 §4.7 (WEB-39): docs/ 문서에서 제목이 그 번호로 시작하는 절
export interface PlanSection { id: string; repo: string; path: string; title: string; content: string; truncated: boolean }
export interface PlanSections { project: string; num: string; matches: PlanSection[] }
export const usePlanSection = (project: string | null, num: string | null) =>
  useQuery({
    queryKey: ['plans', project ?? '', 'section', num ?? ''] as const,
    queryFn: () => getJson<PlanSections>(`/api/plans/${encodeURIComponent(project!)}/section/${encodeURIComponent(num!)}`),
    enabled: !!project && !!num,
  });
