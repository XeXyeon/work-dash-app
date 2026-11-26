// npm run dev: 로컬 API 서버(node --watch)와 Vite 개발 서버를 함께 띄운다. Ctrl+C로 둘 다 끈다.
// 둘 다 node로 직접 실행한다 (npx를 거치면 종료 신호가 vite 손자 프로세스까지 가지 않을 수 있다).
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const viteBin = fileURLToPath(new URL('../node_modules/vite/bin/vite.js', import.meta.url));

const procs = [
  spawn(process.execPath, ['--watch', 'server/index.js'], { stdio: 'inherit' }),
  spawn(process.execPath, [viteBin], { stdio: 'inherit' }),
];
let stopping = false;
const stop = () => { stopping = true; for (const p of procs) if (p.exitCode === null) p.kill('SIGTERM'); };
for (const p of procs) {
  p.on('exit', (code, signal) => {
    // 먼저 끝난 쪽의 결과만 남긴다. 우리가 보낸 SIGTERM으로 끝난 나머지는 덮어쓰지 않는다.
    if (process.exitCode === undefined && !stopping) process.exitCode = code ?? (signal ? 1 : 0);
    stop();
  });
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
