use serde::{Deserialize, Serialize};
use thiserror::Error;

#[derive(Error, Debug)]
pub enum CaptureError {
    #[error("No displays found")]
    NoDisplaysFound,
    #[error("Display index out of range: {0}")]
    DisplayOutOfRange(usize),
    #[error("Capture initialization failed: {0}")]
    InitFailed(String),
    #[error("Frame capture timeout")]
    Timeout,
    #[error("Access denied — screen capture blocked by OS policy")]
    AccessDenied,
    #[error("D3D11 device creation failed: {0}")]
    D3dError(String),
    #[error("WGC error: {0}")]
    WgcError(String),
    #[error("DXGI error: {0}")]
    DxgiError(String),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DisplayInfo {
    pub id: usize,
    pub name: String,
    pub width: u32,
    pub height: u32,
    pub is_primary: bool,
    pub refresh_rate: u32,
    pub x: i32,
    pub y: i32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct DamageRect {
    pub x: u32,
    pub y: u32,
    pub width: u32,
    pub height: u32,
}

/// Raw frame in BGRA8 format, as produced by DXGI/WGC
pub struct RawFrame {
    pub width: u32,
    pub height: u32,
    /// Row stride in bytes (≥ width * 4 due to alignment)
    pub stride: u32,
    /// BGRA8 pixel data
    pub data: Vec<u8>,
    /// Regions that changed from the previous frame (empty = full frame)
    pub damage_rects: Vec<DamageRect>,
    pub timestamp_ns: u64,
    pub display_id: usize,
}

/// Core capture abstraction. Implementations: WgcCapturer (WGC API) and DxgiCapturer (fallback)
pub trait FrameCapturer: Send + Sync {
    fn enumerate_displays(&self) -> Result<Vec<DisplayInfo>, CaptureError>;
    fn start_capture(&mut self, display_id: usize) -> Result<(), CaptureError>;
    /// Returns None if no new frame is available (same as last frame / no damage)
    fn capture_frame(&mut self) -> Result<Option<RawFrame>, CaptureError>;
    fn stop_capture(&mut self) -> Result<(), CaptureError>;
    fn is_capturing(&self) -> bool;
}

// ─────────────────────────────────────────────────────────────────────────────
// Windows platform implementations
// ─────────────────────────────────────────────────────────────────────────────

#[cfg(windows)]
mod windows_impl;

#[cfg(windows)]
pub use windows_impl::{DxgiCapturer, WgcCapturer};

/// Factory: returns the best available capturer for this machine.
/// Prefers WGC (Windows 10 1903+, GPU-accelerated, low-overhead).
/// Falls back to DXGI Desktop Duplication for older systems.
pub fn create_best_capturer() -> Box<dyn FrameCapturer> {
    #[cfg(windows)]
    {
        // WGC requires Windows 10 build 1903 (≥ 18362)
        if windows_impl::is_wgc_supported() {
            log::info!("[capture] Using Windows.Graphics.Capture (WGC)");
            return Box::new(WgcCapturer::new());
        }
        log::info!("[capture] WGC not supported, using DXGI Desktop Duplication");
        Box::new(DxgiCapturer::new())
    }
    #[cfg(not(windows))]
    {
        panic!("Screen capture is only implemented for Windows targets");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn display_info_serializes() {
        let d = DisplayInfo {
            id: 0,
            name: "DISPLAY1".to_string(),
            width: 1920,
            height: 1080,
            is_primary: true,
            refresh_rate: 60,
            x: 0,
            y: 0,
        };
        let json = serde_json::to_string(&d).unwrap();
        assert!(json.contains("\"width\":1920"));
    }

    #[test]
    fn damage_rect_copy_clone() {
        let r = DamageRect { x: 10, y: 20, width: 100, height: 50 };
        let r2 = r;
        assert_eq!(r, r2);
    }

    /// On Windows, enumerate_displays() must return ≥ 1 monitor.
    #[cfg(windows)]
    #[test]
    fn test_enumerate_displays_returns_at_least_one() {
        let capturer = create_best_capturer();
        let displays = capturer.enumerate_displays().expect("enumerate_displays failed");
        assert!(
            !displays.is_empty(),
            "Expected ≥1 display, got 0"
        );
        let primary = displays.iter().find(|d| d.is_primary);
        assert!(primary.is_some(), "No primary display found");
        let p = primary.unwrap();
        assert!(p.width >= 640 && p.height >= 480, "Primary display too small: {}x{}", p.width, p.height);
        println!("[test] Displays: {:?}", displays);
    }
}
