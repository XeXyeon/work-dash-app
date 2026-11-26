const SECRET_WORDS = new Set(['token', 'tokens', 'secret', 'secrets', 'password', 'passwd', 'apikey', 'key', 'keys', 'auth', 'credential', 'credentials', 'cookie', 'cookies', 'bearer', 'session', 'authorization', 'pwd', 'dsn', 'privatekey', 'private_key']);
const isSecretKey = (k) => {
  const words = k.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  return words.some((w) => SECRET_WORDS.has(w)) || /api[-_]?key/i.test(k);
};
export function redact(v) {
  if (Array.isArray(v)) return v.map(redact);
  if (v && typeof v === 'object') {
    const pair = ['key', 'name'].some((f) => typeof v[f] === 'string' && isSecretKey(v[f]));
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, isSecretKey(k) || (pair && k === 'value') ? '••••' : redact(x)]));
  }
  return v;
}

export function redactText(text) {
  return text.split('\n').map((line) => {
    let out = line.replace(/\b(Authorization\s*[:=]\s*["']?(?:Bearer|Basic)\s+)[^\s"',;]+/gi, '$1••••')
      .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]{16,}/gi, '$1••••');
    const m = out.match(/^(\s*(?:-\s+)?(?:export\s+)?["']?)([A-Za-z0-9_.-]+)(["']?\s*[:=]\s*)(\S.*)$/);
    if (m && isSecretKey(m[2]) && m[4] !== '••••') out = `${m[1]}${m[2]}${m[3]}••••`;
    return out;
  }).join('\n');
}
