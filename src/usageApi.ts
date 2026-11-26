// 오늘 비용 · 토큰과 세션 컨텍스트 사용량 API (WEB-20). 모양은 server/usage.js를 따른다.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError } from './api';

export interface UsageModel { name: string; cost: number; tokens: number; output: number }

// 한쪽(Claude 또는 GPT)의 오늘 합계. tokens = 입력 + 출력 + 캐시 쓰기 + 캐시 읽기
export interface UsageSide {
  cost: number;
  tokens: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  models: UsageModel[];
  unpriced: string[];   // 토큰은 있는데 ccusage에 가격이 없는 모델
}

export interface TodayUsage {
  status: 'pending' | 'ok' | 'error';
  date: string;
  updatedAt: number | null;
  error: string | null;   // ok여도 직전 갱신이 실패했으면 문구가 있다 (값은 그 전 것)
  claude: UsageSide | null;
  gpt: UsageSide | null;
}

export interface SessionUsage {
  source: 'claude' | 'gpt';
  id: string;
  title: string;
  status: 'working' | 'waiting' | 'idle' | 'ended' | string;
  updatedAt: number | null;
  model: string | null;
  ctx: number | null;
  limit: number | null;
  limitSource: 'log' | 'learned' | 'default' | null;   // default = 한도를 모르는 Claude 모델이라 200K로 가정
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

// SSE changed: kind 'usage' → today, kind 'usage-session' + project → session(project) (useLiveEvents)
export const usageKeys = {
  today: ['usage', 'today'] as const,
  session: (project: string) => ['usage', 'session', project] as const,
};

export const useTodayUsage = () => useQuery({ queryKey: usageKeys.today, queryFn: () => getJson<TodayUsage>('/api/usage') });

// 새로고침 버튼: 서버가 ccusage를 바로 다시 돌리고, 끝나면 그 결과를 응답으로 준다(보통 1~2초, 최대 90초)
export function useRefreshUsage() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const res = await fetch('/api/usage/refresh', { method: 'POST' });
      if (!res.ok) {
        let msg = `${res.status}`;
        try { msg = (await res.json()).error || msg; } catch { /* 본문 없음 */ }
        throw new ApiError(res.status, msg);
      }
      return res.json() as Promise<TodayUsage>;
    },
    onSuccess: (d) => qc.setQueryData(usageKeys.today, d),
  });
}

export const useSessionUsage = (project: string | null) =>
  useQuery({
    queryKey: usageKeys.session(project ?? ''),
    queryFn: () => getJson<{ project: string; session: SessionUsage | null }>(`/api/usage/${encodeURIComponent(project!)}`),
    enabled: !!project,
  });
