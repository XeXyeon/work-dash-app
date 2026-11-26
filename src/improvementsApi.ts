// 개선 기록 탭 API (WEB-41). 모양은 server/improvements.js를 따른다.
import { useQuery } from '@tanstack/react-query';
import { getJson } from './api';

export interface ImprovementRecord { key: string; title: string; date: number | null; kind: string | null; metric: string | null; measured: 'measured' | 'estimate' | null; body: string }
export interface SolvedProblem { item: string; cardTitle: string; date: number; body: string }
export interface ImprovementsDoc { project: string; hasFile: boolean; records: ImprovementRecord[]; solved: SolvedProblem[] }

// SSE changed(kind: 'improvements' | 'cards', project)가 오면 무효화한다 (useLiveEvents)
export const improvementKeys = {
  project: (project: string) => ['improvements', project] as const,
};

export const useImprovements = (project: string) =>
  useQuery({ queryKey: improvementKeys.project(project), queryFn: () => getJson<ImprovementsDoc>(`/api/improvements/${encodeURIComponent(project)}`) });
