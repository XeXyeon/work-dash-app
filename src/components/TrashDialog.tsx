import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { keys, useProjectAction, type ProjectSummary, type TrashResult } from '../api';

// 프로젝트 삭제 확인 창 (WEB-14). 실수로 지우지 않도록 프로젝트 이름을 그대로 입력해야 버튼이 켜진다
export function TrashDialog({ project, onClose, onDone }: { project: string; onClose: () => void; onDone: (r: TrashResult) => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [typed, setTyped] = useState('');
  const action = useProjectAction({ onSuccess: (r) => onDone(r as TrashResult) });
  const summary = useQueryClient().getQueryData<ProjectSummary[]>(keys.projects)?.find((p) => p.project === project);

  // StrictMode에서 effect가 두 번 돌아도 이미 열린 창에 showModal을 다시 부르지 않는다
  useEffect(() => { const d = ref.current; if (d && !d.open) d.showModal(); }, []);

  const what = [
    summary?.hasRoadmap && `로드맵 (${summary.total}개 항목)`,
    summary?.hasIssues && '이슈',
    '작업 카드 (있으면)',
    summary?.hasFlows && '흐름 문서',
  ].filter(Boolean) as string[];

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (typed !== project) return;
    action.mutate({ project, action: 'trash', confirm: typed });
  };

  return (
    // 옮기는 중에는 Esc · 취소로 닫지 않는다: 닫혀도 서버는 옮기므로 '취소됐다'고 오해하게 된다
    <dialog ref={ref} className="dialog" onClose={onClose} onCancel={(e) => { if (action.isPending) e.preventDefault(); }} aria-labelledby="trash-title">
      <form onSubmit={submit}>
        <h2 id="trash-title" className="dialog-title">프로젝트 삭제</h2>
        <p><b>{project}</b>{summary && summary.displayName !== project && <span className="muted"> ({summary.displayName})</span>}의 파일을 <code>~/.work-dash/trash/</code>로 옮깁니다.</p>
        <ul className="dialog-list">{what.map((w) => <li key={w}>{w}</li>)}</ul>
        <p className="muted small">
          완전히 지우지는 않습니다. 되돌리려면 휴지통 폴더의 <code>manifest.json</code>에 적힌 원래 자리로 옮기세요.
          세션 기록과 완료 시각 기록은 남깁니다. 숨기기만 하려면 "보관"을 쓰세요.
        </p>
        <label className="dialog-label">
          확인을 위해 프로젝트 이름을 입력하세요
          <input autoFocus value={typed} onChange={(e) => setTyped(e.target.value)} placeholder={project} spellCheck={false} autoComplete="off" />
        </label>
        {action.isError && <p className="error small">삭제하지 못했습니다: {action.error.message}</p>}
        <div className="dialog-actions">
          <button type="button" className="mini-button" onClick={() => ref.current?.close()} disabled={action.isPending}>취소</button>
          <button type="submit" className="mini-button danger solid" disabled={typed !== project || action.isPending}>
            {action.isPending ? '옮기는 중…' : '휴지통으로 옮기기'}
          </button>
        </div>
      </form>
    </dialog>
  );
}
