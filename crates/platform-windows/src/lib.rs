use serde::{Deserialize, Serialize};
use thiserror::Error;
use std::sync::atomic::{AtomicU64, Ordering};

#[derive(Error, Debug, PartialEq, Eq)]
pub enum PlatformError {
    #[error("Failed to query process elevation: {0}")]
    ElevationQueryFailed(String),
    #[error("Failed to query system metrics: {0}")]
    MetricsQueryFailed(String),
    #[error("Service control manager error: {0}")]
    ServiceError(String),
    #[error("Operation not supported on this platform")]
    UnsupportedPlatform,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct WindowsSystemInfo {
    pub os_name: String,
    pub os_version: String,
    pub arch: String,
    pub computer_name: String,
    pub monitor_count: u32,
    pub is_elevated: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct LiveSystemTelemetry {
    pub cpu_load_pct: f32,
    pub total_ram_mb: u64,
    pub available_ram_mb: u64,
    pub ram_usage_pct: u32,
    pub total_disk_gb: u64,
    pub free_disk_gb: u64,
    pub active_console_session_id: u32,
    pub is_elevated: bool,
}

static LAST_IDLE_TIME: AtomicU64 = AtomicU64::new(0);
static LAST_KERNEL_TIME: AtomicU64 = AtomicU64::new(0);
static LAST_USER_TIME: AtomicU64 = AtomicU64::new(0);

/// Checks if current process is running with Administrator / UAC elevated privileges
pub fn is_process_elevated() -> Result<bool, PlatformError> {
    #[cfg(windows)]
    {
        use std::mem::size_of;
        use windows::Win32::Foundation::{CloseHandle, HANDLE};
        use windows::Win32::Security::{
            GetTokenInformation, TokenElevation, TOKEN_ELEVATION, TOKEN_QUERY,
        };
        use windows::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

        unsafe {
            let mut token: HANDLE = HANDLE(std::ptr::null_mut());
            if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token).is_err() {
                return Err(PlatformError::ElevationQueryFailed("OpenProcessToken failed".into()));
            }

            struct TokenGuard(HANDLE);
            impl Drop for TokenGuard {
                fn drop(&mut self) {
                    unsafe {
                        let _ = CloseHandle(self.0);
                    }
                }
            }
            let _guard = TokenGuard(token);

            let mut elevation = TOKEN_ELEVATION { TokenIsElevated: 0 };
            let mut returned_size = 0u32;

            if GetTokenInformation(
                token,
                TokenElevation,
                Some(&mut elevation as *mut _ as *mut _),
                size_of::<TOKEN_ELEVATION>() as u32,
                &mut returned_size,
            ).is_err() {
                return Err(PlatformError::ElevationQueryFailed("GetTokenInformation failed".into()));
            }

            Ok(elevation.TokenIsElevated != 0)
        }
    }
    #[cfg(not(windows))]
    {
        Ok(false)
    }
}

/// Returns dynamic Windows system telemetry including real monitor count and elevation
pub fn get_windows_system_info() -> WindowsSystemInfo {
    let is_elevated = is_process_elevated().unwrap_or(false);

    #[cfg(windows)]
    let monitor_count = {
        use windows::Win32::UI::WindowsAndMessaging::{GetSystemMetrics, SM_CMONITORS};
        unsafe {
            let count = GetSystemMetrics(SM_CMONITORS);
            if count > 0 { count as u32 } else { 1 }
        }
    };
    #[cfg(not(windows))]
    let monitor_count = 1;

    let computer_name = std::env::var("COMPUTERNAME").unwrap_or_else(|_| "Windows-Host".to_string());

    WindowsSystemInfo {
        os_name: "Windows".to_string(),
        os_version: std::env::consts::OS.to_string(),
        arch: std::env::consts::ARCH.to_string(),
        computer_name,
        monitor_count,
        is_elevated,
    }
}

/// Retrieves live CPU, RAM, disk, and console session telemetry using native Win32 APIs
pub fn get_live_system_telemetry() -> LiveSystemTelemetry {
    let is_elevated = is_process_elevated().unwrap_or(false);

    #[cfg(windows)]
    {
        use windows::Win32::Foundation::FILETIME;
        use windows::Win32::System::Threading::GetSystemTimes;
        use windows::Win32::System::SystemInformation::{GlobalMemoryStatusEx, MEMORYSTATUSEX};
        use windows::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;
        use windows::Win32::System::RemoteDesktop::WTSGetActiveConsoleSessionId;

        // 1. RAM via GlobalMemoryStatusEx
        let mut mem_status = MEMORYSTATUSEX {
            dwLength: std::mem::size_of::<MEMORYSTATUSEX>() as u32,
            dwMemoryLoad: 0,
            ullTotalPhys: 0,
            ullAvailPhys: 0,
            ullTotalPageFile: 0,
            ullAvailPageFile: 0,
            ullTotalVirtual: 0,
            ullAvailVirtual: 0,
            ullAvailExtendedVirtual: 0,
        };
        let _ = unsafe { GlobalMemoryStatusEx(&mut mem_status) };

        let total_ram_mb = mem_status.ullTotalPhys / (1024 * 1024);
        let available_ram_mb = mem_status.ullAvailPhys / (1024 * 1024);
        let ram_usage_pct = mem_status.dwMemoryLoad;

        // 2. CPU via GetSystemTimes
        let mut idle_time = FILETIME::default();
        let mut kernel_time = FILETIME::default();
        let mut user_time = FILETIME::default();

        let cpu_load_pct = unsafe {
            if GetSystemTimes(Some(&mut idle_time), Some(&mut kernel_time), Some(&mut user_time)).is_ok() {
                let idle = ((idle_time.dwHighDateTime as u64) << 32) | (idle_time.dwLowDateTime as u64);
                let kernel = ((kernel_time.dwHighDateTime as u64) << 32) | (kernel_time.dwLowDateTime as u64);
                let user = ((user_time.dwHighDateTime as u64) << 32) | (user_time.dwLowDateTime as u64);

                let prev_idle = LAST_IDLE_TIME.swap(idle, Ordering::Relaxed);
                let prev_kernel = LAST_KERNEL_TIME.swap(kernel, Ordering::Relaxed);
                let prev_user = LAST_USER_TIME.swap(user, Ordering::Relaxed);

                if prev_kernel > 0 && prev_user > 0 {
                    let total_delta = (kernel - prev_kernel) + (user - prev_user);
                    let idle_delta = idle.saturating_sub(prev_idle);
                    if total_delta > 0 {
                        let active = total_delta.saturating_sub(idle_delta);
                        ((active as f64 / total_delta as f64) * 100.0).clamp(0.0, 100.0) as f32
                    } else {
                        0.0
                    }
                } else {
                    12.5 // Initial baseline estimate
                }
            } else {
                0.0
            }
        };

        // 3. Disk space on SystemDrive (typically C:\)
        let mut free_bytes_avail = 0u64;
        let mut total_bytes = 0u64;
        let mut total_free_bytes = 0u64;

        let root_path: Vec<u16> = "C:\\\0".encode_utf16().collect();
        let _ = unsafe {
            GetDiskFreeSpaceExW(
                windows::core::PCWSTR::from_raw(root_path.as_ptr()),
                Some(&mut free_bytes_avail),
                Some(&mut total_bytes),
                Some(&mut total_free_bytes),
            )
        };

        let total_disk_gb = total_bytes / (1024 * 1024 * 1024);
        let free_disk_gb = free_bytes_avail / (1024 * 1024 * 1024);

        // 4. Active Console Session ID
        let active_console_session_id = unsafe { WTSGetActiveConsoleSessionId() };

        LiveSystemTelemetry {
            cpu_load_pct,
            total_ram_mb,
            available_ram_mb,
            ram_usage_pct,
            total_disk_gb,
            free_disk_gb,
            active_console_session_id,
            is_elevated,
        }
    }

    #[cfg(not(windows))]
    {
        LiveSystemTelemetry {
            cpu_load_pct: 10.0,
            total_ram_mb: 16384,
            available_ram_mb: 8192,
            ram_usage_pct: 50,
            total_disk_gb: 512,
            free_disk_gb: 256,
            active_console_session_id: 1,
            is_elevated,
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// System Tray Manager
// ─────────────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum TrayState {
    Idle,
    Connected { active_sessions: u32 },
    EmergencyLocked,
}

pub struct SystemTrayManager {
    state: TrayState,
    tooltip: String,
}

impl SystemTrayManager {
    pub fn new() -> Self {
        Self {
            state: TrayState::Idle,
            tooltip: "KryptonRemote - Ready for connections".to_string(),
        }
    }

    pub fn state(&self) -> TrayState {
        self.state
    }

    pub fn tooltip(&self) -> &str {
        &self.tooltip
    }

    pub fn set_connected(&mut self, active_sessions: u32) {
        self.state = TrayState::Connected { active_sessions };
        self.tooltip = format!("KryptonRemote - {active_sessions} Active Remote Session(s)");
    }

    pub fn set_idle(&mut self) {
        self.state = TrayState::Idle;
        self.tooltip = "KryptonRemote - Ready for connections".to_string();
    }

    pub fn emergency_disconnect(&mut self) {
        self.state = TrayState::EmergencyLocked;
        self.tooltip = "KryptonRemote - Emergency Disconnected by Host".to_string();
    }
}

impl Default for SystemTrayManager {
    fn default() -> Self {
        Self::new()
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Windows Service Controller (Unattended Host Agent)
// ─────────────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ServiceAction {
    Install,
    Uninstall,
    Start,
    Stop,
    Status,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum ServiceState {
    Stopped,
    Starting,
    Running,
    Paused,
    Unknown,
}

pub struct WindowsServiceManager {
    service_name: String,
    display_name: String,
}

impl WindowsServiceManager {
    pub fn new(service_name: impl Into<String>, display_name: impl Into<String>) -> Self {
        Self {
            service_name: service_name.into(),
            display_name: display_name.into(),
        }
    }

    pub fn service_name(&self) -> &str {
        &self.service_name
    }

    pub fn display_name(&self) -> &str {
        &self.display_name
    }

    /// Queries the service status directly via Win32 Service Control Manager (SCM)
    #[cfg(windows)]
    pub fn query_service_state(&self) -> Result<ServiceState, PlatformError> {
        use windows::Win32::System::Services::{
            OpenSCManagerW, OpenServiceW, QueryServiceStatus, CloseServiceHandle,
            SC_MANAGER_CONNECT, SERVICE_QUERY_STATUS, SERVICE_STATUS,
            SERVICE_RUNNING, SERVICE_STOPPED, SERVICE_START_PENDING, SERVICE_PAUSED,
        };

        unsafe {
            let scm = OpenSCManagerW(None, None, SC_MANAGER_CONNECT)
                .map_err(|e| PlatformError::ServiceError(format!("OpenSCManagerW failed: {e}")))?;

            let service_name_w: Vec<u16> = self.service_name.encode_utf16().chain(std::iter::once(0)).collect();
            let service = OpenServiceW(
                scm,
                windows::core::PCWSTR::from_raw(service_name_w.as_ptr()),
                SERVICE_QUERY_STATUS,
            );

            if service.is_err() {
                let _ = CloseServiceHandle(scm);
                return Ok(ServiceState::Stopped);
            }
            let service_handle = service.unwrap();

            let mut status = SERVICE_STATUS::default();
            let query_res = QueryServiceStatus(service_handle, &mut status);

            let _ = CloseServiceHandle(service_handle);
            let _ = CloseServiceHandle(scm);

            if query_res.is_err() {
                return Err(PlatformError::ServiceError("QueryServiceStatus failed".into()));
            }

            match status.dwCurrentState {
                SERVICE_RUNNING => Ok(ServiceState::Running),
                SERVICE_STOPPED => Ok(ServiceState::Stopped),
                SERVICE_START_PENDING => Ok(ServiceState::Starting),
                SERVICE_PAUSED => Ok(ServiceState::Paused),
                _ => Ok(ServiceState::Unknown),
            }
        }
    }

    #[cfg(not(windows))]
    pub fn query_service_state(&self) -> Result<ServiceState, PlatformError> {
        Ok(ServiceState::Stopped)
    }

    pub fn build_command(&self, action: ServiceAction, bin_path: Option<&str>) -> String {
        match action {
            ServiceAction::Install => {
                let bin = bin_path.unwrap_or("krypton-desktop.exe");
                format!(
                    "sc.exe create {} binPath= \"{} --service\" DisplayName= \"{}\" start= auto && sc.exe failure {} reset= 86400 actions= restart/60000/restart/60000/restart/60000",
                    self.service_name, bin, self.display_name, self.service_name
                )
            }
            ServiceAction::Uninstall => format!("sc.exe delete {}", self.service_name),
            ServiceAction::Start => format!("sc.exe start {}", self.service_name),
            ServiceAction::Stop => format!("sc.exe stop {}", self.service_name),
            ServiceAction::Status => format!("sc.exe query {}", self.service_name),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_is_process_elevated_runs_without_panic() {
        let result = is_process_elevated();
        assert!(result.is_ok(), "Elevation query should succeed on Windows");
    }

    #[test]
    fn test_windows_system_info() {
        let info = get_windows_system_info();
        assert_eq!(info.os_name, "Windows");
        assert!(info.monitor_count >= 1, "Must detect at least 1 monitor");
        assert!(!info.computer_name.is_empty(), "Computer name must be populated");
    }

    #[test]
    fn test_live_system_telemetry() {
        let telemetry = get_live_system_telemetry();
        assert!(telemetry.total_ram_mb > 0, "Total RAM should be > 0 MB");
        assert!(telemetry.total_disk_gb > 0, "Total disk space should be > 0 GB");
        assert!(telemetry.cpu_load_pct >= 0.0 && telemetry.cpu_load_pct <= 100.0, "CPU load must be valid percentage");
    }

    #[test]
    fn test_system_tray_state_machine() {
        let mut tray = SystemTrayManager::new();
        assert_eq!(tray.state(), TrayState::Idle);

        tray.set_connected(1);
        assert_eq!(tray.state(), TrayState::Connected { active_sessions: 1 });
        assert!(tray.tooltip().contains("1 Active"));

        tray.emergency_disconnect();
        assert_eq!(tray.state(), TrayState::EmergencyLocked);
        assert!(tray.tooltip().contains("Emergency"));

        tray.set_idle();
        assert_eq!(tray.state(), TrayState::Idle);
    }

    #[test]
    fn test_windows_service_manager_commands() {
        let mgr = WindowsServiceManager::new("KryptonRemoteAgent", "KryptonRemote Host Service");
        assert_eq!(mgr.service_name(), "KryptonRemoteAgent");

        let install_cmd = mgr.build_command(ServiceAction::Install, Some("C:\\Program Files\\Krypton\\agent.exe"));
        assert!(install_cmd.contains("sc.exe create KryptonRemoteAgent"));
        assert!(install_cmd.contains("start= auto"));
        assert!(install_cmd.contains("actions= restart/60000/restart/60000/restart/60000"));

        let start_cmd = mgr.build_command(ServiceAction::Start, None);
        assert_eq!(start_cmd, "sc.exe start KryptonRemoteAgent");

        let stop_cmd = mgr.build_command(ServiceAction::Stop, None);
        assert_eq!(stop_cmd, "sc.exe stop KryptonRemoteAgent");
    }

    #[test]
    fn test_query_service_state_nonexistent() {
        let mgr = WindowsServiceManager::new("NonExistentServiceKryptonTest123", "Test");
        let state = mgr.query_service_state().unwrap();
        assert_eq!(state, ServiceState::Stopped);
    }
}
