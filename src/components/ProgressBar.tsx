export function ProgressBar({ done, total, size = 'md' }: { done: number; total: number; size?: 'sm' | 'md' }) {
  const pct = total ? Math.round((done / total) * 100) : 0;
  return (
    <span className={`bar bar-${size}`} role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
      <span className="bar-fill" style={{ width: `${pct}%` }} />
    </span>
  );
}
