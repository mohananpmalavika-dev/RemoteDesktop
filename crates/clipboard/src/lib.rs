use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::sync::Mutex;
use thiserror::Error;

#[cfg(windows)]
pub mod windows_impl;

pub const MAX_CLIPBOARD_TEXT_BYTES: usize = 1024 * 1024; // 1 MB limit

#[derive(Error, Debug, PartialEq, Eq)]
pub enum ClipboardError {
    #[error("Failed to open clipboard")]
    OpenFailed,
    #[error("Clipboard data exceeded maximum allowed size")]
    PayloadTooLarge,
    #[error("Failed to read text from clipboard")]
    ReadFailed,
    #[error("Failed to write text to clipboard")]
    WriteFailed,
    #[error("Clipboard access rejected by host: permission denied")]
    PermissionDenied,
}

pub trait ClipboardProvider: Send + Sync {
    fn read_text(&self) -> Result<Option<String>, ClipboardError>;
    fn write_text(&self, text: &str) -> Result<(), ClipboardError>;
}

/// Compute SHA-256 hash of clipboard text for deduplication and loopback suppression
pub fn compute_clipboard_hash(text: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(text.as_bytes());
    hex::encode(hasher.finalize())
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ClipboardPayload {
    pub text: String,
    pub hash: String,
    pub timestamp_ms: u64,
}

impl ClipboardPayload {
    pub fn new(text: String) -> Result<Self, ClipboardError> {
        if text.len() > MAX_CLIPBOARD_TEXT_BYTES {
            return Err(ClipboardError::PayloadTooLarge);
        }
        let hash = compute_clipboard_hash(&text);
        let timestamp_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64;
        Ok(Self {
            text,
            hash,
            timestamp_ms,
        })
    }
}

/// LoopbackFilter tracks recent local and remote hashes to prevent infinite bounce/echo loops
pub struct LoopbackFilter {
    last_local_hash: Mutex<Option<String>>,
    last_remote_hash: Mutex<Option<String>>,
}

impl LoopbackFilter {
    pub fn new() -> Self {
        Self {
            last_local_hash: Mutex::new(None),
            last_remote_hash: Mutex::new(None),
        }
    }

    /// Record a hash received from remote peer and applied to local clipboard
    pub fn record_remote_injected(&self, hash: &str) {
        if let Ok(mut lock) = self.last_remote_hash.lock() {
            *lock = Some(hash.to_string());
        }
    }

    /// Check if a newly read local clipboard content was just injected from remote
    pub fn is_loopback(&self, current_hash: &str) -> bool {
        if let Ok(lock) = self.last_remote_hash.lock() {
            if let Some(remote_hash) = &*lock {
                if remote_hash == current_hash {
                    return true;
                }
            }
        }
        false
    }

    /// Check if the local content has changed since the last local read
    pub fn should_broadcast(&self, current_hash: &str) -> bool {
        if self.is_loopback(current_hash) {
            return false;
        }

        if let Ok(mut lock) = self.last_local_hash.lock() {
            if let Some(prev) = &*lock {
                if prev == current_hash {
                    return false;
                }
            }
            *lock = Some(current_hash.to_string());
            true
        } else {
            false
        }
    }
}

/// In-memory clipboard provider for deterministic unit testing and cross-platform fallback
pub struct MemoryClipboardProvider {
    content: Mutex<Option<String>>,
}

impl MemoryClipboardProvider {
    pub fn new() -> Self {
        Self {
            content: Mutex::new(None),
        }
    }
}

impl ClipboardProvider for MemoryClipboardProvider {
    fn read_text(&self) -> Result<Option<String>, ClipboardError> {
        let guard = self.content.lock().map_err(|_| ClipboardError::ReadFailed)?;
        Ok(guard.clone())
    }

    fn write_text(&self, text: &str) -> Result<(), ClipboardError> {
        if text.len() > MAX_CLIPBOARD_TEXT_BYTES {
            return Err(ClipboardError::PayloadTooLarge);
        }
        let mut guard = self.content.lock().map_err(|_| ClipboardError::WriteFailed)?;
        *guard = Some(text.to_string());
        Ok(())
    }
}

/// Factory function to create the best platform clipboard provider
pub fn create_best_clipboard_provider() -> Box<dyn ClipboardProvider> {
    #[cfg(windows)]
    {
        Box::new(windows_impl::WindowsClipboardProvider::new())
    }
    #[cfg(not(windows))]
    {
        Box::new(MemoryClipboardProvider::new())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_memory_clipboard_read_write() {
        let provider = MemoryClipboardProvider::new();
        assert_eq!(provider.read_text().unwrap(), None);

        let test_text = "Hello Krypton Clipboard!";
        assert!(provider.write_text(test_text).is_ok());
        assert_eq!(provider.read_text().unwrap(), Some(test_text.to_string()));
    }

    #[test]
    fn test_clipboard_payload_size_limit() {
        let oversized = "a".repeat(MAX_CLIPBOARD_TEXT_BYTES + 1);
        let res = ClipboardPayload::new(oversized);
        assert_eq!(res.unwrap_err(), ClipboardError::PayloadTooLarge);
    }

    #[test]
    fn test_loopback_suppression() {
        let filter = LoopbackFilter::new();
        let text = "Remote copied string";
        let hash = compute_clipboard_hash(text);

        // Simulate receiving from remote
        filter.record_remote_injected(&hash);

        // When local clipboard monitor reads it, is_loopback must be true
        assert!(filter.is_loopback(&hash));
        assert!(!filter.should_broadcast(&hash));

        // When user copies something new locally, should_broadcast must be true
        let new_text = "User newly copied string";
        let new_hash = compute_clipboard_hash(new_text);
        assert!(!filter.is_loopback(&new_hash));
        assert!(filter.should_broadcast(&new_hash));

        // Calling should_broadcast again with the exact same hash returns false (dedup)
        assert!(!filter.should_broadcast(&new_hash));
    }

    #[cfg(windows)]
    #[test]
    fn test_windows_clipboard_provider_roundtrip() {
        let provider = windows_impl::WindowsClipboardProvider::new();
        let unique_token = format!("krypton-test-{}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos());

        // Write to real Windows clipboard
        let write_res = provider.write_text(&unique_token);
        if let Ok(()) = write_res {
            let read_res = provider.read_text();
            assert!(read_res.is_ok());
            if let Some(text) = read_res.unwrap() {
                assert_eq!(text, unique_token);
            }
        }
    }
}
