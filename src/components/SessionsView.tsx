import { useEffect, useMemo, useState } from 'react';
import { useDisplayName } from '../api';
import { useCloseoutSession, useCompactSession, useEndSession, useOpenSession, useSessions, type CloseoutEntry, type CloseoutResult, type SessionCard, type SessionStatus, type SubagentItem } from '../sessionsApi';
import { dismiss, dismissAll, isHidden, isUnread, markAllSeen, markSeen, prune, restoreDismissed, useSessionMarks } from '../sessionMarks';
import { SESSIONS_HASH, sessionsHash } from '../useSessionsRoute';
import { ago, fmtFull } from '../format';
import { useNow } from '../useNow';

// 세션 알림 카드 목록 (WEB-18, 정의는 WEB-17 카드)
// - 세션당 카드 1장. 입력 대기 · 응답 끝남 · 종료로 바뀌면 맨 위로(서버 eventAt 순), 작업 중으로 바뀌면 내용만 갱신
// - 새 변화는 점으로 표시, 카드를 누르면 읽음. ✕로 치우면 다음 변화 때까지 숨김
// - 카드를 누르면(WEB-19 재설계) 이 화면에 머문 채 ① 옆에 연결 항목의 작업 카드 패널을 띄우고(#sessions?session=…&project=…&item=…)
//   ② 그 대화를 Claude 앱 · ChatGPT(Codex) 앱 · iTerm에서 연다. 열면 읽음. 열 수 없는 카드는 패널만 띄우고 읽음
//   (예전의 "대화 열기" 버튼과 로드맵으로 이동하던 동작은 없앴다)

const STATUS_LABEL: Record<SessionStatus, string> = { waiting: '입력 대기', working: '작업 중', idle: '응답 끝남', ended: '종료', stale: '응답 없음' };
const KIND_LABEL: Record<SessionCard['kind'], string> = { 'claude-desktop': '데스크톱', 'claude-cli': '터미널', codex: 'Codex' };
// 카드 툴팁: 누르면 어디서 열리는지 (WEB-19)
const OPEN_TITLE: Record<SessionCard['kind'], string> = { 'claude-desktop': 'Claude 앱에서 열기', codex: 'ChatGPT(Codex) 앱에서 열기', 'claude-cli': 'iTerm에서 이어서 열기' };

// 사이드바 "규칙 · 형식 문서" 바로 아래 링크 + 안 읽은 수
export function SessionsLink({ selected }: { selected: boolean }) {
  const q = useSessions();
  const marks = useSessionMarks();
  const list = useMemo(() => q.data?.sessions ?? [], [q.data]);
  // 사이드바 링크는 늘 떠 있으므로 정리도 여기서 한다 (세션 알림 화면을 열지 않아도)
  useEffect(() => { if (list.length) prune(list); }, [list]);
  const unread = list.filter((s) => isUnread(s, marks)).length;
  const waiting = list.some((s) => s.status === 'waiting' && isUnread(s, marks));
  return (
    <a className={`sidebar-link sessions-link${selected ? ' selected' : ''}`} href={SESSIONS_HASH} aria-current={selected ? 'page' : undefined}>
      세션 알림
      {unread > 0 && <span className={`count-badge${waiting ? ' count-waiting' : ''}`}><span className="sr-only">안 읽은 알림 </span>{unread}<span className="sr-only">개</span></span>}
    </a>
  );
}

export function SessionsView({ selected }: { selected: string | null }) {   // selected: 고른 세션 카드 (주소의 session)
  const q = useSessions();
  const marks = useSessionMarks();
  const now = useNow(30_000);
  const [showHidden, setShowHidden] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const list = useMemo(() => q.data?.sessions ?? [], [q.data]);


  const hidden = list.filter((s) => isHidden(s, marks));
  // 보관한 세션은 목록 아래에 접어 둔다. 아직 읽지 않은 변화가 있으면 읽을 때까지 위 목록에 남긴다
  const isFolded = (s: SessionCard) => s.desktop?.archived === true && !isUnread(s, marks);
  const visible = showHidden ? list : list.filter((s) => !isHidden(s, marks));
  const shown = visible.filter((s) => !isFolded(s));
  const archived = visible.filter(isFolded);
  const unreadList = list.filter((s) => isUnread(s, marks));
  const unread = unreadList.length;
  // 모두 치우기: 지금 손이 가야 하는 카드(작업 중 · 입력 대기)는 남긴다. 치운 카드는 다음 변화 때 다시 올라오고, 아래 "모두 되돌리기"로 되살릴 수 있다
  const clearable = list.filter((s) => !isHidden(s, marks) && s.status !== 'working' && s.status !== 'waiting');

  return (
    <div className="sessions">
      <header className="sessions-head">
        <h2>
          세션 알림
          <span className="sessions-actions">
          {unread > 0 && (
            <button className="mini-button sessions-clear" title="카드는 그대로 두고 안 읽음 표시만 지웁니다"
                    onClick={() => markAllSeen(unreadList)}>
              모두 읽음 <span className="muted">{unread}</span>
            </button>
          )}
          {clearable.length > 0 && (
            <button className="mini-button sessions-clear" title="작업 중 · 입력 대기가 아닌 카드를 모두 치웁니다. 다음 변화가 오면 다시 올라옵니다"
                    onClick={() => { dismissAll(clearable); setShowHidden(false); }}>
              모두 치우기 <span className="muted">{clearable.length}</span>
            </button>
          )}
          </span>
        </h2>
        <p className="muted small">
          Claude · GPT 세션의 상태 변화. 입력 대기 · 응답 끝남 · 종료가 되면 맨 위로 올라옵니다
          {unread > 0 && <> · 안 읽음 <b>{unread}</b></>}
        </p>
      </header>
      {q.isPending && <p className="muted">불러오는 중…</p>}
      {q.isError && <p className="error">세션 목록을 불러오지 못했습니다: {q.error.message}</p>}
      {q.isSuccess && !list.length && <p className="muted">최근 7일 동안 기록된 세션이 없습니다.</p>}
      <ul className="session-cards">
        {shown.map((s) => <SessionCardRow key={s.id} s={s} now={now} unread={isUnread(s, marks)} hidden={isHidden(s, marks)} selected={s.id === selected} />)}
      </ul>
      {archived.length > 0 && (
        <section className="sessions-archived">
          <button type="button" className="sessions-archived-toggle small" aria-expanded={showArchived} onClick={() => setShowArchived((v) => !v)}>
            <span aria-hidden>{showArchived ? '▾' : '▸'}</span> 보관한 세션 <span className="muted">{archived.length}</span>
          </button>
          {showArchived && (
            <ul className="session-cards">
              {archived.map((s) => <SessionCardRow key={s.id} s={s} now={now} unread={false} hidden={isHidden(s, marks)} selected={s.id === selected} />)}
            </ul>
          )}
        </section>
      )}
      {hidden.length > 0 && (
        <p className="sessions-foot small muted">
          치운 카드 {hidden.length}장{' '}
          <button className="mini-button" onClick={() => setShowHidden((v) => !v)}>{showHidden ? '숨기기' : '보기'}</button>{' '}
          <button className="mini-button" onClick={() => { restoreDismissed(); setShowHidden(false); }}>모두 되돌리기</button>
        </p>
      )}
    </div>
  );
}

function SessionCardRow({ s, now, unread, hidden, selected }: { s: SessionCard; now: number; unread: boolean; hidden: boolean; selected: boolean }) {
  // 누르면 이 화면에 머문다: 주소에는 고른 카드와 (있으면) 연결 항목만 남긴다
  const dn = useDisplayName();
  const href = sessionsHash(s.id, s.item);
  const line = s.status === 'waiting'
    ? { label: '대기 이유', text: s.waitReason || '응답 대기' }
    : s.task ? { label: '진행 중', text: s.task }
      : s.lastPrompt ? { label: '마지막 요청', text: s.lastPrompt } : null;
  // 작업 중 · 입력 대기 · 응답 없음은 마지막 기록 시각, 응답 끝남 · 종료는 마지막 실제 대화 · 알림 시각.
  // 데스크톱 앱이 예전 세션을 열고 닫기만 해도 기록 시각(updatedAt)이 지금으로 바뀌어 '방금'으로 보이는 것을 막는다
  const when = s.status === 'idle' || s.status === 'ended' ? s.eventAt : s.updatedAt ?? s.eventAt;
  const open = useOpenSession(() => markSeen(s));   // 열기에 성공하면 읽음
  const { reset } = open;
  // 다른 카드를 고르면 이 카드의 지난 열기 오류는 지운다
  useEffect(() => { if (!selected) reset(); }, [selected, reset]);
  const what = s.canOpen ? OPEN_TITLE[s.kind] : s.kind === 'claude-desktop' ? '이 기기에서는 대화 열기가 꺼져 있습니다 (환경 점검)' : '대화 기록이 없는 세션이라 이어서 열 수 없습니다';
  // 링크 이동(패널 · 선택)은 그대로 두고 대화 열기를 함께 한다. Enter도 링크의 click으로 들어온다
  const onClick = () => {
    if (!s.canOpen) { markSeen(s); return; }
    if (open.isPending) return;
    open.mutate(s.id);
  };
  // 앱 세션은 모두 윗줄에 압축 버튼이 있다 (WEB-40): 종료된 세션(다시 열어 압축한다)과 크기를 읽지 못한 세션도 포함. 터미널 세션은 키 입력을 보낼 앱 창이 없어 크기만 보인다
  const isArchived = s.desktop?.archived === true;
  // 보관한 세션은 압축 버튼 없이 크기만 보인다
  const compactable = s.canCompact && !isArchived;   // 서버가 종류 · 열기 가능 · 환경 점검(WEB-53)을 함께 본다
  // 보관 버튼 (WEB-45): Claude 앱 세션 중 아직 보관하지 않은 것
  const archivable = s.canArchive && !s.desktop?.archived;
  const closeout = useCloseoutSession();
  const end = useEndSession();
  return (
    <li className={`session-card${compactable ? ' has-compact' : ''}${archivable ? ' has-archive' : ''}${isArchived ? ' archived' : ''} status-${s.status}${unread ? ' unread' : ''}${hidden ? ' dismissed' : ''}${selected ? ' selected' : ''}${open.isPending ? ' opening' : ''}`}
        aria-busy={open.isPending || undefined}>
      <a className="session-main" href={href} onClick={onClick} aria-current={selected ? 'true' : undefined}
         title={`${s.item ? '작업 카드 보기 · ' : ''}${what}`}>
        <span className="session-top">
          {unread && <span className="unread-dot"><span className="sr-only">안 읽음</span></span>}
          {isArchived
            ? <span className="session-status tone-archived" title={`Claude 앱에서 보관한 세션입니다 (마지막 상태: ${STATUS_LABEL[s.status]})`}>보관됨</span>
            : <span className={`session-status tone-${s.status}`}>{STATUS_LABEL[s.status]}</span>}
          <span className="session-project">{dn(s.project)}</span>
          <span className={`chip chip-${s.source}`}>{s.source === 'gpt' ? 'GPT' : 'Claude'}</span>
          <span className="muted small">{KIND_LABEL[s.kind]}</span>
          {s.context && !compactable && <ContextChip c={s.context} />}
          {!s.canOpen && <span className="session-noopen small">대화 열 수 없음</span>}
          <span className="session-when muted small" title={when ? fmtFull(when) : undefined}>{when ? ago(when, now) : ''}</span>
        </span>
        <span className="session-title">{s.title}</span>
        {line && <span className="session-line small"><span className="muted">{line.label}</span> {line.text}</span>}
        <span className="session-item small">
          {s.item
            ? <>{s.item.project !== s.project && <span className="muted">{dn(s.item.project)} · </span>}<span className="mono">{s.item.id}</span> {s.item.title}{s.item.via === 'doing' && <span className="muted"> (진행 중 항목으로 추정)</span>}</>
            : <span className="muted">{s.hasRoadmap ? '연결된 항목 없음' : '로드맵 없음'}</span>}
        </span>
      </a>
      {/* 여는 중 표시는 카드 오른쪽 아래 고정 크기 스피너 + 테두리 강조라 배치가 밀리지 않는다 */}
      {open.isPending && <span className="session-spinner" role="status" aria-label="대화 여는 중" />}
      {/* 오류는 한 줄 줄임 + 툴팁으로 카드 높이가 크게 바뀌지 않게 */}
      {open.isError && !open.isPending && (
        <p className="session-open-error small" role="alert" title={`대화를 열지 못했습니다: ${open.error.message}`}>
          대화를 열지 못했습니다: {open.error.message}
        </p>
      )}
      {compactable && <CompactButton s={s} c={s.context} />}
      {archivable && (
        <button type="button" className={`session-archive${closeout.isError ? ' failed' : ''}`} disabled={closeout.isPending} aria-busy={closeout.isPending || undefined}
                aria-label={`${s.title} 세션 보관`} onClick={() => { end.reset(); closeout.mutate(s.id); }}
                title={closeout.isError ? closeout.error.message : end.isSuccess ? '이 세션에 종결을 요청했습니다. 세션이 병합 · 서버 내리기 · 보관을 스스로 합니다' : '남은 것(커밋 전 변경 · 병합되지 않은 커밋 · 돌고 있는 하위 세션 등)을 먼저 보여 줍니다. 그다음 "종결 요청 보내기"를 눌러야 세션에 요청이 갑니다'}>
          {closeout.isPending ? '점검 중…' : closeout.isError ? '실패 · 다시' : end.isSuccess ? '요청 보냄' : '보관'}
        </button>
      )}
      {closeout.data && !closeout.isPending && (
        <CloseoutPanel r={closeout.data} onClose={closeout.reset} end={{ pending: end.isPending, sent: end.isSuccess, compact: end.data?.compact === true, error: end.isError ? end.error.message : null, send: () => end.mutate(s.id) }} />
      )}
      {s.subagents && <SubagentList s={s} now={now} />}
      {!hidden && (
        <button className="session-dismiss" aria-label={`${s.title} 카드 치우기`} title="다음 변화 때까지 숨기기" onClick={() => dismiss(s)}>✕</button>
      )}
    </li>
  );
}

// 보관 점검 결과 (WEB-45): 남은 것이 있으면 그 목록, 없으면 치운 것과 다음에 할 일
interface EndState { pending: boolean; sent: boolean; compact: boolean; error: string | null; send: () => void }
function CloseoutPanel({ r, onClose, end }: { r: CloseoutResult; onClose: () => void; end: EndState }) {
  const c = r.check;
  const head = r.stage === 'blocked' ? '남은 것이 있습니다. 요청을 보내면 세션이 병합할 것은 병합하고, 스스로 풀지 못하는 것에서 멈춰 알려 줍니다'
    : r.stage === 'checked' ? '남은 것이 없습니다'
      : '이미 보관한 세션입니다';
  return (
    <div className={`closeout stage-${r.stage}`} role="status">
      <p className="closeout-head"><strong>{head}</strong>
        <button type="button" className="closeout-close" aria-label="점검 결과 닫기" onClick={onClose}>✕</button></p>
      {c.blockers.map((b) => <CloseoutList key={b.kind} tone="block" e={b} />)}
      {r.stage === 'checked' && c.cleanable.processes.length > 0 && <CloseoutList tone="note" e={{ kind: 'procs', summary: `워크트리 안에 남은 프로세스 ${c.cleanable.processes.length}개`, items: c.cleanable.processes.map((p) => `${p.pid}${p.ports.length ? ` :${p.ports.join(',')}` : ''} ${p.command}`) }} />}
      {c.cleanable.branches.length > 0 && <CloseoutList tone="note" e={{ kind: 'merged', summary: '병합이 확인된 브랜치', items: c.cleanable.branches.map((x) => `${x.name} (origin/${x.base})`) }} />}
      {c.notes.map((n) => <CloseoutList key={n.kind} tone="note" e={n} />)}
      {c.unknowns.length > 0 && <CloseoutList tone="note" e={{ kind: 'unknowns', summary: '확인하지 못한 것', items: c.unknowns }} />}
      {(c.dir || c.branch) && <p className="closeout-meta muted small mono">{c.dir}{c.branch ? ` · ${c.branch}` : ''}{c.base ? ` → ${c.base}` : ''}</p>}
      {r.stage !== 'archived' && (
        <p className="closeout-actions">
          <button type="button" className={`closeout-send${end.error ? ' failed' : ''}`} disabled={end.pending || end.sent} aria-busy={end.pending || undefined} onClick={end.send}
                  title="Claude 앱에서 이 세션을 열고 '세션 종결해 줘'를 보냅니다. 세션이 한 일을 원격 통합 브랜치(dev)에 병합하고, 띄운 서버 · 도커를 내리고, 스스로 보관합니다. 대화가 20만 토큰을 넘으면 압축부터 합니다">
            {end.pending ? '보내는 중…' : end.sent ? (end.compact ? '압축을 먼저 보냈습니다' : '종결 요청을 보냈습니다') : end.error ? '실패 · 다시 보내기' : '종결 요청 보내기'}
          </button>
          <span className="muted small">{end.error ?? (end.sent ? (end.compact ? '대화가 커서 압축부터 합니다. 압축이 끝나면 종결 요청이 이어서 갑니다' : '진행은 그 세션의 대화에서 볼 수 있습니다') : '커밋 · 병합 · 서버 내리기 · 보관은 세션이 합니다')}</span>
        </p>
      )}
    </div>
  );
}
function CloseoutList({ e, tone }: { e: CloseoutEntry; tone: 'block' | 'done' | 'note' }) {
  return (
    <div className={`closeout-group tone-${tone}`}>
      <p className="closeout-sum small">{e.summary}</p>
      {e.items.length > 0 && <ul className="closeout-items small mono">{e.items.map((it, i) => <li key={i}>{it}</li>)}</ul>}
    </div>
  );
}

// 압축 버튼 (WEB-40): 카드 윗줄 오른쪽에 컨텍스트 크기와 함께 둔다(크기를 보고 바로 누른다). 한 번 누르면 실행한다.
// 그 세션의 앱(Claude · ChatGPT)이 앞으로 나와 /compact가 들어간다. 입력창에 /compact가 들어간 것을 확인하지 못하면 서버가 Enter를 누르지 않는다.
// 작업 중이어도 막지 않고, 보낸 뒤에도 곧 다시 누를 수 있다
function CompactButton({ s, c }: { s: SessionCard; c: SessionCard['context'] }) {
  const compact = useCompactSession();
  const { isSuccess, isError, reset } = compact;
  useEffect(() => {
    if (!isSuccess && !isError) return;
    const t = setTimeout(reset, isError ? 8000 : 3000);   // 결과를 잠깐 보여 주고 원래 모양으로
    return () => clearTimeout(t);
  }, [isSuccess, isError, reset]);
  const app = s.kind === 'codex' ? 'ChatGPT' : 'Claude';
  // 보낸 뒤부터 압축이 끝난 것이 보일 때까지: 서버가 알려 주는 c.compacting. 그 값이 오기 전 잠깐은 방금 보낸 결과(isSuccess)로 잇는다
  const busy = !compact.isPending && !compact.isError && (!!c?.compacting || compact.isSuccess);
  const size = c ? `컨텍스트 약 ${c.tokens.toLocaleString()} 토큰${c.approx ? " (압축 직후 어림, 다음 응답에서 정확해집니다)" : ""}${CONTEXT_NOTE[c.level]}` : '컨텍스트 크기를 읽지 못한 세션입니다';
  const title = compact.isError ? compact.error.message
    : compact.isSuccess ? (compact.data.draftRestored ? '/compact를 보냈고 입력창에 쓰던 글을 되돌려 놓았습니다' : '/compact를 보냈습니다')
    : busy ? `${app} 앱에서 압축하는 중입니다. 끝나면 줄어든 크기로 바뀝니다 (10분이 지나도 끝난 것이 보이지 않으면 원래 모양으로 돌아옵니다)\n다시 누르면 /compact를 한 번 더 보냅니다`
    : `${size}\n누르면 ${app} 앱에서 이 세션을 압축합니다 (입력창에 쓰던 글은 되돌려 놓습니다)`;
  return (
    <button type="button" className={`session-compact ctx-${c?.level ?? 'ok'}${compact.isError ? ' failed' : ''}${compact.isSuccess ? ' sent' : ''}${busy ? ' compacting' : ''}`}
            disabled={compact.isPending} aria-busy={compact.isPending || undefined} title={title}
            aria-label={`${s.title} 세션 압축${c ? ` (컨텍스트 ${man(c.tokens)})` : ''}`} onClick={() => compact.mutate(s.id)}>
      {compact.isPending ? '보내는 중…' : compact.isError ? '실패 · 다시' : busy ? <><span className="compact-spin" aria-hidden="true" />압축 중…</> : c ? <><span className="mono">{c.approx ? '약 ' : ''}{man(c.tokens)}</span> · 압축</> : '압축'}
    </button>
  );
}

// 컨텍스트 크기 (WEB-37): 압축할 때가 된 세션을 색으로 구분한다. 기준 숫자는 서버(usage.js COMPACT_AT)가 준다
const man = (n: number) => `${(n / 10_000).toFixed(n < 100_000 ? 1 : 0).replace(/\.0$/, '')}만`;
const CONTEXT_NOTE: Record<NonNullable<SessionCard['context']>['level'], string> = { ok: '', soon: ' · 압축할 때', over: ' · 자동 압축 기준 넘음' };
function ContextChip({ c }: { c: NonNullable<SessionCard['context']> }) {
  const title = `컨텍스트 ${c.approx ? '약 ' : ''}${c.tokens.toLocaleString()} 토큰${c.approx ? ' (압축 직후 어림, 다음 응답에서 정확해진다)' : ''}${c.limit ? ` / 한도 ${man(c.limit)}` : ''} · 압축 기준 ${man(c.soonAt)} · 자동 압축 ${man(c.autoAt)}`;
  return (
    <span className={`session-context ctx-${c.level} small mono`} title={title}>
      {man(c.tokens)}{c.level !== 'ok' && <span className="sr-only">{CONTEXT_NOTE[c.level]}</span>}
    </span>
  );
}

// 하위 에이전트 요약 줄 + 펼치면 목록. 카드 클릭(작업 카드 · 대화 열기)과 따로 동작한다
const SUB_STATUS: Record<SubagentItem['status'], string> = { running: '작업 중', background: '백그라운드', waiting: '입력 대기', stale: '응답 없음', done: '끝남' };
function SubagentList({ s, now }: { s: SessionCard; now: number }) {
  const [open, setOpen] = useState(false);
  const sub = s.subagents!;
  return (
    <div className="subagents">
      <button
        type="button"
        className="subagents-toggle small"
        aria-expanded={open}
        onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }}
      >
        <span aria-hidden>{open ? '▾' : '▸'}</span>
        <span className="muted">하위 에이전트</span> {sub.total}개
        {sub.working > 0 && <> · 작업 중 {sub.working}</>}
        {sub.waiting > 0 && <> · <span className="tone-waiting">입력 대기 {sub.waiting}</span></>}
      </button>
      {open && (
        <ul className="subagents-list">
          {sub.items.map((a, i) => (
            <li key={`${a.name}-${a.startedAt ?? i}`} className={`subagent sub-${a.status}`}>
              <span className="subagent-top small">
                <span className={`subagent-status sub-${a.status}`}>{SUB_STATUS[a.status]}</span>
                <span className="subagent-name">{a.name}</span>
                {a.at && <span className="muted" title={fmtFull(a.at)}>{ago(a.at, now)}</span>}
              </span>
              {a.title && <span className="subagent-title small">{a.title}</span>}
              {a.detail && <span className="subagent-detail small muted">{a.detail}</span>}
            </li>
          ))}
          {sub.total > sub.items.length && <li className="muted small">최근 {sub.items.length}개만 보여 줍니다</li>}
        </ul>
      )}
    </div>
  );
}
