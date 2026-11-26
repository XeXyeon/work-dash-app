//! 대시보드 서버(localhost:4949) 준비.
//!
//! 지금은 저장소의 Node 서버를 쓴다 (WEB-8 확정: 단계적). 실행 · 재사용 · 빌드 확인은
//! `bin/work-dash-app.js`(= `work-dash web`)가 이미 하므로 그 명령을 그대로 부른다.
//! 나중에 Rust 서버로 바꾸면(WEB-13) 이 모듈의 `ensure`만 갈아 끼우면 된다. 창은 항상 같은 주소를 띄운다.

use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, Instant};

pub const PORT: u16 = 4949;

/// 창이 띄울 주소 (포트는 PORT 한 곳에서만 정한다)
pub fn url() -> String {
    format!("http://localhost:{PORT}")
}

/// 앱 안에서 `ensure`가 동시에 두 번 돌지 않게 한다 (로딩 화면 새로고침 등).
/// 두 번째 호출은 첫 호출이 띄운 서버를 재사용한다.
static ENSURE_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// 서버 준비 결과
pub struct Ready {
    /// 이번에 앱이 직접 띄웠으면 그 서버의 pid (WEB-11: 앱을 끌 때 정리할지 판단)
    pub started_pid: Option<u32>,
}

#[derive(Debug, PartialEq)]
enum Probe {
    Ours,
    None,
    Other,
    /// 응답이 늦음: 다른 프로그램이라고 단정하지 않고 다시 확인한다
    Slow,
}

/// 늦은 응답이면 잠깐 쉬고 몇 번 더 확인한다
fn probe_patient() -> Probe {
    for _ in 0..3 {
        match probe() {
            Probe::Slow => std::thread::sleep(Duration::from_millis(500)),
            p => return p,
        }
    }
    Probe::Slow
}

/// 저장소 위치: 실행 시 WORK_DASH_APP_ROOT > 빌드할 때의 저장소 경로 (개인용 앱이라 고정해도 된다)
pub fn repo_root() -> PathBuf {
    if let Ok(p) = std::env::var("WORK_DASH_APP_ROOT") {
        return PathBuf::from(p);
    }
    Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap().to_path_buf()
}

pub fn log_path() -> PathBuf {
    repo_root().join(".run").join("server.log")
}

/// HTTP 요청 실패 종류
#[derive(Debug, PartialEq)]
pub enum HttpError {
    /// 아무것도 듣고 있지 않음 (서버 꺼짐)
    Refused,
    /// 연결 · 응답이 늦음
    Slow,
    /// 그 밖의 오류
    Other,
}

/// 127.0.0.1:PORT에 GET을 한 번 보낸다. HTTP 라이브러리 없이 직접 주고받는다.
/// HTTP/1.0으로 보내 Node가 응답을 chunked로 나누지 않게 하고, 서버가 연결을 닫을 때까지 읽는다.
pub fn http_get(path: &str, timeout: Duration) -> Result<(u16, String), HttpError> {
    let addr = SocketAddr::from(([127, 0, 0, 1], PORT));
    let mut s = match TcpStream::connect_timeout(&addr, Duration::from_millis(500)) {
        Ok(s) => s,
        Err(e) if matches!(e.kind(), std::io::ErrorKind::ConnectionRefused | std::io::ErrorKind::ConnectionReset) => return Err(HttpError::Refused),
        Err(_) => return Err(HttpError::Slow),
    };
    let _ = s.set_read_timeout(Some(timeout));
    // Host는 서버의 Host 검사(DNS 리바인딩 방지)를 통과하는 값으로
    let req = format!("GET {path} HTTP/1.0\r\nHost: 127.0.0.1:{PORT}\r\n\r\n");
    s.write_all(req.as_bytes()).map_err(|_| HttpError::Other)?;
    let mut raw = Vec::new();
    if let Err(e) = s.read_to_end(&mut raw) {
        if matches!(e.kind(), std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut) {
            return Err(HttpError::Slow);   // 연결은 됐는데 응답이 늦다 (막 뜨는 중이거나 바쁨)
        }
        return Err(HttpError::Other);
    }
    let text = String::from_utf8(raw).map_err(|_| HttpError::Other)?;
    let (head, body) = text.split_once("\r\n\r\n").ok_or(HttpError::Other)?;
    let status = head.split(' ').nth(1).and_then(|x| x.parse().ok()).ok_or(HttpError::Other)?;
    Ok((status, body.to_string()))
}

/// `/api/health`의 내용
#[derive(serde::Deserialize, Debug)]
pub struct Health {
    pub app: String,
    pub pid: u32,
}

pub fn health() -> Option<Health> {
    let (status, body) = http_get("/api/health", Duration::from_millis(1500)).ok()?;
    let h: Health = serde_json::from_str(&body).ok()?;
    (status == 200 && h.app == "work-dash-app").then_some(h)
}

/// 4949에 무엇이 있는지 확인한다
fn probe() -> Probe {
    match http_get("/api/health", Duration::from_millis(1500)) {
        Err(HttpError::Refused) => Probe::None,
        Err(HttpError::Slow) => Probe::Slow,
        Err(HttpError::Other) => Probe::Other,
        Ok((200, body)) if serde_json::from_str::<Health>(&body).is_ok_and(|h| h.app == "work-dash-app") => Probe::Ours,
        Ok(_) => Probe::Other,
    }
}

/// 앱을 완전히 끌 때: 앱이 띄운 서버면 끈다 (앱 전용으로 전환 — 브라우저로 보는 경우는 고려하지 않는다).
/// 그 사이 다른 서버로 바뀌었으면(work-dash web restart 등) 남의 서버라 끄지 않는다.
/// 돌려주는 값: 서버를 껐는지
pub fn stop_started(started_pid: Option<u32>) -> bool {
    let Some(pid) = started_pid else { return false };
    let Some(h) = health() else { return false };
    if h.pid != pid {
        return false;
    }
    Command::new("/bin/kill").args(["-TERM", &h.pid.to_string()]).status().is_ok_and(|st| st.success())
}

/// Finder · Dock으로 실행한 앱은 셸의 PATH를 모른다 → 흔한 위치를 차례로 찾는다
fn find_node() -> Option<PathBuf> {
    if let Ok(p) = std::env::var("WORK_DASH_NODE") {
        let p = PathBuf::from(p);
        if p.is_file() {
            return Some(p);
        }
    }
    let home = std::env::var("HOME").unwrap_or_default();
    // 1) nvm 최신 버전 (Claude 훅도 nvm의 node를 쓴다)
    let nvm = Path::new(&home).join(".nvm/versions/node");
    if let Ok(rd) = std::fs::read_dir(&nvm) {
        let mut vers: Vec<PathBuf> = rd.flatten().map(|e| e.path().join("bin/node")).filter(|p| p.exists()).collect();
        vers.sort_by_key(|p| version_key(p));
        if let Some(p) = vers.pop() {
            return Some(p);
        }
    }
    // 2) Homebrew · 일반 설치 위치
    for p in ["/opt/homebrew/bin/node", "/usr/local/bin/node"] {
        if Path::new(p).exists() {
            return Some(PathBuf::from(p));
        }
    }
    // 3) 로그인 셸에 물어보기 (느리므로 마지막)
    let out = Command::new("/bin/zsh").args(["-lc", "command -v node"]).output().ok()?;
    // .zshrc가 다른 글을 찍을 수 있으므로 마지막 줄만 경로로 본다
    let stdout = String::from_utf8_lossy(&out.stdout);
    let p = PathBuf::from(stdout.lines().last()?.trim());
    p.is_file().then_some(p)
}

/// ".../v24.14.0/bin/node" → [24, 14, 0]
fn version_key(p: &Path) -> Vec<u32> {
    p.ancestors()
        .nth(2)
        .and_then(|d| d.file_name())
        .and_then(|n| n.to_str())
        .map(|n| n.trim_start_matches('v').split('.').filter_map(|x| x.parse().ok()).collect())
        .unwrap_or_default()
}

/// 서버가 떠 있으면 재사용하고, 없으면 `work-dash web`으로 띄운다.
/// 실패하면 사용자에게 보여 줄 문장을 돌려준다.
pub fn ensure() -> Result<Ready, String> {
    let _guard = ENSURE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    match probe_patient() {
        Probe::Ours => return Ok(Ready { started_pid: None }),
        Probe::Other => {
            return Err(format!(
                "포트 {PORT}을 다른 프로그램이 쓰고 있습니다.\n터미널에서 확인: lsof -nP -iTCP:{PORT} -sTCP:LISTEN"
            ))
        }
        Probe::Slow => {
            return Err(format!("포트 {PORT}의 서버가 응답하지 않습니다. 잠시 뒤 다시 시도하세요.\n상태 확인: work-dash web status"))
        }
        Probe::None => {}
    }

    let root = repo_root();
    let script = root.join("bin").join("work-dash-app.js");
    if !script.exists() {
        return Err(format!("대시보드 저장소를 찾지 못했습니다: {}\n(WORK_DASH_APP_ROOT로 위치를 지정할 수 있습니다)", root.display()));
    }
    let node = find_node().ok_or("node를 찾지 못했습니다. Node.js를 설치하거나 WORK_DASH_NODE에 경로를 지정하세요.")?;

    // 빌드 확인(필요하면 vite build) → 백그라운드 서버 시작까지 이 명령이 한다
    let out = Command::new(&node)
        .arg(&script)
        .current_dir(&root)
        .env("NO_COLOR", "1")
        .output()
        .map_err(|e| format!("서버 실행 명령을 시작하지 못했습니다 ({}): {e}", node.display()))?;
    if !out.status.success() {
        let msg = String::from_utf8_lossy(&out.stderr).trim().to_string();
        let msg = if msg.is_empty() { String::from_utf8_lossy(&out.stdout).trim().to_string() } else { msg };
        return Err(format!("서버를 띄우지 못했습니다.\n{msg}"));
    }

    // 명령이 성공했어도 응답할 때까지 잠깐 기다린다
    let end = Instant::now() + Duration::from_secs(5);
    while Instant::now() < end {
        if let Some(h) = health() {
            return Ok(Ready { started_pid: Some(h.pid) });
        }
        std::thread::sleep(Duration::from_millis(150));
    }
    Err("서버가 5초 안에 응답하지 않았습니다.".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn health_parses_server_response() {
        let h: Health = serde_json::from_str(r#"{"app":"work-dash-app","pid":42,"startedAt":0,"clients":2,"dataDir":"/x"}"#).unwrap();
        assert_eq!((h.app.as_str(), h.pid), ("work-dash-app", 42));
    }

    #[test]
    fn version_key_orders_nvm_dirs() {
        let a = version_key(Path::new("/h/.nvm/versions/node/v9.11.2/bin/node"));
        let b = version_key(Path::new("/h/.nvm/versions/node/v24.14.0/bin/node"));
        assert_eq!(b, vec![24, 14, 0]);
        assert!(a < b);
    }
}
