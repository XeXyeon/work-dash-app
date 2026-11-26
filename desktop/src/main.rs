// work-dash 데스크톱 앱 (WEB-10 · WEB-11)
// - 창은 먼저 앱에 들어 있는 로딩 화면(loading/index.html)을 띄우고, 그 화면이 `prepare`를 불러
//   서버가 준비되면 http://localhost:4949 로 이동한다. 실패하면 이유와 다시 시도 버튼을 보여 준다.
// - 메뉴 막대에 상주한다. 창을 닫으면 숨기고 Dock 아이콘도 숨긴다. 메뉴의 "종료"(⌘Q)로만 완전히 끈다.
// - 완전히 끌 때, 앱이 띄운 서버면 서버도 끈다 (앱 전용으로 전환: 브라우저로 보는 경우는 고려하지 않는다).
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod live;
mod server;
mod tray;

use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::Arc;

use tauri::{AppHandle, Manager, RunEvent, WindowEvent};

const MAIN_WINDOW: &str = "main";
/// 앱에 들어 있는 로딩 화면 주소 (macOS의 Tauri 내장 페이지 출처)
const LOADING_URL: &str = "tauri://localhost/index.html";

#[derive(Default)]
struct AppState {
    /// 이 앱이 직접 띄운 서버의 pid (0이면 없음). 그 사이 서버가 바뀌었으면 끄지 않는다
    started_pid: AtomicU32,
    /// 종료 정리를 한 번만 하도록
    cleaned_up: AtomicBool,
    live: Arc<live::Live>,
}

#[derive(serde::Serialize)]
struct Prepared {
    url: String,
}

#[derive(serde::Serialize)]
struct PrepareError {
    message: String,
    log: String,
}

/// 서버를 준비하고 창이 이동할 주소를 돌려준다. 서버 실행은 느릴 수 있어 별도 스레드에서 한다.
#[tauri::command]
async fn prepare(state: tauri::State<'_, AppState>) -> Result<Prepared, PrepareError> {
    let r = tauri::async_runtime::spawn_blocking(server::ensure)
        .await
        .map_err(|e| PrepareError { message: e.to_string(), log: String::new() })?;
    match r {
        Ok(ready) => {
            if let Some(pid) = ready.started_pid {
                state.started_pid.store(pid, Ordering::SeqCst);
            }
            Ok(Prepared { url: server::url() })
        }
        Err(message) => Err(PrepareError { message, log: server::log_path().display().to_string() }),
    }
}

/// 창을 보이고 앞으로 가져온다. project가 있으면 그 프로젝트로 이동한다.
fn show_window(app: &AppHandle, project: Option<&str>) {
    let Some(w) = app.get_webview_window(MAIN_WINDOW) else { return };
    #[cfg(target_os = "macos")]
    let _ = app.set_activation_policy(tauri::ActivationPolicy::Regular);   // Dock 아이콘 다시 표시
    if server::health().is_none() {
        // 서버가 꺼졌으면 앱에 들어 있는 로딩 화면으로 돌아가 prepare(재사용 또는 실행)를 다시 돌린다
        if let Ok(url) = LOADING_URL.parse() {
            let _ = w.navigate(url);
        }
    } else if let Some(p) = project {
        // 대시보드는 #/<프로젝트>로 선택한다. 같은 페이지면 해시만 바뀌어 새로고침되지 않는다.
        let target = format!("{}/#/{}", server::url(), encode_component(p));
        if let Ok(js) = serde_json::to_string(&target) {
            let _ = w.eval(&format!("location.href = {js}"));
        }
    }
    let _ = w.unminimize();
    let _ = w.show();
    let _ = w.set_focus();
    if std::env::var_os("WORK_DASH_APP_DEBUG").is_some() {
        eprintln!("[window] show project={project:?} visible={:?} focused={:?}", w.is_visible(), w.is_focused());
    }
}

/// 창을 숨기고 메뉴 막대에만 남는다
fn hide_window(app: &AppHandle) {
    if let Some(w) = app.get_webview_window(MAIN_WINDOW) {
        let _ = w.hide();
    }
    #[cfg(target_os = "macos")]
    let _ = app.set_activation_policy(tauri::ActivationPolicy::Accessory);   // Dock 아이콘 숨김
}

/// 완전히 끄기 전 정리: 메뉴 막대 구독 · 창을 닫고, 앱이 띄운 서버면 끈다.
/// 한 번 정리하면 종료가 확정된 것으로 본다 (이후 종료를 취소하는 경로를 만들면 여기도 바꿔야 한다).
/// 메인 스레드에서 불리며, 서버가 응답하지 않을 때 최대 약 2초 걸린다.
fn cleanup(app: &AppHandle) {
    let state = app.state::<AppState>();
    if state.cleaned_up.swap(true, Ordering::SeqCst) {
        return;
    }
    state.live.shutdown();
    if let Some(w) = app.get_webview_window(MAIN_WINDOW) {
        let _ = w.destroy();
    }
    let pid = state.started_pid.load(Ordering::SeqCst);
    let stopped = server::stop_started((pid != 0).then_some(pid));
    if std::env::var_os("WORK_DASH_APP_DEBUG").is_some() {
        eprintln!("[exit] started_pid={pid} stopped={stopped}");
    }
}

/// encodeURIComponent와 같은 규칙 (영문 · 숫자 · -_.!~*'() 는 그대로)
fn encode_component(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&b) {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

fn main() {
    let app = tauri::Builder::default()
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![prepare])
        .setup(|app| {
            tray::create(app.handle())?;
            let handle = app.handle().clone();
            live::spawn(app.state::<AppState>().live.clone(), move |status| {
                // 메뉴 조작은 메인 스레드에서
                let h = handle.clone();
                let _ = handle.run_on_main_thread(move || tray::update(&h, &status));
            });
            Ok(())
        })
        .on_menu_event(|app, event| match event.id().as_ref() {
            tray::MENU_OPEN => show_window(app, None),
            tray::MENU_QUIT => {
                cleanup(app);
                app.exit(0);
            }
            id => {
                if let Some(project) = id.strip_prefix(tray::MENU_PROJECT) {
                    show_window(app, Some(project));
                }
            }
        })
        .on_window_event(|window, event| {
            // 빨간 닫기 단추 · ⌘W: 끄지 않고 숨긴다
            if let WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == MAIN_WINDOW {
                    api.prevent_close();
                    hide_window(window.app_handle());
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("work-dash 앱을 시작하지 못했습니다");

    app.run(|app, event| match event {
        // 앱 메뉴의 Quit(⌘Q) 등 어떤 경로로 꺼지든 정리한다
        RunEvent::ExitRequested { .. } | RunEvent::Exit => cleanup(app),
        // Dock 아이콘을 눌렀을 때 창이 숨어 있으면 다시 보인다
        #[cfg(target_os = "macos")]
        RunEvent::Reopen { has_visible_windows, .. } if !has_visible_windows => show_window(app, None),
        _ => {}
    });
}

#[cfg(test)]
mod tests {
    use super::encode_component;

    #[test]
    fn encodes_like_encode_uri_component() {
        assert_eq!(encode_component("shop_api_v2-BE"), "shop_api_v2-BE");
        assert_eq!(encode_component("a b/c#d"), "a%20b%2Fc%23d");
        assert_eq!(encode_component("한"), "%ED%95%9C");
    }
}
