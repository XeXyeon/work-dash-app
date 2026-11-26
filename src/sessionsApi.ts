// 세션 알림 카드 API (WEB-18). 모양은 server/sessions.js를 따른다.
import { useMutation, useQuery } from '@tanstack/react-query';
import { ApiError, postJson } from './api';

// 대화 열기 (WEB-19): POST /api/sessions/<id>/open
export type OpenHow = 'claude-app' | 'codex-app' | 'iterm';
// onSuccess는 훅 옵션으로 받는다: mutate()에 넘긴 콜백과 달리, 여는 중에 카드가 사라져도(치우기 · 화면 이동) 불린다
export const useOpenSession = (onSuccess?: (id: string) => void) => useMutation({
  mutationFn: (id: string) => postJson<{ ok: true; how: OpenHow }>(`/api/sessions/${encodeURIComponent(id)}/open`, {}),
  onSuccess: (_data, id) => onSuccess?.(id),
});

// 세션 압축 (WEB-40): POST /api/sessions/<id>/compact. 앱 세션(Claude 앱 · ChatGPT 앱의 Codex)만. draftRestored: 입력창에 쓰던 글을 되돌려 놓았다
export const useCompactSession = () => useMutation({
  mutationFn: (id: string) => postJson<{ ok: true; draftRestored: boolean }>(`/api/sessions/${encodeURIComponent(id)}/compact`, {}),
});

// 세션 보관 (WEB-45): Claude 앱 세션만. 대시보드는 직접 치우지 않는다.
// 1) POST /api/sessions/<id>/closeout: 점검만 한다. 남은 것(blockers)이 있으면 stage 'blocked', 없으면 'checked'
// 2) POST /api/sessions/<id>/end: 그 세션에 종결을 요청하는 글을 보낸다. 마무리(커밋 · 병합 · 서버 · 도커 내리기 · 보관)는 세션이 종결 명령(WEB-48)대로 한다.
//    대화가 20만 토큰을 넘으면 서버가 압축을 먼저 보내고(compact: true), 압축이 끝나면 종결 요청을 이어 보낸다
export interface CloseoutEntry { kind: string; summary: string; items: string[] }
export interface CloseoutResult {
  ok: true;
  stage: 'checked' | 'blocked' | 'archived';
  check: {
    dir?: string; branch?: string | null; base?: string;
    worktree?: { exists: boolean; linked?: boolean };
    merge?: { merged: 'ancestor' | 'patch' | 'pr' | null; ahead: number | null };
    blockers: CloseoutEntry[]; notes: CloseoutEntry[]; unknowns: string[];
    cleanable: { processes: { pid: number; command: string; ports: number[] }[]; branches: { name: string; base: string }[] };
  };
}
export const useCloseoutSession = () => useMutation({
  mutationFn: (id: string) => postJson<CloseoutResult>(`/api/sessions/${encodeURIComponent(id)}/closeout`, {}),
});
export const useEndSession = () => useMutation({
  mutationFn: (id: string) => postJson<{ ok: true; compact: boolean; draftRestored?: boolean }>(`/api/sessions/${encodeURIComponent(id)}/end`, {}),
});

// status: stale = 15분 넘게 기록이 없는 작업 중 세션('응답 없음'). Codex는 로그 읽기가 idle로 바꾼 경우도 stale
export type SessionStatus = 'waiting' | 'working' | 'idle' | 'ended' | 'stale';
// 마지막 알림 변화. 작업 중으로 바뀌면 null(카드 내용만 갱신)
export type SessionEvent = 'waiting' | 'done' | 'ended';

export interface SessionCard {
  id: string;
  source: 'claude' | 'gpt';
  kind: 'claude-desktop' | 'claude-cli' | 'codex';
  canOpen: boolean;   // false: 대화 기록이 없는 터미널 세션 (이어서 열 수 없음), 또는 환경 점검이 대화 열기를 끈 Claude 앱 세션
  canCompact: boolean;   // 압축 버튼을 낼지 (환경 점검이 끈 기능이면 false, WEB-53)
  canArchive: boolean;   // 종결(보관) 버튼을 낼지 (Claude 앱 세션이고 환경 점검이 켠 기능일 때)
  project: string;
  title: string;                 // 데스크톱 세션 제목 → 세션 제목(첫 프롬프트) → 마지막 프롬프트
  sessionTitle: string | null;
  desktop: { localId: string; archived: boolean } | null;
  status: SessionStatus;
  waitReason: string | null;
  task: string | null;           // 진행 중 작업 한 줄
  lastPrompt: string | null;
  event: SessionEvent | null;
  eventAt: number;               // 카드 정렬 기준 (알림 변화 때만 바뀐다)
  startedAt: number | null;
  updatedAt: number | null;
  item: { project: string; id: string; title: string; via: 'text' | 'doing' } | null;
  // Codex 하위 에이전트를 부모 카드에 묶은 요약 (하위 에이전트는 따로 카드가 없다)
  // 하위 에이전트 (Codex: 부모 대화가 띄운 대화 · Claude: Agent 도구 호출). 카드를 펼치면 items가 보인다
  subagents?: { total: number; working: number; waiting: number; names: string[]; items: SubagentItem[] };   // project: 세션 폴더와 다른 프로젝트일 수 있다
  hasRoadmap: boolean;
  // 컨텍스트 크기 (WEB-37). 종료된 세션이나 기록에서 읽지 못한 세션은 null.
  // level: soon = 압축할 때(Claude 20만 · Codex 7만), over = 자동 압축 기준(Claude 30만 · Codex 10만)을 넘음
  context: { tokens: number; approx?: boolean; compacting?: boolean; limit: number | null; level: 'ok' | 'soon' | 'over'; soonAt: number; autoAt: number } | null;
}

export interface SessionsResponse { at: number; staleMs: number; sessions: SessionCard[] }

// SSE changed: kind 'sessions' → all (useLiveEvents)
export const sessionKeys = { all: ['sessions'] as const };

export const useSessions = () => useQuery({
  queryKey: sessionKeys.all,
  queryFn: async () => {
    const res = await fetch('/api/sessions');
    if (!res.ok) {
      let msg = `${res.status}`;
      try { msg = (await res.json()).error || msg; } catch { /* 본문 없음 */ }
      throw new ApiError(res.status, msg);
    }
    return res.json() as Promise<SessionsResponse>;
  },
});

export interface SubagentItem {
  name: string;          // Codex: 에이전트 이름 · Claude: 에이전트 종류
  title: string;         // 맡긴 일
  status: 'running' | 'background' | 'waiting' | 'stale' | 'done';
  detail: string | null; // 진행 중 작업 또는 마지막 활동
  startedAt: number | null;
  at: number | null;     // 끝난 시각 · 마지막 활동
}
