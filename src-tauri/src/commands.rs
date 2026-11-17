// Tauri 命令：与 Electron 时代 preload.js 的 window.tot 白名单一一对应

use crate::core::*;
use serde_json::{json, Map, Value};
use std::path::Path;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, WebviewWindow};
use tauri_plugin_dialog::DialogExt;

#[tauri::command]
pub async fn scan_children(app: AppHandle, dir: String) -> Result<Value, String> {
    {
        let state = app.state::<SharedBrowse>();
        let st = state.lock().unwrap();
        if !dir_allowed(&st, &dir) {
            return Err("目录不在可浏览范围内".into());
        }
    }
    let tree = crate::core::scan_children(&dir);
    {
        let state = app.state::<SharedBrowse>();
        let mut st = state.lock().unwrap();
        if is_drive_root(&dir) {
            st.drives_seen.insert(norm_key(&dir));
        } else {
            st.known_dirs.insert(norm_key(&dir));
        }
    }
    Ok(json!({ "tree": tree }))
}

#[tauri::command]
pub async fn read_file(app: AppHandle, p: String) -> Result<String, String> {
    {
        let state = app.state::<SharedBrowse>();
        let st = state.lock().unwrap();
        if !path_allowed(&st, &p) {
            return Err("路径不在可浏览范围内".into());
        }
    }
    let text = tokio::fs::read_to_string(&p)
        .await
        .map_err(|e| e.to_string())?;
    // 去掉 BOM（与 Electron 版一致：保存后 BOM 不保留）
    Ok(text.strip_prefix('\u{FEFF}').unwrap_or(&text).to_string())
}

#[tauri::command]
pub async fn write_file(app: AppHandle, p: String, text: String) -> Result<(), String> {
    {
        let state = app.state::<SharedBrowse>();
        let st = state.lock().unwrap();
        if !path_allowed(&st, &p) {
            return Err("路径不在可浏览范围内".into());
        }
    }
    tokio::fs::write(&p, text).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub fn resolve_images(file_path: String, srcs: Vec<String>) -> Vec<String> {
    crate::core::resolve_images(&file_path, &srcs)
}

#[tauri::command]
pub async fn add_recent(app: AppHandle, p: String) {
    let allowed = {
        let state = app.state::<SharedBrowse>();
        let st = state.lock().unwrap();
        path_allowed(&st, &p)
    };
    if allowed {
        crate::core::add_recent(&app, &p).await;
    }
}

#[tauri::command]
pub async fn open_dropped(app: AppHandle, p: String) {
    if is_md_path(&p) {
        open_by_path(&app, &p).await;
    }
}

#[tauri::command]
pub async fn select_image(app: AppHandle, doc_path: String) -> Option<Value> {
    let picked = tauri::async_runtime::spawn_blocking(move || {
        app.dialog()
            .file()
            .set_title("选择图片")
            .add_filter("图片", &["png", "jpg", "jpeg", "gif", "svg", "webp", "bmp", "ico"])
            .blocking_pick_file()
    })
    .await
    .ok()
    .flatten()?;
    let path = picked.into_path().ok()?;
    let base = Path::new(&doc_path).parent()?;
    let rel = pathdiff_relative(base, &path)?;
    Some(json!({ "rel": rel }))
}

// 相对路径（/ 分隔），对齐 Node path.relative（同盘符场景）
fn pathdiff_relative(base: &Path, target: &Path) -> Option<String> {
    let base_comps: Vec<_> = base.components().collect();
    let target_comps: Vec<_> = target.components().collect();
    let mut i = 0;
    while i < base_comps.len() && i < target_comps.len() && base_comps[i] == target_comps[i] {
        i += 1;
    }
    let mut parts: Vec<String> = Vec::new();
    for _ in i..base_comps.len() {
        parts.push("..".into());
    }
    for c in &target_comps[i..] {
        parts.push(c.as_os_str().to_string_lossy().to_string());
    }
    Some(parts.join("/"))
}

#[tauri::command]
pub fn set_theme(window: WebviewWindow, dark: bool) {
    // Windows 标题栏明暗跟随渲染风格；菜单栏明暗由渲染层 body 风格类驱动
    let _ = window.set_theme(Some(if dark { tauri::Theme::Dark } else { tauri::Theme::Light }));
}

#[tauri::command]
pub async fn save_session(app: AppHandle, data: Value) {
    let mut patch = Map::new();
    patch.insert("session".into(), sanitize_session(&data).unwrap_or(Value::Null));
    config_store(&app).save_patch(patch).await;
}

#[tauri::command]
pub async fn restore_session(app: AppHandle, paths: Vec<String>) -> Value {
    let mut list: Vec<String> = Vec::new();
    for p in paths {
        if !is_md_path(&p) || list.len() >= 20 {
            continue;
        }
        if !Path::new(&p).exists() {
            continue;
        }
        mark_openable(&app, &p);
        list.push(p);
    }
    json!({ "paths": list })
}

#[tauri::command]
pub async fn dismiss_session(app: AppHandle) {
    let mut patch = Map::new();
    patch.insert("session".into(), Value::Null);
    config_store(&app).save_patch(patch).await;
}

#[tauri::command]
pub async fn open_file_dialog(app: AppHandle) {
    let picked = tauri::async_runtime::spawn_blocking({
        let app = app.clone();
        move || {
            app.dialog()
                .file()
                .add_filter("Markdown", &["md", "markdown"])
                .blocking_pick_file()
        }
    })
    .await
    .ok()
    .flatten();
    if let Some(f) = picked {
        if let Ok(p) = f.into_path() {
            open_by_path(&app, &p.to_string_lossy()).await;
        }
    }
}

#[tauri::command]
pub async fn open_folder_dialog(app: AppHandle) {
    let picked = tauri::async_runtime::spawn_blocking({
        let app = app.clone();
        move || app.dialog().file().blocking_pick_folder()
    })
    .await
    .ok()
    .flatten();
    if let Some(f) = picked {
        if let Ok(p) = f.into_path() {
            let _ = app.emit("locate-path", json!({ "path": p.to_string_lossy() }));
        }
    }
}

#[tauri::command]
pub async fn get_recent(app: AppHandle) -> Vec<String> {
    crate::core::get_recent(&app).await
}

#[tauri::command]
pub fn get_version(app: AppHandle) -> String {
    app.package_info().version.to_string()
}

// ---------- 窗口操作（自绘菜单 视图/窗口） ----------

#[tauri::command]
pub fn show_window(window: WebviewWindow) {
    let _ = window.show();
    let _ = window.set_focus();
}

#[tauri::command]
pub fn win_minimize(window: WebviewWindow) {
    let _ = window.minimize();
}

#[tauri::command]
pub fn win_close(window: WebviewWindow) {
    let _ = window.close();
}

#[tauri::command]
pub fn win_quit(app: AppHandle) {
    app.exit(0);
}

#[tauri::command]
pub fn win_fullscreen(window: WebviewWindow) {
    let full = window.is_fullscreen().unwrap_or(false);
    let _ = window.set_fullscreen(!full);
}

#[tauri::command]
pub fn win_reload(window: WebviewWindow) {
    let _ = window.eval("window.location.reload()");
}

#[tauri::command]
pub fn open_devtools(window: WebviewWindow) {
    window.open_devtools();
}

// 缩放：Electron zoomLevel 步进等价（1.2 倍率），限幅 0.3~5
pub type ZoomLevel = Mutex<f64>;

fn apply_zoom(window: &WebviewWindow, factor: f64) {
    let _ = window.set_zoom(factor);
}

#[tauri::command]
pub fn zoom_in(window: WebviewWindow, zoom: tauri::State<'_, ZoomLevel>) {
    let mut z = zoom.lock().unwrap();
    *z = (*z * 1.2).min(5.0);
    apply_zoom(&window, *z);
}

#[tauri::command]
pub fn zoom_out(window: WebviewWindow, zoom: tauri::State<'_, ZoomLevel>) {
    let mut z = zoom.lock().unwrap();
    *z = (*z / 1.2).max(0.3);
    apply_zoom(&window, *z);
}

#[tauri::command]
pub fn zoom_reset(window: WebviewWindow, zoom: tauri::State<'_, ZoomLevel>) {
    let mut z = zoom.lock().unwrap();
    *z = 1.0;
    apply_zoom(&window, *z);
}