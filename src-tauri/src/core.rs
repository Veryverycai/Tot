// 壳层核心：目录扫描 / 路径边界 / config / 最近打开 / 会话 / openByPath
// 语义逐项对齐 Electron 时代的 main.js（knownDirs 链条式信任边界、原子写 config 等）

use serde_json::{json, Map, Value};
use std::collections::HashSet;
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager};

// ---------- 浏览边界状态 ----------

#[derive(Default)]
pub struct BrowseState {
    // 已扫描过的目录（规范化小写键）：渲染层只能扩展它已见到的目录
    pub known_dirs: HashSet<String>,
    // 已扫过列表的盘符（其直接子目录才放行）
    pub drives_seen: HashSet<String>,
}

pub type SharedBrowse = Mutex<BrowseState>;

// 规范化键：Windows 大小写不敏感 + 斜杠归一（对齐 path.resolve().toLowerCase()）
pub fn norm_key(p: &str) -> String {
    p.replace('/', "\\").to_lowercase()
}

// 盘符根（C:\ 或 C:/）
pub fn is_drive_root(p: &str) -> bool {
    let b = p.as_bytes();
    b.len() == 3 && b[0].is_ascii_alphabetic() && b[1] == b':' && (b[2] == b'\\' || b[2] == b'/')
}

fn is_inside(root: &str, p: &str) -> bool {
    let r = Path::new(root);
    let pp = Path::new(p);
    pp != r && pp.starts_with(r)
}

// 文件/图片访问边界：盘符根下的文件随盘符可见，其余须在已浏览目录内
pub fn path_allowed(state: &BrowseState, p: &str) -> bool {
    let parent = Path::new(p)
        .parent()
        .map(|x| x.to_string_lossy().to_string())
        .unwrap_or_default();
    if is_drive_root(&parent) {
        return true;
    }
    let pk = norm_key(p);
    state.known_dirs.iter().any(|k| is_inside(k, &pk))
}

// 树懒加载放行：盘符本身、已见盘符的直接子目录、或已知目录的直接子目录
pub fn dir_allowed(state: &BrowseState, dir: &str) -> bool {
    if is_drive_root(dir) {
        return true;
    }
    let parent = Path::new(dir)
        .parent()
        .map(|x| x.to_string_lossy().to_string())
        .unwrap_or_default();
    if is_drive_root(&parent) {
        return state.drives_seen.contains(&norm_key(&parent));
    }
    state.known_dirs.contains(&norm_key(&parent))
}

// 主进程发起的打开（菜单打开文件 / 最近打开 / 拖入 / argv）：先放行其父目录
pub fn mark_openable(app: &AppHandle, file_path: &str) {
    let parent = Path::new(file_path)
        .parent()
        .map(|x| x.to_string_lossy().to_string())
        .unwrap_or_default();
    if !is_drive_root(&parent) {
        let state = app.state::<SharedBrowse>();
        let mut st = state.lock().unwrap();
        st.known_dirs.insert(norm_key(&parent));
    }
}

// ---------- 目录扫描 ----------

#[derive(serde::Serialize)]
pub struct Entry {
    pub name: String,
    pub path: String,
    #[serde(rename = "type")]
    pub kind: &'static str,
}

fn is_md(name: &str) -> bool {
    let lower = name.to_lowercase();
    lower.ends_with(".md") || lower.ends_with(".markdown")
}

pub fn is_md_path(p: &str) -> bool {
    is_md(p)
}

// Win32 自然排序（zh-CN + 数字按值比较），对齐 localeCompare('zh-CN', {numeric:true})
#[link(name = "kernel32")]
extern "system" {
    fn GetLogicalDriveStringsW(nBufferLength: u32, lpBuffer: *mut u16) -> u32;
    fn CompareStringEx(
        lpLocaleName: *const u16,
        dwCmpFlags: u32,
        lpString1: *const u16,
        cchCount1: i32,
        lpString2: *const u16,
        cchCount2: i32,
        lpVersionInformation: *mut std::ffi::c_void,
        lpReserved: *mut std::ffi::c_void,
        lParam: isize,
    ) -> i32;
}

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

const SORT_DIGITSASNUMBERS: u32 = 0x0000_0008;

fn zh_compare(a: &str, b: &str) -> std::cmp::Ordering {
    let locale = wide("zh-CN");
    let wa = wide(a);
    let wb = wide(b);
    let r = unsafe {
        CompareStringEx(
            locale.as_ptr(),
            SORT_DIGITSASNUMBERS,
            wa.as_ptr(),
            (wa.len() as i32) - 1,
            wb.as_ptr(),
            (wb.len() as i32) - 1,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            0,
        )
    };
    match r {
        1 => std::cmp::Ordering::Less,
        3 => std::cmp::Ordering::Greater,
        _ => a.to_lowercase().cmp(&b.to_lowercase()),
    }
}

// 读取 dir 的直接子项：子目录 + .md/.markdown；跳过 .git/node_modules 与点开头目录；
// 读不了的目录静默返回空
pub fn scan_children(dir: &str) -> Vec<Entry> {
    let Ok(items) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut entries = Vec::new();
    for item in items.flatten() {
        let name = item.file_name().to_string_lossy().to_string();
        let Ok(ft) = item.file_type() else { continue };
        if ft.is_dir() {
            if name == "node_modules" || name == ".git" || name.starts_with('.') {
                continue;
            }
            entries.push(Entry {
                path: Path::new(dir).join(&name).to_string_lossy().to_string(),
                name,
                kind: "dir",
            });
        } else if ft.is_file() && is_md(&name) {
            entries.push(Entry {
                path: Path::new(dir).join(&name).to_string_lossy().to_string(),
                name,
                kind: "file",
            });
        }
    }
    entries.sort_by(|a, b| zh_compare(&a.name, &b.name));
    entries
}

// 枚举存在的盘符（GetLogicalDriveStringsW 一次取全，替代 26 次探测）
pub fn list_drives() -> Vec<Entry> {
    let mut buf = [0u16; 512];
    let n = unsafe { GetLogicalDriveStringsW(buf.len() as u32, buf.as_mut_ptr()) };
    if n == 0 || n as usize >= buf.len() {
        return Vec::new();
    }
    buf[..n as usize]
        .split(|&c| c == 0)
        .filter(|s| !s.is_empty())
        .map(|s| {
            let name = String::from_utf16_lossy(s);
            Entry { path: name.clone(), name, kind: "dir" }
        })
        .collect()
}

// ---------- config.json（串行队列 + 临时文件 rename 原子写） ----------

pub struct ConfigStore {
    pub path: PathBuf,
    pub queue: tokio::sync::Mutex<()>,
}

impl ConfigStore {
    pub async fn load(&self) -> Map<String, Value> {
        let text = tokio::fs::read_to_string(&self.path).await.unwrap_or_default();
        let mut cfg = serde_json::from_str::<Value>(&text)
            .ok()
            .and_then(|v| v.as_object().cloned())
            .unwrap_or_default();
        if !cfg.get("recent").map(|v| v.is_array()).unwrap_or(false) {
            cfg.insert("recent".into(), json!([]));
        }
        cfg
    }

    pub async fn save_patch(&self, patch: Map<String, Value>) {
        self.update(|cfg| {
            for (k, v) in patch {
                cfg.insert(k, v);
            }
        })
        .await;
    }

    // 串行化的读-改-写（对齐 recentQueue/configQueue：并发打开多文件时不互相覆盖）
    pub async fn update(&self, f: impl FnOnce(&mut Map<String, Value>)) {
        let _guard = self.queue.lock().await;
        let mut cfg = self.load().await;
        f(&mut cfg);
        if let Some(parent) = self.path.parent() {
            let _ = tokio::fs::create_dir_all(parent).await;
        }
        let tmp = self.path.with_extension("json.tmp");
        let Ok(text) = serde_json::to_string_pretty(&Value::Object(cfg)) else { return };
        if tokio::fs::write(&tmp, text).await.is_ok() {
            let _ = tokio::fs::rename(&tmp, &self.path).await;
        }
    }
}

pub fn config_store(app: &AppHandle) -> tauri::State<'_, ConfigStore> {
    app.state::<ConfigStore>()
}

// ---------- 最近打开（去重、最多 3 个） ----------

pub async fn add_recent(app: &AppHandle, file_path: &str) {
    let store = config_store(app);
    store
        .update(|cfg| {
            let mut recent: Vec<String> = vec![file_path.to_string()];
            for p in cfg.get("recent").and_then(|v| v.as_array()).into_iter().flatten() {
                if let Some(s) = p.as_str() {
                    if s != file_path && recent.len() < 3 {
                        recent.push(s.to_string());
                    }
                }
            }
            cfg.insert("recent".into(), json!(recent));
        })
        .await;
    let _ = app.emit("recent-changed", json!({}));
}

// 菜单数据源：启动/刷新时把已不存在的文件滤掉
pub async fn get_recent(app: &AppHandle) -> Vec<String> {
    let cfg = config_store(app).load().await;
    let mut out = Vec::new();
    for p in cfg.get("recent").and_then(|v| v.as_array()).into_iter().flatten() {
        if let Some(s) = p.as_str() {
            if Path::new(s).exists() {
                out.push(s.to_string());
            }
        }
    }
    out
}

// ---------- openByPath（菜单打开文件 / 最近打开 / 拖入 / argv 共用） ----------

pub async fn open_by_path(app: &AppHandle, file_path: &str) {
    if !Path::new(file_path).exists() {
        // 文件已不存在：从最近打开索引移除并提示渲染层（不弹框，同步阻塞会挂死自动化）
        let store = config_store(app);
        store
            .update(|cfg| {
                let recent: Vec<String> = cfg
                    .get("recent")
                    .and_then(|v| v.as_array())
                    .into_iter()
                    .flatten()
                    .filter_map(|p| p.as_str().map(|s| s.to_string()))
                    .filter(|p| p != file_path)
                    .collect();
                cfg.insert("recent".into(), json!(recent));
            })
            .await;
        let _ = app.emit("recent-changed", json!({}));
        let _ = app.emit("open-file-error", json!({ "path": file_path }));
        return;
    }
    mark_openable(app, file_path);
    // 先通知渲染层打开，再后台更新最近打开索引（冷启动首屏优先）
    let _ = app.emit("open-file-path", json!({ "path": file_path }));
    let app2 = app.clone();
    let p = file_path.to_string();
    tauri::async_runtime::spawn(async move { add_recent(&app2, &p).await });
}

// ---------- 会话恢复 ----------

const SESSION_MAX: usize = 20;

// 只认 .md/.markdown 路径，去重（大小写不敏感）并限量；空会话返回 None
pub fn sanitize_session(data: &Value) -> Option<Value> {
    let obj = data.as_object()?;
    let mut paths: Vec<String> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    for p in obj.get("paths").and_then(|v| v.as_array()).into_iter().flatten() {
        let Some(s) = p.as_str() else { continue };
        if !is_md_path(s) {
            continue;
        }
        let key = s.to_lowercase();
        if seen.contains(&key) {
            continue;
        }
        seen.insert(key);
        paths.push(s.to_string());
        if paths.len() >= SESSION_MAX {
            break;
        }
    }
    if paths.is_empty() {
        return None;
    }
    let active = obj
        .get("active")
        .and_then(|v| v.as_str())
        .filter(|a| seen.contains(&a.to_lowercase()))
        .unwrap_or(&paths[0])
        .to_string();
    Some(json!({ "paths": paths, "active": active }))
}

pub async fn offer_session(app: &AppHandle) {
    let store = config_store(app);
    let cfg = store.load().await;
    let Some(s) = cfg.get("session").and_then(sanitize_session) else { return };
    let paths: Vec<String> = s["paths"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|p| p.as_str().map(|x| x.to_string()))
        .filter(|p| Path::new(p).exists())
        .collect();
    if paths.is_empty() {
        let mut patch = Map::new();
        patch.insert("session".into(), Value::Null);
        store.save_patch(patch).await;
        return;
    }
    let active = s["active"]
        .as_str()
        .filter(|a| paths.iter().any(|p| p == a))
        .unwrap_or(&paths[0])
        .to_string();
    let _ = app.emit("session-offer", json!({ "paths": paths, "active": active }));
}

// ---------- 图片相对路径解析 ----------

// 对齐 Node path.resolve(base, src)：处理 . / .. / 绝对路径
pub fn resolve_abs(base: &Path, src: &str) -> PathBuf {
    let rel = src.replace('/', "\\");
    let mut out = base.to_path_buf();
    for comp in Path::new(&rel).components() {
        match comp {
            Component::Prefix(p) => out = PathBuf::from(p.as_os_str()),
            Component::RootDir => {
                let prefix = out
                    .components()
                    .next()
                    .map(|c| c.as_os_str().to_os_string())
                    .unwrap_or_default();
                out = PathBuf::from(prefix);
                out.push("\\");
            }
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            Component::Normal(c) => out.push(c),
        }
    }
    out
}

// 对齐 JS encodeURI：保留 A-Za-z0-9 与 ;,/?:@&=+$-_.!~*'()#
fn encode_uri(s: &str) -> String {
    const KEEP: &[u8] = b";,/?:@&=+$-_.!~*'()#";
    let mut out = String::new();
    for &b in s.as_bytes() {
        if b.is_ascii_alphanumeric() || KEEP.contains(&b) {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{:02X}", b));
        }
    }
    out
}

pub fn resolve_images(file_path: &str, srcs: &[String]) -> Vec<String> {
    let base = Path::new(file_path).parent().unwrap_or(Path::new(""));
    srcs
        .iter()
        .map(|src| {
            let lower = src.to_lowercase();
            if lower.starts_with("http:") || lower.starts_with("https:")
                || lower.starts_with("data:") || lower.starts_with("mdfile:")
            {
                return src.clone();
            }
            let abs = resolve_abs(base, src);
            // Windows 下 Tauri 自定义协议经 http://<scheme>.localhost 提供
            format!(
                "http://mdfile.localhost/local/{}",
                encode_uri(&abs.to_string_lossy().replace('\\', "/"))
            )
        })
        .collect()
}

// ---------- 图片协议 MIME ----------

pub fn image_mime(p: &str) -> &'static str {
    let ext = Path::new(p)
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "svg" => "image/svg+xml",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        "ico" => "image/x-icon",
        _ => "application/octet-stream",
    }
}

// ---------- 开发验证钩子白名单（对齐 DEV_HOOK_ENVS） ----------

const DEV_HOOK_ENVS: &[&str] = &[
    "TOT_ARGV", "TOT_ARGV_HOLD", "TOT_CHECK", "TOT_DBL", "TOT_DRAG", "TOT_DROP", "TOT_DROP_FILES",
    "TOT_EDIT", "TOT_MERMAID", "TOT_OPEN_DIR", "TOT_OPEN_FILE", "TOT_PANELS", "TOT_PERF",
    "TOT_RECENT_MISSING", "TOT_REPLACE", "TOT_SCREENSHOT", "TOT_SEARCH", "TOT_SEARCH_QUERY", "TOT_STYLE", "TOT_TABS",
    "TOT_WAIT",
];

pub fn dev_hooks_active() -> bool {
    DEV_HOOK_ENVS.iter().any(|k| std::env::var_os(k).is_some())
}