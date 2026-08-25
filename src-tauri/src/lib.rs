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

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

struct PendingIpcMessage {
    total_chunks: usize,
    chunks: HashMap<usize, String>,
    created_at: Instant,
}

#[derive(Clone, Default)]
pub struct IpcChunkAssembler {
    messages: Arc<Mutex<HashMap<String, PendingIpcMessage>>>,
}

impl IpcChunkAssembler {
    pub fn new() -> Self {
        Self {
            messages: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub fn process_chunk(
        &self,
        webview_label: &str,
        msg_id: &str,
        index: usize,
        total: usize,
        data: String,
    ) -> Result<Option<(String, usize, Duration)>, String> {
        const MAX_TOTAL_CHUNKS: usize = 2000;
        const MAX_MESSAGE_ID_LEN: usize = 128;
        const MESSAGE_EXPIRATION: Duration = Duration::from_secs(30);
        const MAX_PENDING_MESSAGES: usize = 100;

        if msg_id.is_empty() || msg_id.len() > MAX_MESSAGE_ID_LEN {
            return Err("Invalid message ID length".to_string());
        }
        if total == 0 || total > MAX_TOTAL_CHUNKS {
            return Err(format!("Total chunks {} exceeds limit (1..{})", total, MAX_TOTAL_CHUNKS));
        }
        if index >= total {
            return Err(format!("Chunk index {} out of bounds for total {}", index, total));
        }

        let key = format!("{}::{}", webview_label, msg_id);
        let mut map = self.messages.lock().unwrap();

        let now = Instant::now();
        map.retain(|_, msg| now.duration_since(msg.created_at) < MESSAGE_EXPIRATION);

        if map.len() >= MAX_PENDING_MESSAGES && !map.contains_key(&key) {
            return Err("Too many pending IPC messages".to_string());
        }

        let entry = map.entry(key.clone()).or_insert_with(|| PendingIpcMessage {
            total_chunks: total,
            chunks: HashMap::with_capacity(total),
            created_at: now,
        });

        if entry.total_chunks != total {
            return Err("Mismatch in total_chunks for message ID".to_string());
        }

        entry.chunks.insert(index, data);

        if entry.chunks.len() == entry.total_chunks {
            let duration = now.duration_since(entry.created_at);
            let mut assembled = String::new();
            for i in 0..entry.total_chunks {
                if let Some(part) = entry.chunks.get(&i) {
                    assembled.push_str(part);
                } else {
                    return Err(format!("Missing chunk index {}", i));
                }
            }
            map.remove(&key);
            Ok(Some((assembled, total, duration)))
        } else {
            Ok(None)
        }
    }
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

    // Use shared persistent user profile directory so logins, cookies, localStorage, and sessions persist across tabs and restarts
    let mut data_dir = app_handle.path().app_data_dir()
        .map_err(|e| e.to_string())?;
    data_dir.push("aria_profile");

    let parsed_url = url.parse::<tauri::Url>()
        .map_err(|e| format!("Invalid URL: {}", e))?;

    let app_handle_clone = app_handle.clone();
    let webview_label_clone = webview_label.clone();
    let app_handle_page_load = app_handle.clone();
    let webview_label_page_load = webview_label.clone();
    let chunk_assembler = IpcChunkAssembler::new();

    let webview_builder = WebviewBuilder::new(
        &webview_label,
        WebviewUrl::External(parsed_url)
    )
    .data_directory(data_dir)
    .on_navigation(move |url| {
        let is_ipc = url.scheme() == "tauri-ipc-bridge" || 
            ((url.scheme() == "https" || url.scheme() == "http") && url.host_str() == Some("tauri-ipc-bridge"));
        if is_ipc {
            let path = url.path();
            let mut is_chunk = path == "/chunk";
            let mut msg_id = String::new();
            let mut index = 0usize;
            let mut total = 1usize;
            let mut data = String::new();
            let mut single_payload: Option<String> = None;

            for (key, val) in url.query_pairs() {
                match key.as_ref() {
                    "id" => { msg_id = val.into_owned(); is_chunk = true; }
                    "index" => { index = val.parse().unwrap_or(0); is_chunk = true; }
                    "total" => { total = val.parse().unwrap_or(1); is_chunk = true; }
                    "data" => { data = val.into_owned(); is_chunk = true; }
                    "payload" => { single_payload = Some(val.into_owned()); }
                    _ => {}
                }
            }

            if is_chunk && !msg_id.is_empty() {
                println!("[TAURI-IPC-RECEIVE] messageId={}", msg_id);
                println!("[TAURI-IPC-CHUNK] messageId={} index={} total={}", msg_id, index, total);
                match chunk_assembler.process_chunk(&webview_label_clone, &msg_id, index, total, data) {
                    Ok(Some((full_payload, chunk_count, duration))) => {
                        println!(
                            "[TAURI-IPC-ASSEMBLED] messageId={} bytes={} chunks={} duration={:?}",
                            msg_id,
                            full_payload.len(),
                            chunk_count,
                            duration
                        );
                        let event_name = format!("page-content-{}", webview_label_clone);
                        println!("[TAURI-EVENT-EMIT] event={}", event_name);
                        let _ = app_handle_clone.emit(&event_name, full_payload.clone());
                        let _ = app_handle_clone.emit(
                            "tab-metadata-update",
                            serde_json::json!({
                                "webview_label": webview_label_clone,
                                "payload": full_payload
                            })
                        );
                    }
                    Ok(None) => {}
                    Err(e) => {
                        println!("[TAURI-IPC-ERROR] Error assembling chunk id={}: {}", msg_id, e);
                    }
                }
                return false;
            }

            if let Some(payload_val) = single_payload {
                println!("[TAURI-IPC-RECEIVE] singlePayload bytes={}", payload_val.len());
                let event_name = format!("page-content-{}", webview_label_clone);
                println!("[TAURI-EVENT-EMIT] event={}", event_name);
                let _ = app_handle_clone.emit(&event_name, payload_val.clone());
                let _ = app_handle_clone.emit(
                    "tab-metadata-update",
                    serde_json::json!({
                        "webview_label": webview_label_clone,
                        "payload": payload_val
                    })
                );
                return false;
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
        let event_type = match payload.event() {
            tauri::webview::PageLoadEvent::Started => "page_start_load",
            tauri::webview::PageLoadEvent::Finished => "page_load",
        };
        let load_payload = serde_json::json!({
            "type": event_type,
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

        let is_hidden = x < -5000.0 || y < -5000.0 || width <= 0.0 || height <= 0.0;

        let physical_x = (x * scale_factor) as i32;
        let physical_y = (y * scale_factor) as i32;
        let physical_width = (width * scale_factor) as u32;
        let physical_height = (height * scale_factor) as u32;

        if is_hidden {
            let _ = webview.hide();
        } else {
            let _ = webview.show();
        }

        let _ = webview.set_position(tauri::Position::Physical(PhysicalPosition::new(physical_x, physical_y)));
        let _ = webview.set_size(tauri::Size::Physical(PhysicalSize::new(physical_width, physical_height)));
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
fn eval_tab_webview(
    app_handle: tauri::AppHandle,
    webview_label: String,
    js: String,
) -> Result<(), String> {
    let js_preview: String = js.chars().take(80).collect();
    println!("[TAURI EVAL] Injecting JS into '{}': {}...", webview_label, js_preview.replace('\n', " "));
    if let Some(webview) = app_handle.get_webview(&webview_label) {
        webview.eval(&js).map_err(|e| {
            println!("[TAURI EVAL] ERROR injecting into '{}': {}", webview_label, e);
            e.to_string()
        })?;
        println!("[TAURI EVAL] SUCCESS injection into '{}'", webview_label);
    } else {
        println!("[TAURI EVAL] WEBVIEW_NOT_FOUND '{}'", webview_label);
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
        let js = r#"
            (function() {
                try {
                    var rawStr = (document.body && document.body.innerText) || '';
                    var CHUNK_SIZE = 600;
                    var total = Math.ceil(rawStr.length / CHUNK_SIZE) || 1;
                    var msgId = 'msg_' + Math.random().toString(36).substring(2, 9) + '_' + Date.now().toString(36);

                    if (total === 1 && rawStr.length < 1500) {
                        location.href = 'https://tauri-ipc-bridge/data?payload=' + encodeURIComponent(rawStr);
                        return;
                    }

                    for (var i = 0; i < total; i++) {
                        (function(idx) {
                            setTimeout(function() {
                                var slice = rawStr.substring(idx * CHUNK_SIZE, (idx + 1) * CHUNK_SIZE);
                                var chunkUrl = 'https://tauri-ipc-bridge/chunk?id=' + encodeURIComponent(msgId) +
                                               '&index=' + idx +
                                               '&total=' + total +
                                               '&data=' + encodeURIComponent(slice);
                                location.href = chunkUrl;
                            }, idx * 25);
                        })(i);
                    }
                } catch (e) {
                    console.error(e);
                }
            })();
        "#;
        webview.eval(js).map_err(|e| e.to_string())?;
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

#[tauri::command]
fn reset_media_permissions(app_handle: tauri::AppHandle) -> Result<(), String> {
    if let Ok(data_dir) = app_handle.path().app_data_dir() {
        let profile_dir = data_dir.join("aria_profile");
        if profile_dir.exists() {
            let _ = std::fs::remove_dir_all(&profile_dir);
        }
        let sessions_dir = data_dir.join("aria_sessions");
        if sessions_dir.exists() {
            let _ = std::fs::remove_dir_all(&sessions_dir);
        }
    }
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
        .register_uri_scheme_protocol("aria-ipc", move |ctx, request| {
            let webview_label = ctx.webview_label().to_string();
            let app_handle = ctx.app_handle().clone();
            let body_bytes = request.body();
            if let Ok(payload_str) = String::from_utf8(body_bytes.to_vec()) {
                if !payload_str.is_empty() {
                    let preview: String = payload_str.chars().take(80).collect();
                    println!("[TAURI-CUSTOM-PROTOCOL] Received for {}: {}...", webview_label, preview);
                    let event_name = format!("page-content-{}", webview_label);
                    println!("[TAURI-EVENT-EMIT] event={}", event_name);
                    let _ = app_handle.emit(&event_name, payload_str.clone());
                    let _ = app_handle.emit(
                        "tab-metadata-update",
                        serde_json::json!({
                            "webview_label": webview_label,
                            "payload": payload_str
                        })
                    );
                }
            }
            tauri::http::Response::builder()
                .status(200)
                .header("Access-Control-Allow-Origin", "*")
                .header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
                .header("Access-Control-Allow-Headers", "*")
                .body(b"OK".to_vec())
                .unwrap()
        })
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
            log_from_frontend,
            reset_media_permissions
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_single_chunk_assembly() {
        let assembler = IpcChunkAssembler::new();
        let res = assembler.process_chunk("tab-1", "msg1", 0, 1, "hello world".to_string()).unwrap();
        assert!(res.is_some());
        let (payload, total, _) = res.unwrap();
        assert_eq!(total, 1);
        assert_eq!(payload, "hello world");
    }

    #[test]
    fn test_multi_chunk_in_order_assembly() {
        let assembler = IpcChunkAssembler::new();
        let r0 = assembler.process_chunk("tab-1", "msg2", 0, 3, "part0-".to_string()).unwrap();
        assert!(r0.is_none());
        let r1 = assembler.process_chunk("tab-1", "msg2", 1, 3, "part1-".to_string()).unwrap();
        assert!(r1.is_none());
        let r2 = assembler.process_chunk("tab-1", "msg2", 2, 3, "part2".to_string()).unwrap();
        assert!(r2.is_some());
        let (payload, total, _) = r2.unwrap();
        assert_eq!(total, 3);
        assert_eq!(payload, "part0-part1-part2");
    }

    #[test]
    fn test_multi_chunk_out_of_order_assembly() {
        let assembler = IpcChunkAssembler::new();
        // Arrive in reverse order: 2, 0, 1
        assert!(assembler.process_chunk("tab-1", "msg3", 2, 3, "[C]".to_string()).unwrap().is_none());
        assert!(assembler.process_chunk("tab-1", "msg3", 0, 3, "[A]".to_string()).unwrap().is_none());
        let r = assembler.process_chunk("tab-1", "msg3", 1, 3, "[B]".to_string()).unwrap();
        assert!(r.is_some());
        let (payload, _, _) = r.unwrap();
        assert_eq!(payload, "[A][B][C]");
    }

    #[test]
    fn test_duplicate_chunks_safe() {
        let assembler = IpcChunkAssembler::new();
        assert!(assembler.process_chunk("tab-1", "msg4", 0, 2, "hello ".to_string()).unwrap().is_none());
        // Duplicate chunk 0
        assert!(assembler.process_chunk("tab-1", "msg4", 0, 2, "hello ".to_string()).unwrap().is_none());
        let r = assembler.process_chunk("tab-1", "msg4", 1, 2, "world".to_string()).unwrap();
        assert!(r.is_some());
        assert_eq!(r.unwrap().0, "hello world");
    }

    #[test]
    fn test_large_50kb_payload_chunks() {
        let assembler = IpcChunkAssembler::new();
        let full_text = "A".repeat(50_000);
        let chunk_size = 600;
        let total = (full_text.len() + chunk_size - 1) / chunk_size;

        for i in 0..total {
            let start = i * chunk_size;
            let end = std::cmp::min(start + chunk_size, full_text.len());
            let slice = &full_text[start..end];
            let res = assembler.process_chunk("tab-1", "large_msg", i, total, slice.to_string()).unwrap();
            if i < total - 1 {
                assert!(res.is_none());
            } else {
                assert!(res.is_some());
                let (assembled, count, _) = res.unwrap();
                assert_eq!(count, total);
                assert_eq!(assembled.len(), 50_000);
                assert_eq!(assembled, full_text);
            }
        }
    }

    #[test]
    fn test_validation_errors() {
        let assembler = IpcChunkAssembler::new();
        // Index >= total
        assert!(assembler.process_chunk("tab-1", "err1", 5, 3, "data".to_string()).is_err());
        // Total == 0
        assert!(assembler.process_chunk("tab-1", "err2", 0, 0, "data".to_string()).is_err());
        // Empty message ID
        assert!(assembler.process_chunk("tab-1", "", 0, 1, "data".to_string()).is_err());
    }
}
