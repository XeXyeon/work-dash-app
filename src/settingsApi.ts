// 설정 페이지 API (WEB-57). 모양은 bin/install.js의 installStatus · fixInstall을 따른다.
import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getJson, postJson } from './api';

// '+' 만든다 · '~' 바꾼다 · '=' 이미 있음 · '!' 확인 필요(손으로) · '?' 물어봄(같은 이름이 있음)
export type InstallMark = '+' | '~' | '=' | '!' | '?';
export interface InstallItem { id: string; mark: InstallMark; text: string; fixable: boolean }
export interface InstallStep { title: string; items: InstallItem[] }
export interface InstallStatus {
  repo: string;
  branch: string | null;
  worktree: boolean;
  app: { path: string; target: string | null; exists: boolean; isLink: boolean };
  blocked: string | null;   // 고치기를 막는 이유 (데이터 폴더가 기본 위치가 아님 · 워크트리에서 띄운 서버)
  checkedAt: string;
  steps: InstallStep[];
}
export interface FixResult { applied: string[]; failed: { id: string; text: string; error: string }[]; stale: string[]; backup: string | null }

export const installKey = ['install'] as const;

// 서버가 환경 점검(외부 명령)까지 돌리므로 저절로 다시 부르지 않는다. 다시 점검 · 고치기 때만 새로 부른다
export const useInstall = () =>
  useQuery({ queryKey: installKey, queryFn: () => getJson<InstallStatus>('/api/install'), staleTime: Infinity, refetchOnWindowFocus: false, retry: false });

export function useInstallFix() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (ids?: string[]) => postJson<FixResult>('/api/install/fix', ids ? { ids } : {}),
    onSettled: () => qc.invalidateQueries({ queryKey: installKey }),
  });
}

// 손볼 곳: 고칠 수 있음('+' '~') · 확인 필요('!'). 물어봄('?', 같은 이름의 명령 · 스킬)은 사용자가 일부러 둔 것일 수 있어 세지 않는다
export const isProblem = (i: InstallItem) => i.mark === '+' || i.mark === '~' || i.mark === '!';
export const problemCount = (s: InstallStatus | undefined) =>
  s ? s.steps.reduce((n, st) => n + st.items.filter(isProblem).length, 0) : 0;
// '모두 고치기'가 실제로 적용하는 수. 훅 단계는 파일 하나를 한 번에 쓰므로 단계 첫 항목 하나로 센다
export const fixAllCount = (s: InstallStatus | undefined) =>
  s ? s.steps.reduce((n, st) => n + st.items.filter((i) => (i.mark === '+' || i.mark === '~') && i.fixable).length, 0) : 0;

// 주소: #settings (프로젝트 주소 #/<프로젝트>와 겹치지 않게 '/'로 시작하지 않는다)
export const SETTINGS_HASH = '#settings';
export const isSettingsHash = (h = location.hash) => h === SETTINGS_HASH;
export function useSettingsRoute(): boolean {
  const [on, setOn] = useState(() => isSettingsHash());
  useEffect(() => {
    const f = () => setOn(isSettingsHash());
    window.addEventListener('hashchange', f);
    return () => window.removeEventListener('hashchange', f);
  }, []);
  return on;
}
