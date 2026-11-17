// Tot — Tauri 壳入口：窗口 / mdfile 协议 / 单实例 / 拖入 / 启动序列
// 语义对齐 Electron 时代 main.js（非 dev 钩子部分）

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod core;

use core::*;
use serde_json::json;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Instant;
use tauri::{Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

// 启动闸门：渲染层注册完事件监听后调 frontend_ready，壳再发 init-tree（防事件早于监听丢失）
#[derive(Default)]
struct StartupGate {
    notify: tokio::sync::Notify,
}

struct PerfState {
    start: Instant,
    reported: AtomicBool,
}

#[derive(Default)]
struct StartupArgs(Mutex<Vec<String>>);

struct HookFlags {
    argv_done: AtomicBool,
}

#[tauri::command]
fn frontend_ready(app: tauri::AppHandle, page_ms: f64) {
    let perf = app.state::<PerfState>();
    if std::env::var_os("TOT_PERF").is_some() && !perf.reported.swap(true, Ordering::SeqCst) {
        println!(
            "[dev:perf] {}",
            json!({ "uptimeMs": perf.start.elapsed().as_millis() as u64, "pageMs": page_ms.round() as i64 })
        );
    }
    app.state::<StartupGate>().notify.notify_one();
}

// 自动化输出通道：CDP 驱动脚本经此把断言结果打到壳进程控制台（对齐 [dev:*] 输出）
#[tauri::command]
fn dev_log(tag: String, data: String) {
    if dev_hooks_active() || cfg!(debug_assertions) {
        println!("[{}] {}", tag, data);
    }
}

// 对齐 path.resolve：相对路径按当前目录补全
fn resolve_path(p: &str) -> String {
    let path = std::path::Path::new(p);
    if path.is_absolute() {
        p.to_string()
    } else {
        std::env::current_dir()
            .map(|d| d.join(path).to_string_lossy().to_string())
            .unwrap_or_else(|_| p.to_string())
    }
}

async fn startup_sequence(app: tauri::AppHandle) {
    let drives = list_drives();
    // 开发/自动验证：TOT_OPEN_DIR 定位展开到该目录；TOT_OPEN_FILE 再自动打开一个文件
    if let Ok(dir) = std::env::var("TOT_OPEN_DIR") {
        let dir = resolve_path(&dir);
        let _ = app.emit("init-tree", json!({ "drives": drives }));
        let _ = app.emit("locate-path", json!({ "path": dir }));
        if let Ok(file) = std::env::var("TOT_OPEN_FILE") {
            tokio::time::sleep(std::time::Duration::from_millis(2500)).await; // 等目录链懒加载定位完成
            let full = std::path::Path::new(&dir).join(file).to_string_lossy().to_string();
            mark_openable(&app, &full);
            let _ = app.emit("open-file-path", json!({ "path": full }));
        }
        return;
    }
    let _ = app.emit("init-tree", json!({ "drives": drives }));
    // 文件关联双击：打开命令行传入的 md 文件（只消费一次）
    let starts: Vec<String> = app.state::<StartupArgs>().0.lock().unwrap().drain(..).collect();
    for p in starts {
        open_by_path(&app, &p).await;
    }
    // 上次关闭前还有打开的文件：询问是否恢复（自动化钩子下不弹）
    if !dev_hooks_active() {
        offer_session(&app).await;
    }
    // TOT_ARGV：文件关联首次双击验证——argv 传入的 md 已打开并渲染
    if std::env::var_os("TOT_ARGV").is_some()
        && !app.state::<HookFlags>().argv_done.swap(true, Ordering::SeqCst)
    {
        tokio::time::sleep(std::time::Duration::from_millis(2500)).await;
        if let Some(w) = app.get_webview_window("main") {
            let _ = w.eval(
                r#"window.__TAURI_INTERNALS__.invoke('dev_log',{tag:'dev:argv1',data:JSON.stringify({tabs:[...document.querySelectorAll('.tab .tab-name')].map((t)=>t.textContent),h1:document.querySelector('#viewer h1')?.textContent??null})})"#,
            );
        }
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        app.exit(0);
    }
}

// mdfile 图片协议：路径校验限制在已浏览目录内（对齐 handleMdfile）
fn mdfile_response(status: u16, mime: &str, body: Vec<u8>) -> tauri::http::Response<Vec<u8>> {
    tauri::http::Response::builder()
        .status(status)
        .header("Content-Type", mime)
        .header("Access-Control-Allow-Origin", "*")
        .body(body)
        .unwrap()
}

fn main() {
    let start = Instant::now();
    let startup_md: Vec<String> = std::env::args()
        .skip(1)
        .filter(|a| is_md_path(a))
        .collect();

    tauri::Builder::default()
        // 单实例：第二实例把 argv 转交首实例——先还原/前置窗口再打开文件（双击立即可见响应）
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                if w.is_minimized().unwrap_or(false) {
                    let _ = w.unminimize();
                }
                let _ = w.show();
                let _ = w.set_focus();
            }
            let app = app.clone();
            let paths: Vec<String> = argv.into_iter().filter(|a| is_md_path(a)).collect();
            tauri::async_runtime::spawn(async move {
                for p in paths {
                    open_by_path(&app, &p).await;
                }
            });
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .register_uri_scheme_protocol("mdfile", |ctx, request| {
            let app = ctx.app_handle();
            // Windows 下 URL 为 http://mdfile.localhost/local/<路径>；其余平台 mdfile://local/<路径>
            let raw = request.uri().path().to_string();
            let stripped = raw
                .strip_prefix("/local/")
                .map(|s| s.to_string())
                .unwrap_or_else(|| raw.trim_start_matches('/').to_string());
            let decoded = percent_encoding::percent_decode_str(&stripped)
                .decode_utf8_lossy()
                .to_string();
            let allowed = {
                let state = app.state::<SharedBrowse>();
                let st = state.lock().unwrap();
                path_allowed(&st, &decoded)
            };
            if !allowed {
                return mdfile_response(403, "text/plain", b"forbidden".to_vec());
            }
            match std::fs::read(&decoded) {
                Ok(data) => mdfile_response(200, image_mime(&decoded), data),
                Err(_) => mdfile_response(404, "text/plain", b"not found".to_vec()),
            }
        })
        .manage(SharedBrowse::default())
        .manage(StartupGate::default())
        .manage(StartupArgs(Mutex::new(startup_md)))
        .manage(PerfState { start, reported: AtomicBool::new(false) })
        .manage(HookFlags { argv_done: AtomicBool::new(false) })
        .manage(commands::ZoomLevel::new(1.0))
        .invoke_handler(tauri::generate_handler![
            commands::scan_children,
            commands::read_file,
            commands::write_file,
            commands::resolve_images,
            commands::add_recent,
            commands::open_dropped,
            commands::select_image,
            commands::set_theme,
            commands::save_session,
            commands::restore_session,
            commands::dismiss_session,
            commands::open_file_dialog,
            commands::open_folder_dialog,
            commands::get_recent,
            commands::get_version,
            commands::show_window,
            commands::win_minimize,
            commands::win_close,
            commands::win_quit,
            commands::win_fullscreen,
            commands::win_reload,
            commands::open_devtools,
            commands::zoom_in,
            commands::zoom_out,
            commands::zoom_reset,
            frontend_ready,
            dev_log,
        ])
        .setup(|app| {
            let handle = app.handle().clone();

            // config.json 目录：TOT_USER_DATA 隔离（验证用），否则系统应用配置目录
            let config_dir = match std::env::var_os("TOT_USER_DATA") {
                Some(d) => PathBuf::from(d),
                None => app.path().app_config_dir()?,
            };
            std::fs::create_dir_all(&config_dir)?;
            app.manage(ConfigStore {
                path: config_dir.join("config.json"),
                queue: tokio::sync::Mutex::new(()),
            });

            // 窗口：首帧就绪再显示（bridge 调 show_window），避免冷启动白屏闪烁
            let mut builder = WebviewWindowBuilder::new(
                app,
                "main",
                WebviewUrl::App("index.html".into()),
            )
            .title(format!("Tot {}", app.package_info().version))
            .inner_size(1280.0, 840.0)
            .visible(false);
            // 自动化验证：WebView2 远程调试端口（debug 构建默认开；release 需 TOT_CDP）
            // 注：WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS 环境变量会被 wry 覆盖，须走构建器参数
            if cfg!(debug_assertions) || std::env::var_os("TOT_CDP").is_some() {
                let port = std::env::var("TOT_CDP_PORT").unwrap_or_else(|_| "9222".into());
                builder = builder.additional_browser_args(&format!("--remote-debugging-port={port}"));
            }
            if let Some(d) = std::env::var_os("TOT_USER_DATA") {
                // 验证隔离：WebView2 存储（localStorage 等）也随 TOT_USER_DATA 走
                builder = builder.data_directory(PathBuf::from(d).join("webview"));
            }
            builder.build()?;

            // 兜底定时器：防首帧信号意外丢失时窗口永远不出现
            let fallback = handle.clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_secs(2));
                if let Some(w) = fallback.get_webview_window("main") {
                    let _ = w.show();
                }
            });

            // 启动序列：每次前端就绪（含重新加载）重放 init-tree / 会话询问；argv 只消费一次
            let runner = handle.clone();
            tauri::async_runtime::spawn(async move {
                loop {
                    runner.state::<StartupGate>().notify.notified().await;
                    startup_sequence(runner.clone()).await;
                }
            });
            Ok(())
        })
        .on_window_event(|window, event| {
            // 拖入打开：Tauri 原生 drag-drop 自带真实路径，只收 .md/.markdown，走打开全流程
            if let tauri::WindowEvent::DragDrop(tauri::DragDropEvent::Drop { paths, .. }) = event {
                let app = window.app_handle().clone();
                let paths: Vec<String> = paths
                    .iter()
                    .map(|p| p.to_string_lossy().to_string())
                    .filter(|p| is_md_path(p))
                    .collect();
                tauri::async_runtime::spawn(async move {
                    for p in paths {
                        open_by_path(&app, &p).await;
                    }
                });
            }
        })
        .run(tauri::generate_context!())
        .expect("Tot 启动失败");
}