import { useEffect, useState } from 'react';
import { fixAllCount, isProblem, problemCount, SETTINGS_HASH, useInstall, useInstallFix, type FixResult, type InstallItem, type InstallMark } from '../settingsApi';

// 설정 페이지 (WEB-57): npm run init의 계획을 서버 기준으로 다시 만들어, 설치가 꼬인 곳을 단계별로 보여 주고 버튼으로 고친다.
// 고치기는 서버가 계획을 그 자리에서 다시 만들어 id가 맞는 항목만 적용한다(점검한 뒤 바뀐 상태에 낡은 계획을 적용하지 않는다).

const MARK_LABEL: Record<InstallMark, string> = { '+': '고칠 수 있음 · 만든다', '~': '고칠 수 있음 · 바꾼다', '=': '정상', '!': '확인 필요', '?': '물어봄' };
const MARK_CLASS: Record<InstallMark, string> = { '+': 'fix', '~': 'fix', '=': 'ok', '!': 'warn', '?': 'ask' };

// 사이드바 제목 줄의 톱니바퀴. 손봐야 할 항목이 있으면 점을 붙인다
export function SettingsLink({ selected }: { selected: boolean }) {
  const { data } = useInstall();
  const n = problemCount(data);
  return (
    <a className={`gear-link${selected ? ' selected' : ''}`} href={SETTINGS_HASH} aria-current={selected ? 'page' : undefined}
       title={n ? `설정 · 설치 상태에 손볼 곳 ${n}개` : '설정 · 설치 상태'} aria-label={n ? `설정, 손볼 곳 ${n}개` : '설정'}>
      <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="3" />
        <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
      </svg>
      {n > 0 && <span className="gear-dot" />}
    </a>
  );
}

export function SettingsView() {
  const q = useInstall();
  const fix = useInstallFix();
  // 페이지를 열 때 받아 둔 결과가 낡았으면 다시 점검한다(톱니바퀴의 점을 그리느라 앱을 켤 때 한 번 받아 둔 것일 수 있다)
  useEffect(() => {
    if (q.dataUpdatedAt && Date.now() - q.dataUpdatedAt > 5000) q.refetch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [result, setResult] = useState<FixResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const data = q.data;
  const busy = fix.isPending || q.isFetching;
  // '모두 고치기'가 적용하는 것: 만든다 · 바꾼다 (물어봄은 항목마다 '바꾸기'로)
  const fixCount = fixAllCount(data);
  const run = (ids?: string[]) => {
    setResult(null); setError(null);
    fix.mutate(ids, { onSuccess: setResult, onError: (e) => setError(e.message) });
  };
  const recheck = () => { setResult(null); setError(null); q.refetch(); };

  return (
    <div className="settings">
      <header className="settings-head">
        <h2>
          설정
          <span className="settings-actions">
            <button className="mini-button" onClick={recheck} disabled={busy}>{q.isFetching ? '점검 중…' : '다시 점검'}</button>
            <button className="mini-button primary" onClick={() => run()} disabled={busy || !data || !!data.blocked || fixCount === 0}
                    title="만든다 · 바꾼다 항목을 모두 적용합니다. 고치는 파일은 먼저 백업합니다">
              모두 고치기{fixCount > 0 && <span className="settings-count">{fixCount}</span>}
            </button>
          </span>
        </h2>
        <p className="muted small">
          npm run init이 하는 일을 대시보드 서버 기준으로 다시 점검한 결과입니다. 고치는 파일은 먼저 ~/.work-dash/backup-init-*/에 백업합니다.
          대시보드가 뜨지 않을 때는 저장소에서 npm run init을 돌립니다.
        </p>
      </header>

      {q.isPending && <p className="muted">점검 중…</p>}
      {q.isError && <p className="error">설치 상태를 불러오지 못했습니다: {q.error.message}</p>}
      {data && (
        <>
          <dl className="settings-repo small">
            <div><dt>저장소</dt><dd className="mono">{data.repo}{data.branch && <span className="muted"> · {data.branch}</span>}</dd></div>
            <div>
              <dt>app 링크</dt>
              <dd className="mono">
                {data.app.path} → {data.app.target ?? (data.app.isLink ? '?' : '링크가 아님')}
                {data.app.isLink && !data.app.exists && <span className="error"> (가리키는 곳이 없음)</span>}
              </dd>
            </div>
            <div><dt>점검</dt><dd>{new Date(data.checkedAt).toLocaleString()}</dd></div>
          </dl>
          {data.blocked && <p className="settings-blocked">{data.blocked}</p>}
          {error && <p className="error">고치지 못했습니다: {error}</p>}
          {result && <FixNotice result={result} />}
          {data.steps.map((s) => {
            const bad = s.items.filter(isProblem).length;
            return (
              <section key={s.title} className="settings-step">
                <h3>{s.title}{bad > 0 && <span className="settings-step-bad">손볼 곳 {bad}</span>}</h3>
                <ul>
                  {s.items.map((i) => <Row key={i.id} item={i} disabled={busy || !!data.blocked} onFix={() => run([i.id])} />)}
                </ul>
              </section>
            );
          })}
        </>
      )}
    </div>
  );
}

function Row({ item, disabled, onFix }: { item: InstallItem; disabled: boolean; onFix: () => void }) {
  return (
    <li className={`settings-item mark-${MARK_CLASS[item.mark]}`}>
      <span className="settings-mark" title={MARK_LABEL[item.mark]}>{item.mark === '=' ? '✓' : MARK_LABEL[item.mark]}</span>
      <span className="settings-text">{item.text}</span>
      {item.mark === '?' && item.fixable && (
        <button className="mini-button" onClick={onFix} disabled={disabled} title="같은 이름의 파일 · 링크를 백업하고 바꿉니다">바꾸기</button>
      )}
    </li>
  );
}

function FixNotice({ result }: { result: FixResult }) {
  const { applied, failed, stale, backup } = result;
  return (
    <div className={`settings-notice${failed.length ? ' has-error' : ''}`}>
      <p>
        {applied.length ? `${applied.length}개를 적용했습니다(훅은 파일 하나를 한 번에 고쳐 1개로 셉니다).` : '적용한 것이 없습니다.'}
        {backup && <> 백업: <span className="mono">{backup}</span></>}
      </p>
      {stale.length > 0 && <p className="muted">점검한 뒤 상태가 바뀐 항목 {stale.length}개는 적용하지 않았습니다. 아래 새 점검 결과를 보고 다시 누릅니다.</p>}
      {failed.map((f) => <p key={f.id} className="error">실패: {f.text} — {f.error}</p>)}
    </div>
  );
}
