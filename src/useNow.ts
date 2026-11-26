import { useEffect, useState } from 'react';

// 'N분 전' 같은 상대 시각이 저절로 바뀌도록 주기적으로 현재 시각을 갱신한다
export function useNow(intervalMs = 30_000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}
