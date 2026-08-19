// filo backend: file read/write with encoding and line-ending detection,
// atomic saves with rotating backups, user configuration, central metadata
// store (with migration of the old .meta sidecars) and single-instance
// handling ("Open with filo").

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{Emitter, Manager};

// ── Encoding ──────────────────────────────────────────────────────────
// filo handles UTF-8 (with or without BOM) and Windows-1252, the most
// common legacy encoding on Italian Windows systems.

/// Windows-1252 bytes 0x80–0x9F → Unicode code point.
const CP1252_HIGH: [char; 32] = [
    '\u{20AC}', '\u{0081}', '\u{201A}', '\u{0192}', '\u{201E}', '\u{2026}',
    '\u{2020}', '\u{2021}', '\u{02C6}', '\u{2030}', '\u{0160}', '\u{2039}',
    '\u{0152}', '\u{008D}', '\u{017D}', '\u{008F}', '\u{0090}', '\u{2018}',
    '\u{2019}', '\u{201C}', '\u{201D}', '\u{2022}', '\u{2013}', '\u{2014}',
    '\u{02DC}', '\u{2122}', '\u{0161}', '\u{203A}', '\u{0153}', '\u{009D}',
    '\u{017E}', '\u{0178}',
];

fn cp1252_decode(bytes: &[u8]) -> String {
    bytes
        .iter()
        .map(|&b| match b {
            0x80..=0x9F => CP1252_HIGH[(b - 0x80) as usize],
            _ => b as char, // 0x00–0x7F ASCII, 0xA0–0xFF = Latin-1
        })
        .collect()
}

fn cp1252_encode(text: &str) -> Vec<u8> {
    text.chars()
        .map(|c| {
            let cp = c as u32;
            if cp < 0x80 || (0xA0..=0xFF).contains(&cp) {
                cp as u8
            } else if let Some(i) = CP1252_HIGH.iter().position(|&h| h == c) {
                0x80 + i as u8
            } else {
                b'?' // character not representable
            }
        })
        .collect()
}

#[derive(serde::Serialize)]
pub struct FileContents {
    text: String,
    encoding: String, // "utf-8" | "windows-1252"
    eol: String,      // "lf" | "crlf"
    bom: bool,
}

fn decode_bytes(raw: Vec<u8>) -> (String, String, bool) {
    let (body, bom) = if raw.starts_with(&[0xEF, 0xBB, 0xBF]) {
        (raw[3..].to_vec(), true)
    } else {
        (raw, false)
    };
    match String::from_utf8(body) {
        Ok(text) => (text, "utf-8".into(), bom),
        Err(e) => (cp1252_decode(e.as_bytes()), "windows-1252".into(), false),
    }
}

// ── File commands ─────────────────────────────────────────────────────

#[tauri::command]
fn read_file(path: String) -> Result<FileContents, String> {
    let raw = fs::read(&path).map_err(|e| e.to_string())?;
    let (text, encoding, bom) = decode_bytes(raw);
    let eol = if text.contains("\r\n") { "crlf" } else { "lf" };
    Ok(FileContents {
        // internally the editor always works with \n
        text: text.replace("\r\n", "\n"),
        encoding,
        eol: eol.into(),
        bom,
    })
}

/// Last-modified time of the file in milliseconds (None if it does not
/// exist): lets the frontend notice external changes.
#[tauri::command]
fn file_mtime(path: String) -> Option<u64> {
    fs::metadata(&path)
        .ok()?
        .modified()
        .ok()?
        .duration_since(std::time::UNIX_EPOCH)
        .ok()
        .map(|d| d.as_millis() as u64)
}

/// Copies the existing file into the app's backup folder, keeping at
/// most 10 copies per file name.
fn make_backup(app: &tauri::AppHandle, path: &Path) -> Result<(), String> {
    if !path.exists() {
        return Ok(());
    }
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("backups");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "senza-nome".into());
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    fs::copy(path, dir.join(format!("{name}.{stamp}.bak"))).map_err(|e| e.to_string())?;

    // Rotation: delete the oldest backups beyond the tenth.
    let prefix = format!("{name}.");
    let mut mine: Vec<PathBuf> = fs::read_dir(&dir)
        .map_err(|e| e.to_string())?
        .flatten()
        .map(|e| e.path())
        .filter(|p| {
            p.file_name()
                .map(|f| f.to_string_lossy().starts_with(&prefix))
                .unwrap_or(false)
        })
        .collect();
    mine.sort();
    while mine.len() > 10 {
        let _ = fs::remove_file(mine.remove(0));
    }
    Ok(())
}

/// Atomic save: back up the original, write to a temporary file in the
/// same folder, then replace (MoveFileEx with REPLACE_EXISTING).
#[tauri::command]
fn write_file(
    app: tauri::AppHandle,
    path: String,
    contents: String,
    encoding: String,
    eol: String,
    bom: bool,
) -> Result<(), String> {
    let target = Path::new(&path);
    make_backup(&app, target)?;

    let text = if eol == "crlf" {
        contents.replace('\n', "\r\n")
    } else {
        contents
    };
    let mut bytes = if encoding == "windows-1252" {
        cp1252_encode(&text)
    } else {
        text.into_bytes()
    };
    if bom && encoding == "utf-8" {
        let mut with_bom = vec![0xEF, 0xBB, 0xBF];
        with_bom.append(&mut bytes);
        bytes = with_bom;
    }

    let tmp = target.with_extension(format!(
        "{}~filotmp",
        target
            .extension()
            .map(|e| e.to_string_lossy().to_string())
            .unwrap_or_default()
    ));
    fs::write(&tmp, &bytes).map_err(|e| e.to_string())?;
    fs::rename(&tmp, target).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        e.to_string()
    })
}

// ── Central metadata store ────────────────────────────────────────────
// Metadata (groups, links, notes) does NOT sit next to the file: it lives
// in the app data dir under meta/, one JSON record per document. The
// user's file stays the only visible file. Each record is an "envelope":
//   { "path": original path, "docHash": fingerprint, "meta": json }
// If the file gets moved/renamed, the record is found again by content
// fingerprint and adopted under the new path.

#[derive(serde::Serialize, serde::Deserialize)]
struct MetaEnvelope {
    path: String,
    doc_hash: String,
    meta: String,
}

fn meta_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("meta");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

/// 64-bit FNV-1a of the normalized path: name of the record file.
fn path_key(path: &str) -> String {
    let mut h: u64 = 0xcbf29ce484222325;
    for b in path.to_lowercase().replace('/', "\\").bytes() {
        h ^= b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    format!("{h:016x}.json")
}

#[tauri::command]
fn meta_save(
    app: tauri::AppHandle,
    path: String,
    doc_hash: String,
    contents: String,
) -> Result<(), String> {
    let record = meta_dir(&app)?.join(path_key(&path));
    let envelope = MetaEnvelope {
        path,
        doc_hash,
        meta: contents,
    };
    fs::write(
        &record,
        serde_json::to_string(&envelope).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())
}

#[tauri::command]
fn meta_load(
    app: tauri::AppHandle,
    path: String,
    disk_hash: String,
) -> Result<Option<String>, String> {
    let dir = meta_dir(&app)?;

    // 1. direct match by path
    let record = dir.join(path_key(&path));
    if record.exists() {
        let raw = fs::read_to_string(&record).map_err(|e| e.to_string())?;
        if let Ok(env) = serde_json::from_str::<MetaEnvelope>(&raw) {
            return Ok(Some(env.meta));
        }
    }

    // 2. file moved or renamed: look for a record with the same content
    //    fingerprint whose old path no longer exists
    for entry in fs::read_dir(&dir).map_err(|e| e.to_string())?.flatten() {
        let raw = match fs::read_to_string(entry.path()) {
            Ok(r) => r,
            Err(_) => continue,
        };
        let env = match serde_json::from_str::<MetaEnvelope>(&raw) {
            Ok(e) => e,
            Err(_) => continue,
        };
        if env.doc_hash == disk_hash && !Path::new(&env.path).exists() {
            // adoption: the record moves to the new path
            let meta = env.meta.clone();
            let adopted = MetaEnvelope {
                path: path.clone(),
                doc_hash: env.doc_hash,
                meta: env.meta,
            };
            let _ = fs::write(
                dir.join(path_key(&path)),
                serde_json::to_string(&adopted).map_err(|e| e.to_string())?,
            );
            let _ = fs::remove_file(entry.path());
            return Ok(Some(meta));
        }
    }
    Ok(None)
}

#[tauri::command]
fn meta_delete(app: tauri::AppHandle, path: String) -> Result<(), String> {
    let record = meta_dir(&app)?.join(path_key(&path));
    if record.exists() {
        fs::remove_file(&record).map_err(|e| e.to_string())?;
    }
    Ok(())
}

// ── .meta sidecars (migration from the old format only) ──────────────

fn sidecar_path(doc: &str) -> String {
    format!("{doc}.meta")
}

#[tauri::command]
fn read_sidecar(path: String) -> Result<Option<String>, String> {
    let p = sidecar_path(&path);
    if !Path::new(&p).exists() {
        return Ok(None);
    }
    fs::read_to_string(&p).map(Some).map_err(|e| e.to_string())
}

#[tauri::command]
fn delete_sidecar(path: String) -> Result<(), String> {
    let p = sidecar_path(&path);
    if Path::new(&p).exists() {
        fs::remove_file(&p).map_err(|e| e.to_string())?;
    }
    Ok(())
}

// ── User configuration (preferences, session) ─────────────────────────

fn config_file(app: &tauri::AppHandle, name: &str) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join(format!("{name}.json")))
}

#[tauri::command]
fn load_config(app: tauri::AppHandle, name: String) -> Result<Option<String>, String> {
    let p = config_file(&app, &name)?;
    if !p.exists() {
        return Ok(None);
    }
    fs::read_to_string(&p).map(Some).map_err(|e| e.to_string())
}

#[tauri::command]
fn save_config(app: tauri::AppHandle, name: String, contents: String) -> Result<(), String> {
    let p = config_file(&app, &name)?;
    fs::write(&p, contents).map_err(|e| e.to_string())
}

// ── File explorer (sidebar) ───────────────────────────────────────────

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct DirEntry {
    name: String,
    path: String,
    is_dir: bool,
}

/// Contents of a folder: directories first, then files, in
/// case-insensitive alphabetical order.
#[tauri::command]
fn list_dir(path: String) -> Result<Vec<DirEntry>, String> {
    let mut items: Vec<DirEntry> = fs::read_dir(&path)
        .map_err(|e| e.to_string())?
        .flatten()
        .filter_map(|e| {
            let is_dir = e.file_type().ok()?.is_dir();
            Some(DirEntry {
                name: e.file_name().to_string_lossy().to_string(),
                path: e.path().to_string_lossy().to_string(),
                is_dir,
            })
        })
        .collect();
    items.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then(a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(items)
}

/// Recursive file search by name under root (case-insensitive).
/// Capped on results and visited entries to stay instantaneous;
/// hidden folders (names with a leading dot) are skipped.
#[tauri::command]
fn search_dir(root: String, query: String) -> Result<Vec<DirEntry>, String> {
    const MAX_RESULTS: usize = 200;
    const MAX_VISITED: usize = 20_000;
    let q = query.to_lowercase();
    let mut out: Vec<DirEntry> = Vec::new();
    let mut stack = vec![PathBuf::from(&root)];
    let mut visited = 0usize;
    while let Some(dir) = stack.pop() {
        if out.len() >= MAX_RESULTS || visited > MAX_VISITED {
            break;
        }
        let Ok(rd) = fs::read_dir(&dir) else { continue };
        for e in rd.flatten() {
            visited += 1;
            let Ok(ft) = e.file_type() else { continue };
            let name = e.file_name().to_string_lossy().to_string();
            if ft.is_dir() {
                if !name.starts_with('.') {
                    stack.push(e.path());
                }
            } else if name.to_lowercase().contains(&q) {
                out.push(DirEntry {
                    name,
                    path: e.path().to_string_lossy().to_string(),
                    is_dir: false,
                });
                if out.len() >= MAX_RESULTS {
                    break;
                }
            }
        }
    }
    out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Ok(out)
}

// ── Files passed on the command line / "Open with" ───────────────────

struct CliFiles(Mutex<Vec<String>>);

fn files_from_args(args: &[String]) -> Vec<String> {
    args.iter()
        .skip(1)
        .filter(|a| !a.starts_with('-') && Path::new(a).is_file())
        .cloned()
        .collect()
}

#[tauri::command]
fn get_cli_files(state: tauri::State<CliFiles>) -> Vec<String> {
    state.0.lock().map(|v| v.clone()).unwrap_or_default()
}

// ── Custom titlebar: Snap Layouts on the Maximize button ──────────────
// With decorations:false Windows no longer knows where the Maximize
// button is and the Snap Layouts flyout (Win11) disappears. The way
// Microsoft supports (apply-snap-layout-menu) is answering HTMAXBUTTON
// to WM_NCHITTEST — but mouse input over the titlebar goes to the
// WebView2 windows, not ours. So: a tiny, nearly invisible native
// window (layered, alpha 1) overlaid on the HTML button answers
// HTMAXBUTTON, handles the click and forwards hover to the webview
// via the "max-hover" event.

#[cfg(windows)]
mod snap {
    use std::sync::atomic::{AtomicBool, AtomicIsize, Ordering};
    use std::sync::OnceLock;
    use tauri::Emitter;
    use windows_sys::Win32::Foundation::{HWND, LPARAM, LRESULT, RECT, WPARAM};
    use windows_sys::Win32::Graphics::Gdi::ValidateRect;
    use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows_sys::Win32::UI::HiDpi::GetDpiForWindow;
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
        TrackMouseEvent, TME_LEAVE, TME_NONCLIENT, TRACKMOUSEEVENT,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, DefWindowProcW, GetAncestor, GetClientRect, GetWindowLongPtrW, IsZoomed,
        RegisterClassW, SetLayeredWindowAttributes, SetWindowLongPtrW, SetWindowPos, ShowWindow,
        GA_ROOT, GWL_STYLE, HTMAXBUTTON, HWND_TOP, LWA_ALPHA, SWP_NOACTIVATE, SW_MAXIMIZE,
        SW_RESTORE, WM_ERASEBKGND, WM_NCHITTEST, WM_NCLBUTTONDBLCLK, WM_NCLBUTTONDOWN,
        WM_NCLBUTTONUP, WM_NCMOUSELEAVE, WM_NCMOUSEMOVE, WM_PAINT, WNDCLASSW, WS_CHILD,
        WS_EX_LAYERED, WS_EX_NOREDIRECTIONBITMAP, WS_MAXIMIZEBOX, WS_VISIBLE,
    };

    // Titlebar geometry in CSS px: must match styles.css
    // (#toolbar height and width of the .win-controls buttons).
    const BAR_H: f64 = 38.0;
    const BTN_W: f64 = 44.0;

    static HOVER: AtomicBool = AtomicBool::new(false);
    static OVERLAY: AtomicIsize = AtomicIsize::new(0);
    static APP: OnceLock<tauri::AppHandle> = OnceLock::new();

    fn set_hover(on: bool) {
        if HOVER.swap(on, Ordering::Relaxed) != on {
            if let Some(app) = APP.get() {
                let _ = app.emit("max-hover", on);
            }
        }
    }

    /// The overlay's entire surface is the Maximize button.
    unsafe extern "system" fn overlay_proc(
        hwnd: HWND,
        msg: u32,
        w: WPARAM,
        l: LPARAM,
    ) -> LRESULT {
        match msg {
            WM_NCHITTEST => HTMAXBUTTON as LRESULT,
            WM_NCMOUSEMOVE => {
                set_hover(true);
                // without tracking, WM_NCMOUSELEAVE never arrives
                let mut tme = TRACKMOUSEEVENT {
                    cbSize: std::mem::size_of::<TRACKMOUSEEVENT>() as u32,
                    dwFlags: TME_LEAVE | TME_NONCLIENT,
                    hwndTrack: hwnd,
                    dwHoverTime: 0,
                };
                TrackMouseEvent(&mut tme);
                0
            }
            WM_NCMOUSELEAVE => {
                set_hover(false);
                0
            }
            // swallow the down: the toggle happens on release
            WM_NCLBUTTONDOWN | WM_NCLBUTTONDBLCLK => 0,
            WM_NCLBUTTONUP => {
                let root = GetAncestor(hwnd, GA_ROOT);
                ShowWindow(
                    root,
                    if IsZoomed(root) != 0 { SW_RESTORE } else { SW_MAXIMIZE },
                );
                0
            }
            // never paint: the HTML button is underneath
            WM_PAINT => {
                ValidateRect(hwnd, std::ptr::null());
                0
            }
            WM_ERASEBKGND => 1,
            _ => DefWindowProcW(hwnd, msg, w, l),
        }
    }

    /// Sticks the overlay over the Maximize button (second from the right).
    unsafe fn position(root: HWND, overlay: HWND) {
        let mut rc = RECT { left: 0, top: 0, right: 0, bottom: 0 };
        if GetClientRect(root, &mut rc) == 0 {
            return;
        }
        let s = GetDpiForWindow(root) as f64 / 96.0;
        let btn = (BTN_W * s) as i32;
        let bar = (BAR_H * s) as i32;
        SetWindowPos(
            overlay,
            HWND_TOP,
            rc.right - 2 * btn,
            0,
            btn,
            bar,
            SWP_NOACTIVATE,
        );
    }

    fn reposition(window: &tauri::WebviewWindow) {
        let overlay = OVERLAY.load(Ordering::Relaxed);
        if overlay == 0 {
            return;
        }
        if let Ok(h) = window.hwnd() {
            unsafe { position(h.0 as HWND, overlay as HWND) };
        }
    }

    pub fn install(app: &tauri::AppHandle, window: &tauri::WebviewWindow) {
        let _ = APP.set(app.clone());
        let Ok(h) = window.hwnd() else { return };
        let root = h.0 as HWND;
        unsafe {
            // without WS_MAXIMIZEBOX Windows does not offer the flyout
            let style = GetWindowLongPtrW(root, GWL_STYLE);
            SetWindowLongPtrW(root, GWL_STYLE, style | WS_MAXIMIZEBOX as isize);

            let class: Vec<u16> = "filo-snap-overlay\0".encode_utf16().collect();
            let wc = WNDCLASSW {
                style: 0,
                lpfnWndProc: Some(overlay_proc),
                cbClsExtra: 0,
                cbWndExtra: 0,
                hInstance: GetModuleHandleW(std::ptr::null()),
                hIcon: std::ptr::null_mut(),
                hCursor: std::ptr::null_mut(),
                hbrBackground: std::ptr::null_mut(),
                lpszMenuName: std::ptr::null(),
                lpszClassName: class.as_ptr(),
            };
            RegisterClassW(&wc);
            // The style pair from Windows Terminal's drag bar:
            // NOREDIRECTIONBITMAP = no drawing surface (the HTML button
            // stays visible underneath), LAYERED + alpha 255 = the
            // window exists for hit-testing. Layered child windows
            // require the manifest with Win8+ compatibility (build.rs).
            let overlay = CreateWindowExW(
                WS_EX_LAYERED | WS_EX_NOREDIRECTIONBITMAP,
                class.as_ptr(),
                std::ptr::null(),
                WS_CHILD | WS_VISIBLE,
                0,
                0,
                0,
                0,
                root,
                std::ptr::null_mut(),
                GetModuleHandleW(std::ptr::null()),
                std::ptr::null(),
            );
            if overlay.is_null() {
                return;
            }
            SetLayeredWindowAttributes(overlay, 0, 255, LWA_ALPHA);
            OVERLAY.store(overlay as isize, Ordering::Relaxed);
            position(root, overlay);
        }

        // follows resizes and DPI changes
        let win = window.clone();
        window.on_window_event(move |e| {
            if matches!(
                e,
                tauri::WindowEvent::Resized(_) | tauri::WindowEvent::ScaleFactorChanged { .. }
            ) {
                reposition(&win);
            }
        });

        // the webview is created later and might cover the overlay: for a
        // few seconds we keep bringing it back to the top of the child stack
        let handle = app.clone();
        std::thread::spawn(move || {
            for _ in 0..25 {
                let ui = handle.clone();
                let _ = handle.run_on_main_thread(move || {
                    if let Some(w) = ui_window(&ui) {
                        reposition(&w);
                    }
                });
                std::thread::sleep(std::time::Duration::from_millis(200));
            }
        });
    }

    fn ui_window(app: &tauri::AppHandle) -> Option<tauri::WebviewWindow> {
        use tauri::Manager;
        app.get_webview_window("main")
    }
}

// ── Startup ───────────────────────────────────────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let cli: Vec<String> = std::env::args().collect();
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            // Second instance ("Open with filo" on another file): forward
            // the paths to the existing window and bring it to the front.
            let files = files_from_args(&argv);
            if let Some(win) = app.get_webview_window("main") {
                // set_focus alone is not enough: it is ignored if the window
                // is hidden or minimized, so restore it first.
                let _ = win.show();
                let _ = win.unminimize();
                let _ = win.set_focus();
                let _ = win.emit("open-files", files);
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .manage(CliFiles(Mutex::new(files_from_args(&cli))))
        .setup(|app| {
            #[cfg(windows)]
            if let Some(win) = app.get_webview_window("main") {
                snap::install(app.handle(), &win);
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            read_file,
            write_file,
            file_mtime,
            meta_save,
            meta_load,
            meta_delete,
            read_sidecar,
            delete_sidecar,
            load_config,
            save_config,
            list_dir,
            search_dir,
            get_cli_files
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

// ── Tests ─────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn utf8_roundtrip() {
        let (text, enc, bom) = decode_bytes("ciào è €".as_bytes().to_vec());
        assert_eq!(text, "ciào è €");
        assert_eq!(enc, "utf-8");
        assert!(!bom);
    }

    #[test]
    fn utf8_bom_detected() {
        let mut raw = vec![0xEF, 0xBB, 0xBF];
        raw.extend_from_slice("test".as_bytes());
        let (text, enc, bom) = decode_bytes(raw);
        assert_eq!(text, "test");
        assert_eq!(enc, "utf-8");
        assert!(bom);
    }

    #[test]
    fn cp1252_detected_and_decoded() {
        // "città€" in Windows-1252: E0 = à, 80 = €
        let raw = vec![b'c', b'i', b't', b't', 0xE0, 0x80];
        let (text, enc, _) = decode_bytes(raw);
        assert_eq!(text, "città€");
        assert_eq!(enc, "windows-1252");
    }

    #[test]
    fn cp1252_roundtrip() {
        let original = "perché città € “virgolette” – trattino";
        let encoded = cp1252_encode(original);
        assert_eq!(cp1252_decode(&encoded), original);
    }

    #[test]
    fn cp1252_unmappable_becomes_question_mark() {
        assert_eq!(cp1252_encode("日本"), vec![b'?', b'?']);
    }
}
