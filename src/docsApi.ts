// 규칙 · 형식 문서 API (WEB-16). 모양은 server/docs.js를 따른다.
// 흐름 · 보관 기능(api.ts)과 따로 두어 서로 고칠 때 겹치지 않게 했다.
import { useQuery } from '@tanstack/react-query';
import { ApiError } from './api';

export type DocKind = 'markdown' | 'json' | 'html' | 'text' | 'plugins' | 'enabled';

export interface DocMeta {
  id: string;
  section: string;
  group: string;
  title: string;
  kind: DocKind;
  note: string;
  aliases: string[];
  path: string;
  exists: boolean;
  mtime: number;
  size: number;
}

export interface Doc extends DocMeta {
  content: string;
  truncated: boolean;
  error?: string;
  plugins?: PluginsOverview; // kind === 'plugins'일 때만 (WEB-42)
  enabled?: EnabledOverview; // kind === 'enabled'일 때만 (WEB-43)
}

// 프로젝트별 켜진 것 (WEB-43). 모양은 server/enabled.js를 따른다.
export type EnabledSource = 'global' | 'project' | 'local';
type EnabledCounts = { plugins: number; skills: number; commands: number; agents: number; mcp: number; hooks: number };
export interface EnabledLayer {
  dir?: string;
  plugins: { key: string; name: string; on: boolean; source: EnabledSource; installed: boolean; differs: boolean; skillCount: number; chars: number }[];
  skills: { name: string; source: EnabledSource; listed: boolean; chars: number }[];
  commands: { name: string; source: EnabledSource; listed: boolean; chars: number }[];
  agents: { name: string; source: EnabledSource }[];
  mcp: { name: string; source: EnabledSource; on: boolean; differs: boolean }[];
  hooks: { event: string; source: EnabledSource; count: number }[];
  counts: EnabledCounts;
  own: EnabledCounts;   // 저장소가 스스로 더한 것(전역이 아닌 출처)
  differs: number;      // 전역과 켜짐 여부가 다른 플러그인 · MCP 수
  chars: number;
}
export type EnabledRepo = ({ found: true } & EnabledLayer & { repo: string; dir: string }) | { found: false; repo: string; dir: string };
export interface EnabledOverview {
  global: EnabledLayer;
  projects: { project: string; displayName: string; repos: EnabledRepo[] }[];
  errors: string[];
}

// 플러그인 · 스킬 개요 (WEB-42). 모양은 server/plugins.js를 따른다.
export interface SkillInfo {
  name: string;
  description: string;
  chars: number;
  listed: boolean; // false: disable-model-invocation이라 모델용 목록에 들어가지 않는다
}
export type PluginStatus = 'on' | 'off' | 'unset';
export interface PluginInfo {
  key: string;
  name: string;
  marketplace: string;
  version: string;
  scope: string;
  installPath: string;
  updatedAt: string;
  status: PluginStatus;
  skills: SkillInfo[];
  chars: number;
  listedCount: number;
}
export interface PluginNoteItem {
  name: string;
  fields: [string, string][];
  extra: string;
}
export interface PluginsOverview {
  sources: { path: string; exists: boolean }[];
  plugins: PluginInfo[];
  userSkills: SkillInfo[];
  commands: SkillInfo[];
  notes: { intro: string; sections: { title: string; intro: string; items: PluginNoteItem[] }[] };
  notesExists: boolean;
  totals: { enabled: { count: number; chars: number }; all: { count: number; chars: number } };
  errors: string[];
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) {
    let msg = `${res.status}`;
    try { msg = (await res.json()).error || msg; } catch { /* 본문 없음 */ }
    throw new ApiError(res.status, msg);
  }
  return res.json() as Promise<T>;
}

// SSE changed(kind: 'docs')가 오면 ['docs'] 전체를 무효화한다 (useLiveEvents)
export const docKeys = {
  all: ['docs'] as const,
  list: ['docs', 'list'] as const,
  doc: (id: string) => ['docs', 'doc', id] as const,
};

export const useDocs = () => useQuery({ queryKey: docKeys.list, queryFn: () => getJson<DocMeta[]>('/api/docs') });

export const useDoc = (id: string | null) =>
  useQuery({
    queryKey: docKeys.doc(id ?? ''),
    queryFn: () => getJson<Doc>(`/api/docs/${encodeURIComponent(id!)}`),
    enabled: !!id,
  });
