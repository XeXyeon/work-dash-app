// 기능 켜짐 · 꺼짐 (WEB-53 · WEB-56): `npm run init`의 환경 점검이 data/features.json에 적은 값.
// - open: Claude 앱 세션의 대화 열기 (Claude 데스크톱 앱 · 세션 저장 폴더)
// - compact: 압축 버튼 (키 입력 권한)
// - closeout: 종결(보관) 버튼 (Claude 앱 · 세션 저장 폴더 · 키 입력 권한)
// 기기마다 다른 값이라 dotfiles로 옮겨 다니는 config.json에 두지 않는다.
// 파일이 없으면 예전 자리(config.json의 features)를 보고, 그것도 없으면(환경 점검 전에 설치한 기기) 모두 켠 것으로 본다.
import fs from 'node:fs';
import path from 'node:path';
import { CONFIG, WD } from './workdash.js';

const FEATURES = path.join(WD, 'data', 'features.json');
const ALL_ON = { open: true, compact: true, closeout: true };
let cache = { key: '', value: ALL_ON };

const mtime = (p) => { try { return fs.statSync(p).mtimeMs; } catch { return 0; } };
const pick = (f) => (f && typeof f === 'object' ? { open: f.open !== false, compact: f.compact !== false, closeout: f.closeout !== false } : null);

export function features() {
  const key = `${mtime(FEATURES)}:${mtime(CONFIG)}`;
  if (key === cache.key) return cache.value;
  let value;
  try {
    value = (fs.existsSync(FEATURES) ? pick(JSON.parse(fs.readFileSync(FEATURES, 'utf8'))) : pick(JSON.parse(fs.readFileSync(CONFIG, 'utf8')).features)) || ALL_ON;
  } catch { value = fs.existsSync(FEATURES) || fs.existsSync(CONFIG) ? cache.value : ALL_ON; }   // 쓰는 중이라 잘못 읽힌 JSON이면 직전 값을 쓴다
  cache = { key, value };
  return value;
}

export const FEATURE_OFF = '이 기기에서는 꺼진 기능입니다. 환경 점검(npm run init)이 끈 것입니다';
