// 문서 본문을 HTML 문자열로 바꾼다 (WEB-16). 결과는 dangerouslySetInnerHTML로 넣으므로
// 원문은 모두 이스케이프하고, 마크다운 안의 날 HTML도 글자 그대로 보여 준다.
import { Marked, type Token } from 'marked';

export const esc = (s: unknown) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

// 기획 탭(WEB-34)이 문서끼리의 상대 링크를 앱 안 주소로 바꾸는 데 쓴다. 파싱은 동기라 호출하는 동안만 걸어 둔다
let resolveLink: ((href: string) => string | null) | null = null;

const md = new Marked({
  gfm: true,
  renderer: {
    // 날 HTML(<details> 등)은 실행하지 않고 글자로
    html({ text }) { return esc(text); },
    // 링크: http(s)만 새 창으로. 앱 창 안에서 다른 페이지로 넘어가지 않게 한다. 나머지(상대 경로 등)는 글자만
    link({ href, tokens }) {
      const label = this.parser.parseInline(tokens);
      if (/^https?:\/\//i.test(href)) return `<a href="${esc(href)}" target="_blank" rel="noopener noreferrer">${label}</a>`;
      const inApp = resolveLink?.(href);
      return inApp ? `<a href="${esc(inApp)}">${label}</a>` : label;
    },
    image({ text }) { return esc(text); },
  },
});

export const markdownToHtml = (text: string) => md.parse(text, { async: false });
// 한 줄짜리(목록 값 등): 문단 태그 없이
export const inlineMarkdownToHtml = (text: string) => md.parseInline(text, { async: false });

// ```mermaid 블록은 따로 떼어 Mermaid 컴포넌트로 그리고, 나머지는 HTML로 (기획 탭). resolve가 문자열을 주는 상대 링크는 앱 안 이동 링크가 된다
export type MdPart = { t: 'html'; html: string } | { t: 'mermaid'; code: string };
export function markdownParts(text: string, resolve?: (href: string) => string | null): MdPart[] {
  const parts: MdPart[] = [];
  let run: Token[] = [];
  const flush = () => {
    if (!run.length) return;
    resolveLink = resolve ?? null;
    try { parts.push({ t: 'html', html: md.parser(run) }); } finally { resolveLink = null; }
    run = [];
  };
  for (const tok of md.lexer(text)) {
    if (tok.type === 'code' && /^mermaid\b/i.test((tok as { lang?: string }).lang ?? '')) { flush(); parts.push({ t: 'mermaid', code: (tok as { text: string }).text }); }
    else run.push(tok);
  }
  flush();
  return parts;
}

// 슬래시 명령 · 스킬 파일 맨 위의 --- 앞머리를 떼어 낸다. 들여쓴 줄은 바로 위 키에 붙인다.
export function splitFrontmatter(text: string): { meta: [string, string][]; body: string } {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return { meta: [], body: text };
  const meta: [string, string][] = [];
  for (const line of m[1].split(/\r?\n/)) {
    if (!line.trim()) continue;
    const kv = line.match(/^(\s*)([\w.-]+):\s*(.*)$/);
    if (kv && !kv[1]) meta.push([kv[2], unquote(kv[3])]);
    else if (meta.length) {
      const last = meta[meta.length - 1];
      last[1] = [last[1], kv ? `${kv[2]}: ${unquote(kv[3])}` : line.trim()].filter(Boolean).join('\n');
    }
  }
  return { meta, body: text.slice(m[0].length) };
}
const unquote = (s: string) => s.replace(/^(["'])(.*)\1$/, '$2');

// 보기 좋게 정리된 JSON 문자열에 색을 입힌다 (키 · 문자열 · 숫자 · 참거짓/null)
export function jsonToHtml(pretty: string): string {
  const re = /("(?:\\.|[^"\\])*")(\s*:)?|\b(true|false|null)\b|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g;
  let out = '';
  let last = 0;
  for (let m: RegExpExecArray | null; (m = re.exec(pretty)); ) {
    out += esc(pretty.slice(last, m.index));
    if (m[1]) out += m[2] ? `<span class="j-key">${esc(m[1])}</span>${m[2]}` : `<span class="j-str">${esc(m[1])}</span>`;
    else if (m[3]) out += `<span class="j-lit">${m[3]}</span>`;
    else out += `<span class="j-num">${m[4]}</span>`;
    last = re.lastIndex;
  }
  return out + esc(pretty.slice(last));
}
