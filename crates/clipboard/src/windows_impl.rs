use super::{ClipboardError, ClipboardProvider, MAX_CLIPBOARD_TEXT_BYTES};

#[cfg(windows)]
pub struct WindowsClipboardProvider;

#[cfg(windows)]
impl WindowsClipboardProvider {
    pub fn new() -> Self {
        Self
    }
}

#[cfg(windows)]
impl ClipboardProvider for WindowsClipboardProvider {
    fn read_text(&self) -> Result<Option<String>, ClipboardError> {
        use std::ptr;
        use windows::Win32::Foundation::{HGLOBAL, HWND};
        use windows::Win32::System::DataExchange::{CloseClipboard, GetClipboardData, OpenClipboard};
        use windows::Win32::System::Memory::{GlobalLock, GlobalUnlock};

        const CF_UNICODETEXT: u32 = 13;

        // Try opening clipboard with retries (up to 5 times with 10ms delay for lock contention)
        let mut opened = false;
        for _ in 0..5 {
            unsafe {
                if OpenClipboard(HWND(ptr::null_mut())).is_ok() {
                    opened = true;
                    break;
                }
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }

        if !opened {
            return Err(ClipboardError::OpenFailed);
        }

        // Ensure CloseClipboard is called even if reading errors
        struct ClipboardGuard;
        impl Drop for ClipboardGuard {
            fn drop(&mut self) {
                unsafe {
                    let _ = CloseClipboard();
                }
            }
        }
        let _guard = ClipboardGuard;

        unsafe {
            let handle_res = GetClipboardData(CF_UNICODETEXT);
            let handle = match handle_res {
                Ok(h) if !h.0.is_null() => h,
                _ => return Ok(None), // No Unicode text in clipboard
            };

            let ptr = GlobalLock(HGLOBAL(handle.0 as _));
            if ptr.is_null() {
                return Err(ClipboardError::ReadFailed);
            }

            // Find null terminator for UTF-16 slice
            let u16_ptr = ptr as *const u16;
            let mut len = 0usize;
            while *u16_ptr.add(len) != 0 {
                len += 1;
                // Bound check against max size
                if len * 2 > MAX_CLIPBOARD_TEXT_BYTES {
                    let _ = GlobalUnlock(HGLOBAL(handle.0 as _));
                    return Err(ClipboardError::PayloadTooLarge);
                }
            }

            let slice = std::slice::from_raw_parts(u16_ptr, len);
            let result = String::from_utf16(slice).map_err(|_| ClipboardError::ReadFailed);
            let _ = GlobalUnlock(HGLOBAL(handle.0 as _));

            result.map(Some)
        }
    }

    fn write_text(&self, text: &str) -> Result<(), ClipboardError> {
        use std::ptr;
        use windows::Win32::Foundation::{HANDLE, HGLOBAL, HWND};
        use windows::Win32::System::DataExchange::{
            CloseClipboard, EmptyClipboard, OpenClipboard, SetClipboardData,
        };
        use windows::Win32::System::Memory::{
            GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE,
        };

        if text.len() > MAX_CLIPBOARD_TEXT_BYTES {
            return Err(ClipboardError::PayloadTooLarge);
        }

        const CF_UNICODETEXT: u32 = 13;

        let mut opened = false;
        for _ in 0..5 {
            unsafe {
                if OpenClipboard(HWND(ptr::null_mut())).is_ok() {
                    opened = true;
                    break;
                }
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }

        if !opened {
            return Err(ClipboardError::OpenFailed);
        }

        struct ClipboardGuard;
        impl Drop for ClipboardGuard {
            fn drop(&mut self) {
                unsafe {
                    let _ = CloseClipboard();
                }
            }
        }
        let _guard = ClipboardGuard;

        unsafe {
            if EmptyClipboard().is_err() {
                return Err(ClipboardError::WriteFailed);
            }

            // Convert to null-terminated UTF-16
            let utf16: Vec<u16> = text.encode_utf16().chain(std::iter::once(0)).collect();
            let size_bytes = utf16.len() * std::mem::size_of::<u16>();

            let h_mem = match GlobalAlloc(GMEM_MOVEABLE, size_bytes) {
                Ok(h) if !h.0.is_null() => h,
                _ => return Err(ClipboardError::WriteFailed),
            };

            let ptr = GlobalLock(HGLOBAL(h_mem.0 as _));
            if ptr.is_null() {
                return Err(ClipboardError::WriteFailed);
            }

            ptr::copy_nonoverlapping(utf16.as_ptr() as *const u8, ptr as *mut u8, size_bytes);
            let _ = GlobalUnlock(HGLOBAL(h_mem.0 as _));

            if SetClipboardData(CF_UNICODETEXT, HANDLE(h_mem.0)).is_err() {
                return Err(ClipboardError::WriteFailed);
            }

            Ok(())
        }
    }
}
