// 대화 세션 열기 (WEB-19): 세션 알림 카드의 "대화 열기" 버튼 → POST /api/sessions/<id>/open
// - claude-desktop: Claude 앱 링크 claude://claude.ai/epitaxy/<local_…>   (open)
// - codex:          ChatGPT 앱 링크 codex://threads/<UUID>                 (open)
// - claude-cli:     iTerm 새 창에서 세션 cwd로 이동해 claude --resume <id>  (osascript)
// 보안: 셸을 거치지 않는다(execFile + 인자 배열). id · localId · UUID는 형식을 검사하고,
// AppleScript에는 cwd · id를 문자열로 이어 붙이지 않고 argv로 넘긴 뒤 quoted form of로 셸 인용한다.
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const CLAUDE_ID_RE = new RegExp(`^${UUID}$`, 'i');
const LOCAL_ID_RE = new RegExp(`^local_${UUID}$`, 'i');
const CODEX_ID_RE = new RegExp(`^gpt-\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}-(${UUID})$`, 'i');
const ITERM_APP = '/Applications/iTerm.app';
const RUN_TIMEOUT_MS = 15_000;

// 경로 조각으로 들어온 세션 id가 우리가 아는 두 형식 중 하나인지 (서버 목록을 찾기 전에 거른다)
export const validSessionId = (id) => typeof id === 'string' && (CLAUDE_ID_RE.test(id) || CODEX_ID_RE.test(id));

// iTerm 새 창에서 cwd로 이동해 claude --resume. 값은 argv로만 받는다
const ITERM_SCRIPT = [
  'on run argv',
  '  set theDir to item 1 of argv',
  '  set theId to item 2 of argv',
  '  tell application "iTerm"',
  '    activate',
  '    set newWindow to (create window with default profile)',
  '    tell current session of newWindow',
  '      write text "cd " & (quoted form of theDir) & " && claude --resume " & (quoted form of theId)',
  '    end tell',
  '  end tell',
  'end run',
];

const fail = (status, error) => ({ status, error });

// cwd는 원본 세션 기록에서 온다. 절대 경로 · 제어 문자 없음 · 실제 폴더인지 확인
function checkDir(cwd) {
  if (typeof cwd !== 'string' || !cwd || !path.isAbsolute(cwd) || /[\0-\x1f\x7f]/.test(cwd)) return false;
  try { return fs.statSync(cwd).isDirectory(); } catch { return false; }
}

// target: { id, kind, localId?, cwd? } → { cmd, args, how } 또는 { status, error }
// 실행하지 않고 명령 인자 배열만 만든다 (함수 단위 확인용으로 export)
const CLAUDE_BUNDLE = 'com.anthropic.claudefordesktop';
export function buildOpenCommand(target) {
  const { id, kind } = target || {};
  if (kind === 'claude-desktop') {
    if (!LOCAL_ID_RE.test(target.localId || '')) return fail(400, '데스크톱 세션 id 형식이 올바르지 않습니다');
    // 앱을 번들 id로 짚어 연다. claude: 주소는 Claude Code CLI의 주소 처리 앱도 받겠다고 등록해서,
    // macOS가 그쪽(실행 파일이 사라진 옛 것)을 고르면 "No application knows how to open URL"로 실패한다
    return { how: 'claude-app', cmd: 'open', args: ['-b', CLAUDE_BUNDLE, `claude://claude.ai/epitaxy/${target.localId}`] };
  }
  if (kind === 'codex') {
    const m = CODEX_ID_RE.exec(id || '');
    if (!m) return fail(400, 'Codex 세션 id 형식이 올바르지 않습니다');
    return { how: 'codex-app', cmd: 'open', args: [`codex://threads/${m[1].toLowerCase()}`] };
  }
  if (kind === 'claude-cli') {
    if (!CLAUDE_ID_RE.test(id || '')) return fail(400, '세션 id 형식이 올바르지 않습니다');
    if (!checkDir(target.cwd)) return fail(409, '세션 폴더가 없어 터미널에서 이어서 열 수 없습니다');
    if (target.hasTranscript === false) return fail(409, '대화 기록이 없는 세션이라 이어서 열 수 없습니다');
    if (!fs.existsSync(ITERM_APP)) return fail(501, 'iTerm이 설치되어 있지 않습니다');
    return { how: 'iterm', cmd: 'osascript', args: [...ITERM_SCRIPT.flatMap((l) => ['-e', l]), target.cwd, id] };
  }
  return fail(400, '열 수 없는 세션 종류입니다');
}

const HOW_LABEL = { 'claude-app': 'Claude 앱', 'codex-app': 'ChatGPT(Codex) 앱', iterm: 'iTerm' };

// 같은 세션을 겹쳐 열지 않는다: 진행 중인 요청은 합치고, 끝난 뒤 잠깐(쿨다운)은 같은 결과를 돌려준다 (iTerm 창이 여러 개 뜨는 것 방지)
const OPEN_COOLDOWN_MS = 3_000;
const recent = new Map();   // id → { promise, at }

// 실제 실행. 성공하면 { status: 200, body: { ok: true, how } }
export function openSession(target) {
  // 압축 키 입력이 진행 중이면 끝난 뒤에 연다: 그 사이 다른 세션을 열면 /compact가 그 세션에 들어간다
  if (compacting) return compacting.then(() => openSession(target));
  const c = buildOpenCommand(target);
  if (c.error) return Promise.resolve(c);
  if (process.platform !== 'darwin') return Promise.resolve(fail(501, 'macOS에서만 열 수 있습니다'));
  const now = Date.now();
  for (const [k, v] of recent) if (v.at && now - v.at > OPEN_COOLDOWN_MS) recent.delete(k);
  const hit = recent.get(target.id);
  if (hit) return hit.promise;
  const entry = { at: 0, promise: null };
  entry.promise = run(c, target).then((r) => { entry.at = Date.now(); return r; });
  recent.set(target.id, entry);
  return entry.promise;
}

function run(c, target) {
  return new Promise((resolve) => {
    execFile(c.cmd, c.args, { timeout: RUN_TIMEOUT_MS }, (err, _out, stderr) => {
      if (!err) { console.log(`[open] ${c.how} ${target.id}`); return resolve({ status: 200, body: { ok: true, how: c.how } }); }
      const detail = String(stderr || err.message || '').trim().split('\n')[0].slice(0, 200);
      console.warn(`[open] ${c.how} ${target.id} 실패: ${detail}`);
      // -1743: macOS 자동화 권한(서버 → iTerm 제어)이 거절됨
      const hint = /-1743/.test(detail) ? ' (시스템 설정 › 개인정보 보호 및 보안 › 자동화에서 iTerm 제어를 허용해 주세요)' : '';
      resolve(fail(502, `${HOW_LABEL[c.how]}에서 열지 못했습니다${hint}`));
    });
  });
}

// ── 세션 압축 (WEB-40): 세션 알림 카드의 "압축" 버튼 → POST /api/sessions/<id>/compact
// 앱이 띄운 세션에는 바깥에서 명령을 넣을 통로가 없어, Claude 앱에서 그 세션을 열고 입력창에 키 입력으로 /compact를 넣는다.
// 순서: 세션 열기 → 입력창에 쓰던 글을 잘라 내 보관 → /compact 붙여넣고 Enter → 쓰던 글을 다시 붙여넣기 → 클립보드 되돌리기.
// - 글자를 치지 않고 붙여넣는다: 한글 입력 상태에서 keystroke "/compact"는 한글로 들어간다.
// - 단축키도 keystroke "a"가 아니라 key code로 보낸다: 한글 입력 상태에서는 keystroke "a" using command down이 ⌘A로 듣지 않았다
//   (첫 시험에서 잘라 내기 · 붙여넣기는 안 듣고 Enter만 들어가, 입력창에 쓰던 글이 그대로 전송됐다).
// - 그래서 Enter 전에 입력창 내용을 다시 복사해 "/compact"인지 확인하고, 아니면 Enter를 누르지 않는다.
// - 입력창이 비어 있었는지는 표시 글자(SENTINEL)로 안다: 잘라 낸 뒤에도 클립보드가 그대로면 쓰던 글이 없던 것이다.
// - 되돌리는 클립보드는 글자만이다(그림 · 파일은 되돌리지 못한다).
// - System Events 키 입력이라 서버를 띄운 앱에 손쉬운 사용 권한이 있어야 한다.
// - 앱 세션만 지원한다: Claude 앱(claude-desktop) · ChatGPT 앱의 Codex(codex). 터미널 세션(claude-cli)은 지원하지 않는다.
const COMPACT_SCRIPT = [
  'on run argv',
  '  set theUrl to item 1 of argv',
  '  set theMark to item 2 of argv',
  '  set theApp to item 3 of argv',
  '  set theText to item 4 of argv',   // 보낼 글: /compact 또는 종결 요청 (WEB-45)
  '  set savedClip to ""',
  '  try',
  '    set savedClip to (the clipboard as text)',
  '  end try',
  '  if theApp is "Claude" then',
  '    do shell script "open -b ' + CLAUDE_BUNDLE + ' " & quoted form of theUrl',
  '  else',
  '    do shell script "open " & quoted form of theUrl',
  '  end if',
  // 정해진 시간을 기다리지 않고 앱이 앞으로 올 때까지만 기다린다. 그 뒤 0.7초는 앱이 그 세션 화면으로 바꾸는 시간
  '  my waitFront(theApp)',
  '  delay 0.7',
  // 1) 입력창에 쓰던 글을 잘라 낸다 (⌘A ⌘X). 키는 글자가 아니라 키 코드로 보낸다: A=0 X=7 C=8 V=9 Return=36
  '  set the clipboard to theMark',
  '  my bringFront(theApp)',
  '  tell application "System Events"',
  '    key code 0 using command down',
  '    delay 0.08',
  '    key code 7 using command down',
  '  end tell',
  // 클립보드가 바뀌면 바로 넘어간다. 0.4초 동안 그대로면 입력창이 비어 있던 것이다
  '  set theDraft to my waitClipNot(theMark, 0.4)',
  '  set hadDraft to (theDraft is not theMark) and (theDraft is not "")',
  // 2) /compact를 붙여넣고, 입력창에 정말 그것만 들어갔는지 다시 복사해 확인한 뒤에만 Enter를 누른다
  '  set the clipboard to theText',
  '  delay 0.05',
  '  my bringFront(theApp)',
  '  tell application "System Events" to key code 9 using command down',
  '  delay 0.3',   // 앱이 클립보드를 읽기 전에 덮어쓰면 표시 글자가 붙는다
  '  set the clipboard to theMark',
  '  my bringFront(theApp)',
  '  tell application "System Events"',
  '    key code 0 using command down',
  '    delay 0.08',
  '    key code 8 using command down',
  '  end tell',
  '  set theCheck to my waitClipNot(theMark, 0.8)',
  '  if theCheck is not theText then',
  // 확인 실패: Enter를 누르지 않는다(쓰던 글이 그대로 전송되는 것을 막는다). 잘라 낸 글이 있으면 클립보드에 남겨 둔다
  '    if hadDraft then',
  '      set the clipboard to theDraft',
  '      return "unverified-draft"',
  '    end if',
  '    set the clipboard to savedClip',
  '    return "unverified"',
  '  end if',
  '  my bringFront(theApp)',
  '  tell application "System Events" to key code 36',
  // 3) 쓰던 글을 되돌린다
  '  if hadDraft then',
  '    delay 0.5',
  '    set the clipboard to theDraft',
  '    delay 0.05',
  '    my bringFront(theApp)',
  '    tell application "System Events" to key code 9 using command down',
  '    delay 0.4',
  '  end if',
  '  set the clipboard to savedClip',
  '  if hadDraft then return "draft"',
  '  return "empty"',
  'end run',
  // 키를 보내기 직전마다 그 앱이 맨 앞인지 보고, 아니면(사용자가 다른 창으로 넘어갔으면) 다시 앞으로 가져온다
  'on bringFront(theApp)',
  '  try',
  '    tell application "System Events" to set isFront to frontmost of process theApp',
  '    if isFront then return',
  '  end try',
  '  tell application theApp to activate',
  '  delay 0.3',
  'end bringFront',
  // 앱이 맨 앞에 올 때까지 최대 1.5초 기다린다. 안 오면 직접 앞으로 가져온다
  'on waitFront(theApp)',
  '  repeat 30 times',
  '    try',
  '      tell application "System Events" to set isFront to frontmost of process theApp',
  '      if isFront then return',
  '    end try',
  '    delay 0.05',
  '  end repeat',
  '  tell application theApp to activate',
  '  delay 0.3',
  'end waitFront',
  // 클립보드가 v가 아닌 글이 될 때까지 최대 maxSec초 기다려 그 글을 돌려준다. 끝까지 그대로면 v를 돌려준다
  'on waitClipNot(v, maxSec)',
  '  repeat (maxSec / 0.05) as integer times',
  '    try',
  '      set c to (the clipboard as text)',
  '      if c is not v then return c',
  '    end try',
  '    delay 0.05',
  '  end repeat',
  '  return v',
  'end waitClipNot',
];
const COMPACT_MARK = '⁣work-dash-compact⁣';
const COMPACT_TIMEOUT_MS = 20_000;
let compacting = null;   // 키 입력은 겹치면 안 된다: 한 번에 하나만

// target: sessionTarget() 결과 + status. 성공하면 { status: 200, body: { ok: true, draftRestored } }
export const compactSession = (target) => sendInput(target, '/compact', '압축 명령', 'compact');

// ── 세션 종결 요청 (WEB-45): 세션 카드의 "보관" 버튼 → POST /api/sessions/<id>/end
// 대시보드가 직접 치우지 않는다. 그 세션에 종결을 요청하는 글을 보내고, 마무리(병합 · 서버 내리기 · 보관)는 세션이 종결 명령(/end, WEB-48)대로 한다.
// 글 속의 /end가 명령으로 실행되는지는 확인되지 않아 명령이 아니라 말로 보낸다(스킬 설명이 이 말에 걸린다). Claude 앱 세션만.
// 글 끝에 세션 id 앞 8자를 붙인다: 화면 전환이 늦어 글이 다른 세션에 들어가면 그 세션의 스킬이 id가 다른 것을 보고 멈춘다
export const endText = (id) => `세션 종결해 줘 (${String(id).slice(0, 8)})`;
export function endSession(target) {
  if (target?.kind !== 'claude-desktop') return Promise.resolve(fail(400, 'Claude 앱에서 연 세션만 종결을 요청할 수 있습니다'));
  return sendInput(target, endText(target.id), '종결 요청', 'end');
}

// 그 세션을 앱에서 열고 입력창에 text를 넣어 Enter를 누른다 (압축 · 종결 요청이 함께 쓴다)
function sendInput(target, text, what, tag) {
  if (target?.kind !== 'claude-desktop' && target?.kind !== 'codex') return Promise.resolve(fail(400, '앱에서 연 세션에만 보낼 수 있습니다'));
  const c = buildOpenCommand(target);   // 여는 주소와 id 형식 검사는 열기와 같다
  if (c.error) return Promise.resolve(c);
  const app = c.how === 'codex-app' ? 'ChatGPT' : 'Claude';
  // 작업 중인 세션도 막지 않는다: 상태 기록이 '작업 중'으로 남아 버튼이 계속 잠기는 일이 있었다. 앱은 작업 중에 받은 입력을 줄 세운다
  if (process.platform !== 'darwin') return Promise.resolve(fail(501, 'macOS에서만 할 수 있습니다'));
  if (compacting) return Promise.resolve(fail(409, '다른 세션에 키 입력을 보내는 중입니다. 잠시 뒤에 다시 눌러 주세요'));
  const args = [...COMPACT_SCRIPT.flatMap((l) => ['-e', l]), c.args.at(-1), COMPACT_MARK, app, text];
  compacting = new Promise((resolve) => {
    execFile('osascript', args, { timeout: COMPACT_TIMEOUT_MS }, (err, out, stderr) => {
      compacting = null;
      const result = String(out).trim();
      if (!err && result.startsWith('unverified')) {
        console.warn(`[${tag}] ${c.how} ${target.id} 입력 확인 실패 (${result})`);
        return resolve(fail(502, `입력창에 ${what}을 넣지 못해 보내지 않았습니다${result === 'unverified-draft' ? '. 입력창에 쓰던 글은 클립보드에 있습니다(붙여넣기로 되돌릴 수 있습니다)' : ''}`));
      }
      if (!err) {
        const draftRestored = result === 'draft';
        console.log(`[${tag}] ${c.how} ${target.id}${draftRestored ? ' (쓰던 글 되돌림)' : ''}`);
        return resolve({ status: 200, body: { ok: true, draftRestored } });
      }
      const detail = String(stderr || err.message || '').trim().split('\n')[0].slice(0, 200);
      console.warn(`[${tag}] ${target.id} 실패: ${detail}`);
      // 1002 · -25211: 키 입력 권한(손쉬운 사용) 없음, -1743: 자동화 권한 거절
      const hint = /1002|-25211|not allowed to send keystrokes|키 입력/.test(detail)
        ? ' (시스템 설정 › 개인정보 보호 및 보안 › 손쉬운 사용에서 서버를 띄운 앱을 허용해 주세요)'
        : /-1743/.test(detail) ? ' (시스템 설정 › 개인정보 보호 및 보안 › 자동화에서 System Events 제어를 허용해 주세요)' : '';
      resolve(fail(502, `${what}을 보내지 못했습니다${hint}`));
    });
  });
  return compacting;
}
