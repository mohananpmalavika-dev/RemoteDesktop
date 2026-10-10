// Prevents additional console window on Windows in release
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use krypton_remote_core::{
    process_incoming_remote_control, CaptureSession, ClipboardDispatcher,
    ClipboardPayload, DisplayBounds, DisplayInfo, FileChunk, FileTransferAck,
    FileTransferManager, InputDispatcher, KeyAction, MouseAction, RemoteEngine,
    SpecialCombo, TransferMetadata, TransferState, TransferStatusInfo,
};
use krypton_transport::{
    IceServerConfig, RemoteClipboardMessage, RemoteControlMessage, SessionPermissionGate,
    SessionState, TransportTelemetry,
};
use krypton_platform_windows::{
    get_windows_system_info, is_process_elevated, ServiceAction, SystemTrayManager, TrayState,
    WindowsServiceManager, WindowsSystemInfo,
};
use std::path::PathBuf;
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};
use base64::Engine;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, Manager, State};
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct EnrolledIdentity {
    device_id: String,
    remote_id: String,
    public_key_base64: String,
    api_url: String,
}

fn identity_directory(app: &AppHandle) -> Result<PathBuf, String> {
    app.path().app_local_data_dir().map_err(|e| e.to_string())
}

fn prepare_identity(app: &AppHandle, engine: &mut RemoteEngine) -> Result<String, String> {
    #[cfg(windows)]
    { engine.initialize_persisted_identity(&identity_directory(app)?.join("device-key.dpapi")) }
    #[cfg(not(windows))]
    { let _ = app; engine.initialize_identity() }
}

// ─────────────────────────────────────────────────────────────────────────────
// Desktop Modes & Application State
// ─────────────────────────────────────────────────────────────────────────────

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum DesktopMode {
    Idle,
    HostAgent,
    Viewer,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct ActiveSessionInfo {
    pub session_id: String,
    pub target_id: String,
    pub mode: DesktopMode,
    pub state: String,
    pub route: String,
}

struct AppState {
    engine: Mutex<RemoteEngine>,
    capture: Mutex<Option<CaptureSession>>,
    capture_generation: AtomicU64,
    input_dispatcher: Mutex<InputDispatcher>,
    clipboard_dispatcher: Mutex<ClipboardDispatcher>,
    file_transfer_manager: Mutex<FileTransferManager>,
    tray_manager: Mutex<SystemTrayManager>,
    service_manager: Mutex<WindowsServiceManager>,
    active_session: Mutex<Option<ActiveSessionInfo>>,
    permission_gate: Mutex<SessionPermissionGate>,
}

// ─────────────────────────────────────────────────────────────────────────────
// IPC Frame Event Payload
// ─────────────────────────────────────────────────────────────────────────────

/// Payload emitted as a Tauri event for each encoded video frame.
/// JS receives this via `listen('krypton://frame/<sessionId>', ...)`.
#[derive(Clone, Serialize)]
struct FrameEventPayload {
    /// Raw encoded H.264 Annex-B bytes
    data: Vec<u8>,
    is_keyframe: bool,
    pts_ns: u64,
    width: u32,
    height: u32,
}

// ─────────────────────────────────────────────────────────────────────────────
// Tauri Commands — Engine
// ─────────────────────────────────────────────────────────────────────────────

#[tauri::command]
fn get_engine_state(state: State<AppState>) -> Result<String, String> {
    let engine = state.engine.lock().map_err(|e| e.to_string())?;
    Ok(format!("{:?}", engine.state()))
}

#[tauri::command]
fn initialize_identity(app: AppHandle, state: State<AppState>) -> Result<Option<String>, String> {
    let mut engine = state.engine.lock().map_err(|e| e.to_string())?;
    let public_key = prepare_identity(&app, &mut engine)?;
    let path = identity_directory(&app)?.join("enrolled-device.json");
    match std::fs::read(path) {
        Ok(bytes) => {
            let saved: EnrolledIdentity = serde_json::from_slice(&bytes)
                .map_err(|_| "Saved device registration is invalid.".to_string())?;
            if saved.public_key_base64 != public_key {
                return Err("Saved registration does not match this device identity.".into());
            }
            let remote_id = krypton_remote_core::format_remote_id(&saved.remote_id)?;
            engine.set_enrolled_identity(saved.device_id, remote_id);
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(_) => return Err("Could not read saved device registration.".into()),
    }
    engine.shareable_remote_id()
}

const DEFAULT_API_URL: &str = match option_env!("KRYPTON_API_URL") { Some(url) => url, None => "" };

#[tauri::command]
fn get_device_registration(app: AppHandle) -> Result<Option<EnrolledIdentity>, String> {
    let path = identity_directory(&app)?.join("enrolled-device.json");
    match std::fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes).map(Some).map_err(|_| "Invalid saved device registration".into()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}

#[tauri::command]
fn sign_device_challenge(state: State<AppState>, nonce: String) -> Result<String, String> {
    if nonce.len() != 64 || !nonce.bytes().all(|b| b.is_ascii_hexdigit()) { return Err("Invalid authentication challenge".into()); }
    let signature = state.engine.lock().map_err(|e| e.to_string())?.sign_device_payload(nonce.as_bytes())?;
    Ok(base64::engine::general_purpose::STANDARD.encode(signature))
}

static REQUEST_COUNTER: AtomicU64 = AtomicU64::new(0);

#[tauri::command]
async fn device_api_request(app: AppHandle, state: State<'_, AppState>, path: String, body: serde_json::Value) -> Result<serde_json::Value, String> {
    let registration = get_device_registration(app)?.ok_or("Device enrollment is required")?;
    let allowed_device = path == format!("/devices/{}/heartbeat", registration.device_id) || path == format!("/devices/{}/runtime-config", registration.device_id);
    let parts: Vec<&str> = path.split('/').collect();
    let allowed_session = parts.len() == 4 && parts[1] == "sessions" && parts[2].len() == 36 &&
        parts[2].bytes().all(|b| b.is_ascii_hexdigit() || b == b'-') && ["accept", "reject", "host-state"].contains(&parts[3]);
    if !allowed_device && !allowed_session { return Err("Unsupported device API route".into()); }
    let mut url = reqwest::Url::parse(&registration.api_url).map_err(|_| "Invalid configured API URL")?;
    if !cfg!(debug_assertions) && url.scheme() != "https" { return Err("Production device requests require HTTPS".into()); }
    let full_path = format!("{}{}", url.path().trim_end_matches('/'), path);
    url.set_path(&full_path);
    let raw = serde_json::to_vec(&body).map_err(|e| e.to_string())?;
    let timestamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_err(|e| e.to_string())?.as_millis().to_string();
    let seed = format!("{timestamp}:{}", REQUEST_COUNTER.fetch_add(1, Ordering::SeqCst));
    let (nonce, signature) = {
        let engine = state.engine.lock().map_err(|e| e.to_string())?;
        let nonce = format!("{:x}", Sha256::digest(engine.sign_device_payload(seed.as_bytes())?))[..32].to_string();
        let payload = format!("POST\n{full_path}\n{timestamp}\n{nonce}\n{:x}", Sha256::digest(&raw));
        let signature = base64::engine::general_purpose::STANDARD.encode(engine.sign_device_payload(payload.as_bytes())?);
        (nonce, signature)
    };
    let response = reqwest::Client::builder().timeout(std::time::Duration::from_secs(15)).redirect(reqwest::redirect::Policy::none())
        .build().map_err(|e| e.to_string())?.post(url).header("Content-Type", "application/json")
        .header("x-device-id", registration.device_id).header("x-device-timestamp", timestamp)
        .header("x-device-nonce", nonce).header("x-device-signature", signature).body(raw).send().await.map_err(|e| e.to_string())?;
    let status = response.status();
    let result: serde_json::Value = response.json().await.map_err(|_| "Invalid server response")?;
    if !status.is_success() { return Err(result.get("message").and_then(|v| v.as_str()).unwrap_or("Device request rejected").to_string()); }
    Ok(result)
}

#[tauri::command]
fn get_device_heartbeat(state: State<AppState>) -> Result<serde_json::Value, String> {
    let telemetry = state.engine.lock().map_err(|e| e.to_string())?.create_heartbeat()?;
    let live = krypton_platform_windows::get_live_system_telemetry();
    Ok(serde_json::json!({ "agentVersion": telemetry.agent_version, "os": telemetry.os, "osVersion": telemetry.os_version,
        "architecture": telemetry.architecture, "sessionCount": if state.active_session.lock().map_err(|e| e.to_string())?.is_some() { 1 } else { 0 },
        "cpuPercent": live.cpu_load_pct, "memoryPercent": live.ram_usage_pct, "uptimeSeconds": telemetry.uptime_seconds }))
}

#[tauri::command]
async fn viewer_api_request(api_url: String, path: String, body: serde_json::Value, token: Option<String>) -> Result<serde_json::Value, String> {
    let parts: Vec<&str> = path.split('/').collect();
    if path != "/sessions/quick-connect" && !(parts.len() == 4 && parts[1] == "sessions" && parts[3] == "guest-end" &&
        parts[2].len() == 36 && parts[2].bytes().all(|b| b.is_ascii_hexdigit() || b == b'-')) { return Err("Unsupported viewer API route".into()); }
    let mut url = reqwest::Url::parse(&api_url).map_err(|_| "Invalid API URL")?;
    if !["https", "http"].contains(&url.scheme()) || !url.username().is_empty() || url.password().is_some() || url.query().is_some() || url.fragment().is_some() { return Err("Invalid API URL".into()); }
    if !cfg!(debug_assertions) && url.scheme() != "https" { return Err("Production viewer requires HTTPS".into()); }
    url.set_path(&format!("{}{}", url.path().trim_end_matches('/'), path));
    let client = reqwest::Client::builder().timeout(std::time::Duration::from_secs(30)).redirect(reqwest::redirect::Policy::none()).build().map_err(|e| e.to_string())?;
    let mut request = client.post(url).json(&body);
    if let Some(token) = token { request = request.bearer_auth(token); }
    let response = request.send().await.map_err(|e| e.to_string())?;
    let status = response.status();
    let result: serde_json::Value = response.json().await.map_err(|_| "Invalid API response")?;
    if !status.is_success() { return Err(result.get("message").and_then(|v| v.as_str()).unwrap_or("Viewer request rejected").into()); }
    Ok(result)
}

#[tauri::command]
async fn enroll_device(
    app: AppHandle,
    state: State<'_, AppState>,
    api_url: Option<String>,
    enrollment_token: Option<String>,
) -> Result<String, String> {
    let raw_url = api_url.as_deref().unwrap_or("").trim();
    let effective_url = if raw_url.is_empty() {
        DEFAULT_API_URL
    } else {
        raw_url
    };

    let mut url = reqwest::Url::parse(effective_url)
        .map_err(|_| "Enter a valid API URL (e.g. http://server:4000/api/v1).".to_string())?;

    if url.scheme() != "https" && url.scheme() != "http" {
        return Err("API URL must use http or https.".into());
    }
    if !url.username().is_empty() || url.password().is_some() || url.query().is_some() || url.fragment().is_some() {
        return Err("API URL must not contain credentials, a query, or a fragment.".into());
    }
    let base_path = url.path().trim_end_matches('/');
    let enrollment_path = if base_path.is_empty() {
        "/api/v1/devices/enroll".to_string()
    } else if base_path.ends_with("/devices/enroll") {
        base_path.to_string()
    } else {
        format!("{base_path}/devices/enroll")
    };
    url.set_path(&enrollment_path);
    let token = enrollment_token.as_deref().unwrap_or("").trim();
    if token.is_empty() { return Err("Enter the enrollment token issued by your workspace administrator.".into()); }
    if !cfg!(debug_assertions) && url.scheme() != "https" { return Err("Production enrollment requires HTTPS.".into()); }
    let request = {
        let mut engine = state.engine.lock().map_err(|e| e.to_string())?;
        if let Some(id) = engine.shareable_remote_id()? { return Ok(id); }
        prepare_identity(&app, &mut engine)?;
        let name = std::env::var("COMPUTERNAME").unwrap_or_else(|_| "Windows device".into());
        engine.create_enrollment_request(token, &name)?
    };
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .redirect(reqwest::redirect::Policy::none())
        .build().map_err(|_| "Could not initialize the registration client.".to_string())?;
    let response = client.post(url.clone()).json(&request).send().await
        .map_err(|_| "Could not reach the Krypton cloud server. Check network connection.".to_string())?;
    if !response.status().is_success() {
        return Err(match response.status().as_u16() {
            400 | 403 => "Registration rejected. Check that the enrollment token is valid, unused, and unexpired.".into(),
            404 => "Enrollment endpoint not found. Check the API URL.".into(),
            status => format!("Device registration failed (HTTP {status})."),
        });
    }
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct EnrollmentResponse { device_id: String, remote_id: String }
    let result: EnrollmentResponse = response.json().await
        .map_err(|_| "The API returned an invalid device registration response.".to_string())?;
    if result.device_id.trim().is_empty() { return Err("The API returned an empty device ID.".into()); }
    let remote_id = krypton_remote_core::format_remote_id(&result.remote_id)?;
    let base_url = url.as_str().trim_end_matches("/devices/enroll").to_string();
    let saved = EnrolledIdentity {
        device_id: result.device_id.clone(), remote_id: remote_id.clone(),
        public_key_base64: request.public_key_base64, api_url: base_url,
    };
    let directory = identity_directory(&app)?;
    let bytes = serde_json::to_vec(&saved).map_err(|e| e.to_string())?;
    let persist = (|| -> Result<(), std::io::Error> {
        std::fs::create_dir_all(&directory)?;
        let pending = directory.join("enrolled-device.json.pending");
        std::fs::write(&pending, bytes)?;
        std::fs::rename(pending, directory.join("enrolled-device.json"))
    })();
    state.engine.lock().map_err(|e| e.to_string())?
        .set_enrolled_identity(result.device_id, remote_id.clone());
    persist.map_err(|_| "Device registered, but could not save its ID. Keep this app open and check local storage permissions.".to_string())?;
    Ok(remote_id)
}

// ─────────────────────────────────────────────────────────────────────────────
// Tauri Commands — Screen Capture (Phase 4)
// ─────────────────────────────────────────────────────────────────────────────

#[tauri::command]
fn get_capture_displays(_state: State<AppState>) -> Result<Vec<DisplayInfo>, String> {
    #[cfg(windows)]
    {
        use krypton_remote_core::DxgiCapturer;
        use krypton_remote_core::FrameCapturer;
        let capturer = DxgiCapturer::new();
        capturer.enumerate_displays().map_err(|e| format!("{e}"))
    }
    #[cfg(not(windows))]
    Err("Display enumeration only supported on Windows".to_string())
}

#[tauri::command]
fn start_capture(
    app: AppHandle,
    state: State<AppState>,
    display_id: usize,
    fps: Option<u32>,
    bitrate_kbps: Option<u32>,
    session_id: String,
) -> Result<String, String> {
    let mut capture_guard = state.capture.lock().map_err(|e| e.to_string())?;
    let generation = state.capture_generation.fetch_add(1, Ordering::SeqCst) + 1;

    // Stop any existing session
    if let Some(mut old) = capture_guard.take() {
        old.stop();
    }

    let target_fps = fps.unwrap_or(30).clamp(5, 60);
    let target_bitrate = bitrate_kbps.unwrap_or(2000).clamp(200, 20000);

    let session = CaptureSession::start(display_id, target_fps, target_bitrate)
        .map_err(|e| format!("CaptureSession::start: {e}"))?;

    log::info!("[tauri] Capture started: display={display_id} fps={target_fps} bitrate={target_bitrate}kbps session={session_id}");

    // Spawn background thread that reads encoded packets from the session channel
    // and emits them as Tauri events to the frontend.
    let event_name = format!("krypton://frame/{session_id}");
    let app_clone = app.clone();
    // In a real production impl, CaptureSession would expose try_recv/recv methods.
    // Here we use the receiver directly in the thread.
    //
    // NOTE: Tauri command cannot hold the session AND give receiver to thread,
    // so we restructure: store session first, then spawn thread that polls
    // get_capture_status every frame interval.

    *capture_guard = Some(session);

    // Spawn a dedicated frame-forwarding thread
    let app_for_thread = app_clone.clone();
    let event_name_clone = event_name.clone();
    std::thread::Builder::new()
        .name("krypton-frame-emitter".into())
        .spawn(move || {
            log::info!("[frame-emitter] Starting for event={event_name_clone}");
            // We need to access the session receiver from AppState via the app handle
            // Use a loop that tries to get_state and read from receiver
            let state_ref: State<AppState> = app_for_thread.state();
            let frame_interval = std::time::Duration::from_micros(
                1_000_000 / target_fps as u64
            );
            let mut total_frames = 0usize;

            loop {
                if state_ref.capture_generation.load(Ordering::SeqCst) != generation { break; }
                std::thread::sleep(frame_interval / 2); // Poll at 2x frame rate

                // Try to read a frame from the capture session
                let pkt = {
                    let guard = match state_ref.capture.lock() {
                        Ok(g) => g,
                        Err(_) => break,
                    };
                    if state_ref.capture_generation.load(Ordering::SeqCst) != generation { break; }
                    match guard.as_ref() {
                        Some(session) => {
                            if !session.is_running() { break; }
                            session.receiver.try_recv().ok()
                        }
                        None => break, // Session stopped
                    }
                };

                if let Some(pkt) = pkt {
                    let payload = FrameEventPayload {
                        data: pkt.data,
                        is_keyframe: pkt.is_keyframe,
                        pts_ns: pkt.pts_ns,
                        width: pkt.width,
                        height: pkt.height,
                    };
                    if let Err(e) = app_for_thread.emit(&event_name_clone, &payload) {
                        log::warn!("[frame-emitter] emit error: {e}");
                    }
                    total_frames += 1;
                }
            }
            log::info!("[frame-emitter] Stopped after {total_frames} frames");
        })
        .map_err(|e| format!("Failed to spawn frame emitter: {e}"))?;

    Ok(format!("Capturing display {display_id} at {target_fps}fps / {target_bitrate}kbps"))
}

#[tauri::command]
fn stop_capture(state: State<AppState>) -> Result<(), String> {
    state.capture_generation.fetch_add(1, Ordering::SeqCst);
    let mut capture_guard = state.capture.lock().map_err(|e| e.to_string())?;
    if let Some(mut session) = capture_guard.take() {
        session.stop();
        log::info!("[tauri] Capture stopped");
    }
    Ok(())
}

#[tauri::command]
fn set_capture_bitrate(state: State<AppState>, bitrate_kbps: u32) -> Result<(), String> {
    let capture = state.capture.lock().map_err(|e| e.to_string())?;
    capture.as_ref().ok_or("No active capture")?.update_bitrate(bitrate_kbps)
}

#[tauri::command]
fn get_capture_status(state: State<AppState>) -> Result<serde_json::Value, String> {
    let capture_guard = state.capture.lock().map_err(|e| e.to_string())?;
    match &*capture_guard {
        Some(session) => Ok(serde_json::json!({
            "active": session.is_running(),
            "displayId": session.display_id(),
            "fps": session.target_fps(),
        })),
        None => Ok(serde_json::json!({ "active": false })),
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Tauri Commands — Remote Input Injection (Phase 5)
// ─────────────────────────────────────────────────────────────────────────────

#[tauri::command]
fn inject_mouse_input(
    state: State<AppState>,
    action: MouseAction,
    bounds: DisplayBounds,
) -> Result<(), String> {
    let mut dispatcher = state.input_dispatcher.lock().map_err(|e| e.to_string())?;
    dispatcher.dispatch_mouse(action, &bounds)
}

#[tauri::command]
fn inject_keyboard_input(
    state: State<AppState>,
    action: KeyAction,
) -> Result<(), String> {
    let mut dispatcher = state.input_dispatcher.lock().map_err(|e| e.to_string())?;
    dispatcher.dispatch_keyboard(action)
}

#[tauri::command]
fn send_special_combo(
    state: State<AppState>,
    combo: SpecialCombo,
) -> Result<(), String> {
    let mut dispatcher = state.input_dispatcher.lock().map_err(|e| e.to_string())?;
    dispatcher.dispatch_special_combo(combo)
}

#[tauri::command]
fn set_remote_input_enabled(
    state: State<AppState>,
    enabled: bool,
) -> Result<(), String> {
    let mut dispatcher = state.input_dispatcher.lock().map_err(|e| e.to_string())?;
    dispatcher.set_permission_granted(enabled);
    Ok(())
}

#[tauri::command]
fn get_input_stats(
    state: State<AppState>,
) -> Result<serde_json::Value, String> {
    let dispatcher = state.input_dispatcher.lock().map_err(|e| e.to_string())?;
    let (mouse, key) = dispatcher.stats();
    Ok(serde_json::json!({
        "mouseEvents": mouse,
        "keyEvents": key,
        "enabled": dispatcher.is_permission_granted(),
    }))
}

// ─────────────────────────────────────────────────────────────────────────────
// Tauri Commands — Clipboard Synchronization (Phase 6)
// ─────────────────────────────────────────────────────────────────────────────

#[tauri::command]
fn read_clipboard(state: State<AppState>) -> Result<Option<ClipboardPayload>, String> {
    let mut dispatcher = state.clipboard_dispatcher.lock().map_err(|e| e.to_string())?;
    dispatcher.poll_local_clipboard().map_err(|e| format!("{e}"))
}

#[tauri::command]
fn write_clipboard(state: State<AppState>, text: String) -> Result<(), String> {
    let mut dispatcher = state.clipboard_dispatcher.lock().map_err(|e| e.to_string())?;
    let payload = ClipboardPayload::new(text).map_err(|e| format!("{e}"))?;
    dispatcher.inject_remote_clipboard(&payload).map_err(|e| format!("{e}"))
}

#[tauri::command]
fn set_clipboard_enabled(state: State<AppState>, enabled: bool) -> Result<(), String> {
    let mut dispatcher = state.clipboard_dispatcher.lock().map_err(|e| e.to_string())?;
    dispatcher.set_permission_granted(enabled);
    Ok(())
}

#[tauri::command]
fn get_clipboard_stats(state: State<AppState>) -> Result<serde_json::Value, String> {
    let dispatcher = state.clipboard_dispatcher.lock().map_err(|e| e.to_string())?;
    Ok(serde_json::json!({
        "syncCount": dispatcher.sync_count(),
        "enabled": dispatcher.is_permission_granted(),
    }))
}

// ─────────────────────────────────────────────────────────────────────────────
// Tauri Commands — Resumable Chunked File Transfer (Phase 6)
// ─────────────────────────────────────────────────────────────────────────────

#[tauri::command]
fn prepare_file_upload(
    state: State<AppState>,
    file_path: String,
    transfer_id: String,
) -> Result<TransferMetadata, String> {
    let mut manager = state.file_transfer_manager.lock().map_err(|e| e.to_string())?;
    manager.start_outbound_transfer(PathBuf::from(file_path), transfer_id)
        .map_err(|e| format!("{e}"))
}

#[tauri::command]
fn get_file_chunk(
    state: State<AppState>,
    transfer_id: String,
    chunk_index: u32,
) -> Result<FileChunk, String> {
    let manager = state.file_transfer_manager.lock().map_err(|e| e.to_string())?;
    manager.get_outbound_chunk(&transfer_id, chunk_index)
        .map_err(|e| format!("{e}"))
}

#[tauri::command]
fn acknowledge_file_chunk(
    state: State<AppState>,
    transfer_id: String,
    chunk_index: u32,
) -> Result<TransferState, String> {
    let mut manager = state.file_transfer_manager.lock().map_err(|e| e.to_string())?;
    manager.acknowledge_outbound_chunk(&transfer_id, chunk_index)
        .map_err(|e| format!("{e}"))
}

#[tauri::command]
fn prepare_file_download(
    state: State<AppState>,
    metadata: TransferMetadata,
) -> Result<(), String> {
    let mut manager = state.file_transfer_manager.lock().map_err(|e| e.to_string())?;
    manager.prepare_inbound_transfer(metadata)
        .map_err(|e| format!("{e}"))
}

#[tauri::command]
fn receive_file_chunk(
    state: State<AppState>,
    chunk: FileChunk,
) -> Result<FileTransferAck, String> {
    let mut manager = state.file_transfer_manager.lock().map_err(|e| e.to_string())?;
    manager.receive_inbound_chunk(&chunk)
        .map_err(|e| format!("{e}"))
}

#[tauri::command]
fn get_file_transfer_status(
    state: State<AppState>,
    transfer_id: String,
) -> Result<Option<TransferStatusInfo>, String> {
    let manager = state.file_transfer_manager.lock().map_err(|e| e.to_string())?;
    Ok(manager.get_transfer_status(&transfer_id))
}

#[tauri::command]
fn cancel_file_transfer(
    state: State<AppState>,
    transfer_id: String,
) -> Result<bool, String> {
    let mut manager = state.file_transfer_manager.lock().map_err(|e| e.to_string())?;
    Ok(manager.cancel_transfer(&transfer_id))
}

#[tauri::command]
fn set_file_transfer_enabled(
    state: State<AppState>,
    enabled: bool,
) -> Result<(), String> {
    let mut manager = state.file_transfer_manager.lock().map_err(|e| e.to_string())?;
    manager.set_permission_granted(enabled);
    Ok(())
}

// ─────────────────────────────────────────────────────────────────────────────
// Tauri Commands — Multi-Monitor Switching (Phase 6)
// ─────────────────────────────────────────────────────────────────────────────

#[tauri::command]
fn switch_capture_display(
    app: AppHandle,
    state: State<AppState>,
    display_id: usize,
    fps: Option<u32>,
    bitrate_kbps: Option<u32>,
    session_id: String,
) -> Result<String, String> {
    log::info!("[tauri] Switching capture display to {display_id}");
    start_capture(app, state, display_id, fps, bitrate_kbps, session_id)
}

// ─────────────────────────────────────────────────────────────────────────────
// Tauri Commands — Windows Platform & Hardening (Phase 7)
// ─────────────────────────────────────────────────────────────────────────────

#[tauri::command]
fn get_windows_telemetry(_state: State<AppState>) -> Result<WindowsSystemInfo, String> {
    Ok(get_windows_system_info())
}

#[tauri::command]
fn check_process_elevation(_state: State<AppState>) -> Result<bool, String> {
    is_process_elevated().map_err(|e| format!("{e}"))
}

#[tauri::command]
fn get_tray_state(state: State<AppState>) -> Result<TrayState, String> {
    let tray = state.tray_manager.lock().map_err(|e| e.to_string())?;
    Ok(tray.state())
}

#[tauri::command]
fn set_tray_connected(state: State<AppState>, active_sessions: u32) -> Result<String, String> {
    let mut tray = state.tray_manager.lock().map_err(|e| e.to_string())?;
    tray.set_connected(active_sessions);
    Ok(tray.tooltip().to_string())
}

#[tauri::command]
fn set_tray_emergency_disconnect(state: State<AppState>) -> Result<String, String> {
    let mut tray = state.tray_manager.lock().map_err(|e| e.to_string())?;
    tray.emergency_disconnect();
    Ok(tray.tooltip().to_string())
}

#[tauri::command]
fn get_service_command(
    state: State<AppState>,
    action: String,
    bin_path: Option<String>,
) -> Result<String, String> {
    let sm = state.service_manager.lock().map_err(|e| e.to_string())?;
    let act = match action.to_lowercase().as_str() {
        "install" => ServiceAction::Install,
        "uninstall" => ServiceAction::Uninstall,
        "start" => ServiceAction::Start,
        "stop" => ServiceAction::Stop,
        "status" => ServiceAction::Status,
        _ => return Err(format!("Unknown service action: {action}")),
    };
    Ok(sm.build_command(act, bin_path.as_deref()))
}

// ─────────────────────────────────────────────────────────────────────────────
// Tauri Commands — WebRTC Production Transport & Explicit Modes (P0)
// ─────────────────────────────────────────────────────────────────────────────

#[tauri::command]
fn start_viewer_session(
    state: State<AppState>,
    target_remote_id: String,
    session_id: String,
    ice_servers: Option<Vec<IceServerConfig>>,
) -> Result<ActiveSessionInfo, String> {
    let mut session_guard = state.active_session.lock().map_err(|e| e.to_string())?;
    let mut engine_guard = state.engine.lock().map_err(|e| e.to_string())?;

    // CRITICAL REQUIREMENT (Section 16): Do NOT start local screen capture in the viewer when connecting to another computer!
    let mut capture_guard = state.capture.lock().map_err(|e| e.to_string())?;
    if let Some(mut existing_cap) = capture_guard.take() {
        existing_cap.stop();
        log::info!("[viewer] Stopped existing local capture session before entering Viewer mode");
    }

    let servers = ice_servers.unwrap_or_else(|| vec![
        IceServerConfig {
            urls: vec!["stun:stun.l.google.com:19302".to_string()],
            username: None,
            credential: None,
        }
    ]);

    let pc = engine_guard.start_transport_session(servers);
    let sm = pc.state_machine_mut();
    sm.transition(SessionState::Authorizing).map_err(|e| format!("{e}"))?;
    sm.transition(SessionState::Signaling).map_err(|e| format!("{e}"))?;
    sm.transition(SessionState::IceGathering).map_err(|e| format!("{e}"))?;
    sm.transition(SessionState::Connecting).map_err(|e| format!("{e}"))?;

    let route = format!("{:?}", pc.route());
    let info = ActiveSessionInfo {
        session_id: session_id.clone(),
        target_id: target_remote_id,
        mode: DesktopMode::Viewer,
        state: "Connecting".to_string(),
        route,
    };

    *session_guard = Some(info.clone());
    log::info!("[viewer] Established WebRTC viewer session {session_id}");
    Ok(info)
}

#[tauri::command]
fn start_host_session(
    app: AppHandle,
    state: State<AppState>,
    session_id: String,
    viewer_id: String,
    allow_screen_view: bool,
    allow_control: bool,
    allow_clipboard: bool,
    allow_file_transfer: bool,
    display_id: usize,
    fps: Option<u32>,
    bitrate_kbps: Option<u32>,
    ice_servers: Option<Vec<IceServerConfig>>,
) -> Result<ActiveSessionInfo, String> {
    let mut session_guard = state.active_session.lock().map_err(|e| e.to_string())?;
    let mut engine_guard = state.engine.lock().map_err(|e| e.to_string())?;
    let mut gate_guard = state.permission_gate.lock().map_err(|e| e.to_string())?;

    let gate = SessionPermissionGate::new(
        true, // session authenticated
        true, // host accepted consent
        allow_control,
        true, // device policy allows control
    );
    *gate_guard = gate;

    {
        state.input_dispatcher.lock().map_err(|e| e.to_string())?.set_permission_granted(allow_control);
        let mut clip_guard = state.clipboard_dispatcher.lock().map_err(|e| e.to_string())?;
        clip_guard.set_permission_granted(allow_clipboard);
        let mut file_guard = state.file_transfer_manager.lock().map_err(|e| e.to_string())?;
        file_guard.set_permission_granted(allow_file_transfer);
    }

    let servers = ice_servers.unwrap_or_else(|| vec![
        IceServerConfig {
            urls: vec!["stun:stun.l.google.com:19302".to_string()],
            username: None,
            credential: None,
        }
    ]);

    let pc = engine_guard.start_transport_session(servers);
    let sm = pc.state_machine_mut();
    sm.transition(SessionState::Authorizing).map_err(|e| format!("{e}"))?;
    sm.transition(SessionState::WaitingForConsent).map_err(|e| format!("{e}"))?;
    sm.transition(SessionState::Signaling).map_err(|e| format!("{e}"))?;
    sm.transition(SessionState::IceGathering).map_err(|e| format!("{e}"))?;
    sm.transition(SessionState::Connecting).map_err(|e| format!("{e}"))?;

    // Host starts capture pipeline
    if allow_screen_view { start_capture(app, state.clone(), display_id, fps, bitrate_kbps, session_id.clone())?; }

    let route = format!("{:?}", pc.route());
    let info = ActiveSessionInfo {
        session_id: session_id.clone(),
        target_id: viewer_id,
        mode: DesktopMode::HostAgent,
        state: "Connecting".to_string(),
        route,
    };

    *session_guard = Some(info.clone());
    log::info!("[host] Established WebRTC host session {session_id}");
    Ok(info)
}

#[tauri::command]
fn send_remote_control(
    state: State<AppState>,
    message: RemoteControlMessage,
) -> Result<(), String> {
    let mut engine_guard = state.engine.lock().map_err(|e| e.to_string())?;
    if let Some(transport) = engine_guard.transport_mut() {
        let data = serde_json::to_vec(&message).map_err(|e| format!("{e}"))?;
        transport.send_data_channel("remote-control", &data).map_err(|e| format!("{e}"))?;
    }
    Ok(())
}

#[tauri::command]
fn process_remote_control(
    state: State<AppState>,
    message: RemoteControlMessage,
    bounds: DisplayBounds,
) -> Result<(), String> {
    let gate_guard = state.permission_gate.lock().map_err(|e| e.to_string())?;
    let mut input_guard = state.input_dispatcher.lock().map_err(|e| e.to_string())?;
    let raw = serde_json::to_vec(&message).map_err(|e| format!("{e}"))?;
    process_incoming_remote_control(&raw, &gate_guard, &mut input_guard, &bounds)
}

#[tauri::command]
fn send_remote_clipboard(
    state: State<AppState>,
    text: String,
) -> Result<(), String> {
    let mut engine_guard = state.engine.lock().map_err(|e| e.to_string())?;
    if let Some(transport) = engine_guard.transport_mut() {
        let msg = RemoteClipboardMessage::new(text);
        let data = serde_json::to_vec(&msg).map_err(|e| format!("{e}"))?;
        transport.send_data_channel("clipboard", &data).map_err(|e| format!("{e}"))?;
    }
    Ok(())
}

#[tauri::command]
fn get_session_telemetry(state: State<AppState>) -> Result<Option<TransportTelemetry>, String> {
    let engine_guard = state.engine.lock().map_err(|e| e.to_string())?;
    if let Some(transport) = engine_guard.transport() {
        Ok(Some(transport.get_telemetry()))
    } else {
        Ok(None)
    }
}

#[tauri::command]
fn trigger_ice_restart(state: State<AppState>) -> Result<(), String> {
    let mut engine_guard = state.engine.lock().map_err(|e| e.to_string())?;
    if let Some(transport) = engine_guard.transport_mut() {
        transport.restart_ice();
        log::info!("[transport] ICE restart initiated");
        Ok(())
    } else {
        Err("No active transport session to restart ICE".to_string())
    }
}

#[tauri::command]
fn disconnect_session(state: State<AppState>) -> Result<(), String> {
    *state.permission_gate.lock().map_err(|e| e.to_string())? = SessionPermissionGate::new(false, false, false, false);
    state.input_dispatcher.lock().map_err(|e| e.to_string())?.set_permission_granted(false);
    state.clipboard_dispatcher.lock().map_err(|e| e.to_string())?.set_permission_granted(false);
    { let mut files = state.file_transfer_manager.lock().map_err(|e| e.to_string())?; files.set_permission_granted(false); files.cancel_all(); }
    state.capture_generation.fetch_add(1, Ordering::SeqCst);
    let mut session_guard = state.active_session.lock().map_err(|e| e.to_string())?;
    *session_guard = None;

    let mut engine_guard = state.engine.lock().map_err(|e| e.to_string())?;
    engine_guard.end_transport_session();

    let mut capture_guard = state.capture.lock().map_err(|e| e.to_string())?;
    if let Some(mut cap) = capture_guard.take() {
        cap.stop();
    }
    log::info!("[session] Disconnected session and released transport resources");
    Ok(())
}

#[tauri::command]
fn get_active_session_info(state: State<AppState>) -> Result<Option<ActiveSessionInfo>, String> {
    let session_guard = state.active_session.lock().map_err(|e| e.to_string())?;
    Ok(session_guard.clone())
}

// ─────────────────────────────────────────────────────────────────────────────
// Entry Point
// ─────────────────────────────────────────────────────────────────────────────

fn main() {
    env_logger::Builder::from_env(
        env_logger::Env::default().default_filter_or("info")
    ).init();

    let download_dir = std::env::var("USERPROFILE").map(PathBuf::from).unwrap_or_else(|_| std::env::temp_dir()).join("Downloads").join("KryptonRemote");

    tauri::Builder::default()
        .manage(AppState {
            engine: Mutex::new(RemoteEngine::new()),
            capture: Mutex::new(None),
            capture_generation: AtomicU64::new(0),
            input_dispatcher: Mutex::new({ let mut dispatcher = InputDispatcher::new(); dispatcher.set_permission_granted(false); dispatcher }),
            clipboard_dispatcher: Mutex::new({ let mut dispatcher = ClipboardDispatcher::new(); dispatcher.set_permission_granted(false); dispatcher }),
            file_transfer_manager: Mutex::new({ let mut manager = FileTransferManager::new(download_dir); manager.set_permission_granted(false); manager }),
            tray_manager: Mutex::new(SystemTrayManager::new()),
            service_manager: Mutex::new(WindowsServiceManager::new(
                "KryptonRemoteAgent",
                "KryptonRemote Host Service",
            )),
            active_session: Mutex::new(None),
            permission_gate: Mutex::new(SessionPermissionGate::new(
                false,
                false,
                false,
                false,
            )),
        })
        .invoke_handler(tauri::generate_handler![
            get_engine_state,
            initialize_identity,
            enroll_device,
            get_device_registration,
            sign_device_challenge,
            device_api_request,
            get_device_heartbeat,
            viewer_api_request,
            get_capture_displays,
            start_capture,
            stop_capture,
            set_capture_bitrate,
            get_capture_status,
            inject_mouse_input,
            inject_keyboard_input,
            send_special_combo,
            set_remote_input_enabled,
            get_input_stats,
            read_clipboard,
            write_clipboard,
            set_clipboard_enabled,
            get_clipboard_stats,
            prepare_file_upload,
            get_file_chunk,
            acknowledge_file_chunk,
            prepare_file_download,
            receive_file_chunk,
            get_file_transfer_status,
            cancel_file_transfer,
            set_file_transfer_enabled,
            switch_capture_display,
            get_windows_telemetry,
            check_process_elevation,
            get_tray_state,
            set_tray_connected,
            set_tray_emergency_disconnect,
            get_service_command,
            // P0 WebRTC Transport & Session commands
            start_viewer_session,
            start_host_session,
            send_remote_control,
            process_remote_control,
            send_remote_clipboard,
            get_session_telemetry,
            trigger_ice_restart,
            disconnect_session,
            get_active_session_info,
        ])
        .run(tauri::generate_context!())
        .expect("error while running KryptonRemote desktop application");
}
