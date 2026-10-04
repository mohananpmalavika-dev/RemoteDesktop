use krypton_capture::RawFrame;
use serde::{Deserialize, Serialize};
use thiserror::Error;
use std::time::{Duration, Instant};

#[derive(Error, Debug)]
pub enum EncoderError {
    #[error("Initialization failed: {0}")]
    InitFailed(String),
    #[error("Encoding error: {0}")]
    EncodeError(String),
    #[error("Unsupported codec")]
    UnsupportedCodec,
    #[error("Not initialized")]
    NotInitialized,
    #[error("Colorspace conversion failed: {0}")]
    ColorspaceError(String),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum VideoCodec {
    H264,
    VP8,
    AV1,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum EncoderBackend {
    SoftwareRust,
    Nvenc,
    IntelQsv,
    AmdAmf,
    MediaFoundation,
}

impl EncoderBackend {
    /// Detects hardware and system encoder backends available on the host machine.
    pub fn detect_available_backends() -> Vec<EncoderBackend> {
        let mut backends = Vec::new();

        #[cfg(windows)]
        {
            // Probe NVENC (NVIDIA GPU driver)
            if std::path::Path::new("C:\\Windows\\System32\\nvencodeapi64.dll").exists() {
                backends.push(EncoderBackend::Nvenc);
            }
            // Probe AMD AMF (AMD GPU driver)
            if std::path::Path::new("C:\\Windows\\System32\\amfrt64.dll").exists() {
                backends.push(EncoderBackend::AmdAmf);
            }
            // Probe Intel QSV (Intel Graphics driver)
            if std::path::Path::new("C:\\Windows\\System32\\libmfx64-gen.dll").exists()
                || std::path::Path::new("C:\\Windows\\System32\\mfxplugin64_hw.dll").exists()
            {
                backends.push(EncoderBackend::IntelQsv);
            }
            // Probe Windows Media Foundation
            if std::path::Path::new("C:\\Windows\\System32\\mfplat.dll").exists() {
                backends.push(EncoderBackend::MediaFoundation);
            }
        }

        // Software pure-Rust H.264 is always available across all platforms
        backends.push(EncoderBackend::SoftwareRust);
        backends
    }

    pub fn best_available() -> Self {
        let detected = Self::detect_available_backends();
        *detected.first().unwrap_or(&EncoderBackend::SoftwareRust)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EncoderConfig {
    pub codec: VideoCodec,
    pub backend: EncoderBackend,
    pub width: u32,
    pub height: u32,
    pub target_fps: u32,
    pub target_bitrate_kbps: u32,
    pub keyframe_interval: u32,
}

pub struct EncodedPacket {
    pub data: Vec<u8>,
    pub is_keyframe: bool,
    pub pts_ns: u64,
    pub width: u32,
    pub height: u32,
}

pub trait VideoEncoder: Send + Sync {
    fn initialize(&mut self, config: &EncoderConfig) -> Result<(), EncoderError>;
    /// Returns None if no bytes were emitted (lookahead buffering)
    fn encode_frame(&mut self, frame: &RawFrame) -> Result<Option<EncodedPacket>, EncoderError>;
    fn update_bitrate(&mut self, bitrate_kbps: u32) -> Result<(), EncoderError>;
    fn request_keyframe(&mut self);
    fn codec(&self) -> VideoCodec;
    fn backend(&self) -> EncoderBackend;
    fn is_initialized(&self) -> bool;
}

// ─────────────────────────────────────────────────────────────────────────────
// BGRA → YUV420 Colorspace Conversion (BT.601 studio swing)
// ─────────────────────────────────────────────────────────────────────────────

/// Convert a BGRA8 frame (as produced by DXGI Desktop Duplication) to planar
/// YCbCr 4:2:0 (I420) as required by rusty_h264.
///
/// Output planes:
///  - Y:  width × height bytes
///  - Cb: (width/2) × (height/2) bytes
///  - Cr: (width/2) × (height/2) bytes
pub fn bgra_to_yuv420(
    bgra: &[u8],
    stride: u32,
    width: u32,
    height: u32,
) -> Result<(Vec<u8>, Vec<u8>, Vec<u8>), EncoderError> {
    let w = width as usize;
    let h = height as usize;
    let stride = stride as usize;

    if bgra.len() < stride * h {
        return Err(EncoderError::ColorspaceError(format!(
            "Buffer too small: got {} bytes, expected at least {}",
            bgra.len(), stride * h
        )));
    }

    let mut y_plane = vec![0u8; w * h];
    let mut u_plane = vec![0u8; (w / 2) * (h / 2)];
    let mut v_plane = vec![0u8; (w / 2) * (h / 2)];

    for row in 0..h {
        for col in 0..w {
            let idx = row * stride + col * 4;
            let b = bgra[idx] as f32;
            let g = bgra[idx + 1] as f32;
            let r = bgra[idx + 2] as f32;

            // BT.601 studio swing (Y: 16-235, UV: 16-240)
            let y = 16.0 + 0.25679 * r + 0.50413 * g + 0.09791 * b;
            y_plane[row * w + col] = y.clamp(16.0, 235.0) as u8;

            if row % 2 == 0 && col % 2 == 0 {
                let u = 128.0 - 0.14822 * r - 0.29099 * g + 0.43921 * b;
                let v = 128.0 + 0.43921 * r - 0.36779 * g - 0.07142 * b;
                let uv_idx = (row / 2) * (w / 2) + (col / 2);
                u_plane[uv_idx] = u.clamp(16.0, 240.0) as u8;
                v_plane[uv_idx] = v.clamp(16.0, 240.0) as u8;
            }
        }
    }

    Ok((y_plane, u_plane, v_plane))
}

// ─────────────────────────────────────────────────────────────────────────────
// H.264 Encoder via rusty_h264 (pure Rust — no native deps)
// ─────────────────────────────────────────────────────────────────────────────

use rusty_h264::{Encoder as RustyEncoder, EncoderConfig as RustyConfig, YuvFrame, Preset};

pub struct H264Encoder {
    inner: Option<RustyEncoder>,
    config: Option<EncoderConfig>,
    force_keyframe: bool,
    frame_count: u64,
}

impl H264Encoder {
    pub fn new() -> Self {
        Self {
            inner: None,
            config: None,
            force_keyframe: false,
            frame_count: 0,
        }
    }

    /// Build a rusty_h264 EncoderConfig from our config.
    fn make_rusty_config(config: &EncoderConfig) -> RustyConfig {
        let mut cfg = RustyConfig::new(config.width as usize, config.height as usize);
        cfg.gop_size = config.keyframe_interval;
        cfg.min_keyint = 1;
        cfg.bitrate = config.target_bitrate_kbps * 1000; // kbps → bps
        cfg.preset = Preset::Fast;
        cfg.scenecut = 40;
        cfg
    }
}

impl Default for H264Encoder {
    fn default() -> Self { Self::new() }
}

impl VideoEncoder for H264Encoder {
    fn initialize(&mut self, config: &EncoderConfig) -> Result<(), EncoderError> {
        if config.codec != VideoCodec::H264 {
            return Err(EncoderError::UnsupportedCodec);
        }

        let rusty_cfg = Self::make_rusty_config(config);
        let encoder = RustyEncoder::new(rusty_cfg)
            .map_err(|e| EncoderError::InitFailed(format!("Encoder::new: {e:?}")))?;

        self.inner = Some(encoder);
        self.config = Some(config.clone());
        self.frame_count = 0;
        self.force_keyframe = false;

        log::info!(
            "[encoder] H.264 initialized (backend={:?}) {}x{} @{}fps {}kbps keyint={}",
            config.backend, config.width, config.height, config.target_fps,
            config.target_bitrate_kbps, config.keyframe_interval
        );
        Ok(())
    }

    fn encode_frame(&mut self, frame: &RawFrame) -> Result<Option<EncodedPacket>, EncoderError> {
        let encoder = self.inner.as_mut().ok_or(EncoderError::NotInitialized)?;
        let config = self.config.as_ref().unwrap();

        if self.force_keyframe {
            self.force_keyframe = false;
            let new_cfg = Self::make_rusty_config(config);
            match RustyEncoder::new(new_cfg) {
                Ok(e) => { *encoder = e; }
                Err(err) => log::warn!("[encoder] force_keyframe reinit failed: {err:?}"),
            }
        }

        let (y, u, v) = bgra_to_yuv420(&frame.data, frame.stride, frame.width, frame.height)?;

        let yuv = YuvFrame {
            width: frame.width as usize,
            height: frame.height as usize,
            y, u, v,
        };

        let data = encoder.encode(&yuv);
        self.frame_count += 1;

        if data.is_empty() {
            return Ok(None);
        }

        let is_keyframe = self.frame_count == 1
            || self.frame_count % config.keyframe_interval as u64 == 0;

        Ok(Some(EncodedPacket {
            data,
            is_keyframe,
            pts_ns: frame.timestamp_ns,
            width: frame.width,
            height: frame.height,
        }))
    }

    fn update_bitrate(&mut self, bitrate_kbps: u32) -> Result<(), EncoderError> {
        let mut config = self.config.clone().ok_or(EncoderError::NotInitialized)?;
        config.target_bitrate_kbps = bitrate_kbps;
        self.initialize(&config)?;
        log::debug!("[encoder] Bitrate updated to {bitrate_kbps}kbps via reinit");
        Ok(())
    }

    fn request_keyframe(&mut self) {
        self.force_keyframe = true;
        log::debug!("[encoder] Keyframe requested");
    }

    fn codec(&self) -> VideoCodec { VideoCodec::H264 }
    fn backend(&self) -> EncoderBackend {
        self.config.as_ref().map(|c| c.backend).unwrap_or(EncoderBackend::SoftwareRust)
    }
    fn is_initialized(&self) -> bool { self.inner.is_some() }
}

// ─────────────────────────────────────────────────────────────────────────────
// P1.3: Adaptive Quality Controller with Hysteresis & Cooldowns
// ─────────────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum QualityTier {
    Low,
    Medium,
    High,
    Ultra,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QualityReport {
    pub current_bitrate_kbps: u32,
    pub current_fps: u32,
    pub tier: QualityTier,
    pub rtt_ms: u32,
    pub packet_loss_pct: f32,
}

pub struct AdaptiveQualityController {
    min_bitrate_kbps: u32,
    max_bitrate_kbps: u32,
    current_bitrate_kbps: u32,
    min_fps: u32,
    max_fps: u32,
    current_fps: u32,
    last_adjustment: Instant,
    cooldown_period: Duration,
    healthy_streak: u32,
    required_healthy_streak_for_upstep: u32,
}

impl AdaptiveQualityController {
    pub fn new(initial_bitrate_kbps: u32, initial_fps: u32) -> Self {
        Self {
            min_bitrate_kbps: 400,
            max_bitrate_kbps: 12000,
            current_bitrate_kbps: initial_bitrate_kbps.clamp(400, 12000),
            min_fps: 15,
            max_fps: 60,
            current_fps: initial_fps.clamp(15, 60),
            last_adjustment: Instant::now() - Duration::from_secs(10), // allow immediate first adjustment
            cooldown_period: Duration::from_secs(3),
            healthy_streak: 0,
            required_healthy_streak_for_upstep: 4,
        }
    }

    /// Evaluates network telemetry (RTT and packet loss) and updates bitrate/fps.
    /// Returns true if parameters changed and encoder needs update.
    pub fn on_network_telemetry(&mut self, rtt_ms: u32, packet_loss_pct: f32) -> bool {
        let now = Instant::now();

        // Downstep immediately if severe degradation detected (Loss > 3% or RTT > 200ms)
        let is_severely_degraded = packet_loss_pct > 3.0 || rtt_ms > 220;
        let is_mildly_degraded = packet_loss_pct > 1.2 || rtt_ms > 140;

        if is_severely_degraded {
            self.healthy_streak = 0;
            if now.duration_since(self.last_adjustment) >= Duration::from_secs(1) {
                // Aggressive 35% cut
                let new_bitrate = (self.current_bitrate_kbps as f32 * 0.65) as u32;
                self.current_bitrate_kbps = new_bitrate.max(self.min_bitrate_kbps);
                if self.current_fps > 30 {
                    self.current_fps = 30;
                } else if self.current_fps > 15 && packet_loss_pct > 5.0 {
                    self.current_fps = 15;
                }
                self.last_adjustment = now;
                return true;
            }
            return false;
        }

        if is_mildly_degraded {
            self.healthy_streak = 0;
            if now.duration_since(self.last_adjustment) >= self.cooldown_period {
                // Gentle 15% reduction
                let new_bitrate = (self.current_bitrate_kbps as f32 * 0.85) as u32;
                self.current_bitrate_kbps = new_bitrate.max(self.min_bitrate_kbps);
                self.last_adjustment = now;
                return true;
            }
            return false;
        }

        // Network is healthy (Loss <= 1.0% and RTT <= 100ms)
        if packet_loss_pct <= 0.5 && rtt_ms <= 90 {
            self.healthy_streak += 1;
            if self.healthy_streak >= self.required_healthy_streak_for_upstep
                && now.duration_since(self.last_adjustment) >= self.cooldown_period
            {
                if self.current_bitrate_kbps < self.max_bitrate_kbps || self.current_fps < self.max_fps {
                    // Gradual 15% recovery upstep
                    let new_bitrate = (self.current_bitrate_kbps as f32 * 1.15) as u32;
                    self.current_bitrate_kbps = new_bitrate.min(self.max_bitrate_kbps);

                    if self.current_bitrate_kbps >= 3000 && self.current_fps < 60 {
                        self.current_fps = (self.current_fps + 15).min(self.max_fps);
                    }

                    self.healthy_streak = 0;
                    self.last_adjustment = now;
                    return true;
                }
            }
        }

        false
    }

    pub fn current_tier(&self) -> QualityTier {
        if self.current_bitrate_kbps >= 6000 && self.current_fps >= 60 {
            QualityTier::Ultra
        } else if self.current_bitrate_kbps >= 2500 {
            QualityTier::High
        } else if self.current_bitrate_kbps >= 1200 {
            QualityTier::Medium
        } else {
            QualityTier::Low
        }
    }

    pub fn current_bitrate(&self) -> u32 {
        self.current_bitrate_kbps
    }

    pub fn current_fps(&self) -> u32 {
        self.current_fps
    }

    pub fn min_fps(&self) -> u32 {
        self.min_fps
    }

    pub fn max_fps(&self) -> u32 {
        self.max_fps
    }

    pub fn get_report(&self, rtt_ms: u32, packet_loss_pct: f32) -> QualityReport {
        QualityReport {
            current_bitrate_kbps: self.current_bitrate_kbps,
            current_fps: self.current_fps,
            tier: self.current_tier(),
            rtt_ms,
            packet_loss_pct,
        }
    }
}

/// Factory: returns the best available encoder for this platform.
pub fn create_best_encoder() -> Box<dyn VideoEncoder> {
    Box::new(H264Encoder::new())
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn make_bgra_frame(width: u32, height: u32, r: u8, g: u8, b: u8) -> RawFrame {
        let stride = width * 4;
        let mut data = vec![0u8; (stride * height) as usize];
        for i in (0..data.len()).step_by(4) {
            data[i] = b;
            data[i + 1] = g;
            data[i + 2] = r;
            data[i + 3] = 0xFF;
        }
        RawFrame {
            width, height, stride, data,
            damage_rects: vec![],
            timestamp_ns: 1_000_000_000,
            display_id: 0,
        }
    }

    fn make_config(w: u32, h: u32) -> EncoderConfig {
        EncoderConfig {
            codec: VideoCodec::H264,
            backend: EncoderBackend::SoftwareRust,
            width: w, height: h,
            target_fps: 30,
            target_bitrate_kbps: 1000,
            keyframe_interval: 30,
        }
    }

    #[test]
    fn test_backend_detection() {
        let backends = EncoderBackend::detect_available_backends();
        assert!(!backends.is_empty(), "Must detect at least 1 encoder backend");
        assert!(backends.contains(&EncoderBackend::SoftwareRust), "Must contain pure-Rust fallback");
    }

    #[test]
    fn test_adaptive_quality_downstep_on_packet_loss() {
        let mut controller = AdaptiveQualityController::new(4000, 60);
        assert_eq!(controller.current_bitrate(), 4000);

        // Simulate high loss (5%)
        let changed = controller.on_network_telemetry(45, 5.2);
        assert!(changed, "Must trigger downstep on high packet loss");
        assert!(controller.current_bitrate() < 4000, "Bitrate must decrease");
        assert_eq!(controller.current_fps(), 30, "FPS should drop to 30 on high loss");
    }

    #[test]
    fn test_adaptive_quality_hysteresis_and_cooldown() {
        let mut controller = AdaptiveQualityController::new(2000, 30);
        controller.last_adjustment = Instant::now(); // inside cooldown!

        // Single healthy report during cooldown should NOT upstep
        let changed = controller.on_network_telemetry(25, 0.0);
        assert!(!changed, "Report during cooldown must not trigger upstep");

        // Advance past cooldown and reset streak
        controller.last_adjustment = Instant::now() - Duration::from_secs(5);
        controller.healthy_streak = 0;

        assert!(!controller.on_network_telemetry(25, 0.0), "Streak 1 should not trigger upstep");
        assert!(!controller.on_network_telemetry(25, 0.0), "Streak 2 should not trigger upstep");
        assert!(!controller.on_network_telemetry(25, 0.0), "Streak 3 should not trigger upstep");
        let changed_4th = controller.on_network_telemetry(25, 0.0);
        assert!(changed_4th, "4th consecutive healthy report should trigger upstep");
        assert!(controller.current_bitrate() > 2000, "Bitrate should increase");
    }

    #[test]
    fn test_bgra_yuv_dimensions() {
        let w = 64u32; let h = 48u32;
        let bgra = vec![0x80u8, 0x80, 0x80, 0xFF].repeat((w * h) as usize);
        let (y, u, v) = bgra_to_yuv420(&bgra, w * 4, w, h).unwrap();
        assert_eq!(y.len(), (w * h) as usize);
        assert_eq!(u.len(), (w / 2 * h / 2) as usize);
        assert_eq!(v.len(), (w / 2 * h / 2) as usize);
    }

    #[test]
    fn test_black_frame_y_near_16() {
        let w = 64u32; let h = 48u32;
        let bgra = vec![0u8; (w * h * 4) as usize];
        let (y, u, v) = bgra_to_yuv420(&bgra, w * 4, w, h).unwrap();
        for &luma in &y {
            assert!(luma >= 14 && luma <= 20, "Y={luma} out of range for black");
        }
        for &chroma in u.iter().chain(v.iter()) {
            assert!(chroma >= 120 && chroma <= 136, "UV={chroma} out of range for grey");
        }
    }

    #[test]
    fn test_h264_encoder_initialize() {
        let mut enc = H264Encoder::new();
        assert!(!enc.is_initialized());
        enc.initialize(&make_config(320, 240)).expect("H.264 init failed");
        assert!(enc.is_initialized());
        assert_eq!(enc.codec(), VideoCodec::H264);
    }

    #[test]
    fn test_h264_wrong_codec_rejected() {
        let mut enc = H264Encoder::new();
        let config = EncoderConfig {
            codec: VideoCodec::VP8,
            backend: EncoderBackend::SoftwareRust,
            width: 320, height: 240,
            target_fps: 30,
            target_bitrate_kbps: 1000,
            keyframe_interval: 30,
        };
        assert!(matches!(enc.initialize(&config), Err(EncoderError::UnsupportedCodec)));
    }

    #[test]
    fn test_h264_encode_produces_annexb() {
        let mut enc = H264Encoder::new();
        enc.initialize(&make_config(320, 240)).unwrap();

        let frame = make_bgra_frame(320, 240, 0, 0, 0);
        let mut got_packet = false;
        for _ in 0..5 {
            if let Ok(Some(pkt)) = enc.encode_frame(&frame) {
                assert!(!pkt.data.is_empty());
                assert_eq!(&pkt.data[0..4], &[0, 0, 0, 1], "Missing Annex-B start code");
                got_packet = true;
                break;
            }
        }
        assert!(got_packet, "Expected at least one encoded packet within 5 frames");
    }

    #[test]
    fn test_encoder_not_initialized_returns_error() {
        let mut enc = H264Encoder::new();
        let frame = make_bgra_frame(320, 240, 0, 0, 0);
        assert!(matches!(enc.encode_frame(&frame), Err(EncoderError::NotInitialized)));
    }

    #[test]
    fn test_update_bitrate_reinits_encoder() {
        let mut enc = H264Encoder::new();
        enc.initialize(&make_config(320, 240)).unwrap();
        enc.update_bitrate(4000).expect("update_bitrate failed");
        assert!(enc.is_initialized());
    }

    #[test]
    fn test_request_keyframe_sets_flag() {
        let mut enc = H264Encoder::new();
        enc.initialize(&make_config(320, 240)).unwrap();
        enc.request_keyframe();
        assert!(enc.force_keyframe, "force_keyframe flag not set");
    }
}
