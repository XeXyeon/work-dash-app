// 로드맵 · 이슈 · 작업 카드 폴더와 ui-state.json을 감시해 바뀐 것을 모아 알린다.
// 에이전트·훅·서버는 임시 파일에 쓰고 rename하므로(.tmp) 한 번 저장에 이벤트가 여러 번 온다 → 짧게 모아서 한 번에 보낸다.
import fs from 'node:fs';
import path from 'node:path';
import { DIRS, UI_STATE, ARCHIVED, CONFIG } from './workdash.js';

const DEBOUNCE_MS = 150;
const RETRY_MS = 5000;

// onChange(changes): changes = [{ kind: 'roadmaps' | 'issues' | 'cards' | 'flows' | 'ui-state' | 'archived', project?, file? }]
export function watchWorkDash(onChange) {
  const pending = new Map();
  let timer = null;
  const flush = () => { timer = null; const list = [...pending.values()]; pending.clear(); if (list.length) onChange(list); };
  const push = (change) => {
    pending.set(`${change.kind}:${change.project || ''}:${change.file || ''}`, change);
    if (!timer) timer = setTimeout(flush, DEBOUNCE_MS);
  };

  // 폴더가 없거나 감시가 끊기면(폴더 삭제 등) 잠시 뒤 다시 건다. 오류가 서버를 죽이지 않게 error도 받는다.
  const watchers = new Set();
  const retries = new Set();
  let closed = false;
  const watch = (dir, opts, handler) => {
    const retry = (why) => {
      if (closed) return;
      console.warn(`[watch] ${dir} 감시 실패: ${why} — ${RETRY_MS / 1000}초 뒤 다시 시도`);
      const t = setTimeout(() => { retries.delete(t); watch(dir, opts, handler); }, RETRY_MS);
      retries.add(t);
    };
    let w;
    try { w = fs.watch(dir, opts, handler); } catch (e) { return retry(e.message); }
    watchers.add(w);
    w.on('error', (e) => { w.close(); watchers.delete(w); retry(e.message); });
  };
  const isTemp = (name) => !name || name.endsWith('.tmp') || name.endsWith('.lock') || path.basename(name).startsWith('.');

  // roadmaps/<프로젝트>.md, issues/<프로젝트>.md
  for (const kind of ['roadmaps', 'issues', 'improvements']) {
    watch(DIRS[kind], {}, (_ev, name) => {
      if (isTemp(name) || !name.endsWith('.md')) return;
      push({ kind, project: name.slice(0, -3) });
    });
  }
  // flows/<프로젝트>.md — 같은 폴더의 공유 데이터(.share.json) 등 다른 파일은 무시한다
  watch(DIRS.flows, {}, (_ev, name) => {
    if (isTemp(name) || !name.endsWith('.md')) return;
    push({ kind: 'flows', project: name.slice(0, -3) });
  });
  // worklogs/<프로젝트>/<ID>.md (하위 폴더까지)
  watch(DIRS.worklogs, { recursive: true }, (_ev, name) => {
    if (isTemp(name) || !name.endsWith('.md')) return;
    const parts = name.split(path.sep);
    if (parts.length !== 2) return;
    push({ kind: 'cards', project: parts[0], file: parts[1].slice(0, -3) });
  });
  // data/ 안에서는 ui-state.json · archived-projects.json만 (history·세션 기록은 너무 자주 바뀐다)
  watch(path.dirname(UI_STATE), {}, (_ev, name) => {
    if (name === path.basename(UI_STATE)) push({ kind: 'ui-state' });
    else if (name === path.basename(ARCHIVED)) push({ kind: 'archived' });
  });
  // config.json (표시 이름 · 묶인 폴더, WEB-31). 웹 서버 · 에이전트 모두 임시 파일에 쓰고 바꿔치기한다
  watch(path.dirname(CONFIG), {}, (_ev, name) => {
    if (name === path.basename(CONFIG)) push({ kind: 'config' });
  });

  return () => { closed = true; clearTimeout(timer); for (const t of retries) clearTimeout(t); for (const w of watchers) w.close(); };
}
