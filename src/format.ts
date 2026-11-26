// 시각 · 상태 표시 규칙. 예전 TUI(tui.js, 삭제됨)의 ago · fmtDay · whenDone과 같은 규칙이다.
import type { Issue, Item } from './api';

const FRESH_MS = 60 * 60e3;   // 완료 1시간 이내는 강조

export const pad2 = (n: number) => String(n).padStart(2, '0');

export function ago(t: number, now = Date.now()) {
  const s = Math.round((now - t) / 1000);
  if (s < 60) return '방금';
  if (s < 3600) return `${Math.floor(s / 60)}분 전`;
  if (s < 86400) return `${Math.floor(s / 3600)}시간 전`;
  return `${Math.floor(s / 86400)}일 전`;
}

export function fmtDay(t: number) {
  const d = new Date(t);
  return `${String(d.getFullYear()).slice(2)}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

export function fmtFull(t: number) {
  const d = new Date(t);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

// 항목 왼쪽 상태 열: 글자와 색 톤
export type Tone = 'fresh' | 'recent' | 'old' | 'doing' | 'ready' | 'blocked' | 'await' | 'hold' | 'dropped';
export function itemStatus(it: Item, now = Date.now()): { text: string; tone: Tone; title?: string } {
  if (it.state === 'done') {
    if (!it.doneAt) return { text: '이전', tone: 'old' };
    const title = `완료 ${fmtFull(it.doneAt)}${it.estimated ? ' (추정)' : ''}`;
    if (now - it.doneAt < FRESH_MS) return { text: ago(it.doneAt, now), tone: 'fresh', title };
    if (it.recentDone) return { text: ago(it.doneAt, now), tone: 'recent', title };
    return { text: `${it.estimated ? '~' : ''}${fmtDay(it.doneAt)}`, tone: 'old', title };
  }
  if (it.state === 'doing') return { text: '진행 중', tone: 'doing', title: it.startedAt ? `시작 ${fmtFull(it.startedAt)}` : undefined };
  if (it.state === 'ready') return { text: '진행 가능', tone: 'ready' };
  if (it.state === 'await') return { text: '외부 대기', tone: 'await' };
  if (it.state === 'hold') return { text: '보류', tone: 'hold' };
  if (it.state === 'dropped') return { text: '취소', tone: 'dropped' };
  return { text: '선행 필요', tone: 'blocked' };
}

export const issueFinished = (st: Issue['state']) => st === 'done' || st === 'closed';

// 이슈 배지 색: 열린 높음 → 빨강, 열린 이슈 → 주황, 모두 해결 → 회색
export function issueBadgeTone(issues: Issue[]): 'high' | 'open' | 'resolved' {
  const open = issues.filter((x) => !issueFinished(x.state));
  if (open.some((x) => x.severity === '높음')) return 'high';
  return open.length ? 'open' : 'resolved';
}

export const ISSUE_STATE_LABEL: Record<Issue['state'], string> = { open: '열림', doing: '처리 중', done: '해결', closed: '닫음' };
