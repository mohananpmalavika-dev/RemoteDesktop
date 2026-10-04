/// Windows screen capture via DXGI Desktop Duplication.
///
/// Uses dynamic library loading (LoadLibraryW / GetProcAddress) for D3D11, DXGI,
/// and kernel32 (FreeLibrary) to avoid toolchain-specific incompatibilities.
/// Compatible with x86_64-pc-windows-gnu and x86_64-pc-windows-msvc.
///
/// Display enumeration uses windows-sys GDI bindings (EnumDisplayMonitors).
///
/// DXGI Desktop Duplication pipeline (Windows 8+):
///   1. CreateDXGIFactory1 → IDXGIAdapter → IDXGIOutput → IDXGIOutput1
///   2. IDXGIOutput1::DuplicateOutput(d3d11_device) → IDXGIOutputDuplication
///   3. AcquireNextFrame → IDXGIResource (GPU texture)
///   4. ID3D11DeviceContext::CopyResource(staging, frame_texture)
///   5. Map staging texture → BGRA8 bytes → Vec<u8>
use super::{CaptureError, DamageRect, DisplayInfo, FrameCapturer, RawFrame};
use std::{
    ffi::c_void,
    ptr,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

// windows-sys GDI — safe for both GNU and MSVC targets
use windows_sys::Win32::{
    Foundation::{BOOL, LPARAM, RECT},
    Graphics::Gdi::{EnumDisplayMonitors, GetMonitorInfoW, HDC, HMONITOR, MONITORINFOEXW},
    UI::WindowsAndMessaging::MONITORINFOF_PRIMARY,
    System::LibraryLoader::{GetProcAddress, LoadLibraryW},
};

// HMODULE = *mut c_void in windows-sys 0.59
type HMODULE = *mut c_void;

// FreeLibrary is NOT exposed in windows-sys 0.59 LibraryLoader feature,
// so we load it dynamically from kernel32.dll at startup once.
type FnFreeLibrary = unsafe extern "system" fn(h_lib_module: HMODULE) -> BOOL;

fn get_free_library() -> FnFreeLibrary {
    static FREE_LIB_PTR: std::sync::OnceLock<FnFreeLibrary> = std::sync::OnceLock::new();
    *FREE_LIB_PTR.get_or_init(|| unsafe {
        let kernel32: Vec<u16> = "kernel32.dll\0".encode_utf16().collect();
        let hmod = LoadLibraryW(kernel32.as_ptr());
        assert!(!hmod.is_null(), "Failed to load kernel32.dll");
        let fn_name = b"FreeLibrary\0";
        let ptr = GetProcAddress(hmod, fn_name.as_ptr() as *const u8)
            .expect("FreeLibrary not found in kernel32");
        std::mem::transmute(ptr)
    })
}

// ─────────────────────────────────────────────────────────────────────────────
// COM / D3D types defined inline
// ─────────────────────────────────────────────────────────────────────────────

type HRESULT = i32;
type REFIID = *const GUID;

#[repr(C)]
#[derive(Copy, Clone)]
struct GUID {
    data1: u32,
    data2: u16,
    data3: u16,
    data4: [u8; 8],
}

// IDXGIOutput1 {00cddea8-939b-4b83-a340-a685226666cc}
const IID_DXGI_OUTPUT1: GUID = GUID {
    data1: 0x00cddea8, data2: 0x939b, data3: 0x4b83,
    data4: [0xa3, 0x40, 0xa6, 0x85, 0x22, 0x66, 0x66, 0xcc],
};
// ID3D11Texture2D {6f15aaf2-d208-4e89-9ab4-489535d34f9c}
const IID_D3D11_TEXTURE2D: GUID = GUID {
    data1: 0x6f15aaf2, data2: 0xd208, data3: 0x4e89,
    data4: [0x9a, 0xb4, 0x48, 0x95, 0x35, 0xd3, 0x4f, 0x9c],
};
// IDXGIFactory1 {770aae78-f26f-4dba-a829-253c83d1b387}
const IID_DXGI_FACTORY1: GUID = GUID {
    data1: 0x770aae78, data2: 0xf26f, data3: 0x4dba,
    data4: [0xa8, 0x29, 0x25, 0x3c, 0x83, 0xd1, 0xb3, 0x87],
};

// DXGI error codes
const DXGI_ERROR_NOT_FOUND: HRESULT = -0x787A_FFFE_i32; // 0x887A0002
const DXGI_ERROR_WAIT_TIMEOUT: HRESULT = -0x787A_FFD9_i32; // 0x887A0027
const E_ACCESSDENIED: HRESULT = 0x8007_0005_u32 as i32; // 0x80070005

#[repr(C)]
struct DxgiOutputDesc {
    device_name: [u16; 32],
    desktop_coordinates: DxgiRect,
    attached_to_desktop: BOOL,
    rotation: u32,
    monitor: HMONITOR,
}

#[repr(C)]
struct DxgiRect {
    left: i32,
    top: i32,
    right: i32,
    bottom: i32,
}

#[repr(C)]
#[derive(Default)]
struct DxgiOutduplFrameInfo {
    last_present_time: i64,
    last_mouse_update_time: i64,
    accumulated_frames: u32,
    rects_coalesced: BOOL,
    protected_content_masked_out: BOOL,
    pointer_position: [u32; 3],
    total_metadata_buffer_size: u32,
    pointer_shape_buffer_size: u32,
}

#[repr(C)]
struct DxgiSampleDesc { count: u32, quality: u32 }

#[repr(C)]
struct D3D11Texture2DDesc {
    width: u32,
    height: u32,
    mip_levels: u32,
    array_size: u32,
    format: u32,        // DXGI_FORMAT
    sample_desc: DxgiSampleDesc,
    usage: u32,         // D3D11_USAGE_STAGING = 3
    bind_flags: u32,
    cpu_access_flags: u32, // D3D11_CPU_ACCESS_READ = 0x20000
    misc_flags: u32,
}

#[repr(C)]
#[derive(Default)]
struct D3D11MappedSubresource {
    p_data: *mut c_void,
    row_pitch: u32,
    depth_pitch: u32,
}

// D3D constants
const DXGI_FORMAT_B8G8R8A8_UNORM: u32 = 87;
const D3D_DRIVER_TYPE_UNKNOWN: u32 = 0;
const D3D11_SDK_VERSION: u32 = 7;
const D3D11_CREATE_DEVICE_BGRA_SUPPORT: u32 = 0x20;
const D3D11_USAGE_STAGING: u32 = 3;
const D3D11_CPU_ACCESS_READ: u32 = 0x0002_0000;
const D3D11_MAP_READ: u32 = 1;

// ─────────────────────────────────────────────────────────────────────────────
// Dynamic function types
// ─────────────────────────────────────────────────────────────────────────────

type FnD3D11CreateDevice = unsafe extern "system" fn(
    adapter: *mut c_void,
    driver_type: u32,
    software: isize,
    flags: u32,
    feature_levels: *const u32,
    num_feature_levels: u32,
    sdk_version: u32,
    device: *mut *mut c_void,
    feature_level: *mut u32,
    immediate_context: *mut *mut c_void,
) -> HRESULT;

type FnCreateDXGIFactory1 = unsafe extern "system" fn(
    riid: REFIID,
    factory: *mut *mut c_void,
) -> HRESULT;

// ─────────────────────────────────────────────────────────────────────────────
// COM helpers
// ─────────────────────────────────────────────────────────────────────────────

/// QueryInterface via COM vtable slot 0
unsafe fn qi(obj: *mut c_void, iid: &GUID) -> Result<*mut c_void, CaptureError> {
    type FnQI = unsafe extern "system" fn(
        this: *mut c_void,
        iid: *const GUID,
        ppv: *mut *mut c_void,
    ) -> HRESULT;
    let qi_fn: FnQI = std::mem::transmute(*(*(obj as *mut *mut *mut c_void)).add(0));
    let mut out: *mut c_void = ptr::null_mut();
    let hr = qi_fn(obj, iid, &mut out);
    if hr < 0 || out.is_null() {
        Err(CaptureError::DxgiError(format!("QueryInterface {hr:#010x}")))
    } else {
        Ok(out)
    }
}

/// COM Release via vtable slot 2
unsafe fn com_release(obj: *mut c_void) {
    if !obj.is_null() {
        type FnRelease = unsafe extern "system" fn(this: *mut c_void) -> u32;
        let release: FnRelease = std::mem::transmute(*(*(obj as *mut *mut *mut c_void)).add(2));
        release(obj);
    }
}

/// Extract function pointer from COM vtable at given slot index
unsafe fn vtfn<T: Copy>(obj: *mut c_void, slot: usize) -> T {
    let vtable = *(obj as *mut *mut *mut c_void);
    let fn_ptr = *vtable.add(slot);
    std::mem::transmute_copy(&fn_ptr)
}

fn current_ts_ns() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or(Duration::ZERO)
        .as_nanos() as u64
}

// ─────────────────────────────────────────────────────────────────────────────
// Monitor Enumeration
// ─────────────────────────────────────────────────────────────────────────────

struct MonitorCollector { monitors: Vec<DisplayInfo> }

unsafe extern "system" fn enum_monitor_cb(
    monitor: HMONITOR,
    _: HDC,
    _: *mut RECT,
    lparam: LPARAM,
) -> BOOL {
    let col = &mut *(lparam as *mut MonitorCollector);
    let id = col.monitors.len();
    let mut info: MONITORINFOEXW = std::mem::zeroed();
    info.monitorInfo.cbSize = std::mem::size_of::<MONITORINFOEXW>() as u32;
    if GetMonitorInfoW(monitor, &mut info.monitorInfo as *mut _) != 0 {
        let rc = info.monitorInfo.rcMonitor;
        let is_primary = (info.monitorInfo.dwFlags & MONITORINFOF_PRIMARY) != 0;
        let nend = info.szDevice.iter().position(|&c| c == 0).unwrap_or(32);
        col.monitors.push(DisplayInfo {
            id,
            name: String::from_utf16_lossy(&info.szDevice[..nend]),
            width: (rc.right - rc.left) as u32,
            height: (rc.bottom - rc.top) as u32,
            is_primary,
            refresh_rate: 60,
            x: rc.left,
            y: rc.top,
        });
    }
    1
}

pub fn enumerate_windows_displays() -> Result<Vec<DisplayInfo>, CaptureError> {
    let mut col = MonitorCollector { monitors: Vec::new() };
    // HDC = NULL means enumerate the entire virtual screen
    let ok = unsafe {
        EnumDisplayMonitors(
            ptr::null_mut(),         // HDC = *mut c_void = null
            ptr::null(),             // clip rect = NULL
            Some(enum_monitor_cb),
            &mut col as *mut _ as LPARAM,
        )
    };
    if ok == 0 { return Err(CaptureError::InitFailed("EnumDisplayMonitors failed".into())); }
    if col.monitors.is_empty() { return Err(CaptureError::NoDisplaysFound); }
    Ok(col.monitors)
}

pub fn is_wgc_supported() -> bool { false }

// ─────────────────────────────────────────────────────────────────────────────
// WGC stub — not usable on GNU toolchain builds
// ─────────────────────────────────────────────────────────────────────────────

pub struct WgcCapturer;
impl WgcCapturer { pub fn new() -> Self { Self } }
impl FrameCapturer for WgcCapturer {
    fn enumerate_displays(&self) -> Result<Vec<DisplayInfo>, CaptureError> {
        enumerate_windows_displays()
    }
    fn start_capture(&mut self, _: usize) -> Result<(), CaptureError> {
        Err(CaptureError::InitFailed("WGC unavailable on this build target".into()))
    }
    fn capture_frame(&mut self) -> Result<Option<RawFrame>, CaptureError> {
        Err(CaptureError::InitFailed("WGC unavailable on this build target".into()))
    }
    fn stop_capture(&mut self) -> Result<(), CaptureError> { Ok(()) }
    fn is_capturing(&self) -> bool { false }
}

// ─────────────────────────────────────────────────────────────────────────────
// Dynamic D3D11 / DXGI library loader
// ─────────────────────────────────────────────────────────────────────────────

struct D3D11Libs {
    d3d11: HMODULE,   // *mut c_void
    dxgi: HMODULE,    // *mut c_void
    create_device: FnD3D11CreateDevice,
    create_factory: FnCreateDXGIFactory1,
}

unsafe impl Send for D3D11Libs {}
unsafe impl Sync for D3D11Libs {}

impl D3D11Libs {
    fn load() -> Result<Self, CaptureError> {
        unsafe {
            let d3d11_name: Vec<u16> = "d3d11.dll\0".encode_utf16().collect();
            let d3d11: HMODULE = LoadLibraryW(d3d11_name.as_ptr());
            if d3d11.is_null() {
                return Err(CaptureError::D3dError("Failed to load d3d11.dll".into()));
            }

            let fn_name = b"D3D11CreateDevice\0";
            let create_device: FnD3D11CreateDevice = match GetProcAddress(d3d11, fn_name.as_ptr() as *const u8) {
                Some(f) => std::mem::transmute(f),
                None => {
                    get_free_library()(d3d11);
                    return Err(CaptureError::D3dError("D3D11CreateDevice not found".into()));
                }
            };

            let dxgi_name: Vec<u16> = "dxgi.dll\0".encode_utf16().collect();
            let dxgi: HMODULE = LoadLibraryW(dxgi_name.as_ptr());
            if dxgi.is_null() {
                get_free_library()(d3d11);
                return Err(CaptureError::DxgiError("Failed to load dxgi.dll".into()));
            }

            let factory_fn = b"CreateDXGIFactory1\0";
            let create_factory: FnCreateDXGIFactory1 = match GetProcAddress(dxgi, factory_fn.as_ptr() as *const u8) {
                Some(f) => std::mem::transmute(f),
                None => {
                    get_free_library()(dxgi);
                    get_free_library()(d3d11);
                    return Err(CaptureError::DxgiError("CreateDXGIFactory1 not found".into()));
                }
            };

            Ok(D3D11Libs { d3d11, dxgi, create_device, create_factory })
        }
    }
}

impl Drop for D3D11Libs {
    fn drop(&mut self) {
        let free = get_free_library();
        unsafe {
            free(self.dxgi);
            free(self.d3d11);
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// DXGI Desktop Duplication Capturer
// ─────────────────────────────────────────────────────────────────────────────

pub struct DxgiCapturer {
    libs: Option<D3D11Libs>,
    device: *mut c_void,
    context: *mut c_void,
    duplication: *mut c_void,
    staging: *mut c_void,
    frame_width: u32,
    frame_height: u32,
    active_display: Option<usize>,
}

unsafe impl Send for DxgiCapturer {}
unsafe impl Sync for DxgiCapturer {}

impl DxgiCapturer {
    pub fn new() -> Self {
        Self {
            libs: None,
            device: ptr::null_mut(),
            context: ptr::null_mut(),
            duplication: ptr::null_mut(),
            staging: ptr::null_mut(),
            frame_width: 0,
            frame_height: 0,
            active_display: None,
        }
    }

    fn cleanup(&mut self) {
        unsafe {
            com_release(self.staging); self.staging = ptr::null_mut();
            com_release(self.duplication); self.duplication = ptr::null_mut();
            com_release(self.context); self.context = ptr::null_mut();
            com_release(self.device); self.device = ptr::null_mut();
        }
        self.libs = None;
        self.active_display = None;
    }
}

impl Drop for DxgiCapturer {
    fn drop(&mut self) { self.cleanup(); }
}

impl FrameCapturer for DxgiCapturer {
    fn enumerate_displays(&self) -> Result<Vec<DisplayInfo>, CaptureError> {
        enumerate_windows_displays()
    }

    fn start_capture(&mut self, display_id: usize) -> Result<(), CaptureError> {
        self.cleanup();
        let libs = D3D11Libs::load()?;

        unsafe {
            // 1. Create DXGI factory to find the adapter owning display_id
            let mut factory: *mut c_void = ptr::null_mut();
            let hr = (libs.create_factory)(&IID_DXGI_FACTORY1, &mut factory);
            if hr < 0 || factory.is_null() {
                return Err(CaptureError::DxgiError(format!("CreateDXGIFactory1: {hr:#010x}")));
            }

            type FnEnumAdapters1 = unsafe extern "system" fn(*mut c_void, u32, *mut *mut c_void) -> HRESULT;
            type FnEnumOutputs = unsafe extern "system" fn(*mut c_void, u32, *mut *mut c_void) -> HRESULT;
            type FnGetOutputDesc = unsafe extern "system" fn(*mut c_void, *mut DxgiOutputDesc) -> HRESULT;
            let enum_adapters: FnEnumAdapters1 = vtfn(factory, 12);

            let mut target_adapter: *mut c_void = ptr::null_mut();
            let mut target_output: *mut c_void = ptr::null_mut();
            let mut current_display: usize = 0;
            let mut found = false;

            for a_idx in 0..16 {
                let mut adapter: *mut c_void = ptr::null_mut();
                let hr = enum_adapters(factory, a_idx, &mut adapter);
                if hr == DXGI_ERROR_NOT_FOUND || hr < 0 || adapter.is_null() {
                    break;
                }

                let enum_outputs: FnEnumOutputs = vtfn(adapter, 7);
                for o_idx in 0..16 {
                    let mut output: *mut c_void = ptr::null_mut();
                    let hr = enum_outputs(adapter, o_idx, &mut output);
                    if hr == DXGI_ERROR_NOT_FOUND || hr < 0 || output.is_null() {
                        break;
                    }

                    if current_display == display_id {
                        target_adapter = adapter;
                        target_output = output;
                        found = true;
                        break;
                    } else {
                        com_release(output);
                        current_display += 1;
                    }
                }

                if found {
                    break;
                } else {
                    com_release(adapter);
                }
            }
            com_release(factory);

            if !found {
                return Err(CaptureError::DisplayOutOfRange(display_id));
            }

            // 2. Get display dimensions from output desc
            let get_desc: FnGetOutputDesc = vtfn(target_output, 7);
            let mut desc: DxgiOutputDesc = std::mem::zeroed();
            let hr = get_desc(target_output, &mut desc);
            if hr < 0 {
                com_release(target_output);
                com_release(target_adapter);
                return Err(CaptureError::DxgiError(format!("GetOutputDesc: {hr:#010x}")));
            }
            let width = (desc.desktop_coordinates.right - desc.desktop_coordinates.left) as u32;
            let height = (desc.desktop_coordinates.bottom - desc.desktop_coordinates.top) as u32;

            // 3. Create D3D11 device on the exact adapter that owns the display
            let mut device: *mut c_void = ptr::null_mut();
            let mut context: *mut c_void = ptr::null_mut();
            let hr = (libs.create_device)(
                target_adapter,
                D3D_DRIVER_TYPE_UNKNOWN, // Required by DXGI when adapter pointer is provided
                0,
                D3D11_CREATE_DEVICE_BGRA_SUPPORT,
                ptr::null(),
                0,
                D3D11_SDK_VERSION,
                &mut device,
                ptr::null_mut(),
                &mut context,
            );
            com_release(target_adapter);

            if hr < 0 || device.is_null() {
                com_release(target_output);
                return Err(CaptureError::D3dError(format!("D3D11CreateDevice on adapter: {hr:#010x}")));
            }

            // 4. QI IDXGIOutput -> IDXGIOutput1
            let output1 = qi(target_output, &IID_DXGI_OUTPUT1)?;
            com_release(target_output);

            // 5. IDXGIOutput1::DuplicateOutput
            type FnDuplicateOutput = unsafe extern "system" fn(*mut c_void, *mut c_void, *mut *mut c_void) -> HRESULT;
            let dup_output: FnDuplicateOutput = vtfn(output1, 22);
            let mut duplication: *mut c_void = ptr::null_mut();
            let hr = dup_output(output1, device, &mut duplication);
            com_release(output1);
            if hr < 0 || duplication.is_null() {
                com_release(context); com_release(device);
                if hr == E_ACCESSDENIED {
                    return Err(CaptureError::AccessDenied);
                }
                return Err(CaptureError::DxgiError(format!("DuplicateOutput: {hr:#010x}")));
            }

            // 8. Create staging texture (CPU-readable)
            // ID3D11Device::CreateTexture2D = vtable slot 5
            // IUnknown(3) + CreateBuffer=3, CreateTexture1D=4, CreateTexture2D=5
            type FnCreateTexture2D = unsafe extern "system" fn(
                *mut c_void, *const D3D11Texture2DDesc, *const c_void, *mut *mut c_void
            ) -> HRESULT;
            let create_tex2d: FnCreateTexture2D = vtfn(device, 5);

            let staging_desc = D3D11Texture2DDesc {
                width, height,
                mip_levels: 1, array_size: 1,
                format: DXGI_FORMAT_B8G8R8A8_UNORM,
                sample_desc: DxgiSampleDesc { count: 1, quality: 0 },
                usage: D3D11_USAGE_STAGING,
                bind_flags: 0,
                cpu_access_flags: D3D11_CPU_ACCESS_READ,
                misc_flags: 0,
            };
            let mut staging: *mut c_void = ptr::null_mut();
            let hr = create_tex2d(device, &staging_desc, ptr::null(), &mut staging);
            if hr < 0 || staging.is_null() {
                com_release(duplication); com_release(context); com_release(device);
                return Err(CaptureError::D3dError(format!("CreateTexture2D staging: {hr:#010x}")));
            }

            self.libs = Some(libs);
            self.device = device;
            self.context = context;
            self.duplication = duplication;
            self.staging = staging;
            self.frame_width = width;
            self.frame_height = height;
            self.active_display = Some(display_id);
        }

        log::info!("[dxgi] Initialized display={} {}x{}", display_id, self.frame_width, self.frame_height);
        Ok(())
    }

    fn capture_frame(&mut self) -> Result<Option<RawFrame>, CaptureError> {
        if self.duplication.is_null() {
            return Err(CaptureError::InitFailed("Not capturing".into()));
        }
        unsafe {
            // IDXGIOutputDuplication vtable:
            // IUnknown(3)+IDXGIObject(4) = 7 base slots
            // GetDesc=7, AcquireNextFrame=8, GetFrameDirtyRects=9, GetFrameMoveRects=10,
            // GetFramePointerShape=11, MapDesktopSurface=12, UnMapDesktopSurface=13,
            // ReleaseFrame=14
            type FnAcquireNextFrame = unsafe extern "system" fn(
                *mut c_void, u32, *mut DxgiOutduplFrameInfo, *mut *mut c_void
            ) -> HRESULT;
            type FnReleaseFrame = unsafe extern "system" fn(*mut c_void) -> HRESULT;

            let acquire: FnAcquireNextFrame = vtfn(self.duplication, 8);
            let release_frame: FnReleaseFrame = vtfn(self.duplication, 14);

            let mut info = DxgiOutduplFrameInfo::default();
            let mut resource: *mut c_void = ptr::null_mut();
            let hr = acquire(self.duplication, 100, &mut info, &mut resource);

            if hr == DXGI_ERROR_WAIT_TIMEOUT { return Ok(None); }
            if hr < 0 {
                eprintln!("[dxgi] AcquireNextFrame failed with hr={hr:#010x}");
                return Err(CaptureError::DxgiError(format!("AcquireNextFrame: {hr:#010x}")));
            }

            // QI IDXGIResource → ID3D11Texture2D
            let frame_tex = qi(resource, &IID_D3D11_TEXTURE2D)?;
            com_release(resource);

            // ID3D11DeviceContext::CopyResource = vtable slot 47
            type FnCopyResource = unsafe extern "system" fn(*mut c_void, *mut c_void, *mut c_void);
            let copy_res: FnCopyResource = vtfn(self.context, 47);
            copy_res(self.context, self.staging, frame_tex);
            com_release(frame_tex);

            // ID3D11DeviceContext::Map = slot 14, Unmap = slot 15
            type FnMap = unsafe extern "system" fn(
                *mut c_void, *mut c_void, u32, u32, u32, *mut D3D11MappedSubresource
            ) -> HRESULT;
            type FnUnmap = unsafe extern "system" fn(*mut c_void, *mut c_void, u32);

            let map_fn: FnMap = vtfn(self.context, 14);
            let unmap_fn: FnUnmap = vtfn(self.context, 15);

            let mut mapped = D3D11MappedSubresource::default();
            let hr = map_fn(self.context, self.staging, 0, D3D11_MAP_READ, 0, &mut mapped);
            if hr < 0 {
                let _ = release_frame(self.duplication);
                return Err(CaptureError::D3dError(format!("Map staging: {hr:#010x}")));
            }

            let stride = mapped.row_pitch;
            let width = self.frame_width;
            let height = self.frame_height;
            let size = (stride * height) as usize;
            let mut data = vec![0u8; size];
            ptr::copy_nonoverlapping(mapped.p_data as *const u8, data.as_mut_ptr(), size);

            // Extract dirty rects via IDXGIOutputDuplication::GetFrameDirtyRects (vtable slot 9)
            type FnGetFrameDirtyRects = unsafe extern "system" fn(
                *mut c_void, u32, *mut RECT, *mut u32
            ) -> HRESULT;
            let get_dirty: FnGetFrameDirtyRects = vtfn(self.duplication, 9);
            let mut rect_buf: [RECT; 32] = std::mem::zeroed();
            let mut required_bytes: u32 = 0;
            let mut damage = Vec::new();
            if get_dirty(
                self.duplication,
                std::mem::size_of_val(&rect_buf) as u32,
                rect_buf.as_mut_ptr(),
                &mut required_bytes,
            ) >= 0 && required_bytes > 0 {
                let count = (required_bytes as usize / std::mem::size_of::<RECT>()).min(32);
                for r in &rect_buf[..count] {
                    if r.right > r.left && r.bottom > r.top {
                        damage.push(DamageRect {
                            x: r.left.max(0) as u32,
                            y: r.top.max(0) as u32,
                            width: (r.right - r.left) as u32,
                            height: (r.bottom - r.top) as u32,
                        });
                    }
                }
            }
            if damage.is_empty() && (info.total_metadata_buffer_size > 0 || info.accumulated_frames > 0) {
                damage.push(DamageRect { x: 0, y: 0, width, height });
            }

            unmap_fn(self.context, self.staging, 0);
            let _ = release_frame(self.duplication);

            Ok(Some(RawFrame {
                width, height, stride, data,
                damage_rects: damage,
                timestamp_ns: current_ts_ns(),
                display_id: self.active_display.unwrap_or(0),
            }))
        }
    }

    fn stop_capture(&mut self) -> Result<(), CaptureError> {
        self.cleanup();
        log::info!("[dxgi] Capture stopped");
        Ok(())
    }

    fn is_capturing(&self) -> bool { !self.duplication.is_null() }
}
