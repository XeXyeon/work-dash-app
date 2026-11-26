// 서버 SSE(/api/events)를 듣고 바뀐 파일에 해당하는 쿼리만 무효화한다.
// - hello: 처음 연결 · 재연결(서버 재시작 포함). 끊긴 동안 놓친 변경이 있을 수 있어 전부 다시 불러온다.
// - changed: { changes: [{ kind, project, file }] }
// - build: { build } 화면이 새로 빌드됨. hello에도 build가 온다.
//   처음 받은 build와 다르면 페이지를 다시 불러온다 (앱 창에는 새로고침 수단이 없다).
import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { keys } from './api';
import { docKeys } from './docsApi';
import { planKeys } from './plansApi';
import { noteKeys } from './notesApi';
import { improvementKeys } from './improvementsApi';
import { usageKeys } from './usageApi';
import { sessionKeys } from './sessionsApi';

type Change = { kind: 'roadmaps' | 'issues' | 'improvements' | 'cards' | 'flows' | 'ui-state' | 'archived' | 'config' | 'docs' | 'plans' | 'usage' | 'usage-session' | 'sessions'; project?: string; file?: string };
export type LiveStatus = 'connecting' | 'live' | 'offline';

export function useLiveEvents(): LiveStatus {
  const qc = useQueryClient();
  const [status, setStatus] = useState<LiveStatus>('connecting');

  useEffect(() => {
    let es: EventSource;
    let connectedOnce = false;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let delay = 2000;
    let disposed = false;
    let pageBuild: string | null | undefined;   // 이 페이지를 불러온 시점의 화면 빌드

    const checkBuild = (ev: Event) => {
      let build: string | null = null;
      try { build = JSON.parse((ev as MessageEvent).data).build ?? null; } catch { return; }
      if (!build) return;
      if (pageBuild === undefined) { pageBuild = build; return; }
      if (build !== pageBuild) location.reload();
    };
    const onHello = (ev: Event) => {
      checkBuild(ev);
      setStatus('live');
      delay = 2000;
      if (connectedOnce) qc.invalidateQueries();   // 재연결: 놓친 변경을 따라잡는다
      connectedOnce = true;
    };
    const onChanged = (ev: Event) => {
      let changes: Change[] = [];
      try { changes = JSON.parse((ev as MessageEvent).data).changes || []; } catch { return; }
      for (const c of changes) {
        if ((c.kind === 'roadmaps' || c.kind === 'issues' || c.kind === 'cards' || c.kind === 'flows') && !c.project) {
          qc.invalidateQueries();   // 어느 프로젝트인지 모르면 전부
        } else if (c.kind === 'roadmaps' && c.project) {
          // 다른 로드맵이 이 로드맵의 항목을 선행으로 가리킬 수 있으므로(교차 참조) 로드맵은 모두 다시 부른다
          qc.invalidateQueries({ queryKey: ['roadmap'] });
          qc.invalidateQueries({ queryKey: keys.projects });
        } else if (c.kind === 'issues' && c.project) {
          // 로드맵 응답에 항목별 이슈가 붙어 있으므로 로드맵도 다시 부른다
          qc.invalidateQueries({ queryKey: keys.issues(c.project) });
          qc.invalidateQueries({ queryKey: keys.roadmap(c.project) });
          qc.invalidateQueries({ queryKey: keys.projects });
        } else if (c.kind === 'cards' && c.project) {
          if (c.file) qc.invalidateQueries({ queryKey: keys.card(c.project, c.file) });
          qc.invalidateQueries({ queryKey: noteKeys.project(c.project) });   // 학습 노트는 카드에서 모은다 (WEB-35)
          qc.invalidateQueries({ queryKey: improvementKeys.project(c.project) });   // 문제 해결도 카드에서 모은다 (WEB-41)
          qc.invalidateQueries({ queryKey: keys.roadmap(c.project) });   // hasCard
        } else if (c.kind === 'improvements' && c.project) {
          qc.invalidateQueries({ queryKey: improvementKeys.project(c.project) });
        } else if (c.kind === 'flows' && c.project) {
          qc.invalidateQueries({ queryKey: keys.flows(c.project) });
          qc.invalidateQueries({ queryKey: keys.projects });   // hasFlows (문서가 새로 생기거나 지워졌을 때)
        } else if (c.kind === 'plans') {
          // 기획 문서 (WEB-34): 그 프로젝트의 목록 · 본문, 그리고 탭 옆 '없음' 표시(hasPlans)
          if (c.project) qc.invalidateQueries({ queryKey: planKeys.project(c.project) }); else qc.invalidateQueries({ queryKey: planKeys.all });
          qc.invalidateQueries({ queryKey: keys.projects });
        } else if (c.kind === 'config') {
          // config.json: 표시 이름(프로젝트 목록), 교차 참조 접두어(로드맵 선행 계산), 묶인 폴더(세션 연결)
          qc.invalidateQueries({ queryKey: keys.projects });
          qc.invalidateQueries({ queryKey: ['roadmap'] });
          qc.invalidateQueries({ queryKey: planKeys.all });   // 묶인 저장소가 바뀌면 기획 문서도
          qc.invalidateQueries({ queryKey: sessionKeys.all });
        } else if (c.kind === 'archived') {
          qc.invalidateQueries({ queryKey: keys.projects });   // 보관 목록 (다른 창 · 앱에서 바꿨을 때)
        } else if (c.kind === 'docs') {
          qc.invalidateQueries({ queryKey: docKeys.all });   // 규칙 · 형식 문서 (목록의 수정 시각도 바뀐다)
        } else if (c.kind === 'usage') {
          qc.invalidateQueries({ queryKey: usageKeys.today });   // 오늘 비용 · 토큰 (WEB-20, 서버가 ccusage를 다시 돌린 뒤)
        } else if (c.kind === 'usage-session') {
          qc.invalidateQueries({ queryKey: c.project ? usageKeys.session(c.project) : ['usage', 'session'] });   // 세션 컨텍스트
        } else if (c.kind === 'sessions') {
          qc.invalidateQueries({ queryKey: sessionKeys.all });   // 세션 알림 카드 (WEB-18, 세션 기록 폴더 1초 묶음 · Codex 주기 확인)
        } else if (c.kind === 'ui-state') {
          qc.invalidateQueries({ queryKey: ['roadmap'] });   // 접기 기억
        }
      }
    };
    // 브라우저는 연결 거부 같은 오류에는 스스로 재연결하지만(CONNECTING), 비정상 응답이면 포기한다(CLOSED).
    // 그때는 직접 새로 연결한다 (최대 30초 간격으로 늘려 가며).
    const connect = () => {
      es = new EventSource('/api/events');
      es.addEventListener('hello', onHello);
      es.addEventListener('changed', onChanged);
      es.addEventListener('build', checkBuild);
      es.onerror = () => {
        if (es.readyState !== EventSource.CLOSED) return setStatus('connecting');
        setStatus('offline');
        if (disposed) return;
        retryTimer = setTimeout(connect, delay);
        delay = Math.min(delay * 2, 30_000);
      };
    };
    connect();
    return () => { disposed = true; clearTimeout(retryTimer); es.close(); };
  }, [qc]);

  return status;
}
