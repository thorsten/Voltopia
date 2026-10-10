use tauri::Emitter;
use tauri::Manager;

/// Grace period before Rust quits on its own; longer than the frontend's
/// 2 s snapshot timeout plus a slow IndexedDB write.
const QUIT_FALLBACK_SECS: u64 = 5;

/// Last resort: if the frontend never answers `close-requested` (boot
/// screen, reload, crashed React tree), quit anyway after a grace period.
fn exit_after_grace(app: tauri::AppHandle) {
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_secs(QUIT_FALLBACK_SECS));
        app.exit(0);
    });
}

/// Called by the frontend once the autosave has been written (or timed
/// out) after a `close-requested` event. Desktop only: iPadOS suspends
/// the app instead of quitting it. `exit_after_grace` covers a frontend
/// that never calls this.
#[tauri::command]
fn close_app(app: tauri::AppHandle) {
    app.exit(0);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .invoke_handler(tauri::generate_handler![close_app])
        .on_window_event(|window, event| {
            // Hold the window open until the frontend has autosaved; it
            // answers with `close_app`. A frontend timeout guarantees the
            // app never becomes unquittable.
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                exit_after_grace(window.app_handle().clone());
                let _ = window.emit("close-requested", ());
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building Voltopia")
        .run(|app, event| {
            // Cmd+Q (and the Quit menu item) arrive here with `code: None`.
            // Hold the exit until the frontend has autosaved; it answers
            // with `close_app`, whose `exit(0)` carries `Some(0)` and passes.
            if let tauri::RunEvent::ExitRequested { api, code, .. } = &event {
                if code.is_none() {
                    api.prevent_exit();
                    exit_after_grace(app.clone());
                    if let Some(window) = app.get_webview_window("main") {
                        let _ = window.emit("close-requested", ());
                    }
                }
            }
        });
}
