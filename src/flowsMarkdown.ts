// 흐름 문서의 짧은 Markdown(머리말 · 전체 구조 · 흐름 항목)을 HTML 문자열로 바꾼다.
// 예전 HTML 생성기(flows-html.js, 삭제됨)의 mdToHtml · rich와 같은 규칙(제목 · 표 · 목록 · 코드 · 문단 · `코드` · **굵게**)이라
// 생성 HTML과 같은 모양이 된다. 모든 원문은 esc()를 거친 뒤 태그를 붙이므로 dangerouslySetInnerHTML에 넣어도 안전하다.
import type { Flow } from './api';

export const esc = (s: unknown) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

// 한 줄 안: `코드` → <code>, **굵게** → <b>
export const inline = (s: string) =>
  esc(s).replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');

// opts.card: 작업 카드처럼 문서 전체를 그릴 때. `#`~`##` 제목도 제목으로 받고(# → h2, ## → h3, ### → h4, 그 아래 → h5),
// 목록 앞 체크 표시([ ] · [x])와 인용(> …)을 처리한다. 흐름 문서(기본)는 예전처럼 ###부터만 제목이다.
export function mdToHtml(text: string, opts: { card?: boolean } = {}): string {
  const card = !!opts.card;
  const headRe = card ? /^(#{1,6}) (.+)/ : /^(#{3,6}) (.+)/;
  const headTag = (n: number) => (card ? `h${Math.min(n + 1, 5)}` : n === 3 ? 'h3' : 'h4');
  const item = (s: string) => {
    const box = card && s.match(/^\[([ xX~-])\] (.*)$/);
    return box ? `<span class="md-box md-box-${({ ' ': 'open', '~': 'doing', '-': 'closed' } as Record<string, string>)[box[1]] ?? 'done'}">[${esc(box[1])}]</span> ${inline(box[2])}` : inline(s);
  };
  const lines = String(text).split('\n');
  let out = '';
  let i = 0;
  const isList = (l: string) => /^\s*([-*]|\d+\.) /.test(l);
  while (i < lines.length) {
    const l = lines[i];
    if (!l.trim()) { i++; continue; }
    if (l.startsWith('```')) {
      const buf: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith('```')) buf.push(lines[i++]);
      i++;
      out += `<pre class="md-code">${esc(buf.join('\n'))}</pre>`;
      continue;
    }
    const h = l.match(headRe);
    if (h) { const tag = headTag(h[1].length); out += `<${tag}>${inline(h[2])}</${tag}>`; i++; continue; }
    if (card && l.startsWith('>')) {
      const buf: string[] = [];
      while (i < lines.length && lines[i].startsWith('>')) buf.push(lines[i++].replace(/^>\s?/, ''));
      out += `<blockquote>${mdToHtml(buf.join('\n'), opts)}</blockquote>`;
      continue;
    }
    if (l.trim().startsWith('|')) {
      const rows: string[] = [];
      while (i < lines.length && lines[i].trim().startsWith('|')) rows.push(lines[i++].trim());
      const cells = (r: string) => r.replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
      const body = rows.filter((r) => !/^\|[\s:|-]+\|$/.test(r));
      if (!body.length) continue;
      out += '<div class="md-table"><table><thead><tr>' + cells(body[0]).map((c) => `<th>${inline(c)}</th>`).join('') + '</tr></thead><tbody>'
        + body.slice(1).map((r) => '<tr>' + cells(r).map((c) => `<td>${inline(c)}</td>`).join('') + '</tr>').join('') + '</tbody></table></div>';
      continue;
    }
    if (isList(l)) {
      const ordered = /^\s*\d+\. /.test(l);
      const items: string[] = [];
      while (i < lines.length && isList(lines[i])) {
        const mm = lines[i].match(/^(\s*)(?:[-*]|\d+\.) (.*)$/)!;
        const depth = Math.min(Math.floor(mm[1].length / 2), 3);
        items.push(`<li${depth ? ` class="sub${depth > 1 ? ` sub${depth}` : ''}"` : ''}>${item(mm[2])}</li>`);
        i++;
      }
      out += (ordered ? '<ol>' : '<ul>') + items.join('') + (ordered ? '</ol>' : '</ul>');
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !headRe.test(lines[i]) && !/^(\s*\||```)/.test(lines[i]) && !(card && lines[i].startsWith('>')) && !isList(lines[i])) para.push(lines[i++]);
    out += `<p>${inline(para.join(' '))}</p>`;
  }
  return out;
}

// 문서에 Mermaid가 없는 흐름: 진입점 → 단계의 클래스 순서로 시퀀스를 만든다 (예전 flows-html.js seqDiagram과 같음)
const mid = (c: string) => c.replace(/[^A-Za-z0-9_]/g, '_');
export function autoSequence(f: Flow): string {
  if (!f.chain.length) return '';
  const lines = ['sequenceDiagram', '  participant Client'];
  const declared = new Set<string>();   // 같은 클래스가 여러 번 나와도 한 번만 선언 (예전 flows-html.js는 여기서 중복 선언했음)
  for (const r of f.chain) if (!declared.has(mid(r.cls))) { declared.add(mid(r.cls)); lines.push('  participant ' + mid(r.cls) + ' as ' + r.cls); }
  const entry = (f.entry || '').match(/`([A-Z]+ [^`]+)`/);
  lines.push('  Client->>' + mid(f.chain[0].cls) + ': ' + (entry ? entry[1] : f.chain[0].method || '요청').replace(/[;#]/g, ' '));
  for (let i = 1; i < f.chain.length; i++) lines.push('  ' + mid(f.chain[i - 1].cls) + '->>' + mid(f.chain[i].cls) + ': ' + (f.chain[i].method || '호출'));
  return lines.join('\n');
}
