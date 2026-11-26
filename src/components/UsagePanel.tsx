import { useNow } from '../useNow';
import { ago, fmtFull } from '../format';
import { useRefreshUsage, useSessionUsage, useTodayUsage, type SessionUsage, type UsageSide } from '../usageApi';

// 사이드바 맨 아래: 오늘 Claude · GPT 비용 · 토큰 + 고른 프로젝트 세션의 모델 · 컨텍스트 사용량 (WEB-20)
// 옛 TUI 하단 상태 줄(statusBar)과 같은 내용이다.
export function UsagePanel({ project }: { project: string | null }) {
  const now = useNow();
  return (
    <section className="usage-panel" aria-label="오늘 사용량">
      {project && <SessionContext project={project} />}
      <TodayUsageView now={now} />
    </section>
  );
}

// 1234567 → 1.2M, 12345 → 12K
export const kTok = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}K` : String(n));
const money = (n: number) => `$${n.toFixed(2)}`;

// claude-opus-5-5 → Opus 5.5, gpt-6-sol → GPT-6-sol (옛 TUI modelName)
export function modelLabel(m: string) {
  if (/^gpt/i.test(m)) return m.replace(/^gpt/i, 'GPT');
  return m.replace(/^claude-/, '').replace(/-\d{8}$/, '')
    .replace(/^([a-z]+)-(.*)$/, (_, n: string, v: string) => `${n[0].toUpperCase()}${n.slice(1)} ${v.replace(/-/g, '.')}`);
}

const COST_NOTE = 'ccusage가 API 단가로 환산한 금액입니다. 구독 요금제의 실제 청구액과 다를 수 있습니다.';

function TodayUsageView({ now }: { now: number }) {
  const q = useTodayUsage();
  const refresh = useRefreshUsage();
  const d = q.data;
  let body;
  if (q.isPending) body = <p className="muted small">불러오는 중…</p>;
  else if (q.isError) body = <p className="error small">사용량을 불러오지 못했습니다: {q.error.message}</p>;
  else if (d!.status === 'pending') body = <p className="muted small">오늘 비용 계산 중…</p>;
  else if (d!.status === 'error' || !d!.claude || !d!.gpt) body = <p className="error small" title={d!.error ?? undefined}>오늘 비용을 계산하지 못했습니다 (ccusage 실패)</p>;
  else body = <>
    <SideRow label="Claude" tone="claude" side={d!.claude} />
    <SideRow label="GPT" tone="gpt" side={d!.gpt} />
  </>;
  const stale = d?.status === 'ok' && d.error;
  return (
    <div className="usage-today">
      <div className="usage-head">
        <span title={COST_NOTE}>오늘 사용량 <span className="muted small">· API 환산</span></span>
        <span className="usage-head-right">
          {d?.updatedAt && (
            <span className={`small ${stale ? 'error' : 'muted'}`} title={stale ? `마지막 갱신 실패: ${d.error}` : `갱신 ${fmtFull(d.updatedAt)}`}>
              {stale ? '갱신 실패 · ' : ''}{ago(d.updatedAt, now)}
            </span>
          )}
          <button
            type="button"
            className={`usage-refresh${refresh.isPending ? ' spinning' : ''}`}
            onClick={() => refresh.mutate()}
            disabled={refresh.isPending}
            title={refresh.isError ? `새로고침 실패: ${refresh.error.message}` : '지금 다시 계산 (평소에는 1시간마다)'}
            aria-label="오늘 사용량 새로고침"
          >↻</button>
        </span>
      </div>
      {body}
    </div>
  );
}

function SideRow({ label, tone, side }: { label: string; tone: 'claude' | 'gpt'; side: UsageSide }) {
  const models = side.models.map((m) => `${m.name}: ${money(m.cost)} · ${kTok(m.tokens)} 토큰 · 출력 ${kTok(m.output)}`).join('\n');
  const title = [COST_NOTE, models,
    `입력 ${kTok(side.input)} · 캐시 쓰기 ${kTok(side.cacheWrite)} · 캐시 읽기 ${kTok(side.cacheRead)} · 출력 ${kTok(side.output)}`,
    side.unpriced.length ? `가격 정보 없는 모델(비용에 빠짐): ${side.unpriced.join(', ')}` : '']
    .filter(Boolean).join('\n\n');
  return (
    <div className="usage-side" title={title}>
      <span className={`usage-name usage-${tone}`}>{label}</span>
      {side.tokens === 0 ? <span className="muted small">오늘 사용 없음</span> : <>
        <span className="usage-cost mono">{money(side.cost)}{side.unpriced.length ? <span className="usage-warn">+?</span> : null}</span>
        <span className="usage-tok mono muted">{kTok(side.tokens)} · 출력 {kTok(side.output)}</span>
      </>}
    </div>
  );
}

const STATUS_LABEL: Record<string, string> = { working: '작업 중', waiting: '입력 대기', idle: '대기', ended: '끝남' };

function SessionContext({ project }: { project: string }) {
  const q = useSessionUsage(project);
  const s = q.data?.session;
  if (q.isPending) return null;
  if (q.isError) return <div className="usage-session"><p className="error small">세션 정보를 불러오지 못했습니다</p></div>;
  if (!s) return <div className="usage-session"><p className="muted small">이 프로젝트의 세션 기록 없음</p></div>;
  return (
    <div className="usage-session" title={`${s.source === 'gpt' ? 'GPT' : 'Claude'} 세션 · ${STATUS_LABEL[s.status] ?? s.status}${s.title ? `\n${s.title}` : ''}`}>
      <div className="usage-head">
        <span className="usage-model">
          <span className={`usage-dot usage-${s.source === 'gpt' ? 'gpt' : 'claude'}`} aria-hidden>●</span>
          {s.model ? modelLabel(s.model) : (s.source === 'gpt' ? 'GPT' : 'Claude')}
        </span>
        <span className="muted small">{STATUS_LABEL[s.status] ?? s.status}</span>
      </div>
      <ContextBar s={s} />
    </div>
  );
}

function ContextBar({ s }: { s: SessionUsage }) {
  if (s.ctx == null) return <p className="muted small">컨텍스트 정보 없음</p>;
  if (!s.limit) return <p className="small mono">컨텍스트 {kTok(s.ctx)} <span className="muted">(한도 모름)</span></p>;
  const pct = Math.min(100, Math.round((s.ctx / s.limit) * 100));
  const tone = pct >= 80 ? 'high' : pct >= 50 ? 'mid' : 'low';
  const guess = s.limitSource === 'default';
  return (
    <div className="usage-ctx" title={guess ? '이 모델의 컨텍스트 한도를 기록에서 알 수 없어 200K로 가정했습니다' : undefined}>
      <span className="usage-ctx-bar" role="meter" aria-label="컨텍스트 사용량" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
        <span className={`usage-ctx-fill tone-${tone}`} style={{ width: `${pct}%` }} />
      </span>
      <span className={`mono small usage-pct tone-${tone}`}>{pct}%</span>
      <span className="mono small muted">{kTok(s.ctx)}/{kTok(s.limit)}{guess ? '?' : ''}</span>
    </div>
  );
}
