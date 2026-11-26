//! 메뉴 막대 아이콘과 메뉴.
//!
//!   [▤ 3]                       ← 아이콘 옆 숫자: 진행 중 항목 수 (0이면 숫자 없음)
//!   진행 중 3 · 열린 이슈 66      (요약, 누를 수 없음)
//!   ─────────
//!   shop-api   ORD-2 · ORD-3   → 누르면 창에서 그 프로젝트로
//!   ─────────
//!   창 열기 / 종료

use tauri::image::Image;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Runtime};

use crate::live::{ProjectSummary, Status};

pub const TRAY_ID: &str = "main";
pub const MENU_OPEN: &str = "open";
pub const MENU_QUIT: &str = "quit";
/// 프로젝트 메뉴 항목 id 앞머리: "project:<이름>"
pub const MENU_PROJECT: &str = "project:";

/// 한 메뉴 줄에 보여 줄 진행 중 항목 수
const MAX_IDS: usize = 4;

pub fn create<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    let icon = Image::from_bytes(include_bytes!("../icons/tray-template.png"))?;
    TrayIconBuilder::with_id(TRAY_ID)
        .icon(icon)
        .icon_as_template(true) // macOS가 라이트 · 다크 메뉴 막대에 맞게 칠한다
        .tooltip("work-dash")
        .menu(&build_menu(app, &Status::Connecting)?)
        .show_menu_on_left_click(true)
        .build(app)?;
    Ok(())
}

/// 상태가 바뀔 때마다 메뉴를 새로 만든다 (메뉴가 작아서 통째로 바꾸는 편이 단순하다)
pub fn update<R: Runtime>(app: &AppHandle<R>, status: &Status) {
    let Some(tray) = app.tray_by_id(TRAY_ID) else { return };
    if let Ok(menu) = build_menu(app, status) {
        let _ = tray.set_menu(Some(menu));
    }
    let title = match status {
        Status::Live(list) => {
            let doing: u32 = list.iter().map(|p| p.doing).sum();
            (doing > 0).then(|| doing.to_string())
        }
        Status::Offline => Some("–".into()),
        Status::Connecting => None,
    };
    let _ = tray.set_title(title.as_deref());
    if std::env::var_os("WORK_DASH_APP_DEBUG").is_some() {
        eprintln!("[tray] title={title:?} menu={:?}", menu_lines(status));
    }
}

/// 메뉴 위쪽 줄들을 글자로 (디버그 출력 · 확인용)
fn menu_lines(status: &Status) -> Vec<String> {
    match status {
        Status::Connecting => vec!["서버 연결 중…".into()],
        Status::Offline => vec!["서버 꺼짐".into()],
        Status::Live(list) => {
            let doing: u32 = list.iter().map(|p| p.doing).sum();
            let issues: u32 = list.iter().map(|p| p.open_issues).sum();
            std::iter::once(format!("진행 중 {doing} · 열린 이슈 {issues}"))
                .chain(list.iter().filter(|p| p.doing > 0).map(project_label))
                .collect()
        }
    }
}

fn build_menu<R: Runtime>(app: &AppHandle<R>, status: &Status) -> tauri::Result<Menu<R>> {
    let menu = Menu::new(app)?;
    match status {
        Status::Connecting => menu.append(&MenuItem::new(app, "서버 연결 중…", false, None::<&str>)?)?,
        Status::Offline => menu.append(&MenuItem::new(app, "서버 꺼짐 — 창을 열면 다시 띄웁니다", false, None::<&str>)?)?,
        Status::Live(list) => append_summary(app, &menu, list)?,
    }
    menu.append(&PredefinedMenuItem::separator(app)?)?;
    menu.append(&MenuItem::with_id(app, MENU_OPEN, "창 열기", true, None::<&str>)?)?;
    menu.append(&PredefinedMenuItem::separator(app)?)?;
    menu.append(&MenuItem::with_id(app, MENU_QUIT, "work-dash 종료", true, Some("CmdOrCtrl+Q"))?)?;
    Ok(menu)
}

fn append_summary<R: Runtime>(app: &AppHandle<R>, menu: &Menu<R>, list: &[ProjectSummary]) -> tauri::Result<()> {
    let doing: u32 = list.iter().map(|p| p.doing).sum();
    let issues: u32 = list.iter().map(|p| p.open_issues).sum();
    menu.append(&MenuItem::new(app, format!("진행 중 {doing} · 열린 이슈 {issues}"), false, None::<&str>)?)?;
    let active: Vec<&ProjectSummary> = list.iter().filter(|p| p.doing > 0).collect();
    if active.is_empty() {
        return Ok(());
    }
    menu.append(&PredefinedMenuItem::separator(app)?)?;
    for p in active {
        menu.append(&MenuItem::with_id(app, format!("{MENU_PROJECT}{}", p.project), project_label(p), true, None::<&str>)?)?;
    }
    Ok(())
}

/// "shop-api — ORD-2 · ORD-3 · PAY-1 외 2"
fn project_label(p: &ProjectSummary) -> String {
    let ids: Vec<&str> = p
        .doing_items
        .iter()
        .map(|i| if i.id.is_empty() { i.title.as_str() } else { i.id.as_str() })
        .collect();
    let shown = ids.iter().take(MAX_IDS).copied().collect::<Vec<_>>().join(" · ");
    let more = ids.len().saturating_sub(MAX_IDS);
    if more > 0 {
        format!("{} — {shown} 외 {more}", p.project)
    } else {
        format!("{} — {shown}", p.project)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::live::DoingItem;

    fn item(id: &str) -> DoingItem {
        DoingItem { id: id.into(), title: format!("{id} 제목") }
    }

    #[test]
    fn label_lists_ids_and_counts_the_rest() {
        let p = ProjectSummary {
            project: "P".into(),
            doing: 6,
            open_issues: 0,
            doing_items: ["A-1", "A-2", "A-3", "A-4", "A-5", ""].iter().map(|x| item(x)).collect(),
        };
        assert_eq!(project_label(&p), "P — A-1 · A-2 · A-3 · A-4 외 2");
    }

    #[test]
    fn label_uses_title_when_id_missing() {
        let p = ProjectSummary { project: "P".into(), doing: 1, open_issues: 0, doing_items: vec![DoingItem { id: "".into(), title: "제목만".into() }] };
        assert_eq!(project_label(&p), "P — 제목만");
    }
}
