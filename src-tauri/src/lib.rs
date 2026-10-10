use tauri::Emitter;

/// Called by the frontend once the autosave has been written (or timed
/// out) after a `close-requested` event. Desktop only: iPadOS suspends
/// the app instead of quitting it.
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
                let _ = window.emit("close-requested", ());
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running Voltopia");
}
