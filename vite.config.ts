import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

declare const process: { env: Record<string, string | undefined> };   // @types/node 없이 환경변수만 읽는다

// 개발 중에는 Vite(5173)가 화면을, 로컬 서버(4949)가 API를 맡는다.
// changeOrigin: 서버의 Host 검사(DNS 리바인딩 방지)를 통과하도록 Host를 127.0.0.1:4949로 바꿔 보낸다.
export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: Number(process.env.VITE_PORT) || 5173,
    strictPort: true,
    // 개발 포트를 바꿔 띄울 때(VITE_PORT · WORK_DASH_APP_PORT) 프록시도 따라간다
    proxy: { '/api': { target: `http://127.0.0.1:${Number(process.env.WORK_DASH_APP_PORT) || 4949}`, changeOrigin: true } },
  },
});
