// 동작 흐름 문서(~/.work-dash/flows/<프로젝트>.md) 파서. work-dash 앱 서버가 흐름 화면에 쓴다.
// 예전에는 flows-html.js가 브라우저용 HTML도 만들었지만, 앱이 Markdown을 바로 그려서 HTML 생성은 지웠다.
const path = require('path');
const { WD } = require('./paths');

const FDIR = path.join(WD, 'flows');

const REF = /`([A-Z][A-Za-z0-9_]*)(?:\.([A-Za-z0-9_]+))?`/g;
const refsOf = (t) => [...String(t).matchAll(REF)].map((m) => ({ cls: m[1], method: m[2] || '' }));
const FIELDS = { '요약': 'summary', '진입점': 'entry', '데이터·상태 변화': 'state', '예외': 'errors', '관련 파일': 'files', '관련 항목': 'items', '마지막 갱신': 'updated' };

function parse(md, project) {
  const doc = { project, title: `${project} 동작 흐름`, updated: '', intro: [], overview: null, flows: [] };
  // sink: 머리말 · 전체 구조처럼 원문 그대로 보여 줄 곳. cur: 지금 읽는 흐름
  let cur = null, sink = doc.intro, fence = null, code = [], inSteps = false, heading = '';
  const pushMd = (arr, text) => { const last = arr[arr.length - 1]; if (last && last.t === 'md') last.text += '\n' + text; else arr.push({ t: 'md', text }); };
  for (const line of md.split('\n')) {
    if (line.startsWith('```')) {
      if (fence !== null) {
        const body = code.join('\n');
        if (fence === 'mermaid') {
          if (sink) sink.push({ t: 'mermaid', code: body });
          else if (cur) { cur.diagrams.push({ title: heading, code: body }); if (!cur.mermaid) cur.mermaid = body; }
        } else if (sink) pushMd(sink, '```\n' + body + '\n```');
        fence = null; code = [];
      } else fence = line.slice(3).trim() || 'text';
      continue;
    }
    if (fence !== null) { code.push(line); continue; }
    let m;
    if ((m = line.match(/^# (.+)/))) { doc.title = m[1].trim(); continue; }
    if ((m = line.match(/^>\s*마지막 갱신:\s*(.+)/))) { doc.updated = m[1].trim(); continue; }
    if ((m = line.match(/^## (.+)/))) {
      const name = m[1].trim(); heading = '';
      if (/^전체 구조/.test(name)) { doc.overview = { name, items: [] }; sink = doc.overview.items; cur = null; continue; }
      sink = null;
      cur = { name, steps: [], stepsLabel: '단계', extra: [], mermaid: '', diagrams: [] };
      cur.slug = 'f' + doc.flows.length;
      doc.flows.push(cur); inSteps = false; continue;
    }
    if (sink) { pushMd(sink, line); continue; }
    if (!cur) continue;
    if ((m = line.match(/^#{3,4} (.+)/))) { heading = m[1].trim(); inSteps = false; continue; }
    if ((m = line.match(/^- ([^:：]+)[:：]\s*(.*)$/))) {
      const key = m[1].trim();
      inSteps = /^단계/.test(key);
      if (inSteps) cur.stepsLabel = key;
      if (FIELDS[key]) cur[FIELDS[key]] = m[2].trim();
      else if (!inSteps) cur.extra.push(line.slice(2));
      continue;
    }
    if (inSteps && (m = line.match(/^\s+\d+\.\s+(.*)$/))) { cur.steps.push(m[1].trim()); continue; }
    if (line.trim()) cur.extra.push(line.trim());
  }
  // 흐름마다 등장하는 클래스 순서 (진입점 → 단계)
  for (const f of doc.flows) {
    f.chain = [];
    for (const r of [...refsOf(f.entry || ''), ...f.steps.flatMap(refsOf)]) {
      if (!f.chain.length || f.chain[f.chain.length - 1].cls !== r.cls) f.chain.push(r);
      else if (r.method && !f.chain[f.chain.length - 1].method) f.chain[f.chain.length - 1].method = r.method;
    }
  }
  return doc;
}

module.exports = { parse, FDIR };
