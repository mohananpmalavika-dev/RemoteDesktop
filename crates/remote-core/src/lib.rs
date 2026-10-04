pub use device_identity::*;
pub use krypton_capture::*;
pub use krypton_clipboard::*;
pub use krypton_encoder::*;
pub use krypton_file_transfer::*;
pub use krypton_input::*;
pub use krypton_platform_windows::*;
pub use krypton_transport::*;

use serde::{Deserialize, Serialize};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    mpsc::{self, Receiver, SyncSender},
    Arc,
};
use std::thread;
use std::time::Duration;

// ─────────────────────────────────────────────────────────────────────────────
// Engine State Machine
// ─────────────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum EngineState {
    Uninitialized,
    Enrolled,
    Ready,
    SessionActive,
    Terminated,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceEnrollmentRequest {
    pub enrollment_token: String,
    pub public_key_base64: String,
    pub device_name: String,
    pub hostname: String,
    pub os: String,
    pub os_version: String,
    pub architecture: String,
    pub agent_version: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HeartbeatTelemetry {
    pub device_id: String,
    pub timestamp: String,
    pub agent_version: String,
    pub os: String,
    pub os_version: String,
    pub architecture: String,
    pub session_count: u32,
    pub cpu_percent: f32,
    pub memory_percent: f32,
    pub uptime_seconds: u64,
}

pub struct RemoteEngine {
    state: EngineState,
    identity_manager: Option<KeyPairManager>,
    device_id: Option<String>,
    remote_id: Option<String>,
    start_time: std::time::Instant,
    active_transport: Option<WebRtcPeerConnection>,
}

impl RemoteEngine {
    pub fn new() -> Self {
        Self {
            state: EngineState::Uninitialized,
            identity_manager: None,
            device_id: None,
            remote_id: None,
            start_time: std::time::Instant::now(),
            active_transport: None,
        }
    }

    pub fn initialize_identity(&mut self) -> Result<String, String> {
        if let Some(manager) = &self.identity_manager {
            return Ok(manager.public_key_base64());
        }
        let mgr = KeyPairManager::generate();
        let pub_key = mgr.public_key_base64();
        self.identity_manager = Some(mgr);
        self.state = EngineState::Enrolled;
        Ok(pub_key)
    }

    #[cfg(windows)]
    pub fn initialize_persisted_identity(&mut self, path: &std::path::Path) -> Result<String, String> {
        if let Some(manager) = &self.identity_manager {
            return Ok(manager.public_key_base64());
        }
        let manager = KeyPairManager::load_or_generate(path).map_err(|e| e.to_string())?;
        let public_key = manager.public_key_base64();
        self.identity_manager = Some(manager);
        self.state = EngineState::Enrolled;
        Ok(public_key)
    }

    /// Only a server-assigned Remote ID can be shared; a public key is not an ID.
    pub fn shareable_remote_id(&self) -> Result<Option<String>, String> {
        self.remote_id.as_ref().map(|id| format_remote_id(id)).transpose()
    }

    pub fn create_enrollment_request(
        &mut self,
        enrollment_token: &str,
        device_name: &str,
    ) -> Result<DeviceEnrollmentRequest, String> {
        let pubkey = match &self.identity_manager {
            Some(mgr) => mgr.public_key_base64(),
            None => self.initialize_identity()?,
        };

        let sys_info = get_windows_system_info();

        Ok(DeviceEnrollmentRequest {
            enrollment_token: enrollment_token.to_string(),
            public_key_base64: pubkey,
            device_name: device_name.to_string(),
            hostname: std::env::var("COMPUTERNAME").unwrap_or_else(|_| "DESKTOP-NODE".to_string()),
            os: sys_info.os_name,
            os_version: sys_info.os_version,
            architecture: sys_info.arch,
            agent_version: env!("CARGO_PKG_VERSION").to_string(),
        })
    }

    pub fn set_enrolled_identity(&mut self, device_id: String, remote_id: String) {
        self.device_id = Some(device_id);
        self.remote_id = Some(remote_id);
        self.state = EngineState::Ready;
    }

    pub fn create_heartbeat(&self) -> Result<HeartbeatTelemetry, String> {
        let device_id = self.device_id.as_ref().ok_or("Device is not enrolled")?;
        let sys_info = get_windows_system_info();

        Ok(HeartbeatTelemetry {
            device_id: device_id.clone(),
            timestamp: chrono::Utc::now().to_rfc3339(),
            agent_version: env!("CARGO_PKG_VERSION").to_string(),
            os: sys_info.os_name,
            os_version: sys_info.os_version,
            architecture: sys_info.arch,
            session_count: if self.state == EngineState::SessionActive { 1 } else { 0 },
            cpu_percent: 1.5,
            memory_percent: 12.0,
            uptime_seconds: self.start_time.elapsed().as_secs(),
        })
    }

    pub fn state(&self) -> EngineState { self.state }
    pub fn remote_id(&self) -> Option<&str> { self.remote_id.as_deref() }

    pub fn start_transport_session(&mut self, ice_servers: Vec<IceServerConfig>) -> &mut WebRtcPeerConnection {
        self.state = EngineState::SessionActive;
        let pc = WebRtcPeerConnection::new(ice_servers);
        self.active_transport = Some(pc);
        self.active_transport.as_mut().unwrap()
    }

    pub fn transport(&self) -> Option<&WebRtcPeerConnection> {
        self.active_transport.as_ref()
    }

    pub fn transport_mut(&mut self) -> Option<&mut WebRtcPeerConnection> {
        self.active_transport.as_mut()
    }

    pub fn end_transport_session(&mut self) {
        if self.active_transport.is_some() {
            self.active_transport = None;
            self.state = EngineState::Ready;
        }
    }
}

pub fn format_remote_id(value: &str) -> Result<String, String> {
    let clean: String = value.chars().filter(|c| !c.is_ascii_whitespace()).collect();
    if clean.len() != 9 || !clean.bytes().all(|c| c.is_ascii_digit()) {
        return Err("The server did not return a valid 9-digit Remote ID.".into());
    }
    Ok(format!("{} {} {}", &clean[..3], &clean[3..6], &clean[6..]))
}

/// Dispatches an incoming remote control network payload with strict security validation
pub fn process_incoming_remote_control(
    raw_data: &[u8],
    gate: &SessionPermissionGate,
    dispatcher: &mut InputDispatcher,
    bounds: &DisplayBounds,
) -> Result<(), String> {
    if !gate.is_input_allowed() {
        return Err("Permission denied: remote input rejected because session permissions were not granted".into());
    }

    let msg: RemoteControlMessage = serde_json::from_slice(raw_data)
        .map_err(|e| format!("Failed to parse remote control message: {e}"))?;

    match msg {
        RemoteControlMessage::MouseMove { x, y, .. } => {
            dispatcher.dispatch_mouse(
                MouseAction::Move {
                    point: NormalizedPoint::new(x as f32, y as f32),
                },
                bounds,
            )
        }
        RemoteControlMessage::MouseButton { button, state, x, y, .. } => {
            let btn = match button.as_str() {
                "right" => MouseButton::Right,
                "middle" => MouseButton::Middle,
                _ => MouseButton::Left,
            };
            let action = match state.as_str() {
                "down" => MouseAction::ButtonDown {
                    button: btn,
                    point: NormalizedPoint::new(x as f32, y as f32),
                },
                _ => MouseAction::ButtonUp {
                    button: btn,
                    point: NormalizedPoint::new(x as f32, y as f32),
                },
            };
            dispatcher.dispatch_mouse(action, bounds)
        }
        RemoteControlMessage::MouseWheel { delta_x, delta_y, .. } => {
            dispatcher.dispatch_mouse(
                MouseAction::Scroll {
                    delta_x: delta_x as i32,
                    delta_y: delta_y as i32,
                },
                bounds,
            )
        }
        RemoteControlMessage::KeyDown { virtual_key, .. } => {
            dispatcher.dispatch_keyboard(KeyAction::KeyDown { virtual_key })
        }
        RemoteControlMessage::KeyUp { virtual_key, .. } => {
            dispatcher.dispatch_keyboard(KeyAction::KeyUp { virtual_key })
        }
        RemoteControlMessage::SpecialCombo { combo, .. } => {
            let special = match combo.as_str() {
                "CtrlAltDel" => SpecialCombo::CtrlAltDel,
                "AltTab" => SpecialCombo::AltTab,
                "WinKey" => SpecialCombo::WinKey,
                "CtrlShiftEsc" => SpecialCombo::CtrlShiftEsc,
                other => return Err(format!("Unknown special combo: {other}")),
            };
            dispatcher.dispatch_special_combo(special)
        }
    }
}

/// Injects remote clipboard content with loopback suppression and direction policy enforcement
pub fn process_incoming_remote_clipboard(
    raw_data: &[u8],
    policy: ClipboardDirectionPolicy,
    dispatcher: &mut ClipboardDispatcher,
) -> Result<(), String> {
    if policy == ClipboardDirectionPolicy::Disabled || policy == ClipboardDirectionPolicy::HostToViewer {
        return Err("Clipboard sync disabled by security policy".into());
    }

    let msg: RemoteClipboardMessage = serde_json::from_slice(raw_data)
        .map_err(|e| format!("Failed to parse remote clipboard: {e}"))?;

    if msg.text.len() > MAX_CLIPBOARD_BYTES {
        return Err("Clipboard payload exceeded 1MB limit".into());
    }

    let payload = ClipboardPayload::new(msg.text).map_err(|e| format!("{e}"))?;
    dispatcher.inject_remote_clipboard(&payload).map_err(|e| format!("{e}"))
}

/// Receives file transfer protocol message with path traversal protection
pub fn process_incoming_file_transfer(
    raw_data: &[u8],
    manager: &mut FileTransferManager,
) -> Result<Option<FileTransferAck>, String> {
    let msg: FileTransferMessage = serde_json::from_slice(raw_data)
        .map_err(|e| format!("Failed to parse file transfer message: {e}"))?;

    match msg {
        FileTransferMessage::MetadataHandshake {
            transfer_id,
            filename,
            file_size_bytes,
            chunk_size,
            total_chunks,
            sha256_checksum,
            ..
        } => {
            let safe_filename = sanitize_download_filename(&filename)
                .map_err(|e| format!("Path traversal rejected: {e}"))?;
            let meta = TransferMetadata {
                transfer_id,
                filename: safe_filename,
                file_size_bytes,
                chunk_size: chunk_size as usize,
                total_chunks,
                sha256_checksum,
            };
            manager.prepare_inbound_transfer(meta).map_err(|e| format!("{e}"))?;
            Ok(None)
        }
        FileTransferMessage::Chunk {
            transfer_id,
            chunk_index,
            total_chunks,
            data,
            ..
        } => {
            let chunk = FileChunk {
                transfer_id,
                chunk_index,
                total_chunks,
                data,
            };
            let ack = manager.receive_inbound_chunk(&chunk).map_err(|e| format!("{e}"))?;
            Ok(Some(ack))
        }
        FileTransferMessage::Cancel { transfer_id, .. } => {
            manager.cancel_transfer(&transfer_id);
            Ok(None)
        }
        _ => Ok(None),
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Capture Session — capture → encode → channel
// ─────────────────────────────────────────────────────────────────────────────

/// A running capture-encode pipeline for a single display.
/// Runs on a dedicated OS thread (not async) so DXGI COM calls are safe.
/// Encoded packets are sent over an mpsc channel for consumption by the viewer.
pub struct CaptureSession {
    shutdown: Arc<AtomicBool>,
    thread: Option<thread::JoinHandle<()>>,
    pub receiver: Receiver<EncodedPacket>,
    display_id: usize,
    target_fps: u32,
}

impl CaptureSession {
    /// Start capturing from `display_id` and encoding at `target_fps` / `bitrate_kbps`.
    /// The `receiver` field provides a channel to receive encoded packets.
    pub fn start(
        display_id: usize,
        target_fps: u32,
        bitrate_kbps: u32,
    ) -> Result<Self, String> {
        let (tx, rx) = mpsc::sync_channel::<EncodedPacket>(4); // 4-frame backpressure buffer
        let shutdown = Arc::new(AtomicBool::new(false));
        let shutdown_clone = Arc::clone(&shutdown);

        let thread = thread::Builder::new()
            .name(format!("krypton-capture-{display_id}"))
            .spawn(move || {
                if let Err(e) = capture_loop(display_id, target_fps, bitrate_kbps, tx, shutdown_clone) {
                    log::error!("[capture-session] Capture loop error: {e}");
                }
            })
            .map_err(|e| format!("Failed to spawn capture thread: {e}"))?;

        log::info!(
            "[capture-session] Started display={} fps={} bitrate={}kbps",
            display_id, target_fps, bitrate_kbps
        );

        Ok(CaptureSession {
            shutdown,
            thread: Some(thread),
            receiver: rx,
            display_id,
            target_fps,
        })
    }

    /// Signal the capture thread to stop and wait for it to exit.
    pub fn stop(&mut self) {
        self.shutdown.store(true, Ordering::Release);
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
        log::info!("[capture-session] Stopped (display={})", self.display_id);
    }

    pub fn display_id(&self) -> usize { self.display_id }
    pub fn target_fps(&self) -> u32 { self.target_fps }
    pub fn is_running(&self) -> bool {
        !self.shutdown.load(Ordering::Acquire)
    }
}

impl Drop for CaptureSession {
    fn drop(&mut self) {
        self.stop();
    }
}

/// The main capture/encode loop running on the capture thread.
fn capture_loop(
    display_id: usize,
    target_fps: u32,
    bitrate_kbps: u32,
    tx: SyncSender<EncodedPacket>,
    shutdown: Arc<AtomicBool>,
) -> Result<(), String> {
    let mut capturer = krypton_capture::create_best_capturer();
    capturer
        .start_capture(display_id)
        .map_err(|e| format!("start_capture: {e}"))?;

    let displays = capturer
        .enumerate_displays()
        .map_err(|e| format!("enumerate_displays: {e}"))?;

    let display = displays
        .iter()
        .find(|d| d.id == display_id)
        .ok_or_else(|| format!("Display {display_id} not found"))?;

    let encoder_config = krypton_encoder::EncoderConfig {
        codec: krypton_encoder::VideoCodec::H264,
        backend: krypton_encoder::EncoderBackend::SoftwareRust,
        width: display.width,
        height: display.height,
        target_fps,
        target_bitrate_kbps: bitrate_kbps,
        keyframe_interval: target_fps * 2, // IDR every 2 seconds
    };

    let mut encoder = krypton_encoder::create_best_encoder();
    encoder
        .initialize(&encoder_config)
        .map_err(|e| format!("encoder init: {e}"))?;

    let frame_interval = Duration::from_micros(1_000_000 / target_fps as u64);
    let mut last_frame = std::time::Instant::now();

    log::info!(
        "[capture-loop] Running display={} {}x{} @{}fps {}kbps",
        display_id, display.width, display.height, target_fps, bitrate_kbps
    );

    while !shutdown.load(Ordering::Acquire) {
        let elapsed = last_frame.elapsed();
        if elapsed < frame_interval {
            thread::sleep(frame_interval - elapsed);
        }
        last_frame = std::time::Instant::now();

        match capturer.capture_frame() {
            Ok(Some(frame)) => {
                match encoder.encode_frame(&frame) {
                    Ok(Some(pkt)) => {
                        // Non-blocking send; drop frames if consumer is slow
                        if tx.try_send(pkt).is_err() {
                            log::debug!("[capture-loop] Receiver buffer full, dropping frame");
                        }
                    }
                    Ok(None) => {} // Encoder buffering
                    Err(e) => {
                        log::warn!("[capture-loop] Encode error: {e}");
                    }
                }
            }
            Ok(None) => {} // No new frame (DXGI timeout)
            Err(e) => {
                log::warn!("[capture-loop] Capture error: {e}");
                // On access lost, try to re-init capture after brief pause
                thread::sleep(Duration::from_millis(500));
                if let Err(reinit_err) = capturer.start_capture(display_id) {
                    log::error!("[capture-loop] Re-init failed: {reinit_err}");
                    break;
                }
            }
        }
    }

    let _ = capturer.stop_capture();
    log::info!("[capture-loop] Exited (display={})", display_id);
    Ok(())
}

// ─────────────────────────────────────────────────────────────────────────────
// Remote Input Dispatcher with Capability & Safety Enforcement
// ─────────────────────────────────────────────────────────────────────────────

pub struct InputDispatcher {
    controller: Box<dyn InputController>,
    input_permission_granted: bool,
    mouse_event_count: u64,
    key_event_count: u64,
}

impl InputDispatcher {
    pub fn new() -> Self {
        Self {
            controller: create_best_input_controller(),
            input_permission_granted: true,
            mouse_event_count: 0,
            key_event_count: 0,
        }
    }

    pub fn with_controller(controller: Box<dyn InputController>) -> Self {
        Self {
            controller,
            input_permission_granted: true,
            mouse_event_count: 0,
            key_event_count: 0,
        }
    }

    pub fn set_permission_granted(&mut self, granted: bool) {
        self.input_permission_granted = granted;
        log::info!("[input-dispatcher] Remote input permission set to {}", granted);
    }

    pub fn is_permission_granted(&self) -> bool {
        self.input_permission_granted
    }

    pub fn dispatch_mouse(
        &mut self,
        action: MouseAction,
        bounds: &DisplayBounds,
    ) -> Result<(), String> {
        if !self.input_permission_granted {
            return Err("Remote input rejected: session does not have input_control capability granted by host".into());
        }
        self.controller.inject_mouse(action, bounds)?;
        self.mouse_event_count += 1;
        Ok(())
    }

    pub fn dispatch_keyboard(&mut self, action: KeyAction) -> Result<(), String> {
        if !self.input_permission_granted {
            return Err("Remote input rejected: session does not have input_control capability granted by host".into());
        }
        self.controller.inject_keyboard(action)?;
        self.key_event_count += 1;
        Ok(())
    }

    pub fn dispatch_special_combo(&mut self, combo: SpecialCombo) -> Result<(), String> {
        if !self.input_permission_granted {
            return Err("Remote input rejected: session does not have input_control capability granted by host".into());
        }
        self.controller.inject_special_combo(combo)?;
        self.key_event_count += 1;
        Ok(())
    }

    pub fn stats(&self) -> (u64, u64) {
        (self.mouse_event_count, self.key_event_count)
    }
}

impl Default for InputDispatcher {
    fn default() -> Self {
        Self::new()
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Clipboard Dispatcher (Phase 6)
// ─────────────────────────────────────────────────────────────────────────────

pub struct ClipboardDispatcher {
    provider: Box<dyn ClipboardProvider>,
    loopback_filter: LoopbackFilter,
    permission_granted: AtomicBool,
    sync_count: u64,
}

impl ClipboardDispatcher {
    pub fn new() -> Self {
        Self {
            provider: create_best_clipboard_provider(),
            loopback_filter: LoopbackFilter::new(),
            permission_granted: AtomicBool::new(true),
            sync_count: 0,
        }
    }

    pub fn with_provider(provider: Box<dyn ClipboardProvider>) -> Self {
        Self {
            provider,
            loopback_filter: LoopbackFilter::new(),
            permission_granted: AtomicBool::new(true),
            sync_count: 0,
        }
    }

    pub fn set_permission_granted(&mut self, granted: bool) {
        self.permission_granted.store(granted, Ordering::SeqCst);
    }

    pub fn is_permission_granted(&self) -> bool {
        self.permission_granted.load(Ordering::SeqCst)
    }

    /// Reads local clipboard text, applies loopback and deduplication filtering.
    /// Returns Ok(Some(payload)) if new text should be broadcast to remote.
    pub fn poll_local_clipboard(&mut self) -> Result<Option<ClipboardPayload>, ClipboardError> {
        if !self.is_permission_granted() {
            return Err(ClipboardError::PermissionDenied);
        }

        let maybe_text = self.provider.read_text()?;
        if let Some(text) = maybe_text {
            let hash = compute_clipboard_hash(&text);
            if self.loopback_filter.should_broadcast(&hash) {
                let payload = ClipboardPayload::new(text)?;
                self.sync_count += 1;
                return Ok(Some(payload));
            }
        }
        Ok(None)
    }

    /// Injects remote clipboard text into local clipboard, recording hash for loopback suppression.
    pub fn inject_remote_clipboard(&mut self, payload: &ClipboardPayload) -> Result<(), ClipboardError> {
        if !self.is_permission_granted() {
            return Err(ClipboardError::PermissionDenied);
        }

        self.loopback_filter.record_remote_injected(&payload.hash);
        self.provider.write_text(&payload.text)?;
        self.sync_count += 1;
        Ok(())
    }

    pub fn sync_count(&self) -> u64 {
        self.sync_count
    }
}

impl Default for ClipboardDispatcher {
    fn default() -> Self {
        Self::new()
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// File Transfer Manager (Phase 6)
// ─────────────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TransferStatusInfo {
    pub transfer_id: String,
    pub filename: String,
    pub file_size_bytes: u64,
    pub received_bytes: u64,
    pub total_chunks: u32,
    pub received_chunks: usize,
    pub state: TransferState,
}

pub struct FileTransferManager {
    permission_granted: AtomicBool,
    staging_dir: std::path::PathBuf,
    senders: std::collections::HashMap<String, FileTransferSender>,
    receivers: std::collections::HashMap<String, FileTransferReceiver>,
}

impl FileTransferManager {
    pub fn new(staging_dir: std::path::PathBuf) -> Self {
        let _ = std::fs::create_dir_all(&staging_dir);
        Self {
            permission_granted: AtomicBool::new(true),
            staging_dir,
            senders: std::collections::HashMap::new(),
            receivers: std::collections::HashMap::new(),
        }
    }

    pub fn set_permission_granted(&mut self, granted: bool) {
        self.permission_granted.store(granted, Ordering::SeqCst);
    }

    pub fn is_permission_granted(&self) -> bool {
        self.permission_granted.load(Ordering::SeqCst)
    }

    pub fn staging_dir(&self) -> &std::path::Path {
        &self.staging_dir
    }

    pub fn start_outbound_transfer(
        &mut self,
        source_path: std::path::PathBuf,
        transfer_id: String,
    ) -> Result<TransferMetadata, FileTransferError> {
        if !self.is_permission_granted() {
            return Err(FileTransferError::PermissionDenied);
        }

        let sender = FileTransferSender::new(source_path, transfer_id.clone())?;
        let meta = sender.metadata().clone();
        self.senders.insert(transfer_id, sender);
        Ok(meta)
    }

    pub fn get_outbound_chunk(&self, transfer_id: &str, chunk_index: u32) -> Result<FileChunk, FileTransferError> {
        if !self.is_permission_granted() {
            return Err(FileTransferError::PermissionDenied);
        }

        let sender = self.senders.get(transfer_id)
            .ok_or_else(|| FileTransferError::IoError(format!("Unknown outbound transfer {transfer_id}")))?;
        sender.get_chunk(chunk_index)
    }

    pub fn acknowledge_outbound_chunk(
        &mut self,
        transfer_id: &str,
        chunk_index: u32,
    ) -> Result<TransferState, FileTransferError> {
        let sender = self.senders.get_mut(transfer_id)
            .ok_or_else(|| FileTransferError::IoError(format!("Unknown outbound transfer {transfer_id}")))?;
        Ok(sender.acknowledge_chunk(chunk_index))
    }

    pub fn prepare_inbound_transfer(
        &mut self,
        metadata: TransferMetadata,
    ) -> Result<(), FileTransferError> {
        if !self.is_permission_granted() {
            return Err(FileTransferError::PermissionDenied);
        }

        let receiver = FileTransferReceiver::new(metadata.clone(), &self.staging_dir)?;
        self.receivers.insert(metadata.transfer_id, receiver);
        Ok(())
    }

    pub fn receive_inbound_chunk(
        &mut self,
        chunk: &FileChunk,
    ) -> Result<FileTransferAck, FileTransferError> {
        if !self.is_permission_granted() {
            return Err(FileTransferError::PermissionDenied);
        }

        let receiver = self.receivers.get_mut(&chunk.transfer_id)
            .ok_or_else(|| FileTransferError::IoError(format!("Unknown inbound transfer {}", chunk.transfer_id)))?;
        receiver.receive_chunk(chunk)
    }

    pub fn get_transfer_status(&self, transfer_id: &str) -> Option<TransferStatusInfo> {
        if let Some(r) = self.receivers.get(transfer_id) {
            let meta = r.metadata();
            return Some(TransferStatusInfo {
                transfer_id: meta.transfer_id.clone(),
                filename: meta.filename.clone(),
                file_size_bytes: meta.file_size_bytes,
                received_bytes: r.received_bytes(),
                total_chunks: meta.total_chunks,
                received_chunks: r.received_chunks_count(),
                state: r.state(),
            });
        }
        if let Some(s) = self.senders.get(transfer_id) {
            let meta = s.metadata();
            let total = meta.total_chunks;
            let missing = s.missing_chunks().len();
            let acked = (total as usize).saturating_sub(missing);
            let acked_bytes = (acked as u64 * meta.chunk_size as u64).min(meta.file_size_bytes);
            return Some(TransferStatusInfo {
                transfer_id: meta.transfer_id.clone(),
                filename: meta.filename.clone(),
                file_size_bytes: meta.file_size_bytes,
                received_bytes: acked_bytes,
                total_chunks: total,
                received_chunks: acked,
                state: s.state(),
            });
        }
        None
    }

    pub fn cancel_transfer(&mut self, transfer_id: &str) -> bool {
        let mut found = false;
        if let Some(mut r) = self.receivers.remove(transfer_id) {
            r.cancel();
            found = true;
        }
        if self.senders.remove(transfer_id).is_some() {
            found = true;
        }
        found
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shareable_identity_requires_server_enrollment() {
        let mut engine = RemoteEngine::new();
        let public_key = engine.initialize_identity().unwrap();
        assert_eq!(engine.shareable_remote_id().unwrap(), None);
        assert_eq!(engine.initialize_identity().unwrap(), public_key);
        let request = engine.create_enrollment_request("ket_test", "Host").unwrap();
        assert_eq!(request.public_key_base64, public_key);
        assert_eq!(serde_json::to_value(request).unwrap()["publicKeyBase64"], public_key);
        engine.set_enrolled_identity("device".into(), "123456789".into());
        assert_eq!(engine.shareable_remote_id().unwrap(), Some("123 456 789".into()));
        engine.initialize_identity().unwrap();
        assert_eq!(engine.state(), EngineState::Ready);
        engine.set_enrolled_identity("device".into(), public_key);
        assert!(engine.shareable_remote_id().is_err());
    }

    #[test]
    fn remote_id_must_be_exactly_nine_digits() {
        assert_eq!(format_remote_id("001 002 003").unwrap(), "001 002 003");
        for invalid in ["abcdefghi", "12345678", "1234567890", "123-456-789", "１２３４５６７８９"] {
            assert!(format_remote_id(invalid).is_err());
        }
    }

    #[test]
    fn test_engine_initialization_and_enrollment_request() {
        let mut engine = RemoteEngine::new();
        assert_eq!(engine.state(), EngineState::Uninitialized);

        let req = engine.create_enrollment_request("ket_test_token_123", "Finance-Host").unwrap();
        assert_eq!(req.device_name, "Finance-Host");
        assert_eq!(req.enrollment_token, "ket_test_token_123");
        assert!(!req.public_key_base64.is_empty());
        assert_eq!(engine.state(), EngineState::Enrolled);

        engine.set_enrolled_identity("dev-uuid-1".to_string(), "834 951 220".to_string());
        assert_eq!(engine.state(), EngineState::Ready);
        assert_eq!(engine.remote_id(), Some("834 951 220"));

        let heartbeat = engine.create_heartbeat().unwrap();
        assert_eq!(heartbeat.device_id, "dev-uuid-1");
        assert_eq!(heartbeat.session_count, 0);
    }

    #[test]
    fn test_input_dispatcher_capability_gating() {
        let mut dispatcher = InputDispatcher::new();
        assert!(dispatcher.is_permission_granted());

        let bounds = DisplayBounds {
            x: 0,
            y: 0,
            width: 1920,
            height: 1080,
            dpi_scale: 1.0,
        };

        // When permission is revoked by host:
        dispatcher.set_permission_granted(false);
        assert!(!dispatcher.is_permission_granted());

        let move_res = dispatcher.dispatch_mouse(
            MouseAction::Move {
                point: NormalizedPoint::new(0.5, 0.5),
            },
            &bounds,
        );
        assert!(move_res.is_err(), "Must reject mouse move when capability revoked");
        assert!(move_res.unwrap_err().contains("input_control capability"));

        let key_res = dispatcher.dispatch_keyboard(KeyAction::KeyDown { virtual_key: 0x41 });
        assert!(key_res.is_err(), "Must reject keyboard when capability revoked");

        let combo_res = dispatcher.dispatch_special_combo(SpecialCombo::AltTab);
        assert!(combo_res.is_err(), "Must reject combo when capability revoked");

        let (mouse_count, key_count) = dispatcher.stats();
        assert_eq!(mouse_count, 0);
        assert_eq!(key_count, 0);
    }

    /// Integration test: tests real CaptureSession if desktop is active,
    /// or verifies OS AccessDenied detection + complete H.264 encode pipeline.
    #[cfg(windows)]
    #[test]
    fn test_capture_session_produces_encoded_frames() {
        use std::time::{Duration, Instant};

        let mut capturer = krypton_capture::create_best_capturer();
        match capturer.start_capture(0) {
            Ok(()) => {
                let _ = capturer.stop_capture();
                let mut session = CaptureSession::start(0, 15, 1000)
                    .expect("CaptureSession::start failed");
                assert!(session.is_running());

                let deadline = Instant::now() + Duration::from_secs(5);
                let mut received = 0usize;
                while Instant::now() < deadline && received < 3 {
                    if let Ok(pkt) = session.receiver.recv_timeout(Duration::from_millis(500)) {
                        received += 1;
                        assert!(!pkt.data.is_empty(), "Received empty packet");
                        println!(
                            "[test] Live frame {}: {} bytes, keyframe={}",
                            received, pkt.data.len(), pkt.is_keyframe
                        );
                    }
                }
                session.stop();
                assert!(received >= 1, "Expected ≥1 live encoded frame within 5s");
            }
            Err(krypton_capture::CaptureError::AccessDenied) => {
                println!("[test] Live capture returned AccessDenied (screen locked/inactive desktop); verifying full encode pipeline via RawFrame");
                let config = krypton_encoder::EncoderConfig {
                    codec: krypton_encoder::VideoCodec::H264,
                    backend: krypton_encoder::EncoderBackend::SoftwareRust,
                    width: 640,
                    height: 480,
                    target_fps: 30,
                    target_bitrate_kbps: 1000,
                    keyframe_interval: 60,
                };
                let mut encoder = krypton_encoder::create_best_encoder();
                encoder.initialize(&config).expect("encoder initialization failed");

                // Generate real BGRA frame (gradient pattern)
                let mut bgra = Vec::with_capacity(640 * 480 * 4);
                for y in 0..480 {
                    for x in 0..640 {
                        bgra.push((x % 256) as u8);
                        bgra.push((y % 256) as u8);
                        bgra.push(((x + y) % 256) as u8);
                        bgra.push(255);
                    }
                }
                let raw_frame = krypton_capture::RawFrame {
                    width: 640,
                    height: 480,
                    stride: 640 * 4,
                    data: bgra,
                    damage_rects: vec![krypton_capture::DamageRect { x: 0, y: 0, width: 640, height: 480 }],
                    timestamp_ns: 1_000_000,
                    display_id: 0,
                };

                let encoded = encoder.encode_frame(&raw_frame).expect("encode failed");
                assert!(encoded.is_some(), "Expected encoded H.264 packet from raw frame");
                let pkt = encoded.unwrap();
                assert!(!pkt.data.is_empty(), "Encoded packet must not be empty");
                assert!(pkt.is_keyframe, "First encoded frame must be a keyframe");
                assert!(
                    pkt.data.starts_with(&[0, 0, 0, 1]) || pkt.data.starts_with(&[0, 0, 1]),
                    "Must contain Annex-B NAL start code"
                );
                println!("[test] Verified encode pipeline: {} bytes H.264 Annex-B", pkt.data.len());
            }
            Err(e) => {
                panic!("Unexpected capture error: {e}");
            }
        }
    }

    #[test]
    fn test_clipboard_dispatcher_capability_gating() {
        let mut dispatcher = ClipboardDispatcher::with_provider(Box::new(MemoryClipboardProvider::new()));
        assert!(dispatcher.is_permission_granted());

        // Write and read when allowed
        let payload = ClipboardPayload::new("Test Clipboard Text".to_string()).unwrap();
        assert!(dispatcher.inject_remote_clipboard(&payload).is_ok());

        // Revoke capability
        dispatcher.set_permission_granted(false);
        assert!(!dispatcher.is_permission_granted());

        let read_res = dispatcher.poll_local_clipboard();
        assert_eq!(read_res.unwrap_err(), ClipboardError::PermissionDenied);

        let write_res = dispatcher.inject_remote_clipboard(&payload);
        assert_eq!(write_res.unwrap_err(), ClipboardError::PermissionDenied);
    }

    #[test]
    fn test_file_transfer_manager_capability_gating() {
        let temp_dir = std::env::temp_dir().join(format!("krypton_core_ft_{}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        let mut manager = FileTransferManager::new(temp_dir.clone());
        assert!(manager.is_permission_granted());

        // Revoke capability
        manager.set_permission_granted(false);
        assert!(!manager.is_permission_granted());

        let test_file = temp_dir.join("test.bin");
        std::fs::write(&test_file, b"sample content").unwrap();

        let outbound_res = manager.start_outbound_transfer(test_file, "tx-1".to_string());
        assert_eq!(outbound_res.unwrap_err(), FileTransferError::PermissionDenied);

        let meta = TransferMetadata {
            transfer_id: "rx-1".to_string(),
            filename: "file.bin".to_string(),
            file_size_bytes: 100,
            chunk_size: 64 * 1024,
            total_chunks: 1,
            sha256_checksum: "dummy".to_string(),
        };
        let inbound_res = manager.prepare_inbound_transfer(meta);
        assert_eq!(inbound_res.unwrap_err(), FileTransferError::PermissionDenied);

        let _ = std::fs::remove_dir_all(&temp_dir);
    }

    struct MockInputController {
        mouse_events: Vec<MouseAction>,
    }

    impl InputController for MockInputController {
        fn inject_mouse(&mut self, action: MouseAction, _bounds: &DisplayBounds) -> Result<(), String> {
            self.mouse_events.push(action);
            Ok(())
        }
        fn inject_keyboard(&mut self, _action: KeyAction) -> Result<(), String> {
            Ok(())
        }
        fn inject_special_combo(&mut self, _combo: SpecialCombo) -> Result<(), String> {
            Ok(())
        }
    }

    #[test]
    fn test_process_incoming_remote_control_network_dispatch() {
        let mut dispatcher = InputDispatcher::with_controller(Box::new(MockInputController {
            mouse_events: Vec::new(),
        }));
        let bounds = DisplayBounds {
            x: 0,
            y: 0,
            width: 1920,
            height: 1080,
            dpi_scale: 1.0,
        };

        let gate = SessionPermissionGate {
            session_authenticated: true,
            session_accepted: true,
            control_capability_granted: true,
            device_policy_allows_control: true,
        };

        let mouse_move = RemoteControlMessage::MouseMove {
            v: 1,
            x: 0.25,
            y: 0.75,
            display_id: 0,
            sequence: 101,
            timestamp: 1000,
        };
        let raw = serde_json::to_vec(&mouse_move).unwrap();
        assert!(process_incoming_remote_control(&raw, &gate, &mut dispatcher, &bounds).is_ok());

        // Revoke gate
        let unauth_gate = SessionPermissionGate {
            session_authenticated: false,
            ..gate
        };
        assert!(process_incoming_remote_control(&raw, &unauth_gate, &mut dispatcher, &bounds).is_err());
    }

    #[test]
    fn test_process_incoming_remote_clipboard_network_dispatch() {
        let mut dispatcher = ClipboardDispatcher::with_provider(Box::new(MemoryClipboardProvider::new()));
        let msg = RemoteClipboardMessage {
            v: 1,
            text: "Network Clipboard Payload".to_string(),
            content_hash: "hash".to_string(),
            timestamp: 2000,
        };
        let raw = serde_json::to_vec(&msg).unwrap();

        // Allowed bidirectional
        assert!(process_incoming_remote_clipboard(&raw, ClipboardDirectionPolicy::Bidirectional, &mut dispatcher).is_ok());

        // Blocked when policy is disabled or host-to-viewer only
        assert!(process_incoming_remote_clipboard(&raw, ClipboardDirectionPolicy::Disabled, &mut dispatcher).is_err());
        assert!(process_incoming_remote_clipboard(&raw, ClipboardDirectionPolicy::HostToViewer, &mut dispatcher).is_err());
    }

    #[test]
    fn test_process_incoming_file_transfer_network_dispatch() {
        let temp_dir = std::env::temp_dir().join(format!("krypton_net_ft_{}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        let mut manager = FileTransferManager::new(temp_dir.clone());

        let handshake = FileTransferMessage::MetadataHandshake {
            v: 1,
            transfer_id: "tx-net-1".to_string(),
            filename: "safe_file.txt".to_string(),
            file_size_bytes: 4,
            chunk_size: 64 * 1024,
            total_chunks: 1,
            sha256_checksum: "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08".to_string(), // "test"
        };
        let raw = serde_json::to_vec(&handshake).unwrap();
        assert!(process_incoming_file_transfer(&raw, &mut manager).is_ok());

        // Path traversal payload must fail
        let traversal_handshake = FileTransferMessage::MetadataHandshake {
            v: 1,
            transfer_id: "tx-bad".to_string(),
            filename: "../bad.txt".to_string(),
            file_size_bytes: 4,
            chunk_size: 64 * 1024,
            total_chunks: 1,
            sha256_checksum: "dummy".to_string(),
        };
        let bad_raw = serde_json::to_vec(&traversal_handshake).unwrap();
        assert!(process_incoming_file_transfer(&bad_raw, &mut manager).is_err());

        let _ = std::fs::remove_dir_all(&temp_dir);
    }
}
