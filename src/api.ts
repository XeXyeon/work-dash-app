// 로컬 서버(server/) API 응답 타입과 조회 함수. 모양은 server/workdash.js를 따른다.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

export type ItemState = 'done' | 'doing' | 'ready' | 'blocked' | 'await' | 'hold' | 'dropped';
export type IssueState = 'open' | 'doing' | 'done' | 'closed';
export type Severity = '높음' | '중간' | '낮음';

export interface Issue {
  id: string;
  parent: string;
  state: IssueState;
  severity: Severity;
  kind: string;
  title: string;
  owner: string;
  from: string;
  related: string[];
  github: string;
  details: { key: string; value: string }[];
  createdAt?: number;
  startedAt?: number;
  doneAt?: number;
}

export interface Item {
  state: ItemState;
  id: string;
  title: string;
  after: string[];
  waiting: string[];
  unknown: string[];
  owner: string;
  doneAt?: number;
  estimated: boolean;
  startedAt?: number;
  recentDone: boolean;
  recentStart: boolean;
  issues: Issue[];
  hasCard: boolean;
  // 다른 프로젝트 항목을 가리키는 선행 토큰('BE:MAT-11') → 해석 결과. 파서가 붙여 준다(없을 수 있다)
  xrefs?: Record<string, { project: string; id: string; found: boolean; state?: string }>;
}

export interface Milestone {
  key: string;
  name: string;
  due: string;
  folded: boolean;
  foldRemembered: boolean;
  total: number;
  done: number;
  openIssues: number;
  items: Item[];
}

export interface Roadmap {
  project: string;
  total: number;
  done: number;
  recentDone: number;
  mtime: number;
  milestones: Milestone[];
  commonIssues: Issue[];
}

export interface ProjectSummary {
  project: string;
  displayName: string;
  refKey: string | null;   // 다른 로드맵에서 이 프로젝트의 항목을 가리킬 때 쓰는 접두어 (config.json의 key, WEB-38)
  folders: string[];   // 묶인 작업 폴더 이름 (자기 이름 포함). 하나뿐이면 묶이지 않은 프로젝트
  hasRoadmap: boolean;
  hasIssues: boolean;
  hasFlows: boolean;
  hasPlans: boolean;   // 묶인 저장소 docs/에 문서가 있다 (WEB-34)
  archived: boolean;
  total: number;
  done: number;
  doing: number;
  ready: number;
  blocked: number;
  await: number;
  recentDone: number;
  doingItems: { id: string; title: string; owner: string; startedAt?: number }[];
  openIssues: number;
  mtime: number;
}

// 흐름 문서 (server getFlows → core/flows.js parse 결과)
export type FlowPart = { t: 'md'; text: string } | { t: 'mermaid'; code: string };

export interface Flow {
  name: string;
  slug: string;
  summary?: string;
  entry?: string;
  state?: string;
  errors?: string;
  files?: string;
  items?: string;
  updated?: string;
  stepsLabel: string;
  steps: string[];
  extra: string[];
  mermaid: string;
  diagrams: { title: string; code: string }[];
  chain: { cls: string; method: string }[];
}

export interface FlowsDoc {
  project: string;
  title: string;
  updated: string;
  intro: FlowPart[];
  overview: { name: string; items: FlowPart[] } | null;
  flows: Flow[];
  mtime: number;
}

// 이슈 화면 (server getIssues)
export interface IssuesDoc {
  project: string;
  issues: Issue[];
  common: Issue[];
  byParent: Record<string, Issue[]>;
  open: number;
}

// 작업 카드 원문 (server getCard)
export interface Card { project: string; id: string; markdown: string; mtime: number }

// 항목 작업 내역 (server getDetail → core/detail.js)
export interface ItemDetail {
  project: string;
  id: string;
  mode: 'window' | 'mention';
  from?: number;
  to?: number;
  asks: { t: number; source: 'claude' | 'gpt'; text: string }[];
  asksTotal: number;
  commits: { t: number; subject: string; add: number; del: number; files: number }[];
  files: { path: string; add?: number; del?: number }[];
  agents: string[];
}

// 작업 카드 파일 이름: 서버 cardName과 같은 규칙 (ID가 없으면 제목, / 와 : 는 _). SSE changed의 file과 맞춰 쿼리 키로 쓴다
export const cardName = (idOrTitle: string) => idOrTitle.replace(/[/:]/g, '_');

export class ApiError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) {
    let msg = `${res.status}`;
    try { msg = (await res.json()).error || msg; } catch { /* 본문 없음 */ }
    throw new ApiError(res.status, msg);
  }
  return res.json() as Promise<T>;
}

// 쿼리 키: SSE changed 이벤트의 kind · project로 필요한 것만 무효화한다 (useLiveEvents)
export const keys = {
  projects: ['projects'] as const,
  roadmap: (project: string) => ['roadmap', project] as const,
  issues: (project: string) => ['issues', project] as const,
  card: (project: string, id: string) => ['card', project, id] as const,
  flows: (project: string) => ['flows', project] as const,
  detail: (project: string, id: string) => ['detail', project, id] as const,
};

export const useProjects = () =>
  useQuery({ queryKey: keys.projects, queryFn: () => getJson<ProjectSummary[]>('/api/projects') });

// 화면에 보일 프로젝트 이름. 프로젝트 이름(파일 이름)은 구분용 값이고, 보이는 글자만 표시 이름으로 바꾼다 (WEB-31).
// 목록에 없으면(아직 못 불렀거나 이슈만 있는 이름 등) 프로젝트 이름 그대로
export function useDisplayName(): (project: string) => string {
  const { data } = useProjects();
  return (project) => data?.find((p) => p.project === project)?.displayName || project;
}

export const useRoadmap = (project: string | null, enabled = true) =>
  useQuery({
    queryKey: keys.roadmap(project ?? ''),
    queryFn: () => getJson<Roadmap>(`/api/roadmaps/${encodeURIComponent(project!)}`),
    enabled: !!project && enabled,
  });

export const useIssues = (project: string, enabled = true) =>
  useQuery({
    queryKey: keys.issues(project),
    queryFn: () => getJson<IssuesDoc>(`/api/issues/${encodeURIComponent(project)}`),
    enabled,
  });

// 카드가 없으면 404. 나중에 카드가 생기면 SSE(cards)가 이 키를 무효화해 다시 부른다
export const useCard = (project: string, id: string) =>
  useQuery({
    queryKey: keys.card(project, cardName(id)),
    queryFn: () => getJson<Card>(`/api/cards/${encodeURIComponent(project)}/${encodeURIComponent(cardName(id))}`),
  });

// 작업 내역은 감시하지 않는 세션 기록에서 오므로 SSE로 갱신되지 않는다. 패널을 다시 열 때 30초가 지났으면 새로 부른다
export const useItemDetail = (project: string, id: string, enabled = true) =>
  useQuery({
    queryKey: keys.detail(project, id),
    queryFn: () => getJson<ItemDetail>(`/api/details/${encodeURIComponent(project)}/${encodeURIComponent(cardName(id))}`),
    enabled,
    staleTime: 30_000,
  });

export const useFlows = (project: string, enabled = true) =>
  useQuery({
    queryKey: keys.flows(project),
    queryFn: () => getJson<FlowsDoc>(`/api/flows/${encodeURIComponent(project)}`),
    enabled,
  });

// ---- 쓰기: 프로젝트 보관 · 복원 · 휴지통 (WEB-14) ----
export async function postJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) {
    let msg = `${res.status}`;
    try { msg = (await res.json()).error || msg; } catch { /* 본문 없음 */ }
    throw new ApiError(res.status, msg);
  }
  return res.json() as Promise<T>;
}

export function saveFold(key: string, folded: boolean) {
  return postJson<{ key: string; folded: boolean }>('/api/ui-state/fold', { key, folded });
}

export type ProjectAction = 'archive' | 'unarchive' | 'trash' | 'rename';
export interface TrashResult { project: string; trashedTo: string; moved: string[] }

// SSE로도 갱신되지만, 누른 창은 응답을 받자마자 목록을 다시 불러 바로 반영한다
type ActionVars = { project: string; action: ProjectAction; confirm?: string; name?: string };
type ActionResult = { project: string; displayName?: string } & Partial<TrashResult>;
// 결과 알림은 여기(useMutation 옵션) 콜백으로 받는다. mutate(…, { onSuccess })는 연달아 누르면 앞 요청의 콜백이 버려지고
// 컴포넌트가 사라지면 불리지 않는다
export function useProjectAction(opts: { onSuccess?: (r: ActionResult, v: ActionVars) => void; onError?: (e: Error, v: ActionVars) => void } = {}) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ project, action, confirm, name }: ActionVars) =>
      postJson<ActionResult>(`/api/projects/${encodeURIComponent(project)}/${action}`, action === 'trash' ? { confirm } : action === 'rename' ? { name } : {}),
    onSuccess: (r, v) => { qc.invalidateQueries({ queryKey: keys.projects }); opts.onSuccess?.(r, v); },
    onError: (e, v) => opts.onError?.(e, v),
  });
}

// 4xx(없는 프로젝트 등)는 다시 시도해도 같으므로 재시도하지 않는다
export const shouldRetry = (count: number, err: Error) => !(err instanceof ApiError && err.status < 500) && count < 1;
