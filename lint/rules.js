import path from 'node:path';

const PATH_MODULES = ['server/kit.js'];
const DIRECTIVE = /^\s*(eslint|globals?\b|exported\b|@ts-|@vite-|[@#]__PURE__|c8 |v8 |istanbul )/;

const rel = (context) => path.relative(context.cwd, context.filename).split(path.sep).join('/');

const noHomePath = {
  meta: {
    type: 'problem',
    schema: [],
    messages: {
      home: '홈 폴더를 직접 구한다({{what}}) → `server/kit.js`의 `HOME`이나 기록 도구 `core/paths.js`의 `HOME` · `WD`를 가져다 쓴다',
    },
  },
  create(context) {
    if (PATH_MODULES.includes(rel(context))) return {};
    const name = (n) => (n.type === 'Identifier' ? n.name : n.type === 'Literal' ? n.value : null);
    return {
      MemberExpression(node) {
        const prop = node.computed && node.property.type !== 'Literal' ? null : name(node.property);
        if (prop === 'homedir') return context.report({ node, messageId: 'home', data: { what: 'homedir' } });
        if (prop !== 'HOME' && prop !== 'USERPROFILE') return;
        const o = node.object;
        if (o.type === 'MemberExpression' && name(o.property) === 'env' && name(o.object) === 'process') {
          context.report({ node, messageId: 'home', data: { what: `process.env.${prop}` } });
        }
      },
    };
  },
};

const noComments = {
  meta: {
    type: 'suggestion',
    fixable: 'code',
    schema: [],
    messages: {
      comment: '주석을 쓰지 않는다 → 지운다(`npm run lint -- --fix`). 이유 · 경위는 작업 카드에 적는다. `#!` 파일 맨 위 사용법과 도구 지시문만 남긴다',
    },
  },
  create(context) {
    const src = context.sourceCode;
    return {
      Program(program) {
        const comments = src.getAllComments();
        const executable = comments.length > 0 && comments[0].type === 'Shebang';
        const first = src.getFirstToken(program);
        const bodyStart = first ? first.range[0] : Infinity;
        for (const c of comments) {
          if (c.type === 'Shebang') continue;
          if (DIRECTIVE.test(c.value)) continue;
          if (executable && c.range[1] <= bodyStart) continue;
          context.report({
            loc: c.loc,
            messageId: 'comment',
            fix(fixer) {
              const text = src.text;
              let [start, end] = c.range;
              while (start > 0 && (text[start - 1] === ' ' || text[start - 1] === '\t')) start--;
              const lineStart = start === 0 || text[start - 1] === '\n';
              let after = end;
              while (text[after] === ' ' || text[after] === '\t') after++;
              const lineEnd = after >= text.length || text[after] === '\n';
              if (lineStart && lineEnd) return fixer.removeRange([start, Math.min(after + 1, text.length)]);
              if (lineEnd) return fixer.removeRange([start, after]);
              return fixer.removeRange([lineStart ? c.range[0] : start, lineStart ? after : end]);
            },
          });
        }
      },
    };
  },
};

export default { rules: { 'no-home-path': noHomePath, 'no-comments': noComments } };
