// 본문에 적힌 항목 · 이슈 ID를 링크로 바꾼다 (WEB-38).
// 문서를 쓰는 쪽은 정해진 모양의 ID만 쓰고(공통 규칙 "다른 곳을 가리킬 때"), 링크는 화면이 만든다.
//   WEB-37        같은 프로젝트의 로드맵 항목 → 작업 카드
//   BE:MAT-11     다른 프로젝트의 항목 (접두어 = config.json의 key 또는 프로젝트 이름)
//   WEB-10#1      항목 이슈 → 이슈 카드      ISS-5  공통 이슈
import { useMemo } from 'react';
import { useProjects, useRoadmap } from './api';
import { esc } from './flowsMarkdown';
import { issueHash, routeHash, type View } from './useHashProject';

export interface Ref { prefix: string | null; id: string; issue: string | null }   // issue: '#1'
// sections: § 절 참조를 찾을 프로젝트 (저장소 docs/가 있을 때만). 있으면 본문의 §4.7이 누르는 버튼이 된다 (WEB-39, SectionPopover)
export type RefResolver = ((ref: Ref) => { href: string; title: string } | null) & { sections?: string | null };

// 앞뒤가 글자 · 숫자 · 경로 기호면 ID로 보지 않는다 (feat/WEB-3-x, v2-1 같은 것)
const REF = /(?<![A-Za-z0-9_/.#:-])(?:([A-Za-z][A-Za-z0-9_-]{0,39}):)?([A-Z][A-Z0-9]{1,7}-\d+)(#\d+)?(?![A-Za-z0-9_-])/g;
const REF_ONLY = new RegExp(`^${REF.source}$`);
const SEC = /§\s?(\d{1,3}(?:\.\d{1,3}){0,5})/g;
const ANY = new RegExp(`${REF.source}|${SEC.source}`, 'g');

const anchor = (text: string, r: { href: string; title: string }) =>
  `<a class="ref-link" href="${esc(r.href)}" title="${esc(r.title)}">${text}</a>`;

const secButton = (text: string, num: string, resolve: RefResolver) => (resolve.sections
  ? `<button type="button" class="sec-ref" data-project="${esc(resolve.sections)}" data-sec="${esc(num)}" title="§${esc(num)} 절 내용 보기">${text}</button>`
  : text);

// 이스케이프된 글자 조각 안의 ID를 링크로
function linkText(text: string, resolve: RefResolver): string {
  return text.replace(ANY, (m, prefix: string | undefined, id: string | undefined, issue: string | undefined, sec: string | undefined) => {
    if (sec) return secButton(m, sec, resolve);
    const r = resolve({ prefix: prefix ?? null, id: id!, issue: issue ?? null });
    return r ? anchor(m, r) : m;
  });
}

// 만들어진 HTML의 글자 부분만 훑는다. 링크 · 코드 블록 안은 건드리지 않고, `코드` 안은 내용 전체가 ID 하나일 때만 바꾼다
export function linkRefsHtml(html: string, resolve: RefResolver | null): string {
  if (!resolve) return html;
  let inA = 0, inPre = 0, inCode = 0;
  return html.split(/(<[^>]+>)/).map((part) => {
    if (part.startsWith('<')) {
      const t = part.match(/^<(\/?)(a|pre|code)\b/i);
      if (t) {
        const d = t[1] ? -1 : 1;
        const tag = t[2].toLowerCase();
        if (tag === 'a') inA = Math.max(0, inA + d); else if (tag === 'pre') inPre = Math.max(0, inPre + d); else inCode = Math.max(0, inCode + d);
      }
      return part;
    }
    if (!part || inA || inPre) return part;
    if (inCode) {
      const m = part.match(REF_ONLY);
      const r = m && resolve({ prefix: m[1] ?? null, id: m[2], issue: m[3] ?? null });
      return r ? anchor(part, r) : part.replace(SEC, (s, num: string) => secButton(s, num, resolve));
    }
    return linkText(part, resolve);
  }).join('');
}

// 글자 그대로인 값(이슈 세부 줄 등)을 이스케이프한 뒤 링크를 건다
export const linkRefsPlain = (text: string, resolve: RefResolver | null) => linkRefsHtml(esc(text), resolve);

// 지금 프로젝트 기준으로 ID가 가리키는 곳을 찾는다.
// - 접두어 없는 ID는 이 프로젝트의 로드맵 · 이슈에 실제로 있을 때만 링크가 된다 (UTF-8 같은 글자를 잘못 잡지 않게)
// - 접두어가 있으면 그 프로젝트의 로드맵으로 간다 (그 프로젝트에 항목이 있는지는 확인하지 않는다)
// self: 지금 열려 있는 카드의 ID (자기 자신은 링크로 만들지 않는다)
export function useRefResolver(project: string, view: View, flow: string | null, self?: string): RefResolver | null {
  const projects = useProjects();
  const roadmap = useRoadmap(project, !!projects.data?.find((s) => s.project === project)?.hasRoadmap);
  return useMemo(() => {
    const items = new Map<string, string>();
    const issues = new Map<string, string>();
    for (const ms of roadmap.data?.milestones ?? []) {
      for (const it of ms.items) {
        if (it.id) items.set(it.id, it.title);
        for (const x of it.issues) issues.set(x.id, x.title);
      }
    }
    for (const x of roadmap.data?.commonIssues ?? []) issues.set(x.id, x.title);
    const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
    const byPrefix = (p: string) => projects.data?.find((s) => s.refKey && same(s.refKey, p)) ?? projects.data?.find((s) => same(s.project, p));

    const fn: RefResolver = ({ prefix, id, issue }) => {
      const full = id + (issue ?? '');
      if (prefix) {
        const p = byPrefix(prefix);
        if (!p) return null;
        return issue
          ? { href: issueHash(p.project, 'roadmap', null, full), title: `${p.displayName} · 이슈 ${full}` }
          : { href: routeHash(p.project, 'roadmap', null, id), title: `${p.displayName} · ${id}` };
      }
      if (full === self) return null;
      if (issue || !items.has(id)) {
        const t = issues.get(full);
        return t === undefined ? null : { href: issueHash(project, view, flow, full), title: `이슈 ${full} ${t}` };
      }
      return { href: routeHash(project, view, flow, id), title: `${id} ${items.get(id)}` };
    };
    fn.sections = projects.data?.find((s) => s.project === project)?.hasPlans ? project : null;
    return fn;
  }, [roadmap.data, projects.data, project, view, flow, self]);
}
