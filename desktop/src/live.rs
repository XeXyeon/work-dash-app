//! 메뉴 막대 요약을 최신으로 유지한다.
//! 서버의 SSE(`/api/events`)를 Rust가 직접 듣고, `hello`(연결 · 재연결)나 `changed`가 오면
//! `/api/projects`를 다시 받아 메뉴 막대를 갱신한다. 서버가 꺼지면 몇 초마다 다시 연결한다.

use std::io::{BufRead, BufReader, Write};
use std::net::{SocketAddr, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use crate::server::{self, PORT};

const RETRY: Duration = Duration::from_secs(3);
/// 서버는 25초마다 `: ping`을 보낸다. 그보다 넉넉히 기다려도 아무것도 안 오면 끊긴 것으로 본다.
const READ_TIMEOUT: Duration = Duration::from_secs(60);

/// `/api/projects`에서 메뉴 막대에 필요한 것만
#[derive(serde::Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSummary {
    pub project: String,
    pub doing: u32,
    pub open_issues: u32,
    pub doing_items: Vec<DoingItem>,
}

#[derive(serde::Deserialize, Clone, Debug)]
pub struct DoingItem {
    pub id: String,
    pub title: String,
}

/// 메뉴 막대가 보여 줄 상태
pub enum Status {
    Connecting,
    Live(Vec<ProjectSummary>),
    Offline,
}

#[derive(Default)]
pub struct Live {
    stop: AtomicBool,
    /// 지금 열려 있는 SSE 연결. 앱을 끌 때 닫아 구독 스레드를 깨운다
    stream: Mutex<Option<TcpStream>>,
}

impl Live {
    /// 구독을 끝내고 연결을 닫는다 (앱 종료 때)
    pub fn shutdown(&self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(s) = self.stream.lock().unwrap_or_else(|e| e.into_inner()).take() {
            let _ = s.shutdown(std::net::Shutdown::Both);
        }
    }
}

/// 별도 스레드에서 구독을 돌린다. `on_status`는 상태가 바뀔 때마다 불린다.
pub fn spawn(live: std::sync::Arc<Live>, on_status: impl Fn(Status) + Send + 'static) {
    std::thread::spawn(move || {
        let mut ever_connected = false;
        while !live.stop.load(Ordering::SeqCst) {
            // 이벤트를 받은 뒤 오류로 끊겨도(읽기 시간 초과 등) "붙었던 적 있음"은 남긴다
            let _ = subscribe(&live, &on_status, &mut ever_connected);
            if live.stop.load(Ordering::SeqCst) {
                break;
            }
            // 한 번도 붙지 못했으면 "연결 중"(서버가 아직 뜨는 중), 붙었다가 끊기면 "꺼짐"
            on_status(if ever_connected { Status::Offline } else { Status::Connecting });
            std::thread::sleep(RETRY);
        }
    });
}

/// SSE 한 줄을 읽고, 화면을 갱신할 때가 됐는지 알려 준다.
/// `event: hello`/`event: changed` 다음 빈 줄(이벤트 끝)에서 true. `: ping` 같은 주석 줄은 무시.
fn on_line(line: &str, pending: &mut bool) -> bool {
    if line == "event: hello" || line == "event: changed" {
        *pending = true;
        false
    } else if line.is_empty() && *pending {
        *pending = false;
        true
    } else {
        false
    }
}

/// 한 번 연결해 끊길 때까지 읽는다. 이벤트를 하나라도 받으면 `connected`를 true로 바꾼다
fn subscribe(live: &Live, on_status: &impl Fn(Status), connected: &mut bool) -> std::io::Result<()> {
    let addr = SocketAddr::from(([127, 0, 0, 1], PORT));
    let mut s = TcpStream::connect_timeout(&addr, Duration::from_millis(500))?;
    s.set_read_timeout(Some(READ_TIMEOUT))?;
    s.write_all(format!("GET /api/events HTTP/1.0\r\nHost: 127.0.0.1:{PORT}\r\nAccept: text/event-stream\r\n\r\n").as_bytes())?;
    *live.stream.lock().unwrap_or_else(|e| e.into_inner()) = Some(s.try_clone()?);
    if live.stop.load(Ordering::SeqCst) {
        return Ok(());   // 연결하는 사이 종료가 시작됐다
    }

    let reader = BufReader::new(s);
    let mut pending = false;
    for line in reader.lines() {
        let line = line?;
        if live.stop.load(Ordering::SeqCst) {
            break;
        }
        // 이벤트 하나가 끝났다 (서버가 150ms 동안 모아서 보내므로 따로 더 모으지 않는다)
        if on_line(&line, &mut pending) {
            *connected = true;
            // 목록을 받지 못하면 직전 메뉴를 그대로 둔다 (다음 이벤트나 재연결 때 다시 받는다)
            if let Some(list) = fetch_projects() {
                on_status(Status::Live(list));
            }
        }
    }
    Ok(())
}

pub fn fetch_projects() -> Option<Vec<ProjectSummary>> {
    let (status, body) = server::http_get("/api/projects", Duration::from_secs(5)).ok()?;
    if status != 200 {
        return None;
    }
    serde_json::from_str(&body).ok()
}

#[cfg(test)]
mod tests {
    use super::on_line;

    #[test]
    fn refreshes_at_end_of_hello_and_changed_events() {
        let mut pending = false;
        let lines = ["retry: 2000", "event: hello", "data: {}", "", ": ping", "", "event: changed", "data: {\"changes\":[]}", ""];
        let fired: Vec<bool> = lines.iter().map(|l| on_line(l, &mut pending)).collect();
        assert_eq!(fired, [false, false, false, true, false, false, false, false, true]);
    }
}
