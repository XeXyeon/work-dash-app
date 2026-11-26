#!/usr/bin/env node
// Claude Code hook → 세션 상태 파일 갱신.
// 어떤 경우에도 Claude 작업을 막지 않도록 항상 exit 0, 출력 없음.
const { record } = require('./lib');
const { trackIfChanged } = require('./roadmap');

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { input += c; });
process.stdin.on('end', () => {
  try { if (input.trim()) record(JSON.parse(input)); } catch {}
  try { trackIfChanged(); } catch {}   // 로드맵 항목 시작/완료 시각 기록
  try { require('./issues').trackIfChanged(); } catch {}   // 이슈 발견/시작/해결 시각 기록
  process.exit(0);
});
setTimeout(() => process.exit(0), 2500);
