use tauri::{PhysicalPosition, PhysicalSize, WebviewBuilder, WebviewUrl, Manager, Emitter};
use keyring::Entry;
use tauri_plugin_sql::{Migration, MigrationKind};

fn get_migrations() -> Vec<Migration> {
    vec![
        Migration {
            version: 1,
            description: "create_initial_tables",
            sql: "
                CREATE TABLE IF NOT EXISTS tabs (
                    id TEXT PRIMARY KEY,
                    url TEXT NOT NULL,
                    title TEXT NOT NULL,
                    favicon TEXT,
                    position INTEGER NOT NULL,
                    pinned INTEGER NOT NULL DEFAULT 0,
                    last_active INTEGER NOT NULL
                );
                CREATE TABLE IF NOT EXISTS history (
                    id TEXT PRIMARY KEY,
                    url TEXT NOT NULL,
                    title TEXT NOT NULL,
                    visited_at INTEGER NOT NULL,
                    visit_count INTEGER NOT NULL DEFAULT 1
                );
                CREATE TABLE IF NOT EXISTS bookmark_folders (
                    id TEXT PRIMARY KEY,
                    name TEXT NOT NULL,
                    parent_id TEXT,
                    created_at INTEGER NOT NULL
                );
                CREATE TABLE IF NOT EXISTS bookmarks (
                    id TEXT PRIMARY KEY,
                    url TEXT NOT NULL,
                    title TEXT NOT NULL,
                    favicon TEXT,
                    folder_id TEXT,
                    created_at INTEGER NOT NULL,
                    FOREIGN KEY(folder_id) REFERENCES bookmark_folders(id) ON DELETE SET NULL
                );
                CREATE TABLE IF NOT EXISTS ai_chats (
                    id TEXT PRIMARY KEY,
                    tab_id TEXT NOT NULL,
                    role TEXT NOT NULL,
                    content TEXT NOT NULL,
                    provider TEXT NOT NULL,
                    model TEXT NOT NULL,
                    created_at INTEGER NOT NULL
                );
                CREATE TABLE IF NOT EXISTS reading_list (
                    id TEXT PRIMARY KEY,
                    url TEXT NOT NULL,
                    title TEXT NOT NULL,
                    excerpt TEXT,
                    saved_at INTEGER NOT NULL,
                    read INTEGER NOT NULL DEFAULT 0
                );
            ",
            kind: MigrationKind::Up,
        }
    ]
}

// Custom commands for managing dynamic child webviews (tabs)
#[tauri::command]
async fn create_tab_webview(
    app_handle: tauri::AppHandle,
    window_label: String,
    webview_label: String,
    url: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    let window = app_handle.get_window(&window_label)
        .ok_or_else(|| "Window not found".to_string())?;

    // Create unique data directory path for session isolation
    let mut data_dir = app_handle.path().app_data_dir()
        .map_err(|e| e.to_string())?;
    data_dir.push("aria_sessions");
    data_dir.push(&webview_label);

    let parsed_url = url.parse::<tauri::Url>()
        .map_err(|e| format!("Invalid URL: {}", e))?;

    let app_handle_clone = app_handle.clone();
    let webview_label_clone = webview_label.clone();
    let app_handle_page_load = app_handle.clone();
    let webview_label_page_load = webview_label.clone();

    let webview_builder = WebviewBuilder::new(
        &webview_label,
        WebviewUrl::External(parsed_url)
    )
    .data_directory(data_dir)
    .on_navigation(move |url| {
        let is_ipc = url.scheme() == "tauri-ipc-bridge" || 
            ((url.scheme() == "https" || url.scheme() == "http") && url.host_str() == Some("tauri-ipc-bridge"));
        if is_ipc {
            for (key, val) in url.query_pairs() {
                if key == "payload" {
                    let payload_val = val.into_owned();
                    let event_name = format!("page-content-{}", webview_label_clone);
                    let _ = app_handle_clone.emit(
                        &event_name,
                        payload_val.clone()
                    );
                    let _ = app_handle_clone.emit(
                        "tab-metadata-update",
                        serde_json::json!({
                            "webview_label": webview_label_clone,
                            "payload": payload_val
                        })
                    );
                }
            }
            return false;
        }

        // Real navigation starts! Notify the frontend so the spinners start rotating.
        let start_payload = serde_json::json!({
            "type": "page_start_load",
            "url": url.to_string()
        });
        let _ = app_handle_clone.emit(
            "tab-metadata-update",
            serde_json::json!({
                "webview_label": webview_label_clone,
                "payload": start_payload.to_string()
            })
        );
        true
    })
    .on_page_load(move |_webview, payload| {
        let url_str = payload.url().to_string();
        let load_payload = serde_json::json!({
            "type": "page_load",
            "url": url_str,
            "title": url_str.clone(),
        });
        let _ = app_handle_page_load.emit(
            "tab-metadata-update",
            serde_json::json!({
                "webview_label": webview_label_page_load,
                "payload": load_payload.to_string()
            })
        );
    });

    let scale_factor = window.scale_factor().map_err(|e| e.to_string())?;
    let physical_x = (x * scale_factor) as i32;
    let physical_y = (y * scale_factor) as i32;
    let physical_width = (width * scale_factor) as u32;
    let physical_height = (height * scale_factor) as u32;

    window.add_child(
        webview_builder,
        tauri::Position::Physical(PhysicalPosition::new(physical_x, physical_y)),
        tauri::Size::Physical(PhysicalSize::new(physical_width, physical_height))
    ).map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
async fn resize_tab_webview(
    app_handle: tauri::AppHandle,
    webview_label: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    if let Some(webview) = app_handle.get_webview(&webview_label) {
        let window = app_handle.get_window("main")
            .ok_or_else(|| "Main window not found".to_string())?;
        let scale_factor = window.scale_factor().map_err(|e| e.to_string())?;

        let physical_x = (x * scale_factor) as i32;
        let physical_y = (y * scale_factor) as i32;
        let physical_width = (width * scale_factor) as u32;
        let physical_height = (height * scale_factor) as u32;

        webview.set_position(tauri::Position::Physical(PhysicalPosition::new(physical_x, physical_y)))
            .map_err(|e| e.to_string())?;
        webview.set_size(tauri::Size::Physical(PhysicalSize::new(physical_width, physical_height)))
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
async fn destroy_tab_webview(
    app_handle: tauri::AppHandle,
    webview_label: String,
) -> Result<(), String> {
    if let Some(webview) = app_handle.get_webview(&webview_label) {
        webview.close().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
async fn navigate_tab_webview(
    app_handle: tauri::AppHandle,
    webview_label: String,
    url: String,
) -> Result<(), String> {
    if let Some(webview) = app_handle.get_webview(&webview_label) {
        let parsed_url = url.parse::<tauri::Url>()
            .map_err(|e| format!("Invalid URL: {}", e))?;
        webview.navigate(parsed_url).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
async fn eval_tab_webview(
    app_handle: tauri::AppHandle,
    webview_label: String,
    js: String,
) -> Result<(), String> {
    if let Some(webview) = app_handle.get_webview(&webview_label) {
        webview.eval(&js).map_err(|e| {
            e.to_string()
        })?;
    } else {
        return Err(format!("Webview '{}' not found", webview_label));
    }
    Ok(())
}

// Page text extraction bridge commands
#[tauri::command]
fn send_page_content(app_handle: tauri::AppHandle, webview_label: String, text: String) {
    let _ = app_handle.emit(&format!("page-content-{}", webview_label), text);
}

#[tauri::command]
fn log_from_frontend(level: String, message: String) {
    println!("[FRONTEND {}] {}", level.to_uppercase(), message);
}

#[tauri::command]
async fn extract_page_text(app_handle: tauri::AppHandle, webview_label: String) -> Result<(), String> {
    if let Some(webview) = app_handle.get_webview(&webview_label) {
        let js = format!(
            "try {{
                const text = document.body.innerText || '';
                window.location.href = 'https://tauri-ipc-bridge/data?payload=' + encodeURIComponent(text);
             }} catch (e) {{
                console.error(e);
             }}"
        );
        webview.eval(&js).map_err(|e| e.to_string())?;
    }
    Ok(())
}

// Keychain secure credential storage commands
#[tauri::command]
fn save_credential(service: String, username: String, secret: String) -> Result<(), String> {
    let entry = Entry::new(&service, &username).map_err(|e| e.to_string())?;
    entry.set_password(&secret).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn get_credential(service: String, username: String) -> Result<String, String> {
    let entry = Entry::new(&service, &username).map_err(|e| e.to_string())?;
    entry.get_password().map_err(|e| e.to_string())
}

#[tauri::command]
fn delete_credential(service: String, username: String) -> Result<(), String> {
    let entry = Entry::new(&service, &username).map_err(|e| e.to_string())?;
    entry.delete_password().map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_http::init())
        .plugin(
            tauri_plugin_sql::Builder::default()
                .add_migrations("sqlite:aria.db", get_migrations())
                .build()
        )
        .invoke_handler(tauri::generate_handler![
            create_tab_webview,
            resize_tab_webview,
            destroy_tab_webview,
            navigate_tab_webview,
            eval_tab_webview,
            extract_page_text,
            send_page_content,
            save_credential,
            get_credential,
            delete_credential,
            log_from_frontend
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
