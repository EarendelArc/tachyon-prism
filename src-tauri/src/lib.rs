use regex::Regex;
use rustls::pki_types::ServerName;
use rustls::{ClientConfig, ClientConnection, RootCertStore, StreamOwned};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs::{self, OpenOptions};
use std::io::{self, BufRead, BufReader, Read, Write};
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, Shutdown, SocketAddr, TcpStream, ToSocketAddrs};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Output, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::OnceLock;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{Emitter, Manager};
use ureq::http::{Method, Request, Uri};

#[cfg(unix)]
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};

mod secure_vault;
mod system_proxy;
#[cfg(unix)]
mod unix_generation_fs;
mod xray_generation;

const XRAY_RUN_CONFIG_ARGS: [&str; 4] = ["run", "-format", "json", "-config"];
const XRAY_TEST_CONFIG_ARGS: [&str; 5] = ["run", "-test", "-format", "json", "-config"];

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ConfigDraftPaths {
    config_dir: String,
    core_config_path: String,
    xray_config_path: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CanonicalXrayConfigText {
    exists: bool,
    contents: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RuntimePaths {
    bin_dir: String,
    tachyon_core_binary_path: String,
    xray_binary_path: String,
    runtime_settings_path: String,
}

#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeSettings {
    #[serde(default)]
    tachyon_grpc_listen: String,
    #[serde(default)]
    tachyon_grpc_port: u16,
    #[serde(default)]
    tachyon_ipc_listen: String,
    #[serde(default)]
    tachyon_ipc_port: u16,
    #[serde(default)]
    tachyon_core_binary_path: String,
    #[serde(default)]
    xray_binary_path: String,
    #[serde(default)]
    tachyon_fec_adapt_window: u32,
    #[serde(default)]
    tachyon_fec_data_shards: u32,
    #[serde(default = "default_true")]
    tachyon_fec_dynamic: bool,
    #[serde(default)]
    tachyon_fec_group_timeout_ms: u32,
    #[serde(default)]
    tachyon_fec_parity_shards: u32,
    #[serde(default = "default_true")]
    tachyon_connection_migration: bool,
    #[serde(default)]
    tachyon_local_addrs: String,
    #[serde(default)]
    tachyon_multipath: bool,
    #[serde(default)]
    tachyon_server_address: String,
    #[serde(default)]
    tachyon_tgp_auth_psk: String,
    #[serde(default)]
    tachyon_tgp_server_address: String,
    #[serde(default)]
    xray_http_listen: String,
    #[serde(default)]
    xray_http_port: u16,
    #[serde(default)]
    tachyon_telemetry_interval_ms: u32,
    #[serde(default)]
    tachyon_core_release_channel: String,
    #[serde(default)]
    tachyon_tun_address: String,
    #[serde(default)]
    tachyon_tun_auto_route: bool,
    #[serde(default)]
    tachyon_tun_dns_hijack: bool,
    #[serde(default)]
    tachyon_tun_mtu: u32,
    #[serde(default)]
    xray_socks_listen: String,
    #[serde(default)]
    xray_socks_port: u16,
    #[serde(default)]
    system_proxy_bypass: String,
    #[serde(default)]
    xray_stats_enabled: bool,
    #[serde(default)]
    xray_stats_listen: String,
    #[serde(default)]
    xray_stats_port: u16,
    #[serde(default)]
    xray_release_channel: String,
    #[serde(default)]
    xray_egress_probe_url: String,
    #[serde(default = "default_egress_probe_status")]
    xray_egress_probe_status: u16,
    #[serde(default)]
    xray_egress_probe_nonce: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ManagedBinaryInventory {
    bin_dir: String,
    runtime_settings: RuntimeSettings,
    tachyon_core: ManagedBinaryInfo,
    xray: ManagedBinaryInfo,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ManagedBinaryInfo {
    kind: String,
    display_name: String,
    target_path: String,
    configured_path: String,
    sidecar_dependencies: Vec<SidecarDependencyInfo>,
    managed_exists: bool,
    configured_exists: bool,
    managed_size_bytes: Option<u64>,
    configured_size_bytes: Option<u64>,
    managed_modified_at: Option<u64>,
    configured_modified_at: Option<u64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SidecarDependencyInfo {
    name: String,
    path: String,
    required: bool,
    exists: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeReleaseInfo {
    tag_name: String,
    asset_name: String,
    asset_url: String,
    asset_size_bytes: u64,
    checksum_asset_name: String,
    checksum_url: String,
    published_at: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeInstallResult {
    release: RuntimeReleaseInfo,
    sha256: String,
    binary_path: String,
    inventory: ManagedBinaryInventory,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CoreReleaseDiagnostics {
    kind: String,
    display_name: String,
    selected_channel: String,
    resolved_tag: Option<String>,
    asset_name: Option<String>,
    asset_url: Option<String>,
    asset_size_bytes: Option<u64>,
    checksum_asset_name: Option<String>,
    checksum_url: Option<String>,
    checksum_expected_sha256: Option<String>,
    checksum_actual_sha256: Option<String>,
    checksum_match: Option<bool>,
    installed_path: String,
    installed_exists: bool,
    installed_version: Option<String>,
    last_error: Option<String>,
}

#[derive(Deserialize)]
struct GithubRelease {
    tag_name: String,
    published_at: Option<String>,
    #[serde(default)]
    prerelease: bool,
    assets: Vec<GithubAsset>,
}

#[derive(Clone, Deserialize)]
struct GithubAsset {
    name: String,
    browser_download_url: String,
    size: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ProcessStatus {
    state: String,
    pid: Option<u32>,
    binary_path: Option<String>,
    config_path: Option<String>,
    started_at: Option<u64>,
    last_error: Option<String>,
    exit_code: Option<i32>,
    stdout_tail: String,
    stderr_tail: String,
    stop_method: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeStatus {
    tachyon_core: ProcessStatus,
    xray: ProcessStatus,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct StartAllResult {
    runtime: RuntimeStatus,
    confirmation: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct StopAllResult {
    runtime: RuntimeStatus,
    proxy_restored: bool,
    proxy_restore_status: String,
    errors: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RuntimePrivilegeStatus {
    platform: String,
    elevated: bool,
    can_manage_tun: bool,
    message: String,
}

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct XrayTrafficStats {
    bytes_sent: u64,
    bytes_received: u64,
    queried_at: Option<u64>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
struct TachyonTelemetryEvent {
    #[serde(rename = "type")]
    event_type: String,
    seq: u64,
    ts: String,
    data: Value,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct TachyonTelemetryPoll {
    events: Vec<TachyonTelemetryEvent>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TcpLatencyResult {
    ok: bool,
    latency_ms: Option<u32>,
    error: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ProxyProbeResult {
    ok: bool,
    status_code: Option<u16>,
    latency_ms: Option<u32>,
    via: String,
    target_url: String,
    error: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LocalProxyProbeReport {
    ok: bool,
    target_url: String,
    checked_at: Option<u64>,
    http: ProxyProbeResult,
    socks: ProxyProbeResult,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ConfigValidationResult {
    ok: bool,
    target: String,
    command: String,
    details: String,
    error: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TachyonCorePreflightResult {
    supported: bool,
    ok: bool,
    overall: String,
    checks: Vec<TachyonCorePreflightCheck>,
    structured_report: Value,
    command: String,
    stdout: String,
    stdout_truncated: bool,
    stderr: String,
    stderr_truncated: bool,
    exit_code: Option<i32>,
    error: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TachyonCorePreflightCheck {
    code: String,
    status: String,
    message: String,
    details: String,
    raw: Value,
}

const WINTUN_VERSION: &str = "0.14.1";
const WINTUN_ARCHIVE_NAME: &str = "wintun-0.14.1.zip";
const WINTUN_DOWNLOAD_URL: &str = "https://www.wintun.net/builds/wintun-0.14.1.zip";
const WINTUN_SHA256: &str = "07c256185d6ee3652e09fa55c0b673e2624b565e02c4b9091c79ca7d2f24ef51";
const PREFLIGHT_OUTPUT_LIMIT_BYTES: usize = 8 * 1024;
// The canonical Xray config read and commit limits are encoded UTF-8 bytes, not characters.
const CANONICAL_XRAY_CONFIG_LIMIT_BYTES: usize = 2 * 1024 * 1024;
const XRAY_DIAGNOSTIC_LIMIT_BYTES: usize = 8 * 1024;
const PROCESS_LOG_TAIL_BYTES: usize = 32 * 1024;
const GRACEFUL_STOP_TIMEOUT: Duration = Duration::from_secs(3);
const STARTUP_READINESS_TIMEOUT: Duration = Duration::from_secs(10);
const STARTUP_READINESS_INTERVAL: Duration = Duration::from_millis(100);
const STARTUP_PROBE_TIMEOUT: Duration = Duration::from_secs(1);
const EGRESS_PROBE_TIMEOUT: Duration = Duration::from_secs(8);
const PROXY_BIND_EGRESS_TIMEOUT: Duration = Duration::from_secs(2);
const PROXY_WATCHDOG_INTERVAL: Duration = Duration::from_millis(250);
const PROXY_WATCHDOG_LISTENER_TIMEOUT: Duration = Duration::from_millis(120);
const PROXY_RESTORE_ATTEMPTS: usize = 3;
const PROXY_RESTORE_RETRY_DELAY: Duration = Duration::from_millis(100);
const TELEMETRY_EVENT_LIMIT: usize = 64;
const TELEMETRY_RESPONSE_LIMIT_BYTES: usize = 256 * 1024;

#[derive(Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct MatchRule {
    process_names: Vec<String>,
    paths: Vec<String>,
    path_prefixes: Vec<String>,
    sha256: Vec<String>,
    steam_app_ids: Vec<u32>,
}

#[derive(Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct GameProfile {
    id: String,
    display_name: String,
    enabled: bool,
    manual: bool,
    priority: u32,
    #[serde(rename = "match")]
    match_rule: MatchRule,
    udp_policy: String,
    tcp_policy: String,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct GameProfilesFile {
    profiles: Vec<GameProfile>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SteamAppManifest {
    app_id: u32,
    name: String,
    install_dir: String,
    universe: String,
    state_flags: u32,
    library_path: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SteamScanResult {
    apps: Vec<SteamAppManifest>,
    profiles: Vec<GameProfile>,
}

struct RuntimeState {
    xray: Mutex<XrayCoordinator>,
    window_restore_bounds: Mutex<Option<WindowBounds>>,
}

#[derive(Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
enum XrayConfigTrustMode {
    Managed,
    Advanced,
}

#[derive(Clone)]
struct XrayConfigAuthorization {
    digest: [u8; 32],
    mode: XrayConfigTrustMode,
}

// Lock order is always XrayCoordinator first, then SystemProxyRuntime's internal lock.
// No caller may retain either lock while acquiring XrayCoordinator again.
struct GenerationWatchdog {
    stop: Arc<AtomicBool>,
    join: Option<thread::JoinHandle<()>>,
}

#[derive(Default)]
struct XrayCoordinator {
    processes: RuntimeProcesses,
    generations: xray_generation::GenerationRuntime,
    proxy_watchdog: Option<GenerationWatchdog>,
    xray_config_authorization: Option<XrayConfigAuthorization>,
}

#[derive(Clone, Copy)]
struct WindowBounds {
    position: tauri::PhysicalPosition<i32>,
    size: tauri::PhysicalSize<u32>,
}

#[cfg(windows)]
#[allow(clippy::items_after_test_module)]
mod native_titlebar {
    use windows_sys::Win32::Foundation::{HWND, LPARAM, LRESULT, POINT, RECT, WPARAM};
    use windows_sys::Win32::Graphics::Gdi::ScreenToClient;
    use windows_sys::Win32::UI::HiDpi::GetDpiForWindow;
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::ReleaseCapture;
    use windows_sys::Win32::UI::Shell::{DefSubclassProc, SetWindowSubclass};
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        EnumChildWindows, EnumWindows, GetAncestor, GetClientRect, GetCursorPos, GetParent,
        GetWindowLongPtrW, GetWindowThreadProcessId, IsWindowVisible, SendMessageW,
        SetWindowLongPtrW, SetWindowPos, GA_ROOT, GWL_STYLE, HTCAPTION, SC_MOVE, SWP_FRAMECHANGED,
        SWP_NOMOVE, SWP_NOOWNERZORDER, SWP_NOSIZE, SWP_NOZORDER, WM_LBUTTONDOWN, WM_NCHITTEST,
        WM_SYSCOMMAND, WS_CAPTION, WS_THICKFRAME,
    };

    const TITLEBAR_HEIGHT_LOGICAL_PX: i32 = 42;
    const WINDOW_CONTROL_WIDTH_LOGICAL_PX: i32 = 156;
    const DEFAULT_DPI: u32 = 96;
    const TITLEBAR_SUBCLASS_ID: usize = 1;

    pub fn install(window: &tauri::WebviewWindow) -> Result<(), String> {
        let raw_hwnd = match window.hwnd() {
            Ok(handle) => handle.0 as HWND,
            Err(_) => find_process_window()?,
        };
        let root = unsafe { GetAncestor(raw_hwnd, GA_ROOT) };
        let hwnd = if root.is_null() { raw_hwnd } else { root };
        remove_native_frame(hwnd)?;
        install_subclass(hwnd, hwnd)?;
        unsafe {
            EnumChildWindows(hwnd, Some(enum_child_window), hwnd as LPARAM);
        }
        Ok(())
    }

    fn find_process_window() -> Result<HWND, String> {
        let mut found: HWND = std::ptr::null_mut();
        for _ in 0..40 {
            unsafe {
                EnumWindows(
                    Some(find_process_window_proc),
                    &mut found as *mut HWND as LPARAM,
                );
            }
            if !found.is_null() {
                return Ok(found);
            }
            std::thread::sleep(std::time::Duration::from_millis(25));
        }
        Err("get native window handle: no visible process window".to_string())
    }

    unsafe extern "system" fn find_process_window_proc(hwnd: HWND, lparam: LPARAM) -> i32 {
        let mut process_id = 0u32;
        GetWindowThreadProcessId(hwnd, &mut process_id);
        let mut rect = RECT {
            left: 0,
            top: 0,
            right: 0,
            bottom: 0,
        };
        if process_id == std::process::id()
            && IsWindowVisible(hwnd) != 0
            && GetClientRect(hwnd, &mut rect) != 0
            && rect.right - rect.left >= 700
            && rect.bottom - rect.top >= 480
        {
            *(lparam as *mut HWND) = hwnd;
            return 0;
        }
        1
    }

    fn install_subclass(hwnd: HWND, parent: HWND) -> Result<(), String> {
        let ok = unsafe {
            SetWindowSubclass(
                hwnd,
                Some(titlebar_subclass_proc),
                TITLEBAR_SUBCLASS_ID,
                parent as usize,
            )
        };
        if ok == 0 {
            Err("install native titlebar subclass failed".to_string())
        } else {
            Ok(())
        }
    }

    unsafe extern "system" fn enum_child_window(hwnd: HWND, lparam: LPARAM) -> i32 {
        let parent = lparam as HWND;
        let _ = install_subclass(hwnd, parent);
        1
    }

    unsafe extern "system" fn titlebar_subclass_proc(
        hwnd: HWND,
        umsg: u32,
        wparam: WPARAM,
        lparam: LPARAM,
        _subclass_id: usize,
        ref_data: usize,
    ) -> LRESULT {
        if umsg == WM_NCHITTEST && is_draggable_titlebar_point(hwnd) {
            return HTCAPTION as LRESULT;
        }
        if umsg == WM_LBUTTONDOWN && is_draggable_titlebar_point(hwnd) {
            let parent = if ref_data == 0 {
                GetParent(hwnd)
            } else {
                ref_data as HWND
            };
            if !parent.is_null() {
                let _ = ReleaseCapture();
                let mut point = POINT { x: 0, y: 0 };
                if GetCursorPos(&mut point) != 0 {
                    SendMessageW(
                        parent,
                        WM_SYSCOMMAND,
                        (SC_MOVE | HTCAPTION) as WPARAM,
                        screen_point_lparam(point),
                    );
                }
                return 0;
            }
        }
        DefSubclassProc(hwnd, umsg, wparam, lparam)
    }

    fn borderless_style(style: isize) -> isize {
        style & !((WS_CAPTION | WS_THICKFRAME) as isize)
    }

    fn screen_point_lparam(point: POINT) -> LPARAM {
        let x = point.x as u16 as usize;
        let y = point.y as u16 as usize;
        (x | (y << 16)) as LPARAM
    }

    fn logical_pixels(logical: i32, dpi: u32) -> i32 {
        let dpi = dpi.max(DEFAULT_DPI);
        ((logical as i64 * dpi as i64 + (DEFAULT_DPI / 2) as i64) / DEFAULT_DPI as i64) as i32
    }

    fn remove_native_frame(hwnd: HWND) -> Result<(), String> {
        let style = unsafe { GetWindowLongPtrW(hwnd, GWL_STYLE) };
        let borderless = borderless_style(style);
        unsafe { SetWindowLongPtrW(hwnd, GWL_STYLE, borderless) };
        let updated = unsafe { GetWindowLongPtrW(hwnd, GWL_STYLE) };
        if updated & ((WS_CAPTION | WS_THICKFRAME) as isize) != 0 {
            return Err("remove native window caption/frame failed".to_string());
        }
        let ok = unsafe {
            SetWindowPos(
                hwnd,
                std::ptr::null_mut(),
                0,
                0,
                0,
                0,
                SWP_FRAMECHANGED | SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOOWNERZORDER,
            )
        };
        if ok == 0 {
            return Err("refresh borderless window frame failed".to_string());
        }
        Ok(())
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn borderless_style_removes_caption_and_resize_frame_only() {
            let unrelated = 0x0008_0000isize;
            let style = unrelated | WS_CAPTION as isize | WS_THICKFRAME as isize;
            let result = borderless_style(style);
            assert_eq!(result & WS_CAPTION as isize, 0);
            assert_eq!(result & WS_THICKFRAME as isize, 0);
            assert_eq!(result & unrelated, unrelated);
        }

        #[test]
        fn screen_point_lparam_packs_signed_win32_coordinates() {
            let packed = screen_point_lparam(POINT { x: -20, y: 320 });
            assert_eq!(packed as usize & 0xffff, (-20i16) as u16 as usize);
            assert_eq!((packed as usize >> 16) & 0xffff, 320);
        }

        #[test]
        fn titlebar_hit_regions_scale_with_window_dpi() {
            assert_eq!(logical_pixels(TITLEBAR_HEIGHT_LOGICAL_PX, 96), 42);
            assert_eq!(logical_pixels(TITLEBAR_HEIGHT_LOGICAL_PX, 120), 53);
            assert_eq!(logical_pixels(WINDOW_CONTROL_WIDTH_LOGICAL_PX, 144), 234);
        }
    }

    unsafe fn is_draggable_titlebar_point(hwnd: HWND) -> bool {
        let mut point = POINT { x: 0, y: 0 };
        if GetCursorPos(&mut point) == 0 || ScreenToClient(hwnd, &mut point) == 0 {
            return false;
        }

        let mut rect = RECT {
            left: 0,
            top: 0,
            right: 0,
            bottom: 0,
        };
        if GetClientRect(hwnd, &mut rect) == 0 {
            return false;
        }

        let dpi = unsafe { GetDpiForWindow(hwnd) };
        let titlebar_height = logical_pixels(TITLEBAR_HEIGHT_LOGICAL_PX, dpi);
        let window_control_width = logical_pixels(WINDOW_CONTROL_WIDTH_LOGICAL_PX, dpi);

        point.y >= 0
            && point.y < titlebar_height
            && point.x >= 0
            && point.x < rect.right.saturating_sub(window_control_width)
    }
}

#[cfg(not(windows))]
mod native_titlebar {
    pub fn install(_window: &tauri::WebviewWindow) -> Result<(), String> {
        Ok(())
    }
}

impl Default for RuntimeState {
    fn default() -> Self {
        Self {
            xray: Mutex::new(XrayCoordinator::default()),
            window_restore_bounds: Mutex::new(None),
        }
    }
}

#[derive(Default)]
struct RuntimeProcesses {
    tachyon_core: ManagedProcess,
    xray: ManagedProcess,
}

#[derive(Default)]
struct ManagedProcess {
    child: Option<Child>,
    binary_path: Option<String>,
    config_path: Option<String>,
    started_at: Option<u64>,
    last_error: Option<String>,
    exit_code: Option<i32>,
    stdout_tail: Arc<Mutex<String>>,
    stderr_tail: Arc<Mutex<String>>,
    stdout_reader: Option<thread::JoinHandle<()>>,
    stderr_reader: Option<thread::JoinHandle<()>>,
    stop_method: Option<String>,
    sanitize_diagnostics: bool,
    #[cfg(test)]
    stop_fault: Option<StopFault>,
}

enum ManagedConfigDelivery<'a> {
    Path(PathBuf),
    Generation(&'a xray_generation::ConfigLease),
}

#[cfg(test)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum StopFault {
    TryWait,
    Kill,
    Wait,
}

struct ProductionXrayBackend<'a> {
    app: &'a tauri::AppHandle,
    proxy: &'a system_proxy::SystemProxyRuntime,
    process: &'a mut ManagedProcess,
    watchdog: &'a mut Option<GenerationWatchdog>,
    binary: PathBuf,
    config_mode: XrayConfigTrustMode,
    settings: RuntimeSettings,
}

impl xray_generation::ApplyBackend for ProductionXrayBackend<'_> {
    fn validate_config(
        &mut self,
        plan: &xray_generation::ApplyPlan,
        config: &xray_generation::ConfigLease,
    ) -> Result<(), xray_generation::BackendFailure> {
        validate_xray_apply_plan(plan, self.config_mode, &self.settings)
            .map_err(|_| xray_generation::BackendFailure::Failed)?;
        let validation = validate_xray_config_lease(&self.binary, config)
            .map_err(|_| xray_generation::BackendFailure::Failed)?;
        if validation.ok {
            Ok(())
        } else {
            Err(xray_generation::BackendFailure::Failed)
        }
    }

    fn capture_proxy_snapshot(
        &mut self,
    ) -> Result<Option<xray_generation::ProxySnapshotHandle>, xray_generation::BackendFailure> {
        let query = system_proxy::query(self.app, self.proxy)
            .map_err(|_| xray_generation::BackendFailure::Failed)?;
        if query.current.error.is_some() {
            return Err(xray_generation::BackendFailure::Failed);
        }
        if !query.current.enabled {
            return Ok(None);
        }
        if !query.current.matches_prism || query.pending_transaction.is_none() {
            return Err(xray_generation::BackendFailure::Failed);
        }
        Ok(Some(xray_generation::ProxySnapshotHandle {
            token: "system-proxy-journal".to_string(),
        }))
    }

    fn restore_proxy_snapshot(
        &mut self,
        snapshot: &xray_generation::ProxySnapshotHandle,
    ) -> Result<xray_generation::ProxyReadback, xray_generation::BackendFailure> {
        if snapshot.token != "system-proxy-journal" {
            return Ok(xray_generation::ProxyReadback::Unknown);
        }
        system_proxy::restore_if_pending(self.app, self.proxy)
            .map_err(|_| xray_generation::BackendFailure::Failed)?;
        let current = system_proxy::query(self.app, self.proxy)
            .map_err(|_| xray_generation::BackendFailure::Failed)?
            .current;
        if current.error.is_none() && !current.enabled {
            Ok(xray_generation::ProxyReadback::Restored)
        } else {
            Ok(xray_generation::ProxyReadback::Unknown)
        }
    }

    fn stop_active(
        &mut self,
        active: &xray_generation::CandidateHandle,
    ) -> Result<(), xray_generation::BackendFailure> {
        let status = self.process.status();
        if status.state != "running" || status.pid != Some(active.pid()) {
            return Err(xray_generation::BackendFailure::Failed);
        }
        self.process
            .stop("xray")
            .map(|_| ())
            .map_err(|_| xray_generation::BackendFailure::Failed)
    }

    fn confirm_exit(
        &mut self,
        handle: &xray_generation::CandidateHandle,
    ) -> Result<(), xray_generation::BackendFailure> {
        let status = self.process.status();
        if status.state != "running" && status.pid != Some(handle.pid()) {
            Ok(())
        } else {
            Err(xray_generation::BackendFailure::Failed)
        }
    }

    fn start_candidate(
        &mut self,
        plan: &xray_generation::ApplyPlan,
        config: &xray_generation::ConfigLease,
    ) -> Result<xray_generation::RunnerHandle, xray_generation::BackendFailure> {
        let status = self
            .process
            .start_generation(
                "xray",
                ManagedBinaryKind::Xray,
                path_string(&self.binary),
                config,
                &XRAY_RUN_CONFIG_ARGS,
            )
            .map_err(|_| xray_generation::BackendFailure::Failed)?;
        let pid = status.pid.ok_or(xray_generation::BackendFailure::Failed)?;
        Ok(xray_generation::RunnerHandle {
            pid,
            runner_token: plan.generation_id().as_str().to_string(),
        })
    }

    fn stop_candidate(
        &mut self,
        handle: &xray_generation::CandidateHandle,
    ) -> Result<(), xray_generation::BackendFailure> {
        self.stop_active(handle)
    }

    fn confirm_process_identity(
        &mut self,
        _generation_id: &xray_generation::GenerationId,
        handle: &xray_generation::CandidateHandle,
    ) -> Result<(), xray_generation::BackendFailure> {
        self.process
            .confirm_running("xray")
            .map_err(|_| xray_generation::BackendFailure::Failed)?;
        let status = self.process.status();
        if status.pid == Some(handle.pid())
            && status.config_path.as_deref() == Some(&path_string(handle.config_path()))
        {
            Ok(())
        } else {
            Err(xray_generation::BackendFailure::Failed)
        }
    }

    fn confirm_listener_readiness(
        &mut self,
        _generation_id: &xray_generation::GenerationId,
        handle: &xray_generation::CandidateHandle,
        listeners: &[String],
    ) -> Result<(), xray_generation::BackendFailure> {
        verify_owned_managed_listeners(handle.pid(), listeners, STARTUP_READINESS_TIMEOUT)
            .map_err(|_| xray_generation::BackendFailure::Failed)
    }

    fn confirm_egress_ready(
        &mut self,
        generation_id: &xray_generation::GenerationId,
        handle: &xray_generation::CandidateHandle,
        listeners: &[String],
        probe: &xray_generation::EgressProbeSettings,
    ) -> Result<bool, xray_generation::BackendFailure> {
        self.confirm_process_identity(generation_id, handle)?;
        self.confirm_listener_readiness(generation_id, handle, listeners)?;
        if !probe.is_configured() {
            return Ok(false);
        }
        probe_xray_egress(probe, EGRESS_PROBE_TIMEOUT)
            .map_err(|_| xray_generation::BackendFailure::Failed)?;
        self.confirm_process_identity(generation_id, handle)?;
        self.confirm_listener_readiness(generation_id, handle, listeners)?;
        Ok(true)
    }

    fn rollback(
        &mut self,
        active: &xray_generation::GenerationView,
        previous_handle: &xray_generation::CandidateHandle,
    ) -> Result<xray_generation::RunnerHandle, xray_generation::RollbackFailure> {
        let status = self
            .process
            .start_generation(
                "xray",
                ManagedBinaryKind::Xray,
                path_string(&self.binary),
                previous_handle.config_lease(),
                &XRAY_RUN_CONFIG_ARGS,
            )
            .map_err(|_| xray_generation::RollbackFailure { runner: None })?;
        let pid = status
            .pid
            .ok_or(xray_generation::RollbackFailure { runner: None })?;
        let runner = xray_generation::RunnerHandle {
            pid,
            runner_token: active.generation_id.as_str().to_string(),
        };
        if verify_owned_managed_listeners(
            pid,
            &active.managed_listener_addresses,
            STARTUP_READINESS_TIMEOUT,
        )
        .is_ok()
        {
            return Ok(runner);
        }
        let stopped = self.process.stop("xray").is_ok();
        let exited = self.process.status().state != "running";
        if stopped && exited {
            Err(xray_generation::RollbackFailure { runner: None })
        } else {
            Err(xray_generation::RollbackFailure {
                runner: Some(runner),
            })
        }
    }

    fn bind_proxy(
        &mut self,
        generation_id: &xray_generation::GenerationId,
        handle: &xray_generation::CandidateHandle,
        active: &xray_generation::GenerationView,
    ) -> Result<xray_generation::ProxyReadback, xray_generation::BackendFailure> {
        if active.generation_id != *generation_id
            || active.pid != Some(handle.pid())
            || active.readiness != xray_generation::ReadinessLevel::EgressReady
            || !active.egress_verified
        {
            return Err(xray_generation::BackendFailure::Failed);
        }
        self.confirm_process_identity(generation_id, handle)?;
        self.confirm_listener_readiness(generation_id, handle, &active.managed_listener_addresses)?;
        probe_xray_egress(&active.egress_probe, PROXY_BIND_EGRESS_TIMEOUT)
            .map_err(|_| xray_generation::BackendFailure::Failed)?;
        let settings = active_proxy_settings(self.app, active)
            .map_err(|_| xray_generation::BackendFailure::Failed)?;
        if start_generation_watchdog(
            self.app,
            self.watchdog,
            generation_id.clone(),
            handle.pid(),
            active.managed_listener_addresses.clone(),
        )
        .is_err()
        {
            return fail_proxy_bind(self.app, self.proxy, self.watchdog);
        }
        let applied = match system_proxy::apply_with_settings(self.app, self.proxy, &settings, true)
        {
            Ok(applied) => applied,
            Err(_) => return fail_proxy_bind(self.app, self.proxy, self.watchdog),
        };

        // Keep the system-proxy transaction tied to this generation. A successful registry
        // write alone is not a binding: the journal and the readback must still describe the
        // transaction created for this active Xray candidate.
        let readback = match system_proxy::query_with_settings(self.app, self.proxy, &settings) {
            Ok(readback) => readback,
            Err(_) => return fail_proxy_bind(self.app, self.proxy, self.watchdog),
        };
        if !proxy_readback_matches_active(&readback, &settings, &applied.transaction_id) {
            return fail_proxy_bind(self.app, self.proxy, self.watchdog);
        }

        if self
            .confirm_process_identity(generation_id, handle)
            .is_err()
            || self
                .confirm_listener_readiness(
                    generation_id,
                    handle,
                    &active.managed_listener_addresses,
                )
                .is_err()
        {
            return fail_proxy_bind(self.app, self.proxy, self.watchdog);
        }

        // This is deliberately the last network probe. Everything after it is a local,
        // generation-bound readback so a process kill or listener takeover cannot be reported
        // as a green system-proxy binding.
        if active.generation_id != *generation_id
            || active.pid != Some(handle.pid())
            || !active.egress_verified
            || probe_xray_egress(&active.egress_probe, PROXY_BIND_EGRESS_TIMEOUT).is_err()
        {
            return fail_proxy_bind(self.app, self.proxy, self.watchdog);
        }

        let final_readback =
            match system_proxy::query_with_settings(self.app, self.proxy, &settings) {
                Ok(readback) => readback,
                Err(_) => return fail_proxy_bind(self.app, self.proxy, self.watchdog),
            };
        if !proxy_readback_matches_active(&final_readback, &settings, &applied.transaction_id)
            || self
                .confirm_process_identity(generation_id, handle)
                .is_err()
            || self
                .confirm_listener_readiness(
                    generation_id,
                    handle,
                    &active.managed_listener_addresses,
                )
                .is_err()
        {
            return fail_proxy_bind(self.app, self.proxy, self.watchdog);
        }
        Ok(xray_generation::ProxyReadback::Bound(
            xray_generation::ProxyGenerationView {
                generation_id: generation_id.clone(),
                pid: handle.pid(),
            },
        ))
    }
}

fn fail_proxy_bind(
    app: &tauri::AppHandle,
    proxy: &system_proxy::SystemProxyRuntime,
    watchdog: &mut Option<GenerationWatchdog>,
) -> Result<xray_generation::ProxyReadback, xray_generation::BackendFailure> {
    // The generation runtime clears proxy_generation and marks itself Degraded when this error
    // reaches it. Restore the OS snapshot here as well, while the transaction journal still
    // identifies the failed binding.
    stop_generation_watchdog(watchdog);
    let _ = system_proxy::restore_if_pending(app, proxy);
    Err(xray_generation::BackendFailure::Failed)
}

impl XrayCoordinator {
    fn apply_xray(
        &mut self,
        app: &tauri::AppHandle,
        proxy: &system_proxy::SystemProxyRuntime,
        binary_path: String,
        config_path: String,
    ) -> Result<ProcessStatus, String> {
        self.stop_proxy_watchdog();
        let binary = PathBuf::from(clean_path_input(&binary_path));
        let source = PathBuf::from(clean_path_input(&config_path));
        let config =
            fs::read(&source).map_err(|error| format!("read Xray desired config: {error}"))?;
        if config.len() > CANONICAL_XRAY_CONFIG_LIMIT_BYTES {
            return Err("Xray desired config exceeds the managed size limit".to_string());
        }
        let config_text = std::str::from_utf8(&config)
            .map_err(|_| "Xray desired config is not UTF-8".to_string())?;
        ensure_json_object("Xray desired config", config_text)?;
        let config_value: Value = serde_json::from_str(config_text)
            .map_err(|_| "Xray desired config is not valid JSON".to_string())?;
        use sha2::{Digest, Sha256};
        let digest_bytes: [u8; 32] = Sha256::digest(&config).into();
        let authorization = self
            .xray_config_authorization
            .clone()
            .filter(|authorization| authorization.digest == digest_bytes)
            .ok_or_else(|| {
                "Xray config was not committed through the trusted validation boundary".to_string()
            })?;
        let settings = load_runtime_settings(app)?;
        validate_xray_config_value(&config_value, authorization.mode, &settings)?;
        let managed_listeners = xray_managed_listener_addresses(&config_value, &settings)?;
        let digest = digest_bytes
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        let node_id = format!("managed-config-{}", &digest[..16]);
        self.generations
            .select_desired_with_probe(
                &config,
                node_id,
                digest,
                managed_listeners,
                egress_probe_settings(&settings)?,
            )
            .map_err(generation_apply_error)?;
        let (processes, generations, watchdog) = (
            &mut self.processes,
            &mut self.generations,
            &mut self.proxy_watchdog,
        );
        let mut backend = ProductionXrayBackend {
            app,
            proxy,
            process: &mut processes.xray,
            watchdog,
            binary,
            config_mode: authorization.mode,
            settings,
        };
        generations
            .execute_latest(&mut backend)
            .map_err(generation_apply_error)?;
        Ok(processes.xray.status())
    }

    fn stop_xray(
        &mut self,
        app: &tauri::AppHandle,
        proxy: &system_proxy::SystemProxyRuntime,
    ) -> Result<ProcessStatus, String> {
        self.stop_proxy_watchdog();
        let process_status = self.processes.xray.status();
        let generation_status = self.generations.status();
        if process_status.state == "running" && generation_status.active.is_none() {
            return Err("refusing to stop uncoordinated Xray process".to_string());
        }
        if generation_status.active.is_none() {
            self.set_proxy_binding(app, proxy, false)?;
            return Ok(process_status);
        }
        let settings = load_runtime_settings(app)?;
        let binary = PathBuf::from(
            process_status
                .binary_path
                .clone()
                .unwrap_or_else(|| settings.xray_binary_path.clone()),
        );
        let config_mode = self
            .xray_config_authorization
            .as_ref()
            .map(|authorization| authorization.mode)
            .unwrap_or(XrayConfigTrustMode::Managed);
        let (processes, generations, watchdog) = (
            &mut self.processes,
            &mut self.generations,
            &mut self.proxy_watchdog,
        );
        let mut backend = ProductionXrayBackend {
            app,
            proxy,
            process: &mut processes.xray,
            watchdog,
            binary,
            config_mode,
            settings,
        };
        generations
            .stop_active(&mut backend)
            .map_err(generation_apply_error)?;
        Ok(processes.xray.status())
    }

    fn start_all(
        &mut self,
        app: &tauri::AppHandle,
        proxy: &system_proxy::SystemProxyRuntime,
        xray_binary_path: String,
        xray_config_path: String,
        tachyon_core_binary_path: String,
        tachyon_core_config_path: String,
    ) -> Result<(), String> {
        let current = self.processes.status();
        if current.xray.state == "running" || current.tachyon_core.state == "running" {
            return Err("start_all requires both managed cores to be stopped".to_string());
        }
        let tachyon_binary = PathBuf::from(clean_path_input(&tachyon_core_binary_path));
        let tachyon_config = PathBuf::from(clean_path_input(&tachyon_core_config_path));
        let preflight = preflight_tachyon_core_config_file(&tachyon_binary, &tachyon_config)?;
        ensure_tachyon_core_preflight_allows_start(&preflight)?;
        self.apply_xray(app, proxy, xray_binary_path, xray_config_path)?;
        let settings = load_runtime_settings(app)?;
        let tachyon_start = self
            .processes
            .tachyon_core
            .start(
                "tachyon-core",
                ManagedBinaryKind::TachyonCore,
                path_string(&tachyon_binary),
                path_string(&tachyon_config),
                &["run", "--config"],
            )
            .and_then(|_| {
                wait_for_readiness(
                    "Tachyon Core",
                    STARTUP_READINESS_TIMEOUT,
                    STARTUP_READINESS_INTERVAL,
                    |remaining| {
                        self.processes
                            .tachyon_core
                            .confirm_running("tachyon-core")?;
                        let status = core_health_check_with_timeout(
                            &settings,
                            remaining.min(STARTUP_PROBE_TIMEOUT),
                        )?;
                        if status == "ok" {
                            Ok(())
                        } else {
                            Err(format!("Tachyon Core returned status {status:?}"))
                        }
                    },
                )
            });
        if let Err(error) = tachyon_start {
            let mut rollback_errors = Vec::new();
            if let Err(stop_error) = self.processes.tachyon_core.stop("tachyon-core") {
                rollback_errors.push(stop_error);
            }
            if let Err(stop_error) = self.stop_xray(app, proxy) {
                rollback_errors.push(stop_error);
            }
            return Err(start_all_rollback_error(error, rollback_errors));
        }
        Ok(())
    }

    fn stop_all(
        &mut self,
        app: &tauri::AppHandle,
        proxy: &system_proxy::SystemProxyRuntime,
    ) -> RuntimeShutdownOutcome {
        let mut errors = Vec::new();
        if let Err(error) = self.processes.tachyon_core.stop("tachyon-core") {
            errors.push(error);
        }
        let mut proxy_restored = false;
        let mut proxy_restore_status = "failed".to_string();
        let mut xray_stop_blocked = false;
        let mut last_error = None;
        for attempt in 1..=PROXY_RESTORE_ATTEMPTS {
            match self.stop_xray(app, proxy) {
                Ok(_) => {
                    proxy_restored = true;
                    proxy_restore_status = if attempt == 1 {
                        "restored".to_string()
                    } else {
                        format!("restoredAfterRetry{attempt}")
                    };
                    last_error = None;
                    break;
                }
                Err(error) => {
                    last_error = Some(error);
                    if attempt < PROXY_RESTORE_ATTEMPTS {
                        thread::sleep(PROXY_RESTORE_RETRY_DELAY);
                    }
                }
            }
        }
        if let Some(error) = last_error {
            xray_stop_blocked = true;
            errors.push(sanitize_xray_ui_error(error));
        }
        RuntimeShutdownOutcome {
            proxy_restored,
            proxy_restore_status,
            xray_stop_blocked,
            errors,
        }
    }

    fn set_proxy_binding(
        &mut self,
        app: &tauri::AppHandle,
        proxy: &system_proxy::SystemProxyRuntime,
        enabled: bool,
    ) -> Result<system_proxy::SystemProxyState, String> {
        if !enabled {
            self.stop_proxy_watchdog();
        }
        let settings = load_runtime_settings(app)?;
        let status = self.processes.xray.status();
        let binary = PathBuf::from(
            status
                .binary_path
                .clone()
                .unwrap_or_else(|| settings.xray_binary_path.clone()),
        );
        let config_mode = self
            .xray_config_authorization
            .as_ref()
            .map(|authorization| authorization.mode)
            .unwrap_or(XrayConfigTrustMode::Managed);
        let (processes, generations, watchdog) = (
            &mut self.processes,
            &mut self.generations,
            &mut self.proxy_watchdog,
        );
        let mut backend = ProductionXrayBackend {
            app,
            proxy,
            process: &mut processes.xray,
            watchdog,
            binary,
            config_mode,
            settings,
        };
        if enabled {
            let result = generations
                .bind_proxy_active(&mut backend)
                .map_err(generation_apply_error);
            if result.is_err() {
                stop_generation_watchdog(watchdog);
            }
            result?;
        } else {
            generations
                .restore_proxy(&mut backend)
                .map_err(generation_apply_error)?;
        }
        Ok(system_proxy::query(app, proxy)?.current)
    }

    fn revalidate_xray_generation(
        &mut self,
        app: &tauri::AppHandle,
        proxy: &system_proxy::SystemProxyRuntime,
    ) -> Result<(), String> {
        let settings = load_runtime_settings(app)?;
        let process_status = self.processes.xray.status();
        let binary = PathBuf::from(
            process_status
                .binary_path
                .clone()
                .unwrap_or_else(|| settings.xray_binary_path.clone()),
        );
        let config_mode = self
            .xray_config_authorization
            .as_ref()
            .map(|authorization| authorization.mode)
            .unwrap_or(XrayConfigTrustMode::Managed);
        let (processes, generations, watchdog) = (
            &mut self.processes,
            &mut self.generations,
            &mut self.proxy_watchdog,
        );
        let mut backend = ProductionXrayBackend {
            app,
            proxy,
            process: &mut processes.xray,
            watchdog,
            binary,
            config_mode,
            settings,
        };
        generations
            .revalidate_active(&mut backend)
            .map_err(generation_apply_error)
    }

    fn revalidate_xray_generation_with_proxy_recovery(
        &mut self,
        app: &tauri::AppHandle,
        proxy: &system_proxy::SystemProxyRuntime,
    ) -> Result<(), String> {
        let generation_check_failed = self.revalidate_xray_generation(app, proxy).is_err();
        let process_status = self.processes.status();
        if generation_check_failed || should_restore_proxy_for_runtime(&process_status) {
            self.set_proxy_binding(app, proxy, false).map_err(|error| {
                format!(
                    "restore system proxy for stopped Xray: {}",
                    sanitize_xray_ui_error(error)
                )
            })?;
        }
        Ok(())
    }

    fn stop_proxy_watchdog(&mut self) {
        stop_generation_watchdog(&mut self.proxy_watchdog);
    }

    fn proxy_watchdog_tick(
        &mut self,
        app: &tauri::AppHandle,
        proxy: &system_proxy::SystemProxyRuntime,
        expected_generation_id: &xray_generation::GenerationId,
        expected_pid: u32,
        expected_listeners: &[String],
    ) -> bool {
        let status = self.generations.status();
        // The watcher starts before the OS proxy write. Until the binding is visible in the
        // generation runtime it only waits; bind_proxy owns failures during that short window.
        if status.proxy_generation.is_none() {
            return false;
        }
        let process_status = self.processes.xray.status();
        let process_alive =
            process_status.state == "running" && process_status.pid == Some(expected_pid);
        let listeners_owned = process_alive
            && verify_owned_managed_listeners(
                expected_pid,
                expected_listeners,
                PROXY_WATCHDOG_LISTENER_TIMEOUT,
            )
            .is_ok();
        let proxy_readback_active = status
            .active
            .as_ref()
            .and_then(|active| {
                let settings = active_proxy_settings(app, active).ok()?;
                let readback = system_proxy::query_with_settings(app, proxy, &settings).ok()?;
                Some(proxy_readback_matches_active_state(&readback, &settings))
            })
            .unwrap_or(false);
        if watchdog_binding_is_current(
            &status,
            expected_generation_id,
            expected_pid,
            process_alive,
            listeners_owned,
            proxy_readback_active,
        ) {
            return false;
        }

        recover_proxy_binding_after_watchdog(&mut self.generations, || {
            system_proxy::restore_if_pending(app, proxy)
        });
        true
    }
}

impl Drop for XrayCoordinator {
    fn drop(&mut self) {
        self.stop_proxy_watchdog();
    }
}

fn start_generation_watchdog(
    app: &tauri::AppHandle,
    slot: &mut Option<GenerationWatchdog>,
    generation_id: xray_generation::GenerationId,
    pid: u32,
    listeners: Vec<String>,
) -> Result<(), String> {
    stop_generation_watchdog(slot);
    let stop = Arc::new(AtomicBool::new(false));
    let thread_stop = Arc::clone(&stop);
    let app = app.clone();
    let join = thread::Builder::new()
        .name("tachyon-prism-proxy-watchdog".to_string())
        .spawn(move || {
            proxy_watchdog_loop(app, thread_stop, generation_id, pid, listeners);
        })
        .map_err(|error| format!("start proxy watchdog: {error}"))?;
    *slot = Some(GenerationWatchdog {
        stop,
        join: Some(join),
    });
    Ok(())
}

fn stop_generation_watchdog(slot: &mut Option<GenerationWatchdog>) {
    let Some(mut watchdog) = slot.take() else {
        return;
    };
    watchdog.stop.store(true, Ordering::Release);
    if let Some(join) = watchdog.join.take() {
        if join.thread().id() != thread::current().id() {
            let _ = join.join();
        }
    }
}

fn proxy_watchdog_loop(
    app: tauri::AppHandle,
    stop: Arc<AtomicBool>,
    generation_id: xray_generation::GenerationId,
    pid: u32,
    listeners: Vec<String>,
) {
    loop {
        if wait_for_proxy_watchdog_tick(&stop, pid) {
            return;
        }
        let runtime = app.state::<RuntimeState>();
        let proxy = app.state::<system_proxy::SystemProxyRuntime>();
        let Ok(mut coordinator) = runtime.xray.try_lock() else {
            continue;
        };
        if coordinator.proxy_watchdog_tick(&app, &proxy, &generation_id, pid, &listeners) {
            return;
        }
    }
}

fn wait_for_proxy_watchdog_tick(stop: &AtomicBool, pid: u32) -> bool {
    #[cfg(not(target_os = "windows"))]
    let _ = pid;
    #[cfg(target_os = "windows")]
    {
        use windows_sys::Win32::Foundation::CloseHandle;
        use windows_sys::Win32::System::Threading::{OpenProcess, WaitForSingleObject};
        const SYNCHRONIZE: u32 = 0x0010_0000;
        const WAIT_OBJECT_0: u32 = 0;
        let handle = unsafe { OpenProcess(SYNCHRONIZE, 0, pid) };
        if !handle.is_null() {
            let result =
                unsafe { WaitForSingleObject(handle, PROXY_WATCHDOG_INTERVAL.as_millis() as u32) };
            unsafe { CloseHandle(handle) };
            if result == WAIT_OBJECT_0 {
                return stop.load(Ordering::Acquire);
            }
        }
    }
    thread::sleep(PROXY_WATCHDOG_INTERVAL);
    stop.load(Ordering::Acquire)
}

fn watchdog_binding_is_current(
    status: &xray_generation::GenerationStatus,
    expected_generation_id: &xray_generation::GenerationId,
    expected_pid: u32,
    process_alive: bool,
    listeners_owned: bool,
    proxy_readback_active: bool,
) -> bool {
    status.proxy_ready
        && process_alive
        && listeners_owned
        && proxy_readback_active
        && status.active.as_ref().is_some_and(|active| {
            active.generation_id == *expected_generation_id
                && active.pid == Some(expected_pid)
                && active.readiness == xray_generation::ReadinessLevel::EgressReady
                && active.egress_verified
        })
        && status.proxy_generation.as_ref().is_some_and(|binding| {
            binding.generation_id == *expected_generation_id && binding.pid == expected_pid
        })
}

fn recover_proxy_binding_after_watchdog(
    generations: &mut xray_generation::GenerationRuntime,
    restore: impl FnOnce() -> Result<bool, String>,
) {
    let restore_failed = restore().is_err();
    generations.degrade_proxy_binding(if restore_failed {
        "proxyWatchdogRestoreFailed"
    } else {
        "proxyWatchdogFailed"
    });
}

fn generation_apply_error(error: xray_generation::ApplyFailure) -> String {
    format!("Xray coordinator transaction failed: {error:?}")
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ProcessLogs {
    kind: String,
    stdout_tail: String,
    stderr_tail: String,
    capacity_bytes_per_stream: usize,
}

#[tauri::command]
fn core_status(app: tauri::AppHandle) -> String {
    match load_runtime_settings(&app).and_then(|settings| core_health_check(&settings)) {
        Ok(status) => status,
        Err(_) => "disconnected".to_string(),
    }
}

fn core_health_check(settings: &RuntimeSettings) -> Result<String, String> {
    core_health_check_with_timeout(settings, Duration::from_secs(3))
}

fn core_health_check_with_timeout(
    settings: &RuntimeSettings,
    timeout: Duration,
) -> Result<String, String> {
    let url = core_health_url(settings)?;
    let mut response = health_agent_with_timeout(timeout)
        .get(&url)
        .header("User-Agent", "Tachyon-Prism/0.1")
        .call()
        .map_err(|err| format!("core health check: {err}"))?;

    let body: serde_json::Value = response
        .body_mut()
        .read_json()
        .map_err(|err| format!("decode health response: {err}"))?;

    let status = body
        .get("status")
        .and_then(|v| v.as_str())
        .unwrap_or("unknown");

    Ok(status.to_string())
}

fn core_health_url(settings: &RuntimeSettings) -> Result<String, String> {
    let address = local_loopback_socket_addr(
        &settings.tachyon_ipc_listen,
        settings.tachyon_ipc_port,
        "Tachyon Core IPC",
    )?;
    Ok(format!("http://{address}/v1/health"))
}

#[tauri::command]
fn list_game_profiles(app: tauri::AppHandle) -> Result<GameProfilesFile, String> {
    load_game_profiles(&app)
}

#[tauri::command]
fn save_game_profile(app: tauri::AppHandle, profile: GameProfile) -> Result<GameProfile, String> {
    validate_game_profile(&profile)?;
    let mut file = load_game_profiles(&app)?;
    file.profiles.retain(|current| current.id != profile.id);
    file.profiles.push(profile.clone());
    sort_game_profiles(&mut file.profiles);
    save_game_profiles(&app, &file)?;
    Ok(profile)
}

#[tauri::command]
fn remove_game_profile(app: tauri::AppHandle, id: String) -> Result<GameProfilesFile, String> {
    let mut file = load_game_profiles(&app)?;
    file.profiles.retain(|profile| profile.id != id);
    save_game_profiles(&app, &file)?;
    Ok(file)
}

#[tauri::command]
fn scan_steam_library(root: Option<String>) -> Result<SteamScanResult, String> {
    scan_steam(root.as_deref())
}

#[tauri::command]
fn config_paths(app: tauri::AppHandle) -> Result<ConfigDraftPaths, String> {
    draft_paths(&app)
}

#[tauri::command]
fn read_canonical_xray_config(app: tauri::AppHandle) -> Result<CanonicalXrayConfigText, String> {
    let paths = draft_paths(&app)?;
    read_optional_utf8_file_bounded(
        Path::new(&paths.xray_config_path),
        CANONICAL_XRAY_CONFIG_LIMIT_BYTES,
    )
}

fn read_optional_utf8_file_bounded(
    path: &Path,
    limit_bytes: usize,
) -> Result<CanonicalXrayConfigText, String> {
    let file = match fs::File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            return Ok(CanonicalXrayConfigText {
                exists: false,
                contents: None,
            })
        }
        Err(error) => return Err(format!("open canonical Xray config: {error}")),
    };
    let mut bytes = Vec::new();
    file.take(limit_bytes.saturating_add(1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("read canonical Xray config: {error}"))?;
    if bytes.len() > limit_bytes {
        return Err(format!(
            "canonical Xray config exceeds the {limit_bytes}-byte UTF-8 limit"
        ));
    }
    let contents = String::from_utf8(bytes)
        .map_err(|error| format!("canonical Xray config is not valid UTF-8: {error}"))?;
    Ok(CanonicalXrayConfigText {
        exists: true,
        contents: Some(contents),
    })
}

#[tauri::command]
fn save_config_drafts(
    app: tauri::AppHandle,
    core_json: String,
    xray_json: String,
) -> Result<ConfigDraftPaths, String> {
    ensure_json_object("Core config", &core_json)?;
    ensure_json_object("Xray config", &xray_json)?;

    let paths = draft_paths(&app)?;
    let config_dir = PathBuf::from(&paths.config_dir);
    fs::create_dir_all(&config_dir).map_err(|err| format!("create config directory: {err}"))?;

    write_atomic(Path::new(&paths.core_config_path), &core_json)?;
    write_atomic(Path::new(&paths.xray_config_path), &xray_json)?;

    Ok(paths)
}

#[tauri::command]
fn save_config_draft(
    app: tauri::AppHandle,
    kind: String,
    json: String,
) -> Result<ConfigDraftPaths, String> {
    let paths = draft_paths(&app)?;
    let config_dir = PathBuf::from(&paths.config_dir);
    fs::create_dir_all(&config_dir).map_err(|err| format!("create config directory: {err}"))?;

    match kind.trim().to_ascii_lowercase().as_str() {
        "core" | "tachyoncore" | "tachyon-core" => {
            ensure_json_object("Core config", &json)?;
            write_atomic(Path::new(&paths.core_config_path), &json)?;
        }
        "xray" | "xray-core" => {
            ensure_json_object("Xray config", &json)?;
            write_atomic(Path::new(&paths.xray_config_path), &json)?;
        }
        other => return Err(format!("unknown config draft kind: {other}")),
    }

    Ok(paths)
}

#[tauri::command]
fn runtime_paths(app: tauri::AppHandle) -> Result<RuntimePaths, String> {
    default_runtime_paths(&app)
}

#[tauri::command]
fn runtime_settings(app: tauri::AppHandle) -> Result<RuntimeSettings, String> {
    load_runtime_settings(&app)
}

#[tauri::command]
fn save_runtime_settings(
    app: tauri::AppHandle,
    settings: RuntimeSettings,
) -> Result<RuntimeSettings, String> {
    save_runtime_settings_file(&app, settings)
}

#[tauri::command]
fn managed_binaries(app: tauri::AppHandle) -> Result<ManagedBinaryInventory, String> {
    managed_binary_inventory(&app)
}

#[tauri::command]
fn install_managed_binary(
    app: tauri::AppHandle,
    kind: String,
    source_path: String,
) -> Result<ManagedBinaryInventory, String> {
    let binary_kind = ManagedBinaryKind::parse(&kind)?;
    let source = PathBuf::from(clean_path_input(&source_path));
    if !source.is_file() {
        return Err(format!("source binary not found: {}", source.display()));
    }

    let target = managed_binary_target(&app, binary_kind)?;
    let target_dir = target
        .parent()
        .ok_or_else(|| "managed binary target has no parent".to_string())?;
    fs::create_dir_all(target_dir)
        .map_err(|err| format!("create binary directory {}: {err}", target_dir.display()))?;

    if !same_file(&source, &target) {
        copy_binary_atomic(&source, &target)?;
    }
    make_executable(&target)?;

    let mut settings = load_runtime_settings(&app)?;
    match binary_kind {
        ManagedBinaryKind::TachyonCore => settings.tachyon_core_binary_path = path_string(&target),
        ManagedBinaryKind::Xray => settings.xray_binary_path = path_string(&target),
    }
    let _ = save_runtime_settings_file(&app, settings)?;
    managed_binary_inventory(&app)
}

#[tauri::command]
fn latest_xray_release(app: tauri::AppHandle) -> Result<RuntimeReleaseInfo, String> {
    let settings = load_runtime_settings(&app)?;
    fetch_latest_xray_release(&settings.xray_release_channel)
}

#[tauri::command]
fn install_latest_xray(app: tauri::AppHandle) -> Result<RuntimeInstallResult, String> {
    install_latest_xray_release(&app)
}

#[tauri::command]
fn latest_tachyon_core_release(app: tauri::AppHandle) -> Result<RuntimeReleaseInfo, String> {
    let settings = load_runtime_settings(&app)?;
    fetch_latest_tachyon_core_release(&settings.tachyon_core_release_channel)
}

#[tauri::command]
fn install_latest_tachyon_core(app: tauri::AppHandle) -> Result<RuntimeInstallResult, String> {
    install_latest_tachyon_core_release(&app)
}

#[tauri::command]
fn core_release_diagnostics(
    app: tauri::AppHandle,
    kind: String,
) -> Result<CoreReleaseDiagnostics, String> {
    let binary_kind = ManagedBinaryKind::parse(&kind)?;
    build_core_release_diagnostics(&app, binary_kind)
}

#[tauri::command]
fn install_wintun_sidecar(app: tauri::AppHandle) -> Result<ManagedBinaryInventory, String> {
    install_wintun_sidecar_file(&app)
}

#[tauri::command]
fn fetch_subscription_text(source_url: String) -> Result<String, String> {
    let url = clean_url_input(&source_url);
    if url.is_empty() {
        return Err("subscription URL is required".to_string());
    }
    fetch_subscription_url(&url)
}

#[tauri::command]
fn load_secure_vault(app: tauri::AppHandle) -> Result<secure_vault::SecureVaultLoadResult, String> {
    secure_vault::load(&app)
}

#[tauri::command]
fn save_secure_vault_section(
    app: tauri::AppHandle,
    section: String,
    value: Value,
) -> Result<secure_vault::SecureVaultLoadResult, String> {
    secure_vault::save_section(&app, &section, value)
}

#[tauri::command]
fn migrate_secure_vault(
    app: tauri::AppHandle,
    mut payload: secure_vault::SecureVaultPayload,
) -> Result<secure_vault::SecureVaultMigrationResult, String> {
    let settings = load_runtime_settings(&app)?;
    let legacy_psk = settings.tachyon_tgp_auth_psk.trim().to_string();
    if payload.runtime_tgp_auth_psk.is_none() && !legacy_psk.is_empty() {
        payload.runtime_tgp_auth_psk = Some(Value::String(legacy_psk.clone()));
    }

    let migration = secure_vault::migrate(&app, payload)?;
    if !settings.tachyon_tgp_auth_psk.is_empty() {
        if migration.payload.runtime_tgp_auth_psk.as_ref() != Some(&Value::String(legacy_psk)) {
            return Err("secure-vault-migration-conflict".to_string());
        }
        let mut scrubbed = settings;
        scrubbed.tachyon_tgp_auth_psk.clear();
        save_runtime_settings_plain_file(&app, &scrubbed)?;
    }
    Ok(migration)
}

#[tauri::command]
fn clear_secure_vault(app: tauri::AppHandle) -> Result<(), String> {
    secure_vault::clear(&app)
}

#[tauri::command]
fn runtime_status(
    app: tauri::AppHandle,
    state: tauri::State<RuntimeState>,
    proxy_state: tauri::State<system_proxy::SystemProxyRuntime>,
) -> Result<RuntimeStatus, String> {
    let mut coordinator = state
        .xray
        .lock()
        .map_err(|err| format!("lock runtime state: {err}"))?;
    coordinator.revalidate_xray_generation_with_proxy_recovery(&app, &proxy_state)?;
    let status = coordinator.processes.status();
    Ok(status)
}

#[tauri::command]
fn xray_generation_status(
    app: tauri::AppHandle,
    state: tauri::State<RuntimeState>,
    proxy_state: tauri::State<system_proxy::SystemProxyRuntime>,
) -> Result<xray_generation::GenerationStatus, String> {
    let mut runtime = state
        .xray
        .lock()
        .map_err(|err| format!("lock Xray generation state: {err}"))?;
    runtime.revalidate_xray_generation_with_proxy_recovery(&app, &proxy_state)?;
    Ok(runtime.generations.status())
}

#[tauri::command]
fn runtime_process_logs(
    state: tauri::State<RuntimeState>,
    kind: String,
) -> Result<ProcessLogs, String> {
    let processes = state
        .xray
        .lock()
        .map_err(|err| format!("lock runtime state: {err}"))?;
    processes.processes.logs(&kind)
}

#[tauri::command]
fn runtime_privilege_status() -> RuntimePrivilegeStatus {
    platform_runtime_privilege_status()
}

#[tauri::command]
fn xray_traffic_stats(app: tauri::AppHandle) -> Result<XrayTrafficStats, String> {
    let settings = load_runtime_settings(&app)?;
    if !settings.xray_stats_enabled {
        return Ok(XrayTrafficStats::default());
    }

    let binary = PathBuf::from(clean_path_input(&settings.xray_binary_path));
    if !binary.is_file() {
        return Err(format!("xray binary not found: {}", binary.display()));
    }

    let server = xray_stats_server(&settings)?;
    let output = run_xray_stats_query(&binary, &server)?;
    let mut stats = parse_xray_stats_query_output(&output);
    stats.queried_at = epoch_seconds(SystemTime::now());
    Ok(stats)
}

#[tauri::command]
fn tachyon_telemetry_events(app: tauri::AppHandle) -> Result<TachyonTelemetryPoll, String> {
    let settings = load_runtime_settings(&app)?;
    let address = local_loopback_socket_addr(
        &settings.tachyon_ipc_listen,
        settings.tachyon_ipc_port,
        "Tachyon telemetry",
    )?;
    let url = format!("http://{address}/v1/telemetry/sse");
    let interval = Duration::from_millis(u64::from(
        settings.tachyon_telemetry_interval_ms.clamp(100, 2_000),
    ));
    poll_tachyon_telemetry_url(&url, interval + Duration::from_secs(1))
}

fn poll_tachyon_telemetry_url(
    url: &str,
    timeout: Duration,
) -> Result<TachyonTelemetryPoll, String> {
    let mut response = health_agent_with_timeout(timeout)
        .get(url)
        .header("Accept", "text/event-stream")
        .header("User-Agent", "Tachyon-Prism/0.1")
        .call()
        .map_err(|error| format!("tachyon-telemetry-connect-failed: {error}"))?;
    let content_type = response
        .headers()
        .get("content-type")
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default()
        .to_ascii_lowercase();
    if !content_type.starts_with("text/event-stream") {
        return Err("tachyon-telemetry-invalid-content-type".to_string());
    }

    parse_tachyon_sse_batch(BufReader::new(response.body_mut().as_reader()))
}

fn parse_tachyon_sse_batch(reader: impl Read) -> Result<TachyonTelemetryPoll, String> {
    let mut reader = BufReader::new(reader.take(TELEMETRY_RESPONSE_LIMIT_BYTES as u64 + 1));
    let mut events = Vec::new();
    let mut consumed = 0_usize;
    let mut data_lines = Vec::new();
    let mut line = String::new();

    loop {
        line.clear();
        let read = reader
            .read_line(&mut line)
            .map_err(|_| "tachyon-telemetry-read-failed".to_string())?;
        if read == 0 {
            break;
        }
        consumed = consumed.saturating_add(read);
        if consumed > TELEMETRY_RESPONSE_LIMIT_BYTES {
            return Err("tachyon-telemetry-response-too-large".to_string());
        }
        let line = line.trim_end_matches(['\r', '\n']);
        if line.is_empty() {
            if data_lines.is_empty() {
                continue;
            }
            let encoded = data_lines.join("\n");
            data_lines.clear();
            let event: TachyonTelemetryEvent = serde_json::from_str(&encoded)
                .map_err(|_| "tachyon-telemetry-invalid-event".to_string())?;
            let is_snapshot = event.event_type == "telemetry";
            events.push(event);
            if events.len() >= TELEMETRY_EVENT_LIMIT || is_snapshot {
                break;
            }
            continue;
        }
        if let Some(data) = line.strip_prefix("data:") {
            data_lines.push(data.strip_prefix(' ').unwrap_or(data).to_string());
        }
    }

    if events.is_empty() {
        return Err("tachyon-telemetry-stream-ended".to_string());
    }
    Ok(TachyonTelemetryPoll { events })
}

#[tauri::command]
fn test_tcp_latency(
    address: String,
    port: u16,
    timeout_ms: Option<u64>,
) -> Result<TcpLatencyResult, String> {
    let host = address.trim();
    if host.is_empty() {
        return Err("address is required".to_string());
    }
    if port == 0 {
        return Err("port is required".to_string());
    }
    let timeout = Duration::from_millis(timeout_ms.unwrap_or(2500).clamp(100, 10000));
    let addrs: Vec<_> = (host, port)
        .to_socket_addrs()
        .map_err(|err| format!("resolve {host}:{port}: {err}"))?
        .collect();
    if addrs.is_empty() {
        return Err(format!("resolve {host}:{port}: no addresses"));
    }

    let mut last_error = String::new();
    for addr in addrs {
        let started = Instant::now();
        match TcpStream::connect_timeout(&addr, timeout) {
            Ok(stream) => {
                let _ = stream.shutdown(Shutdown::Both);
                let latency = started.elapsed().as_millis().min(u32::MAX as u128) as u32;
                return Ok(TcpLatencyResult {
                    ok: true,
                    latency_ms: Some(latency),
                    error: None,
                });
            }
            Err(err) => {
                last_error = err.to_string();
            }
        }
    }

    Ok(TcpLatencyResult {
        ok: false,
        latency_ms: None,
        error: Some(last_error),
    })
}

#[tauri::command]
fn test_xray_proxy(
    app: tauri::AppHandle,
    target_url: Option<String>,
    timeout_ms: Option<u64>,
) -> Result<ProxyProbeResult, String> {
    let settings = load_runtime_settings(&app)?;
    let url = target_url
        .map(|value| clean_url_input(&value))
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "http://cp.cloudflare.com/generate_204".to_string());
    let timeout = Duration::from_millis(timeout_ms.unwrap_or(5000).clamp(500, 30000));
    probe_http_via_proxy(
        &settings.xray_http_listen,
        settings.xray_http_port,
        &url,
        timeout,
    )
}

#[tauri::command]
fn test_xray_local_proxies(
    app: tauri::AppHandle,
    target_url: Option<String>,
    timeout_ms: Option<u64>,
) -> Result<LocalProxyProbeReport, String> {
    let settings = load_runtime_settings(&app)?;
    let url = target_url
        .map(|value| clean_url_input(&value))
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "http://cp.cloudflare.com/generate_204".to_string());
    let timeout = Duration::from_millis(timeout_ms.unwrap_or(5000).clamp(500, 30000));
    probe_xray_local_proxies(&settings, &url, timeout)
}

#[tauri::command]
fn validate_xray_config(
    app: tauri::AppHandle,
    binary_path: Option<String>,
    config_path: Option<String>,
) -> Result<ConfigValidationResult, String> {
    let settings = load_runtime_settings(&app)?;
    let paths = draft_paths(&app)?;
    let binary = PathBuf::from(clean_path_input(
        binary_path
            .as_deref()
            .filter(|value| !value.trim().is_empty())
            .unwrap_or(&settings.xray_binary_path),
    ));
    let config = PathBuf::from(clean_path_input(
        config_path
            .as_deref()
            .filter(|value| !value.trim().is_empty())
            .unwrap_or(&paths.xray_config_path),
    ));
    validate_xray_config_file(&binary, &config)
}

#[tauri::command]
fn commit_validated_xray_config(
    app: tauri::AppHandle,
    state: tauri::State<RuntimeState>,
    contents: String,
    config_mode: XrayConfigTrustMode,
    advanced_confirmed: bool,
) -> Result<ConfigDraftPaths, String> {
    let settings = load_runtime_settings(&app)?;
    let paths = draft_paths(&app)?;
    let binary = PathBuf::from(clean_path_input(&settings.xray_binary_path));
    let canonical = PathBuf::from(&paths.xray_config_path);
    let authorization = authorize_xray_config(
        contents.as_bytes(),
        config_mode,
        advanced_confirmed,
        &settings,
    )?;
    let mut coordinator = state
        .xray
        .lock()
        .map_err(|_| "lock Xray validation state failed".to_string())?;

    commit_validated_xray_config_file(
        &canonical,
        &contents,
        |candidate| validate_xray_config_file(&binary, candidate),
        &PlatformAtomicFileReplacer,
    )?;
    coordinator.xray_config_authorization = Some(authorization);
    Ok(paths)
}

#[tauri::command]
fn validate_tachyon_core_config(
    app: tauri::AppHandle,
    binary_path: Option<String>,
    config_path: Option<String>,
) -> Result<ConfigValidationResult, String> {
    let settings = load_runtime_settings(&app)?;
    let paths = draft_paths(&app)?;
    let binary = PathBuf::from(clean_path_input(
        binary_path
            .as_deref()
            .filter(|value| !value.trim().is_empty())
            .unwrap_or(&settings.tachyon_core_binary_path),
    ));
    let config = PathBuf::from(clean_path_input(
        config_path
            .as_deref()
            .filter(|value| !value.trim().is_empty())
            .unwrap_or(&paths.core_config_path),
    ));
    validate_tachyon_core_config_file(&binary, &config)
}

#[tauri::command]
fn tachyon_core_preflight(
    app: tauri::AppHandle,
    binary_path: Option<String>,
    config_path: Option<String>,
) -> Result<TachyonCorePreflightResult, String> {
    let settings = load_runtime_settings(&app)?;
    let paths = draft_paths(&app)?;
    let binary = PathBuf::from(clean_path_input(
        binary_path
            .as_deref()
            .filter(|value| !value.trim().is_empty())
            .unwrap_or(&settings.tachyon_core_binary_path),
    ));
    let config = PathBuf::from(clean_path_input(
        config_path
            .as_deref()
            .filter(|value| !value.trim().is_empty())
            .unwrap_or(&paths.core_config_path),
    ));
    preflight_tachyon_core_config_file(&binary, &config)
}

#[tauri::command]
fn system_proxy_capability() -> system_proxy::SystemProxyCapability {
    system_proxy::capability()
}

#[tauri::command]
fn system_proxy_query(
    app: tauri::AppHandle,
    state: tauri::State<system_proxy::SystemProxyRuntime>,
) -> Result<system_proxy::SystemProxyQuery, String> {
    system_proxy::query(&app, &state)
}

#[tauri::command]
fn system_proxy_apply(
    app: tauri::AppHandle,
    runtime_state: tauri::State<RuntimeState>,
    state: tauri::State<system_proxy::SystemProxyRuntime>,
    enabled: bool,
) -> Result<system_proxy::SystemProxyState, String> {
    let mut coordinator = runtime_state
        .xray
        .lock()
        .map_err(|err| format!("lock Xray coordinator: {err}"))?;
    coordinator.set_proxy_binding(&app, &state, enabled)
}

#[tauri::command]
fn system_proxy_restore(
    app: tauri::AppHandle,
    runtime_state: tauri::State<RuntimeState>,
    state: tauri::State<system_proxy::SystemProxyRuntime>,
    transaction_id: Option<String>,
) -> Result<system_proxy::SystemProxyState, String> {
    let mut coordinator = runtime_state
        .xray
        .lock()
        .map_err(|err| format!("lock Xray coordinator: {err}"))?;
    if transaction_id.is_some() {
        return Err(
            "transaction-specific proxy restore is unavailable outside XrayCoordinator".to_string(),
        );
    }
    coordinator.set_proxy_binding(&app, &state, false)
}

#[tauri::command]
fn system_proxy_status(
    app: tauri::AppHandle,
    state: tauri::State<system_proxy::SystemProxyRuntime>,
) -> Result<system_proxy::SystemProxyState, String> {
    Ok(system_proxy::query(&app, &state)?.current)
}

#[tauri::command]
fn enable_system_proxy(
    app: tauri::AppHandle,
    runtime_state: tauri::State<RuntimeState>,
    state: tauri::State<system_proxy::SystemProxyRuntime>,
) -> Result<system_proxy::SystemProxyState, String> {
    let mut coordinator = runtime_state
        .xray
        .lock()
        .map_err(|err| format!("lock Xray coordinator: {err}"))?;
    coordinator.set_proxy_binding(&app, &state, true)
}

fn validate_system_proxy_owner_state(xray_state: &str) -> Result<(), String> {
    if xray_state == "running" {
        Ok(())
    } else {
        Err("system proxy can only be enabled while Xray is running".to_string())
    }
}

#[tauri::command]
fn disable_system_proxy(
    app: tauri::AppHandle,
    runtime_state: tauri::State<RuntimeState>,
    state: tauri::State<system_proxy::SystemProxyRuntime>,
) -> Result<system_proxy::SystemProxyState, String> {
    let mut coordinator = runtime_state
        .xray
        .lock()
        .map_err(|err| format!("lock Xray coordinator: {err}"))?;
    coordinator.set_proxy_binding(&app, &state, false)
}

#[tauri::command]
fn start_xray(
    app: tauri::AppHandle,
    state: tauri::State<RuntimeState>,
    proxy_state: tauri::State<system_proxy::SystemProxyRuntime>,
    binary_path: String,
    config_path: String,
) -> Result<ProcessStatus, String> {
    let result = (|| {
        let mut coordinator = state
            .xray
            .lock()
            .map_err(|err| format!("lock runtime state: {err}"))?;
        coordinator.apply_xray(&app, &proxy_state, binary_path, config_path)
    })();
    sanitize_xray_ui_result(result)
}

#[tauri::command]
fn stop_xray(
    app: tauri::AppHandle,
    state: tauri::State<RuntimeState>,
    proxy_state: tauri::State<system_proxy::SystemProxyRuntime>,
) -> Result<ProcessStatus, String> {
    let mut coordinator = state
        .xray
        .lock()
        .map_err(|err| format!("lock Xray coordinator: {err}"))?;
    coordinator.stop_xray(&app, &proxy_state)
}

#[cfg(test)]
fn stop_xray_transaction<T>(
    restore_proxy: impl FnOnce() -> Result<(), String>,
    stop_process: impl FnOnce() -> Result<T, String>,
) -> Result<T, String> {
    restore_proxy()?;
    stop_process()
}

#[tauri::command]
fn start_tachyon_core(
    state: tauri::State<RuntimeState>,
    binary_path: String,
    config_path: String,
) -> Result<ProcessStatus, String> {
    let binary = PathBuf::from(clean_path_input(&binary_path));
    let config = PathBuf::from(clean_path_input(&config_path));
    let preflight = preflight_tachyon_core_config_file(&binary, &config)?;
    ensure_tachyon_core_preflight_allows_start(&preflight)?;
    let mut processes = state
        .xray
        .lock()
        .map_err(|err| format!("lock runtime state: {err}"))?;
    processes.processes.tachyon_core.start(
        "tachyon-core",
        ManagedBinaryKind::TachyonCore,
        path_string(&binary),
        path_string(&config),
        &["run", "--config"],
    )
}

#[tauri::command]
fn stop_tachyon_core(state: tauri::State<RuntimeState>) -> Result<ProcessStatus, String> {
    let mut processes = state
        .xray
        .lock()
        .map_err(|err| format!("lock runtime state: {err}"))?;
    processes.processes.tachyon_core.stop("tachyon-core")
}

fn should_restore_proxy_for_runtime(status: &RuntimeStatus) -> bool {
    validate_system_proxy_owner_state(&status.xray.state).is_err()
}

#[tauri::command]
fn start_all(
    app: tauri::AppHandle,
    state: tauri::State<RuntimeState>,
    proxy_state: tauri::State<system_proxy::SystemProxyRuntime>,
    xray_binary_path: String,
    xray_config_path: String,
    tachyon_core_binary_path: String,
    tachyon_core_config_path: String,
) -> Result<StartAllResult, String> {
    let mut coordinator = state
        .xray
        .lock()
        .map_err(|err| format!("lock runtime state: {err}"))?;
    sanitize_xray_ui_result(coordinator.start_all(
        &app,
        &proxy_state,
        xray_binary_path,
        xray_config_path,
        tachyon_core_binary_path,
        tachyon_core_config_path,
    ))?;
    Ok(StartAllResult {
        runtime: coordinator.processes.status(),
        confirmation: "readinessVerified".to_string(),
    })
}

#[tauri::command]
fn stop_all(
    app: tauri::AppHandle,
    state: tauri::State<RuntimeState>,
    proxy_state: tauri::State<system_proxy::SystemProxyRuntime>,
) -> Result<StopAllResult, String> {
    let mut coordinator = state
        .xray
        .lock()
        .map_err(|err| format!("lock runtime state: {err}"))?;
    let outcome = coordinator.stop_all(&app, &proxy_state);
    let runtime = coordinator.processes.status();
    Ok(StopAllResult {
        runtime,
        proxy_restored: outcome.proxy_restored,
        proxy_restore_status: outcome.proxy_restore_status,
        errors: outcome.errors,
    })
}

#[cfg(test)]
trait RuntimeStopControl {
    fn stop_tachyon_core_checked(&mut self) -> Result<(), String>;
    fn stop_xray_checked(&mut self) -> Result<(), String>;
}

#[derive(Debug, PartialEq, Eq)]
struct RuntimeShutdownOutcome {
    proxy_restored: bool,
    proxy_restore_status: String,
    xray_stop_blocked: bool,
    errors: Vec<String>,
}

#[cfg(test)]
fn execute_runtime_shutdown(
    runtime: &mut impl RuntimeStopControl,
    mut restore_proxy: impl FnMut() -> Result<bool, String>,
    mut wait: impl FnMut(Duration),
) -> RuntimeShutdownOutcome {
    let mut restore_errors = Vec::new();
    let mut proxy_restored = false;
    let mut proxy_restore_status = "failed".to_string();
    for attempt in 1..=PROXY_RESTORE_ATTEMPTS {
        match restore_proxy() {
            Ok(restored) => {
                proxy_restored = restored;
                proxy_restore_status = if restored { "restored" } else { "notPending" }.to_string();
                restore_errors.clear();
                break;
            }
            Err(error) => restore_errors.push(format!(
                "restore system proxy attempt {attempt}/{PROXY_RESTORE_ATTEMPTS}: {}",
                sanitize_xray_ui_error(error)
            )),
        }
        if attempt < PROXY_RESTORE_ATTEMPTS {
            wait(PROXY_RESTORE_RETRY_DELAY);
        }
    }

    let mut errors = restore_errors;
    if let Err(error) = runtime.stop_tachyon_core_checked() {
        errors.push(sanitize_xray_ui_error(error));
    }
    let xray_stop_blocked = proxy_restore_status == "failed";
    if xray_stop_blocked {
        errors.push(
            "Xray was kept running because the system proxy could not be restored; retry shutdown before exiting."
                .to_string(),
        );
    } else if let Err(error) = runtime.stop_xray_checked() {
        errors.push(sanitize_xray_ui_error(error));
    }

    RuntimeShutdownOutcome {
        proxy_restored,
        proxy_restore_status,
        xray_stop_blocked,
        errors,
    }
}

fn validate_xray_config_file(
    binary: &Path,
    config: &Path,
) -> Result<ConfigValidationResult, String> {
    validate_config_with_command(
        "xray",
        binary,
        config,
        &["run", "-test", "-config"],
        Duration::from_secs(8),
    )
}

fn validate_xray_config_lease(
    binary: &Path,
    config: &xray_generation::ConfigLease,
) -> Result<ConfigValidationResult, String> {
    if !binary.is_file() {
        return Err(format!("xray binary not found: {}", binary.display()));
    }
    let child_path = config.child_config_path();
    let command_line = validation_command_line(binary, &XRAY_TEST_CONFIG_ARGS, &child_path);
    let mut command = Command::new(binary);
    command.args(XRAY_TEST_CONFIG_ARGS);
    command.arg(&child_path);
    command.stdin(Stdio::null());
    command.stdout(Stdio::piped());
    command.stderr(Stdio::piped());
    if let Some(work_dir) = generation_config_work_dir(binary, config.path()) {
        command.current_dir(work_dir);
    }
    hide_command_window(&mut command);
    let child = config
        .spawn_command(&mut command)
        .map_err(|error| format!("spawn Xray config validation: {error}"))?;
    let output = child_output_with_timeout(child, Duration::from_secs(8))?;
    Ok(config_validation_result("xray", command_line, Ok(output)))
}

fn validate_tachyon_core_config_file(
    binary: &Path,
    config: &Path,
) -> Result<ConfigValidationResult, String> {
    validate_config_with_command(
        "tachyon-core",
        binary,
        config,
        &["validate", "--config"],
        Duration::from_secs(8),
    )
}

fn preflight_tachyon_core_config_file(
    binary: &Path,
    config: &Path,
) -> Result<TachyonCorePreflightResult, String> {
    if !binary.is_file() {
        return Err(format!(
            "tachyon-core binary not found: {}",
            binary.display()
        ));
    }
    if !config.is_file() {
        return Err(format!(
            "tachyon-core config not found: {}",
            config.display()
        ));
    }

    let args_before_config = ["preflight", "--config"];
    let command_line = preflight_command_line(binary, config);
    let mut command = Command::new(binary);
    command.args(args_before_config);
    command.arg(config);
    command.arg("--json");
    if let Some(work_dir) = config.parent().or_else(|| binary.parent()) {
        command.current_dir(work_dir);
    }
    let output = command_output_with_timeout(command, Duration::from_secs(8));
    let result = tachyon_core_preflight_result(command_line, output);
    if result.supported {
        return Ok(result);
    }
    let has_game_routes = prism_config_has_non_empty_game_routes(config)?;
    Ok(fail_closed_legacy_selective_routes(result, has_game_routes))
}

fn ensure_tachyon_core_preflight_allows_start(
    result: &TachyonCorePreflightResult,
) -> Result<(), String> {
    if result.ok {
        Ok(())
    } else {
        Err("Tachyon Core preflight blocked startup".to_string())
    }
}

fn prism_config_has_non_empty_game_routes(config: &Path) -> Result<bool, String> {
    let bytes = std::fs::read(config)
        .map_err(|error| format!("read Tachyon Core config for preflight fallback: {error}"))?;
    let value: Value = serde_json::from_slice(&bytes)
        .map_err(|error| format!("parse Tachyon Core config for preflight fallback: {error}"))?;
    Ok(value
        .pointer("/client/tun/game_routes")
        .and_then(Value::as_array)
        .is_some_and(|routes| !routes.is_empty()))
}

fn fail_closed_legacy_selective_routes(
    mut result: TachyonCorePreflightResult,
    has_game_routes: bool,
) -> TachyonCorePreflightResult {
    if !has_game_routes {
        return result;
    }
    let message = "Installed Core cannot preflight selective game routes.".to_string();
    let details = "Upgrade to the paired Tachyon Core release or clear client.tun.game_routes before starting game acceleration.".to_string();
    result.ok = false;
    result.overall = "error".to_string();
    result.checks = vec![TachyonCorePreflightCheck {
        code: "SELECTIVE_ROUTES_SUPPORTED".to_string(),
        status: "error".to_string(),
        message: message.clone(),
        details,
        raw: Value::Null,
    }];
    result.error = Some(format!("SELECTIVE_ROUTES_SUPPORTED: {message}"));
    result
}

fn validate_config_with_command(
    target: &str,
    binary: &Path,
    config: &Path,
    args_before_config: &[&str],
    timeout: Duration,
) -> Result<ConfigValidationResult, String> {
    if !binary.is_file() {
        return Err(format!("{target} binary not found: {}", binary.display()));
    }
    if !config.is_file() {
        return Err(format!("{target} config not found: {}", config.display()));
    }

    let command_line = validation_command_line(binary, args_before_config, config);
    let mut command = Command::new(binary);
    command.args(args_before_config);
    command.arg(config);
    if let Some(work_dir) = config.parent().or_else(|| binary.parent()) {
        command.current_dir(work_dir);
    }
    let output = command_output_with_timeout(command, timeout);
    Ok(config_validation_result(target, command_line, output))
}

fn validation_command_line(binary: &Path, args_before_config: &[&str], config: &Path) -> String {
    let mut parts = Vec::with_capacity(args_before_config.len() + 2);
    parts.push(path_string(binary));
    parts.extend(args_before_config.iter().map(|arg| (*arg).to_string()));
    parts.push(path_string(config));
    parts
        .into_iter()
        .map(|part| quote_command_part(&part))
        .collect::<Vec<_>>()
        .join(" ")
}

#[cfg(unix)]
fn generation_config_work_dir<'a>(binary: &'a Path, _config: &'a Path) -> Option<&'a Path> {
    binary.parent()
}

#[cfg(not(unix))]
fn generation_config_work_dir<'a>(binary: &'a Path, config: &'a Path) -> Option<&'a Path> {
    config.parent().or_else(|| binary.parent())
}

fn preflight_command_line(binary: &Path, config: &Path) -> String {
    let binary_name = path_file_name_for_display(binary).unwrap_or("tachyon-core");
    let config_label = path_file_name_for_display(config).unwrap_or("<config>");
    [
        binary_name.to_string(),
        "preflight".to_string(),
        "--config".to_string(),
        config_label.to_string(),
        "--json".to_string(),
    ]
    .into_iter()
    .map(|part| quote_command_part(&part))
    .collect::<Vec<_>>()
    .join(" ")
}

fn path_file_name_for_display(path: &Path) -> Option<&str> {
    let raw = path.to_str()?;
    raw.rsplit(['\\', '/'])
        .find(|name| !name.is_empty())
        .or_else(|| path.file_name().and_then(|name| name.to_str()))
        .filter(|name| !name.is_empty())
}

fn quote_command_part(part: &str) -> String {
    if part.chars().all(|character| {
        character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | '-' | '/' | '\\' | ':')
    }) {
        return part.to_string();
    }
    format!("\"{}\"", part.replace('"', "\\\""))
}

fn config_validation_result(
    target: &str,
    command: String,
    output: Result<Output, String>,
) -> ConfigValidationResult {
    let sanitize = |value: &str| sanitize_xray_diagnostic(value).text;
    let command = sanitize(&command);
    match output {
        Ok(output) => {
            let stdout = String::from_utf8_lossy(&output.stdout);
            let stderr = String::from_utf8_lossy(&output.stderr);
            let stdout = stdout.trim();
            let stderr = stderr.trim();
            let ok = output.status.success();
            let details = if target == "xray" {
                xray_validation_output_details(stdout, stderr)
            } else {
                validation_details(&sanitize(stdout), &sanitize(stderr))
            };
            let error = (!ok).then(|| details.clone());
            ConfigValidationResult {
                ok,
                target: target.to_string(),
                command,
                details,
                error,
            }
        }
        Err(error) => ConfigValidationResult {
            ok: false,
            target: target.to_string(),
            command,
            details: String::new(),
            error: Some(sanitize(&error)),
        },
    }
}

struct SanitizedXrayDiagnostic {
    text: String,
}

fn sanitize_xray_ui_error(error: String) -> String {
    sanitize_xray_diagnostic(&error).text
}

fn sanitize_xray_ui_result<T>(result: Result<T, String>) -> Result<T, String> {
    result.map_err(sanitize_xray_ui_error)
}

fn sanitize_xray_diagnostic(value: &str) -> SanitizedXrayDiagnostic {
    sanitize_xray_output(value, XRAY_DIAGNOSTIC_LIMIT_BYTES)
}

fn sanitize_xray_output(value: &str, limit_bytes: usize) -> SanitizedXrayDiagnostic {
    static JSON_SECRET: OnceLock<Regex> = OnceLock::new();
    static ESCAPED_JSON_SECRET: OnceLock<Regex> = OnceLock::new();
    static ASSIGNMENT_SECRET: OnceLock<Regex> = OnceLock::new();
    static URI_USERINFO: OnceLock<Regex> = OnceLock::new();
    static ESCAPED_URI_USERINFO: OnceLock<Regex> = OnceLock::new();

    let json_secret = JSON_SECRET.get_or_init(|| {
        Regex::new(
            r#"(\x22(?P<key>[A-Za-z][A-Za-z0-9_-]*)\x22\s*:\s*)(\x22(?:\\.|[^\x22\\])*\x22|[^,\s}\]]+)"#,
        )
        .expect("valid Xray JSON secret regex")
    });
    let escaped_json_secret = ESCAPED_JSON_SECRET.get_or_init(|| {
        Regex::new(
            r#"(\\\x22(?P<key>[A-Za-z][A-Za-z0-9_-]*)\\\x22\s*:\s*)(\\\x22(?:\\\\.|[^\x22\\])*\\\x22|[^,\s}\]]+)"#,
        )
        .expect("valid escaped Xray JSON secret regex")
    });
    let assignment_secret = ASSIGNMENT_SECRET.get_or_init(|| {
        Regex::new(
            r#"(?im)(?P<prefix>(?:^|[^A-Za-z0-9_-])(?P<key>auth|id|pass|passwd|password|token|secret(?:[_-]?key)?|psk|private[_-]?key|pre[_-]?shared[_-]?key|uuid|[A-Za-z][A-Za-z0-9_-]+(?:password|passwd|token|secret(?:[_-]?key)?|psk|private[_-]?key|pre[_-]?shared[_-]?key))\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'[^'\r\n]*'|[^\s,}\]]+)"#,
        )
        .expect("valid Xray assignment secret regex")
    });
    let uri_userinfo = URI_USERINFO.get_or_init(|| {
        Regex::new(r#"(?i)\b([a-z][a-z0-9+.-]*://)([^/@\s]+)@"#).expect("valid URI userinfo regex")
    });
    let escaped_uri_userinfo = ESCAPED_URI_USERINFO.get_or_init(|| {
        Regex::new(r#"(?i)\b([a-z][a-z0-9+.-]*:\\/\\/)([^@\s]+)@"#)
            .expect("valid escaped URI userinfo regex")
    });

    let redacted = escaped_json_secret.replace_all(value, |captures: &regex::Captures<'_>| {
        if is_sensitive_xray_key(&captures["key"]) {
            format!(r#"{}\"<redacted>\""#, &captures[1])
        } else {
            captures[0].to_string()
        }
    });
    let redacted = json_secret.replace_all(&redacted, |captures: &regex::Captures<'_>| {
        if is_sensitive_xray_key(&captures["key"]) {
            format!(r#"{}"<redacted>""#, &captures[1])
        } else {
            captures[0].to_string()
        }
    });
    let redacted = assignment_secret.replace_all(&redacted, |captures: &regex::Captures<'_>| {
        debug_assert!(is_sensitive_xray_key(&captures["key"]));
        format!("{}<redacted>", &captures["prefix"])
    });
    let redacted = uri_userinfo.replace_all(&redacted, "${1}<redacted>@");
    let redacted = escaped_uri_userinfo.replace_all(&redacted, "${1}<redacted>@");
    let redacted = redact_sensitive_paths(&redacted);
    truncate_diagnostic(&redacted, limit_bytes)
}

fn is_sensitive_xray_key(key: &str) -> bool {
    let normalized = key
        .bytes()
        .filter(|byte| !matches!(byte, b'_' | b'-'))
        .map(|byte| byte.to_ascii_lowercase() as char)
        .collect::<String>();
    matches!(
        normalized.as_str(),
        "auth"
            | "id"
            | "pass"
            | "passwd"
            | "password"
            | "presharedkey"
            | "privatekey"
            | "psk"
            | "secret"
            | "secretkey"
            | "token"
            | "uuid"
    ) || [
        "password",
        "passwd",
        "presharedkey",
        "privatekey",
        "secret",
        "secretkey",
        "token",
        "psk",
    ]
    .iter()
    .any(|suffix| normalized.ends_with(suffix))
}

fn xray_validation_output_details(stdout: &str, stderr: &str) -> String {
    const STDERR_LABEL: &str = "stderr:\n";
    const STDOUT_LABEL: &str = "stdout:\n";
    match (stderr.is_empty(), stdout.is_empty()) {
        (true, true) => "validation command finished without output".to_string(),
        (false, true) => {
            let budget = XRAY_DIAGNOSTIC_LIMIT_BYTES.saturating_sub(STDERR_LABEL.len());
            format!(
                "{STDERR_LABEL}{}",
                sanitize_xray_output(stderr, budget).text
            )
        }
        (true, false) => {
            let budget = XRAY_DIAGNOSTIC_LIMIT_BYTES.saturating_sub(STDOUT_LABEL.len());
            format!(
                "{STDOUT_LABEL}{}",
                sanitize_xray_output(stdout, budget).text
            )
        }
        (false, false) => {
            let labels = STDERR_LABEL.len() + 1 + STDOUT_LABEL.len();
            let stream_budget = XRAY_DIAGNOSTIC_LIMIT_BYTES.saturating_sub(labels);
            let stderr_budget = stream_budget / 2 + stream_budget % 2;
            let stdout_budget = stream_budget / 2;
            let stderr = sanitize_xray_output(stderr, stderr_budget).text;
            let stdout = sanitize_xray_output(stdout, stdout_budget).text;
            format!("{STDERR_LABEL}{stderr}\n{STDOUT_LABEL}{stdout}")
        }
    }
}

fn truncate_diagnostic(value: &str, limit_bytes: usize) -> SanitizedXrayDiagnostic {
    const MARKER: &str = "\n...[truncated]";
    if value.len() <= limit_bytes {
        return SanitizedXrayDiagnostic {
            text: value.to_string(),
        };
    }
    let mut end = limit_bytes.saturating_sub(MARKER.len()).min(value.len());
    while !value.is_char_boundary(end) {
        end = end.saturating_sub(1);
    }
    SanitizedXrayDiagnostic {
        text: format!("{}{}", &value[..end], MARKER),
    }
}

struct SanitizedPreflightOutput {
    text: String,
    truncated: bool,
}

fn sanitize_preflight_output(output: &str) -> SanitizedPreflightOutput {
    let sanitized = sanitize_xray_output(output, PREFLIGHT_OUTPUT_LIMIT_BYTES);
    let truncated = sanitized.text.ends_with("\n...[truncated]");
    SanitizedPreflightOutput {
        text: sanitized.text,
        truncated,
    }
}

fn sanitize_preflight_string(value: &str) -> String {
    sanitize_preflight_output(value).text
}

fn sanitize_preflight_report(value: Value) -> Value {
    let Value::Object(object) = value else {
        return Value::Null;
    };
    let mut report = serde_json::Map::new();
    for key in [
        "overall_status",
        "overall",
        "status",
        "result",
        "client_requires_tun",
        "auto_route",
        "checks",
    ] {
        if let Some(value) = object.get(key) {
            report.insert(key.to_string(), sanitize_preflight_value(value));
        }
    }
    Value::Object(report)
}

fn sanitize_preflight_value(value: &Value) -> Value {
    match value {
        Value::String(value) => Value::String(sanitize_preflight_string(value)),
        Value::Array(values) => Value::Array(values.iter().map(sanitize_preflight_value).collect()),
        Value::Object(object) => {
            let mut sanitized = serde_json::Map::new();
            for (key, value) in object {
                if is_raw_preflight_field(key) {
                    continue;
                }
                sanitized.insert(
                    key.clone(),
                    if is_sensitive_structured_key(key) {
                        Value::String("<redacted>".to_string())
                    } else {
                        sanitize_preflight_value(value)
                    },
                );
            }
            Value::Object(sanitized)
        }
        _ => value.clone(),
    }
}

fn is_sensitive_structured_key(key: &str) -> bool {
    let normalized = key
        .bytes()
        .filter(|byte| !matches!(byte, b'_' | b'-'))
        .map(|byte| byte.to_ascii_lowercase() as char)
        .collect::<String>();
    matches!(normalized.as_str(), "pass" | "passwd" | "password")
        || [
            "password",
            "passwd",
            "presharedkey",
            "privatekey",
            "secret",
            "secretkey",
            "token",
            "psk",
        ]
        .iter()
        .any(|suffix| normalized.ends_with(suffix))
}

fn is_raw_preflight_field(key: &str) -> bool {
    matches!(
        key.to_ascii_lowercase().as_str(),
        "stdout" | "stderr" | "command" | "raw_report" | "rawreport"
    )
}

fn redact_sensitive_paths(value: &str) -> String {
    let mut redacted = value.to_string();
    for path in sensitive_user_path_prefixes() {
        redacted = replace_ascii_case_insensitive(&redacted, &path, "<user-dir>");
        redacted =
            replace_ascii_case_insensitive(&redacted, &path.replace('\\', "\\\\"), "<user-dir>");
        redacted =
            replace_ascii_case_insensitive(&redacted, &path.replace('\\', "/"), "<user-dir>");
    }
    for marker in common_user_dir_markers() {
        redacted = redact_after_marker(&redacted, marker);
    }
    redacted
}

fn common_user_dir_markers() -> &'static [&'static str] {
    &[
        "C:\\Users\\",
        "C:\\\\Users\\\\",
        "C:/Users/",
        "/Users/",
        "/home/",
    ]
}

fn sensitive_user_path_prefixes() -> Vec<String> {
    let mut prefixes = Vec::new();
    for key in ["USERPROFILE", "HOME"] {
        if let Ok(value) = std::env::var(key) {
            if !value.trim().is_empty() {
                prefixes.push(value);
            }
        }
    }
    if let (Ok(drive), Ok(path)) = (std::env::var("HOMEDRIVE"), std::env::var("HOMEPATH")) {
        let home = format!("{drive}{path}");
        if !home.trim().is_empty() {
            prefixes.push(home);
        }
    }
    prefixes.sort();
    prefixes.dedup();
    prefixes
}

fn replace_ascii_case_insensitive(input: &str, needle: &str, replacement: &str) -> String {
    if needle.is_empty() {
        return input.to_string();
    }
    let input_lower = input.to_ascii_lowercase();
    let needle_lower = needle.to_ascii_lowercase();
    let mut output = String::with_capacity(input.len());
    let mut index = 0;
    while let Some(offset) = input_lower[index..].find(&needle_lower) {
        let match_start = index + offset;
        output.push_str(&input[index..match_start]);
        output.push_str(replacement);
        index = match_start + needle.len();
    }
    output.push_str(&input[index..]);
    output
}

fn redact_after_marker(input: &str, marker: &str) -> String {
    let lower_input = input.to_ascii_lowercase();
    let lower_marker = marker.to_ascii_lowercase();
    let mut output = String::with_capacity(input.len());
    let mut index = 0;
    while let Some(offset) = lower_input[index..].find(&lower_marker) {
        let match_start = index + offset;
        let user_start = match_start + marker.len();
        let user_end = input[user_start..]
            .find(|character: char| ['\\', '/', '"', '\'', ' ', '\r', '\n'].contains(&character))
            .map(|offset| user_start + offset)
            .unwrap_or(input.len());
        output.push_str(&input[index..match_start]);
        output.push_str("<user-dir>");
        index = user_end;
    }
    output.push_str(&input[index..]);
    output
}

fn tachyon_core_preflight_result(
    command: String,
    output: Result<Output, String>,
) -> TachyonCorePreflightResult {
    let output = match output {
        Ok(output) => output,
        Err(error) => {
            let error = sanitize_preflight_string(&error);
            return TachyonCorePreflightResult {
                supported: true,
                ok: false,
                overall: "error".to_string(),
                checks: vec![TachyonCorePreflightCheck {
                    code: "PREFLIGHT_EXECUTION".to_string(),
                    status: "error".to_string(),
                    message: error.clone(),
                    details: String::new(),
                    raw: Value::Null,
                }],
                structured_report: Value::Null,
                command,
                stdout: String::new(),
                stdout_truncated: false,
                stderr: String::new(),
                stderr_truncated: false,
                exit_code: None,
                error: Some(error),
            };
        }
    };
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let sanitized_stdout = sanitize_preflight_output(&stdout);
    let sanitized_stderr = sanitize_preflight_output(&stderr);
    let combined = validation_details(&sanitized_stdout.text, &sanitized_stderr.text);
    let exit_code = output.status.code();

    if let Ok(value) = serde_json::from_str::<Value>(&stdout) {
        return parse_tachyon_core_preflight_json(
            command,
            sanitized_stdout,
            sanitized_stderr,
            exit_code,
            value,
        );
    }

    if is_unsupported_preflight_output(&combined) {
        return TachyonCorePreflightResult {
            supported: false,
            ok: true,
            overall: "unsupported".to_string(),
            checks: vec![],
            structured_report: Value::Null,
            command,
            stdout: sanitized_stdout.text,
            stdout_truncated: sanitized_stdout.truncated,
            stderr: sanitized_stderr.text,
            stderr_truncated: sanitized_stderr.truncated,
            exit_code,
            error: Some("Core version lacks preflight; validate only".to_string()),
        };
    }

    TachyonCorePreflightResult {
        supported: true,
        ok: false,
        overall: "error".to_string(),
        checks: vec![TachyonCorePreflightCheck {
            code: "PREFLIGHT_JSON".to_string(),
            status: "error".to_string(),
            message: "tachyon-core preflight did not return JSON".to_string(),
            details: combined.clone(),
            raw: Value::Null,
        }],
        structured_report: Value::Null,
        command,
        stdout: sanitized_stdout.text,
        stdout_truncated: sanitized_stdout.truncated,
        stderr: sanitized_stderr.text,
        stderr_truncated: sanitized_stderr.truncated,
        exit_code,
        error: Some(combined),
    }
}

fn parse_tachyon_core_preflight_json(
    command: String,
    stdout: SanitizedPreflightOutput,
    stderr: SanitizedPreflightOutput,
    exit_code: Option<i32>,
    value: Value,
) -> TachyonCorePreflightResult {
    let overall = first_string(&value, &["overall_status", "overall", "status", "result"])
        .unwrap_or_else(|| inferred_preflight_overall(&value));
    let checks = value
        .get("checks")
        .and_then(Value::as_array)
        .map(|checks| {
            checks
                .iter()
                .map(parse_tachyon_core_preflight_check)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let normalized_overall = overall.to_ascii_lowercase();
    let has_error_check = checks
        .iter()
        .any(|check| matches!(check.status.as_str(), "error" | "failed" | "fail"));
    let ok =
        !has_error_check && !matches!(normalized_overall.as_str(), "error" | "failed" | "fail");
    let error = if ok {
        None
    } else {
        Some(preflight_error_summary(&checks))
    };

    TachyonCorePreflightResult {
        supported: true,
        ok,
        overall,
        checks,
        structured_report: sanitize_preflight_report(value),
        command,
        stdout: stdout.text,
        stdout_truncated: stdout.truncated,
        stderr: stderr.text,
        stderr_truncated: stderr.truncated,
        exit_code,
        error,
    }
}

fn parse_tachyon_core_preflight_check(value: &Value) -> TachyonCorePreflightCheck {
    TachyonCorePreflightCheck {
        code: first_string(value, &["code", "name", "id", "check"])
            .unwrap_or_else(|| "UNKNOWN".to_string()),
        status: check_status(value),
        message: first_string(value, &["message", "summary", "title"])
            .map(|message| sanitize_preflight_string(&message))
            .unwrap_or_default(),
        details: first_string(
            value,
            &["details", "detail", "hint", "reason", "remediation"],
        )
        .map(|details| sanitize_preflight_string(&details))
        .unwrap_or_default(),
        raw: sanitize_preflight_value(value),
    }
}

fn inferred_preflight_overall(value: &Value) -> String {
    let Some(checks) = value.get("checks").and_then(Value::as_array) else {
        return "ok".to_string();
    };
    if checks
        .iter()
        .any(|check| matches!(check_status(check).as_str(), "error" | "failed" | "fail"))
    {
        return "error".to_string();
    }
    if checks
        .iter()
        .any(|check| matches!(check_status(check).as_str(), "warn" | "warning"))
    {
        return "warn".to_string();
    }
    "ok".to_string()
}

fn check_status(value: &Value) -> String {
    first_string(value, &["status", "result", "state"])
        .unwrap_or_else(|| "unknown".to_string())
        .to_ascii_lowercase()
}

fn first_string(value: &Value, keys: &[&str]) -> Option<String> {
    keys.iter()
        .filter_map(|key| value.get(*key).and_then(Value::as_str))
        .map(str::trim)
        .find(|value| !value.is_empty())
        .map(ToString::to_string)
}

fn preflight_error_summary(checks: &[TachyonCorePreflightCheck]) -> String {
    let summary = checks
        .iter()
        .filter(|check| matches!(check.status.as_str(), "error" | "failed" | "fail"))
        .map(|check| {
            let message = if check.message.is_empty() {
                check.details.as_str()
            } else {
                check.message.as_str()
            };
            if message.is_empty() {
                check.code.clone()
            } else {
                format!("{}: {message}", check.code)
            }
        })
        .collect::<Vec<_>>()
        .join("; ");
    if summary.is_empty() {
        "tachyon-core preflight reported an error".to_string()
    } else {
        summary
    }
}

fn is_unsupported_preflight_output(output: &str) -> bool {
    let output = output.to_ascii_lowercase();
    output.contains("unrecognized subcommand")
        || output.contains("unknown subcommand")
        || output.contains("unexpected argument 'preflight'")
        || output.contains("invalid subcommand")
        || output.contains("no such command")
}

fn validation_details(stdout: &str, stderr: &str) -> String {
    match (stdout.is_empty(), stderr.is_empty()) {
        (false, false) => format!("{stdout}\n{stderr}"),
        (false, true) => stdout.to_string(),
        (true, false) => stderr.to_string(),
        (true, true) => "validation command finished without output".to_string(),
    }
}

fn run_xray_stats_query(binary: &Path, server: &str) -> Result<String, String> {
    run_xray_stats_query_with_timeout(binary, server, Duration::from_secs(2))
}

fn run_xray_stats_query_with_timeout(
    binary: &Path,
    server: &str,
    timeout: Duration,
) -> Result<String, String> {
    let mut command = Command::new(binary);
    command.args([
        "api",
        "statsquery",
        "--server",
        server,
        "-pattern",
        "",
        "-reset=false",
    ]);
    let output = command_output_with_timeout(command, timeout)?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        let details = if stderr.is_empty() { stdout } else { stderr };
        return Err(format!("xray stats query failed: {details}"));
    }
    String::from_utf8(output.stdout).map_err(|err| format!("decode xray stats output: {err}"))
}

fn probe_http_via_proxy(
    proxy_host: &str,
    proxy_port: u16,
    target_url: &str,
    timeout: Duration,
) -> Result<ProxyProbeResult, String> {
    let target = parse_http_probe_url(target_url)?;
    let proxy_address = local_managed_listener_address(proxy_host, proxy_port, "HTTP")?;
    let proxy = proxy_address.to_string();
    let started = Instant::now();
    let mut stream = TcpStream::connect_timeout(&proxy_address, timeout)
        .map_err(|err| format!("connect local HTTP proxy {proxy}: {err}"))?;
    stream
        .set_read_timeout(Some(timeout))
        .map_err(|err| format!("set proxy read timeout: {err}"))?;
    stream
        .set_write_timeout(Some(timeout))
        .map_err(|err| format!("set proxy write timeout: {err}"))?;
    let request = format!(
        "GET {} HTTP/1.1\r\nHost: {}\r\nUser-Agent: Tachyon-Prism/0.1\r\nAccept: */*\r\nProxy-Connection: close\r\nConnection: close\r\n\r\n",
        target.absolute_url, target.host_header
    );
    stream
        .write_all(request.as_bytes())
        .map_err(|err| format!("write proxy probe request: {err}"))?;
    let mut response = Vec::new();
    stream
        .read_to_end(&mut response)
        .map_err(|err| format!("read proxy probe response: {err}"))?;
    let text = String::from_utf8_lossy(&response);
    let status_code = parse_http_status_code(&text);
    let ok = status_code.is_some_and(|code| (200..400).contains(&code));
    Ok(ProxyProbeResult {
        ok,
        status_code,
        latency_ms: Some(started.elapsed().as_millis().min(u32::MAX as u128) as u32),
        via: proxy,
        target_url: target.absolute_url,
        error: if ok {
            None
        } else {
            Some(
                first_response_line(&text)
                    .unwrap_or("empty proxy response")
                    .to_string(),
            )
        },
    })
}

fn probe_xray_local_proxies(
    settings: &RuntimeSettings,
    target_url: &str,
    timeout: Duration,
) -> Result<LocalProxyProbeReport, String> {
    let target = parse_http_probe_url(target_url)?;
    let http = match probe_http_via_proxy(
        &settings.xray_http_listen,
        settings.xray_http_port,
        &target.absolute_url,
        timeout,
    ) {
        Ok(result) => result,
        Err(error) => failed_proxy_probe_result(
            "http",
            &settings.xray_http_listen,
            settings.xray_http_port,
            &target.absolute_url,
            error,
        ),
    };
    let socks = match probe_http_via_socks5(
        &settings.xray_socks_listen,
        settings.xray_socks_port,
        &target.absolute_url,
        timeout,
    ) {
        Ok(result) => result,
        Err(error) => failed_proxy_probe_result(
            "socks5",
            &settings.xray_socks_listen,
            settings.xray_socks_port,
            &target.absolute_url,
            error,
        ),
    };

    Ok(LocalProxyProbeReport {
        ok: http.ok && socks.ok,
        target_url: target.absolute_url,
        checked_at: epoch_seconds(SystemTime::now()),
        http,
        socks,
    })
}

fn probe_http_via_socks5(
    proxy_host: &str,
    proxy_port: u16,
    target_url: &str,
    timeout: Duration,
) -> Result<ProxyProbeResult, String> {
    let target = parse_http_probe_url(target_url)?;
    let proxy_address = local_managed_listener_address(proxy_host, proxy_port, "SOCKS5")?;
    let proxy = format!("socks5://{proxy_address}");
    let started = Instant::now();
    let mut stream = TcpStream::connect_timeout(&proxy_address, timeout)
        .map_err(|err| format!("connect local SOCKS5 proxy {proxy}: {err}"))?;
    stream
        .set_read_timeout(Some(timeout))
        .map_err(|err| format!("set SOCKS read timeout: {err}"))?;
    stream
        .set_write_timeout(Some(timeout))
        .map_err(|err| format!("set SOCKS write timeout: {err}"))?;
    if let Err(error) = socks5_connect(&mut stream, &target) {
        return Ok(ProxyProbeResult {
            ok: false,
            status_code: None,
            latency_ms: Some(started.elapsed().as_millis().min(u32::MAX as u128) as u32),
            via: proxy,
            target_url: target.absolute_url,
            error: Some(error),
        });
    }
    let request = format!(
        "GET {} HTTP/1.1\r\nHost: {}\r\nUser-Agent: Tachyon-Prism/0.1\r\nAccept: */*\r\nConnection: close\r\n\r\n",
        target.path_and_query, target.host_header
    );
    stream
        .write_all(request.as_bytes())
        .map_err(|err| format!("write SOCKS probe request: {err}"))?;
    let mut response = Vec::new();
    stream
        .read_to_end(&mut response)
        .map_err(|err| format!("read SOCKS probe response: {err}"))?;
    let text = String::from_utf8_lossy(&response);
    let status_code = parse_http_status_code(&text);
    let ok = status_code.is_some_and(|code| (200..400).contains(&code));
    Ok(ProxyProbeResult {
        ok,
        status_code,
        latency_ms: Some(started.elapsed().as_millis().min(u32::MAX as u128) as u32),
        via: proxy,
        target_url: target.absolute_url,
        error: if ok {
            None
        } else {
            Some(
                first_response_line(&text)
                    .unwrap_or("empty SOCKS proxy response")
                    .to_string(),
            )
        },
    })
}

fn failed_proxy_probe_result(
    scheme: &str,
    host: &str,
    port: u16,
    target_url: &str,
    error: String,
) -> ProxyProbeResult {
    ProxyProbeResult {
        ok: false,
        status_code: None,
        latency_ms: None,
        via: format!("{scheme}://{}:{}", host.trim(), port),
        target_url: target_url.to_string(),
        error: Some(error),
    }
}

fn socks5_connect(stream: &mut TcpStream, target: &HttpProbeTarget) -> Result<(), String> {
    socks5_connect_with_deadline(stream, target, None)
}

fn socks5_connect_with_deadline(
    stream: &mut TcpStream,
    target: &HttpProbeTarget,
    deadline: Option<Instant>,
) -> Result<(), String> {
    write_socket_with_deadline(stream, &[0x05, 0x01, 0x00], deadline)
        .map_err(|err| format!("write SOCKS greeting: {err}"))?;
    let mut greeting = [0_u8; 2];
    read_socket_exact_with_deadline(stream, &mut greeting, deadline)
        .map_err(|err| format!("read SOCKS greeting: {err}"))?;
    if greeting != [0x05, 0x00] {
        return Err(format!(
            "SOCKS server rejected no-auth method: {:02x} {:02x}",
            greeting[0], greeting[1]
        ));
    }

    let mut request = vec![0x05, 0x01, 0x00];
    if let Ok(addr) = target.host.parse::<std::net::IpAddr>() {
        match addr {
            std::net::IpAddr::V4(ip) => {
                request.push(0x01);
                request.extend_from_slice(&ip.octets());
            }
            std::net::IpAddr::V6(ip) => {
                request.push(0x04);
                request.extend_from_slice(&ip.octets());
            }
        }
    } else {
        let host = target.host.as_bytes();
        if host.len() > u8::MAX as usize {
            return Err("SOCKS target host is too long".to_string());
        }
        request.push(0x03);
        request.push(host.len() as u8);
        request.extend_from_slice(host);
    }
    request.extend_from_slice(&target.port.to_be_bytes());
    write_socket_with_deadline(stream, &request, deadline)
        .map_err(|err| format!("write SOCKS connect request: {err}"))?;

    let mut header = [0_u8; 4];
    read_socket_exact_with_deadline(stream, &mut header, deadline)
        .map_err(|err| format!("read SOCKS connect response: {err}"))?;
    if header[0] != 0x05 {
        return Err(format!("invalid SOCKS response version: {}", header[0]));
    }
    if header[1] != 0x00 {
        return Err(format!(
            "SOCKS connect failed: {}",
            socks5_reply_label(header[1])
        ));
    }
    let address_len = match header[3] {
        0x01 => 4,
        0x03 => {
            let mut len = [0_u8; 1];
            read_socket_exact_with_deadline(stream, &mut len, deadline)
                .map_err(|err| format!("read SOCKS bind domain length: {err}"))?;
            len[0] as usize
        }
        0x04 => 16,
        other => return Err(format!("invalid SOCKS address type: {other}")),
    };
    let mut skip = vec![0_u8; address_len + 2];
    read_socket_exact_with_deadline(stream, &mut skip, deadline)
        .map_err(|err| format!("read SOCKS bind address: {err}"))?;
    Ok(())
}

fn write_socket_with_deadline(
    stream: &mut TcpStream,
    bytes: &[u8],
    deadline: Option<Instant>,
) -> Result<(), String> {
    match deadline {
        Some(deadline) => write_with_deadline(stream, bytes, deadline),
        None => stream.write_all(bytes).map_err(|error| error.to_string()),
    }
}

fn read_socket_exact_with_deadline(
    stream: &mut TcpStream,
    buffer: &mut [u8],
    deadline: Option<Instant>,
) -> Result<(), String> {
    if let Some(deadline) = deadline {
        let mut offset = 0;
        while offset < buffer.len() {
            stream.refresh_deadline(deadline)?;
            let read = stream
                .read(&mut buffer[offset..])
                .map_err(|error| error.to_string())?;
            if read == 0 {
                return Err("unexpected EOF".to_string());
            }
            offset += read;
        }
        Ok(())
    } else {
        stream.read_exact(buffer).map_err(|error| error.to_string())
    }
}

fn probe_xray_egress(
    settings: &xray_generation::EgressProbeSettings,
    timeout: Duration,
) -> Result<(), String> {
    let roots = RootCertStore::from_iter(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
    probe_xray_egress_with_roots(settings, timeout, roots)
}

fn probe_xray_egress_with_roots(
    settings: &xray_generation::EgressProbeSettings,
    timeout: Duration,
    roots: RootCertStore,
) -> Result<(), String> {
    let target = parse_https_egress_probe_url(&settings.url)?;
    let deadline = Instant::now() + timeout;
    probe_https_via_http_proxy(
        &settings.http_listen,
        settings.http_port,
        &target,
        settings.expected_status,
        &settings.expected_nonce,
        &roots,
        deadline,
    )
    .map_err(|error| format!("HTTP egress probe failed: {error}"))?;
    probe_https_via_socks5(
        &settings.socks_listen,
        settings.socks_port,
        &target,
        settings.expected_status,
        &settings.expected_nonce,
        &roots,
        deadline,
    )
    .map_err(|error| format!("SOCKS5 egress probe failed: {error}"))
}

fn probe_https_via_http_proxy(
    host: &str,
    port: u16,
    target: &HttpsProbeTarget,
    expected_status: u16,
    expected_nonce: &str,
    roots: &RootCertStore,
    deadline: Instant,
) -> Result<(), String> {
    let mut stream = connect_local_proxy(host, port, deadline, "HTTP")?;
    let request = build_http_request(
        Method::CONNECT,
        &target.host_header,
        &target.host_header,
        &[("Proxy-Connection", "keep-alive")],
    )?;
    set_probe_timeouts(&stream, remaining_probe_time(deadline)?)?;
    write_with_deadline(&mut stream, &request, deadline)?;
    set_probe_timeouts(&stream, remaining_probe_time(deadline)?)?;
    let (status, _) = read_http_headers(&mut stream, deadline)?;
    if status != Some(200) {
        return Err(format!("HTTP proxy CONNECT returned {:?}", status));
    }
    probe_https_stream(
        stream,
        target,
        expected_status,
        expected_nonce,
        roots,
        deadline,
    )
}

fn probe_https_via_socks5(
    host: &str,
    port: u16,
    target: &HttpsProbeTarget,
    expected_status: u16,
    expected_nonce: &str,
    roots: &RootCertStore,
    deadline: Instant,
) -> Result<(), String> {
    let mut stream = connect_local_proxy(host, port, deadline, "SOCKS5")?;
    let http_target = HttpProbeTarget {
        absolute_url: format!("https://{}{}", target.host_header, target.path),
        host: target.host.clone(),
        host_header: target.host_header.clone(),
        path_and_query: target.path.clone(),
        port: target.port,
    };
    socks5_connect_with_deadline(&mut stream, &http_target, Some(deadline))?;
    probe_https_stream(
        stream,
        target,
        expected_status,
        expected_nonce,
        roots,
        deadline,
    )
}

fn connect_local_proxy(
    host: &str,
    port: u16,
    deadline: Instant,
    kind: &str,
) -> Result<TcpStream, String> {
    let address = local_managed_listener_address(host, port, kind)?;
    let timeout = remaining_probe_time(deadline)?;
    let stream = TcpStream::connect_timeout(&address, timeout)
        .map_err(|error| format!("connect local {kind} proxy {address}: {error}"))?;
    let remaining = remaining_probe_time(deadline)?;
    set_probe_timeouts(&stream, remaining)
        .map_err(|error| format!("set {kind} probe timeout: {error}"))?;
    Ok(stream)
}

fn local_managed_listener_address(host: &str, port: u16, kind: &str) -> Result<SocketAddr, String> {
    let ip = host
        .trim()
        .parse::<IpAddr>()
        .map_err(|_| format!("local {kind} proxy must use a numeric loopback address"))?;
    if !ip.is_loopback() {
        return Err(format!(
            "local {kind} proxy must use a numeric loopback address"
        ));
    }
    Ok(SocketAddr::new(ip, port))
}

fn probe_https_stream(
    stream: TcpStream,
    target: &HttpsProbeTarget,
    expected_status: u16,
    expected_nonce: &str,
    roots: &RootCertStore,
    deadline: Instant,
) -> Result<(), String> {
    let config = ClientConfig::builder()
        .with_root_certificates(roots.clone())
        .with_no_client_auth();
    let server_name = ServerName::try_from(target.host.clone())
        .map_err(|_| "HTTPS egress probe host is not a valid TLS server name".to_string())?;
    let connection = ClientConnection::new(std::sync::Arc::new(config), server_name)
        .map_err(|error| format!("create HTTPS egress probe TLS session: {error}"))?;
    let mut tls = StreamOwned::new(connection, DeadlineStream::new(stream, deadline));
    let mut headers = vec![
        ("User-Agent", "Tachyon-Prism/0.1"),
        ("Accept", "*/*"),
        ("Connection", "close"),
    ];
    if !expected_nonce.is_empty() {
        headers.push(("X-Tachyon-Probe-Nonce", expected_nonce));
    }
    let request = build_http_request(Method::GET, &target.path, &target.host_header, &headers)?;
    tls.refresh_deadline(deadline)?;
    write_with_deadline(&mut tls, &request, deadline)?;
    tls.refresh_deadline(deadline)?;
    let (status, nonce) = read_http_headers(&mut tls, deadline)?;
    if status != Some(expected_status) {
        return Err(format!("HTTPS egress probe returned {:?}", status));
    }
    if !expected_nonce.is_empty() && nonce.as_deref() != Some(expected_nonce) {
        return Err("HTTPS egress probe nonce was not verified".to_string());
    }
    Ok(())
}

fn remaining_probe_time(deadline: Instant) -> Result<Duration, String> {
    let remaining = deadline.saturating_duration_since(Instant::now());
    if remaining.is_zero() {
        Err("HTTPS egress probe timed out".to_string())
    } else {
        Ok(remaining)
    }
}

fn set_probe_timeouts(stream: &TcpStream, timeout: Duration) -> Result<(), String> {
    stream
        .set_read_timeout(Some(timeout))
        .map_err(|error| format!("set probe read timeout: {error}"))?;
    stream
        .set_write_timeout(Some(timeout))
        .map_err(|error| format!("set probe write timeout: {error}"))
}

trait DeadlineIo {
    fn refresh_deadline(&mut self, deadline: Instant) -> Result<(), String>;
}

impl DeadlineIo for TcpStream {
    fn refresh_deadline(&mut self, deadline: Instant) -> Result<(), String> {
        set_probe_timeouts(self, remaining_probe_time(deadline)?)
    }
}

struct DeadlineStream {
    stream: TcpStream,
    deadline: Instant,
}

impl DeadlineStream {
    fn new(stream: TcpStream, deadline: Instant) -> Self {
        Self { stream, deadline }
    }
}

impl Read for DeadlineStream {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        self.refresh_deadline(self.deadline)
            .map_err(|error| io::Error::new(io::ErrorKind::TimedOut, error))?;
        self.stream.read(buffer)
    }
}

impl Write for DeadlineStream {
    fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
        self.refresh_deadline(self.deadline)
            .map_err(|error| io::Error::new(io::ErrorKind::TimedOut, error))?;
        self.stream.write(buffer)
    }

    fn flush(&mut self) -> io::Result<()> {
        self.refresh_deadline(self.deadline)
            .map_err(|error| io::Error::new(io::ErrorKind::TimedOut, error))?;
        self.stream.flush()
    }
}

impl DeadlineIo for DeadlineStream {
    fn refresh_deadline(&mut self, deadline: Instant) -> Result<(), String> {
        self.deadline = deadline;
        set_probe_timeouts(&self.stream, remaining_probe_time(deadline)?)
    }
}

impl DeadlineIo for StreamOwned<ClientConnection, DeadlineStream> {
    fn refresh_deadline(&mut self, deadline: Instant) -> Result<(), String> {
        self.get_mut().refresh_deadline(deadline)
    }
}

fn build_http_request(
    method: Method,
    target: &str,
    host: &str,
    headers: &[(&str, &str)],
) -> Result<Vec<u8>, String> {
    let mut builder = Request::builder()
        .method(method)
        .uri(Uri::try_from(target).map_err(|_| "invalid HTTP request target".to_string())?)
        .header("Host", host);
    for (name, value) in headers {
        builder = builder.header(*name, *value);
    }
    let request = builder
        .body(())
        .map_err(|_| "invalid HTTP request header".to_string())?;
    let mut bytes = format!("{} {} HTTP/1.1\r\n", request.method(), request.uri()).into_bytes();
    for (name, value) in request.headers() {
        bytes.extend_from_slice(name.as_str().as_bytes());
        bytes.extend_from_slice(b": ");
        bytes.extend_from_slice(value.as_bytes());
        bytes.extend_from_slice(b"\r\n");
    }
    bytes.extend_from_slice(b"\r\n");
    Ok(bytes)
}

fn write_with_deadline<W: Write + DeadlineIo>(
    writer: &mut W,
    bytes: &[u8],
    deadline: Instant,
) -> Result<(), String> {
    let mut offset = 0;
    while offset < bytes.len() {
        writer.refresh_deadline(deadline)?;
        let written = writer
            .write(&bytes[offset..])
            .map_err(|error| format!("write HTTPS egress probe: {error}"))?;
        if written == 0 {
            return Err("write HTTPS egress probe returned zero bytes".to_string());
        }
        offset += written;
    }
    Ok(())
}

fn read_http_headers<R: Read + DeadlineIo>(
    reader: &mut R,
    deadline: Instant,
) -> Result<(Option<u16>, Option<String>), String> {
    const MAX_HEADERS: usize = 64 * 1024;
    let mut bytes = Vec::new();
    let mut one = [0_u8; 1];
    while bytes.len() < MAX_HEADERS {
        reader.refresh_deadline(deadline)?;
        let count = reader
            .read(&mut one)
            .map_err(|error| format!("read HTTPS egress probe: {error}"))?;
        if count == 0 {
            break;
        }
        bytes.push(one[0]);
        if bytes.ends_with(b"\r\n\r\n") {
            break;
        }
    }
    if !bytes.ends_with(b"\r\n\r\n") {
        return Err("HTTPS egress probe returned incomplete headers".to_string());
    }
    let text = String::from_utf8_lossy(&bytes);
    let status = parse_http_status_code(&text);
    let nonce = text.lines().find_map(|line| {
        let (name, value) = line.split_once(':')?;
        name.trim()
            .eq_ignore_ascii_case("x-tachyon-probe-nonce")
            .then(|| value.trim().to_string())
    });
    Ok((status, nonce))
}

fn socks5_reply_label(code: u8) -> &'static str {
    match code {
        0x01 => "general failure",
        0x02 => "connection not allowed",
        0x03 => "network unreachable",
        0x04 => "host unreachable",
        0x05 => "connection refused",
        0x06 => "TTL expired",
        0x07 => "command not supported",
        0x08 => "address type not supported",
        _ => "unknown error",
    }
}

fn expected_system_proxy_server(settings: &RuntimeSettings) -> String {
    format!(
        "http={}:{};https={}:{};socks={}:{}",
        settings.xray_http_listen,
        settings.xray_http_port,
        settings.xray_http_listen,
        settings.xray_http_port,
        settings.xray_socks_listen,
        settings.xray_socks_port
    )
}

fn proxy_readback_matches_active(
    readback: &system_proxy::SystemProxyQuery,
    settings: &RuntimeSettings,
    transaction_id: &str,
) -> bool {
    proxy_readback_matches_active_state(readback, settings)
        && readback
            .pending_transaction
            .as_ref()
            .is_some_and(|pending| pending.transaction_id == transaction_id)
}

fn proxy_readback_matches_active_state(
    readback: &system_proxy::SystemProxyQuery,
    settings: &RuntimeSettings,
) -> bool {
    let active_http = format!(
        "http={}:{}",
        settings.xray_http_listen, settings.xray_http_port
    );
    let http_port_is_active = readback
        .current
        .proxy_server
        .split(';')
        .map(str::trim)
        .any(|entry| entry.eq_ignore_ascii_case(&active_http));
    readback.current.error.is_none()
        && readback.current.enabled
        && readback.current.matches_prism
        && readback.current.expected_proxy_server == expected_system_proxy_server(settings)
        && http_port_is_active
        && readback.pending_transaction.is_some()
}

fn default_system_proxy_bypass() -> String {
    "localhost;127.*;10.*;172.16.*;172.17.*;172.18.*;172.19.*;172.20.*;172.21.*;172.22.*;172.23.*;172.24.*;172.25.*;172.26.*;172.27.*;172.28.*;172.29.*;172.30.*;172.31.*;192.168.*;<local>".to_string()
}

#[cfg(not(target_os = "windows"))]
fn system_proxy_state(
    settings: &RuntimeSettings,
    supported: bool,
    enabled: bool,
    proxy_server: String,
    bypass: String,
    error: Option<String>,
) -> system_proxy::SystemProxyState {
    let expected = expected_system_proxy_server(settings);
    let matches_prism =
        enabled && normalize_proxy_server(&proxy_server) == normalize_proxy_server(&expected);
    system_proxy::SystemProxyState {
        supported,
        enabled,
        matches_prism,
        proxy_server,
        expected_proxy_server: expected,
        bypass,
        error,
    }
}

fn normalize_proxy_server(value: &str) -> String {
    value
        .split(';')
        .map(str::trim)
        .filter(|part| !part.is_empty())
        .map(|part| part.to_ascii_lowercase())
        .collect::<Vec<_>>()
        .join(";")
}

#[cfg(target_os = "macos")]
fn platform_system_proxy_status(settings: &RuntimeSettings) -> system_proxy::SystemProxyState {
    match macos_first_network_service() {
        Ok(service) => match run_command("networksetup", &["-getwebproxy", &service]) {
            Ok(raw) => {
                let enabled = raw
                    .lines()
                    .any(|line| line.trim().eq_ignore_ascii_case("Enabled: Yes"));
                let server = format!(
                    "http={}:{};https={}:{};socks={}:{}",
                    settings.xray_http_listen,
                    settings.xray_http_port,
                    settings.xray_http_listen,
                    settings.xray_http_port,
                    settings.xray_socks_listen,
                    settings.xray_socks_port
                );
                system_proxy_state(
                    settings,
                    true,
                    enabled,
                    server,
                    settings.system_proxy_bypass.clone(),
                    None,
                )
            }
            Err(err) => system_proxy_state(
                settings,
                true,
                false,
                String::new(),
                String::new(),
                Some(err),
            ),
        },
        Err(err) => system_proxy_state(
            settings,
            true,
            false,
            String::new(),
            String::new(),
            Some(err),
        ),
    }
}

#[cfg(target_os = "macos")]
fn platform_enable_system_proxy(settings: &RuntimeSettings) -> Result<(), String> {
    for service in macos_network_services()? {
        run_command(
            "networksetup",
            &[
                "-setwebproxy",
                &service,
                &settings.xray_http_listen,
                &settings.xray_http_port.to_string(),
            ],
        )?;
        run_command(
            "networksetup",
            &[
                "-setsecurewebproxy",
                &service,
                &settings.xray_http_listen,
                &settings.xray_http_port.to_string(),
            ],
        )?;
        run_command(
            "networksetup",
            &[
                "-setsocksfirewallproxy",
                &service,
                &settings.xray_socks_listen,
                &settings.xray_socks_port.to_string(),
            ],
        )?;
        run_command("networksetup", &["-setwebproxystate", &service, "on"])?;
        run_command("networksetup", &["-setsecurewebproxystate", &service, "on"])?;
        run_command(
            "networksetup",
            &["-setsocksfirewallproxystate", &service, "on"],
        )?;
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn platform_disable_system_proxy(_settings: &RuntimeSettings) -> Result<(), String> {
    for service in macos_network_services()? {
        run_command("networksetup", &["-setwebproxystate", &service, "off"])?;
        run_command(
            "networksetup",
            &["-setsecurewebproxystate", &service, "off"],
        )?;
        run_command(
            "networksetup",
            &["-setsocksfirewallproxystate", &service, "off"],
        )?;
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn macos_first_network_service() -> Result<String, String> {
    macos_network_services()?
        .into_iter()
        .next()
        .ok_or_else(|| "no macOS network service found".to_string())
}

#[cfg(target_os = "macos")]
fn macos_network_services() -> Result<Vec<String>, String> {
    let raw = run_command("networksetup", &["-listallnetworkservices"])?;
    Ok(raw
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty() && !line.starts_with("An asterisk"))
        .map(|line| line.trim_start_matches("*").trim().to_string())
        .collect())
}

#[cfg(target_os = "linux")]
fn platform_system_proxy_status(settings: &RuntimeSettings) -> system_proxy::SystemProxyState {
    match run_command("gsettings", &["get", "org.gnome.system.proxy", "mode"]) {
        Ok(mode) => {
            let enabled = mode.contains("manual");
            system_proxy_state(
                settings,
                true,
                enabled,
                expected_system_proxy_server(settings),
                settings.system_proxy_bypass.clone(),
                None,
            )
        }
        Err(err) => system_proxy_state(
            settings,
            false,
            false,
            String::new(),
            String::new(),
            Some(err),
        ),
    }
}

#[cfg(target_os = "linux")]
fn platform_enable_system_proxy(settings: &RuntimeSettings) -> Result<(), String> {
    run_command(
        "gsettings",
        &["set", "org.gnome.system.proxy", "mode", "manual"],
    )?;
    run_command(
        "gsettings",
        &[
            "set",
            "org.gnome.system.proxy.http",
            "host",
            &settings.xray_http_listen,
        ],
    )?;
    run_command(
        "gsettings",
        &[
            "set",
            "org.gnome.system.proxy.http",
            "port",
            &settings.xray_http_port.to_string(),
        ],
    )?;
    run_command(
        "gsettings",
        &[
            "set",
            "org.gnome.system.proxy.https",
            "host",
            &settings.xray_http_listen,
        ],
    )?;
    run_command(
        "gsettings",
        &[
            "set",
            "org.gnome.system.proxy.https",
            "port",
            &settings.xray_http_port.to_string(),
        ],
    )?;
    run_command(
        "gsettings",
        &[
            "set",
            "org.gnome.system.proxy.socks",
            "host",
            &settings.xray_socks_listen,
        ],
    )?;
    run_command(
        "gsettings",
        &[
            "set",
            "org.gnome.system.proxy.socks",
            "port",
            &settings.xray_socks_port.to_string(),
        ],
    )?;
    run_command(
        "gsettings",
        &[
            "set",
            "org.gnome.system.proxy",
            "ignore-hosts",
            &linux_ignore_hosts(&settings.system_proxy_bypass),
        ],
    )?;
    Ok(())
}

#[cfg(target_os = "linux")]
fn platform_disable_system_proxy(_settings: &RuntimeSettings) -> Result<(), String> {
    run_command(
        "gsettings",
        &["set", "org.gnome.system.proxy", "mode", "none"],
    )?;
    Ok(())
}

#[cfg(target_os = "linux")]
fn linux_ignore_hosts(bypass: &str) -> String {
    let hosts = bypass
        .split(';')
        .map(str::trim)
        .filter(|item| !item.is_empty() && *item != "<local>")
        .map(|item| format!("'{}'", item.replace('\'', "")))
        .collect::<Vec<_>>()
        .join(", ");
    format!("[{hosts}]")
}

#[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
fn platform_system_proxy_status(settings: &RuntimeSettings) -> system_proxy::SystemProxyState {
    system_proxy_state(
        settings,
        false,
        false,
        String::new(),
        String::new(),
        Some("system proxy is unsupported on this platform".to_string()),
    )
}

#[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
fn platform_enable_system_proxy(_settings: &RuntimeSettings) -> Result<(), String> {
    Err("system proxy is unsupported on this platform".to_string())
}

#[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
fn platform_disable_system_proxy(_settings: &RuntimeSettings) -> Result<(), String> {
    Err("system proxy is unsupported on this platform".to_string())
}

#[cfg(target_os = "windows")]
fn platform_runtime_privilege_status() -> RuntimePrivilegeStatus {
    let mut command = Command::new("net");
    command.arg("session");
    let elevated = command_output_with_timeout(command, Duration::from_secs(2))
        .map(|output| output.status.success())
        .unwrap_or(false);
    runtime_privilege_status_from_flag(
        "windows",
        elevated,
        if elevated {
            "Administrator privileges detected. Tachyon Core can create Wintun devices."
        } else {
            "Administrator privileges are required before Prism can start Tachyon Core TUN mode."
        },
    )
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn platform_runtime_privilege_status() -> RuntimePrivilegeStatus {
    let mut command = Command::new("id");
    command.arg("-u");
    let elevated = command_output_with_timeout(command, Duration::from_secs(2))
        .ok()
        .and_then(|output| String::from_utf8(output.stdout).ok())
        .map(|uid| uid.trim() == "0")
        .unwrap_or(false);
    runtime_privilege_status_from_flag(
        std::env::consts::OS,
        elevated,
        if elevated {
            "Root privileges detected. Tachyon Core can create TUN devices."
        } else {
            "Root or CAP_NET_ADMIN privileges are required before Prism can start Tachyon Core TUN mode."
        },
    )
}

#[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
fn platform_runtime_privilege_status() -> RuntimePrivilegeStatus {
    RuntimePrivilegeStatus {
        platform: std::env::consts::OS.to_string(),
        elevated: false,
        can_manage_tun: false,
        message: "TUN privilege detection is unsupported on this platform.".to_string(),
    }
}

fn runtime_privilege_status_from_flag(
    platform: &str,
    elevated: bool,
    message: &str,
) -> RuntimePrivilegeStatus {
    RuntimePrivilegeStatus {
        platform: platform.to_string(),
        elevated,
        can_manage_tun: elevated,
        message: message.to_string(),
    }
}

fn run_command(program: &str, args: &[&str]) -> Result<String, String> {
    let mut command = Command::new(program);
    command.args(args);
    let output = command_output_with_timeout(command, Duration::from_secs(5))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        let details = if stderr.is_empty() { stdout } else { stderr };
        return Err(format!("{program} failed: {details}"));
    }
    String::from_utf8(output.stdout).map_err(|err| format!("decode {program} output: {err}"))
}

fn command_output_with_timeout(mut command: Command, timeout: Duration) -> Result<Output, String> {
    hide_command_window(&mut command);
    let child = command
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|err| format!("spawn command: {err}"))?;
    child_output_with_timeout(child, timeout)
}

fn child_output_with_timeout(mut child: Child, timeout: Duration) -> Result<Output, String> {
    let started = Instant::now();
    loop {
        if child
            .try_wait()
            .map_err(|err| format!("poll command: {err}"))?
            .is_some()
        {
            return child
                .wait_with_output()
                .map_err(|err| format!("collect command output: {err}"));
        }
        if started.elapsed() >= timeout {
            let _ = child.kill();
            let _ = child.wait();
            return Err("command timed out".to_string());
        }
        thread::sleep(Duration::from_millis(20));
    }
}

fn parse_xray_stats_query_output(output: &str) -> XrayTrafficStats {
    let mut current_name = String::new();
    let mut stats = XrayTrafficStats::default();
    for line in output.lines() {
        if let Some(name) = quoted_field(line, "name:") {
            current_name = name;
        }
        let Some(value) = numeric_field(line, "value:") else {
            continue;
        };
        if !current_name.starts_with("outbound>>>") || is_xray_internal_stat(&current_name) {
            continue;
        }
        if current_name.ends_with(">>>traffic>>>uplink") {
            stats.bytes_sent = stats.bytes_sent.saturating_add(value);
        } else if current_name.ends_with(">>>traffic>>>downlink") {
            stats.bytes_received = stats.bytes_received.saturating_add(value);
        }
    }
    stats
}

fn quoted_field(line: &str, marker: &str) -> Option<String> {
    let rest = line.split_once(marker)?.1.trim();
    let start = rest.find('"')? + 1;
    let end = rest[start..].find('"')? + start;
    Some(rest[start..end].to_string())
}

fn numeric_field(line: &str, marker: &str) -> Option<u64> {
    let rest = line.split_once(marker)?.1.trim_start();
    let digits: String = rest.chars().take_while(|ch| ch.is_ascii_digit()).collect();
    if digits.is_empty() {
        return None;
    }
    digits.parse().ok()
}

struct HttpProbeTarget {
    absolute_url: String,
    host: String,
    host_header: String,
    path_and_query: String,
    port: u16,
}

fn parse_http_probe_url(input: &str) -> Result<HttpProbeTarget, String> {
    let url = clean_url_input(input);
    let rest = url
        .strip_prefix("http://")
        .ok_or_else(|| "proxy probe target must start with http://".to_string())?;
    let (authority, path) = match rest.split_once('/') {
        Some((authority, path)) => (authority, format!("/{path}")),
        None => (rest, "/".to_string()),
    };
    if authority.trim().is_empty() {
        return Err("proxy probe target host is required".to_string());
    }
    let (host, port) = parse_http_authority(authority)?;
    Ok(HttpProbeTarget {
        absolute_url: format!("http://{authority}{path}"),
        host,
        host_header: authority.to_string(),
        path_and_query: path,
        port,
    })
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct HttpsProbeTarget {
    host: String,
    host_header: String,
    path: String,
    port: u16,
}

fn parse_https_egress_probe_url(input: &str) -> Result<HttpsProbeTarget, String> {
    let url = clean_url_input(input);
    reject_url_controls(&url)?;
    let uri = Uri::try_from(url.as_str())
        .map_err(|_| "Xray egress probe URL is not a valid absolute URL".to_string())?;
    if uri.scheme_str() != Some("https") {
        return Err("Xray egress probe URL must use https://".to_string());
    }
    if uri.query().is_some() || url.contains('#') {
        return Err("Xray egress probe URL must not contain a query or fragment".to_string());
    }
    let authority = uri
        .authority()
        .ok_or_else(|| "Xray egress probe host is required".to_string())?
        .as_str();
    if authority.is_empty() || authority.contains('@') {
        return Err("Xray egress probe URL must not contain credentials".to_string());
    }
    let (host, port) = parse_https_authority(authority)?;
    let host_header = format_probe_host_header(&host, port)?;
    let path = uri
        .path_and_query()
        .map_or("/", |path| path.as_str())
        .to_string();
    if !path.starts_with('/') {
        return Err("Xray egress probe path is invalid".to_string());
    }
    Ok(HttpsProbeTarget {
        host,
        host_header,
        path,
        port,
    })
}

fn parse_https_authority(authority: &str) -> Result<(String, u16), String> {
    if authority.is_empty()
        || authority
            .chars()
            .any(|ch| ch.is_ascii_control() || ch.is_whitespace())
    {
        return Err("Xray egress probe host is invalid".to_string());
    }
    if let Some(rest) = authority.strip_prefix('[') {
        let (host, suffix) = rest
            .split_once(']')
            .ok_or_else(|| "Xray egress probe IPv6 host is invalid".to_string())?;
        if host.parse::<Ipv6Addr>().is_err() {
            return Err("Xray egress probe IPv6 host is invalid".to_string());
        }
        let port = if suffix.is_empty() {
            443
        } else {
            parse_probe_port(
                suffix
                    .strip_prefix(':')
                    .ok_or_else(|| "Xray egress probe port is invalid".to_string())?,
            )?
        };
        return Ok((host.to_string(), port));
    }
    if authority.matches(':').count() > 1 {
        return Err("Xray egress probe IPv6 host must use brackets".to_string());
    }
    let (host, port) = match authority.rsplit_once(':') {
        Some((host, port)) => (host, parse_probe_port(port)?),
        None => (authority, 443),
    };
    if host.is_empty() || host.starts_with('.') || host.ends_with('.') {
        return Err("Xray egress probe host is required".to_string());
    }
    if host.parse::<IpAddr>().is_err()
        && (host.bytes().any(|byte| {
            !byte.is_ascii() || !(byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'.')
        }) || host
            .split('.')
            .any(|label| label.is_empty() || label.starts_with('-') || label.ends_with('-')))
    {
        return Err("Xray egress probe host is invalid".to_string());
    }
    Ok((host.to_ascii_lowercase(), port))
}

fn format_probe_host_header(host: &str, port: u16) -> Result<String, String> {
    if host.parse::<Ipv6Addr>().is_ok() {
        Ok(format!("[{host}]:{port}"))
    } else if host.parse::<Ipv4Addr>().is_ok() || !host.is_empty() {
        Ok(format!("{host}:{port}"))
    } else {
        Err("Xray egress probe host is required".to_string())
    }
}

fn reject_url_controls(value: &str) -> Result<(), String> {
    let bytes = value.as_bytes();
    let mut index = 0;
    while index < bytes.len() {
        let byte = bytes[index];
        if byte.is_ascii_control() {
            return Err("Xray egress probe URL contains a control character".to_string());
        }
        if byte == b'%' {
            if index + 2 >= bytes.len() {
                return Err("Xray egress probe URL contains an invalid percent escape".to_string());
            }
            let decoded = (hex_value(bytes[index + 1])? << 4) | hex_value(bytes[index + 2])?;
            if decoded.is_ascii_control() {
                return Err(
                    "Xray egress probe URL contains an encoded control character".to_string(),
                );
            }
            index += 3;
        } else {
            index += 1;
        }
    }
    Ok(())
}

fn hex_value(byte: u8) -> Result<u8, String> {
    match byte {
        b'0'..=b'9' => Ok(byte - b'0'),
        b'a'..=b'f' => Ok(byte - b'a' + 10),
        b'A'..=b'F' => Ok(byte - b'A' + 10),
        _ => Err("Xray egress probe URL contains an invalid percent escape".to_string()),
    }
}

fn parse_http_authority(authority: &str) -> Result<(String, u16), String> {
    let trimmed = authority.trim();
    if let Some(rest) = trimmed.strip_prefix('[') {
        let (host, suffix) = rest
            .split_once(']')
            .ok_or_else(|| "IPv6 proxy probe target must use [host]".to_string())?;
        if host.trim().is_empty() {
            return Err("proxy probe target host is required".to_string());
        }
        let port = if suffix.is_empty() {
            80
        } else {
            parse_probe_port(
                suffix
                    .strip_prefix(':')
                    .ok_or_else(|| "proxy probe target port is invalid".to_string())?,
            )?
        };
        return Ok((host.to_string(), port));
    }

    if trimmed.matches(':').count() > 1 {
        return Err("IPv6 proxy probe target must use [host]".to_string());
    }
    let (host, port) = match trimmed.rsplit_once(':') {
        Some((host, port)) => (host, parse_probe_port(port)?),
        None => (trimmed, 80),
    };
    if host.trim().is_empty() {
        return Err("proxy probe target host is required".to_string());
    }
    Ok((host.to_string(), port))
}

fn parse_probe_port(value: &str) -> Result<u16, String> {
    let port: u16 = value
        .parse()
        .map_err(|_| "proxy probe target port is invalid".to_string())?;
    if port == 0 {
        return Err("proxy probe target port is invalid".to_string());
    }
    Ok(port)
}

fn parse_http_status_code(response: &str) -> Option<u16> {
    let line = first_response_line(response)?;
    let mut parts = line.split_whitespace();
    let _version = parts.next()?;
    parts.next()?.parse().ok()
}

fn first_response_line(response: &str) -> Option<&str> {
    response
        .lines()
        .next()
        .map(str::trim)
        .filter(|line| !line.is_empty())
}

fn is_xray_internal_stat(name: &str) -> bool {
    name.contains("tachyon-xray-api") || name.contains(">>>api>>>")
}

fn draft_paths(app: &tauri::AppHandle) -> Result<ConfigDraftPaths, String> {
    let config_dir = app
        .path()
        .app_config_dir()
        .map_err(|err| format!("resolve app config directory: {err}"))?;
    let core_config_path = config_dir.join("client.json");
    let xray_config_path = config_dir.join("xray-client.json");

    Ok(ConfigDraftPaths {
        config_dir: path_string(&config_dir),
        core_config_path: path_string(&core_config_path),
        xray_config_path: path_string(&xray_config_path),
    })
}

fn game_profiles_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let config_dir = app
        .path()
        .app_config_dir()
        .map_err(|err| format!("resolve app config directory: {err}"))?;
    Ok(config_dir.join("game-profiles.json"))
}

fn load_game_profiles(app: &tauri::AppHandle) -> Result<GameProfilesFile, String> {
    let path = game_profiles_path(app)?;
    if !path.exists() {
        return Ok(GameProfilesFile {
            profiles: default_game_profiles(),
        });
    }

    let raw = fs::read_to_string(&path).map_err(|err| format!("read {}: {err}", path.display()))?;
    let mut file: GameProfilesFile =
        serde_json::from_str(&raw).map_err(|err| format!("parse game profiles: {err}"))?;
    if file.profiles.is_empty() {
        file.profiles = default_game_profiles();
    }
    sort_game_profiles(&mut file.profiles);
    Ok(file)
}

fn save_game_profiles(app: &tauri::AppHandle, file: &GameProfilesFile) -> Result<(), String> {
    let path = game_profiles_path(app)?;
    let parent = path
        .parent()
        .ok_or_else(|| "game profile path has no parent".to_string())?;
    fs::create_dir_all(parent)
        .map_err(|err| format!("create config directory {}: {err}", parent.display()))?;
    let data =
        serde_json::to_string_pretty(file).map_err(|err| format!("encode game profiles: {err}"))?;
    write_atomic(&path, &(data + "\n"))
}

fn validate_game_profile(profile: &GameProfile) -> Result<(), String> {
    if profile.id.trim().is_empty() {
        return Err("profile id is required".to_string());
    }
    if profile.display_name.trim().is_empty() {
        return Err("profile display name is required".to_string());
    }
    if profile.match_rule.process_names.is_empty()
        && profile.match_rule.paths.is_empty()
        && profile.match_rule.path_prefixes.is_empty()
        && profile.match_rule.sha256.is_empty()
        && profile.match_rule.steam_app_ids.is_empty()
    {
        return Err("profile needs at least one match rule".to_string());
    }
    Ok(())
}

fn sort_game_profiles(profiles: &mut [GameProfile]) {
    profiles.sort_by(|left, right| {
        right
            .priority
            .cmp(&left.priority)
            .then_with(|| left.display_name.cmp(&right.display_name))
    });
}

fn default_game_profiles() -> Vec<GameProfile> {
    vec![GameProfile {
        id: "cs2".to_string(),
        display_name: "Counter-Strike 2".to_string(),
        enabled: true,
        manual: true,
        priority: 100,
        match_rule: MatchRule {
            process_names: vec!["cs2.exe".to_string()],
            paths: Vec::new(),
            path_prefixes: Vec::new(),
            sha256: Vec::new(),
            steam_app_ids: vec![730],
        },
        udp_policy: "tgp".to_string(),
        tcp_policy: "auto".to_string(),
    }]
}

fn scan_steam(root: Option<&str>) -> Result<SteamScanResult, String> {
    let candidates = steam_candidate_roots(root);
    if root
        .map(clean_path_input)
        .is_some_and(|value| !value.is_empty())
        && candidates.is_empty()
    {
        return Err("Steam root not found".to_string());
    }

    let mut libraries = Vec::new();
    for candidate in candidates {
        push_unique_path(&mut libraries, candidate.clone());
        let library_file = candidate.join("steamapps").join("libraryfolders.vdf");
        if let Ok(raw) = fs::read_to_string(&library_file) {
            for path in vdf_values_for_key(&raw, "path") {
                push_unique_path(&mut libraries, PathBuf::from(path));
            }
        }
    }

    let mut apps = Vec::new();
    for library in libraries {
        let steamapps = library.join("steamapps");
        let Ok(entries) = fs::read_dir(&steamapps) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let Some(file_name) = path.file_name().and_then(|name| name.to_str()) else {
                continue;
            };
            if !file_name.starts_with("appmanifest_") || !file_name.ends_with(".acf") {
                continue;
            }
            let Ok(raw) = fs::read_to_string(&path) else {
                continue;
            };
            if let Some(app) = parse_steam_app_manifest(&raw, &library) {
                apps.push(app);
            }
        }
    }
    let mut seen_app_ids = Vec::new();
    apps.retain(|app| {
        if seen_app_ids.contains(&app.app_id) {
            false
        } else {
            seen_app_ids.push(app.app_id);
            true
        }
    });
    apps.sort_by(|left, right| {
        left.name
            .cmp(&right.name)
            .then(left.app_id.cmp(&right.app_id))
    });

    let profiles = apps.iter().map(steam_profile_from_app).collect();
    Ok(SteamScanResult { apps, profiles })
}

fn steam_candidate_roots(root: Option<&str>) -> Vec<PathBuf> {
    let mut roots = Vec::new();
    if let Some(root) = root.map(clean_path_input).filter(|value| !value.is_empty()) {
        let path = PathBuf::from(root);
        if path.exists() {
            push_unique_path(&mut roots, path);
        }
        return roots;
    }

    #[cfg(target_os = "windows")]
    {
        for variable in ["ProgramFiles(x86)", "ProgramFiles"] {
            if let Ok(base) = std::env::var(variable) {
                let candidate = PathBuf::from(base).join("Steam");
                if candidate.exists() {
                    push_unique_path(&mut roots, candidate);
                }
            }
        }
    }

    #[cfg(target_os = "macos")]
    {
        if let Some(home) = home_dir() {
            let candidate = home
                .join("Library")
                .join("Application Support")
                .join("Steam");
            if candidate.exists() {
                push_unique_path(&mut roots, candidate);
            }
        }
    }

    #[cfg(target_os = "linux")]
    {
        if let Some(home) = home_dir() {
            for relative in [
                ".steam/steam",
                ".steam/root",
                ".local/share/Steam",
                ".var/app/com.valvesoftware.Steam/data/Steam",
            ] {
                let candidate = home.join(relative);
                if candidate.exists() {
                    push_unique_path(&mut roots, candidate);
                }
            }
        }
    }

    roots
}

fn parse_steam_app_manifest(input: &str, library_path: &Path) -> Option<SteamAppManifest> {
    let app_id = first_vdf_value(input, "appid")?.parse::<u32>().ok()?;
    let name = first_vdf_value(input, "name").unwrap_or_else(|| format!("Steam App {app_id}"));
    let install_dir = first_vdf_value(input, "installdir").unwrap_or_else(|| app_id.to_string());
    let universe = first_vdf_value(input, "Universe").unwrap_or_else(|| "1".to_string());
    let state_flags = first_vdf_value(input, "StateFlags")
        .and_then(|value| value.parse::<u32>().ok())
        .unwrap_or_default();

    Some(SteamAppManifest {
        app_id,
        name,
        install_dir,
        universe,
        state_flags,
        library_path: path_string(library_path),
    })
}

fn steam_profile_from_app(app: &SteamAppManifest) -> GameProfile {
    let install_path = Path::new(&app.library_path)
        .join("steamapps")
        .join("common")
        .join(&app.install_dir);
    GameProfile {
        id: format!("steam-{}", app.app_id),
        display_name: app.name.clone(),
        enabled: true,
        manual: false,
        priority: 80,
        match_rule: MatchRule {
            process_names: Vec::new(),
            paths: Vec::new(),
            path_prefixes: vec![path_string(&install_path)],
            sha256: Vec::new(),
            steam_app_ids: vec![app.app_id],
        },
        udp_policy: "tgp".to_string(),
        tcp_policy: "auto".to_string(),
    }
}

fn first_vdf_value(input: &str, key: &str) -> Option<String> {
    vdf_values_for_key(input, key).into_iter().next()
}

fn vdf_values_for_key(input: &str, key: &str) -> Vec<String> {
    input
        .lines()
        .flat_map(|line| {
            quoted_vdf_values(line)
                .chunks_exact(2)
                .filter_map(|pair| {
                    let candidate = &pair[0];
                    let value = &pair[1];
                    candidate.eq_ignore_ascii_case(key).then(|| value.clone())
                })
                .collect::<Vec<_>>()
        })
        .collect()
}

fn quoted_vdf_values(line: &str) -> Vec<String> {
    let mut values = Vec::new();
    let mut current = String::new();
    let mut chars = line.chars().peekable();
    let mut in_quote = false;

    while let Some(character) = chars.next() {
        if in_quote {
            match character {
                '"' => {
                    values.push(current.clone());
                    current.clear();
                    in_quote = false;
                }
                '\\' => {
                    if let Some(next) = chars.next() {
                        current.push(next);
                    }
                }
                _ => current.push(character),
            }
        } else if character == '"' {
            in_quote = true;
        }
    }

    values
}

fn push_unique_path(paths: &mut Vec<PathBuf>, path: PathBuf) {
    let cleaned = path.components().collect::<PathBuf>();
    if paths
        .iter()
        .any(|existing| same_path_lossy(existing, &cleaned))
    {
        return;
    }
    paths.push(cleaned);
}

fn same_path_lossy(left: &Path, right: &Path) -> bool {
    if cfg!(target_os = "windows") {
        path_string(left).eq_ignore_ascii_case(&path_string(right))
    } else {
        left == right
    }
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
}

fn default_runtime_paths(app: &tauri::AppHandle) -> Result<RuntimePaths, String> {
    let config_dir = app
        .path()
        .app_config_dir()
        .map_err(|err| format!("resolve app config directory: {err}"))?;
    let bin_dir = config_dir.join("bin");
    Ok(RuntimePaths {
        bin_dir: path_string(&bin_dir),
        tachyon_core_binary_path: path_string(&bin_dir.join(binary_name("tachyon-core"))),
        xray_binary_path: path_string(&bin_dir.join(binary_name("xray"))),
        runtime_settings_path: path_string(&config_dir.join("runtime-settings.json")),
    })
}

fn runtime_settings_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let config_dir = app
        .path()
        .app_config_dir()
        .map_err(|err| format!("resolve app config directory: {err}"))?;
    Ok(config_dir.join("runtime-settings.json"))
}

fn load_runtime_settings(app: &tauri::AppHandle) -> Result<RuntimeSettings, String> {
    let settings_path = runtime_settings_path(app)?;
    if !settings_path.exists() {
        return default_runtime_settings(app);
    }
    let raw = fs::read_to_string(&settings_path)
        .map_err(|err| format!("read {}: {err}", settings_path.display()))?;
    let settings: RuntimeSettings =
        serde_json::from_str(&raw).map_err(|err| format!("parse runtime settings: {err}"))?;
    normalize_runtime_settings(app, settings)
}

fn save_runtime_settings_file(
    app: &tauri::AppHandle,
    settings: RuntimeSettings,
) -> Result<RuntimeSettings, String> {
    let settings = normalize_runtime_settings(app, settings)?;
    secure_vault::save_section(
        app,
        secure_vault::SECTION_RUNTIME_TGP_PSK,
        Value::String(settings.tachyon_tgp_auth_psk.clone()),
    )?;
    save_runtime_settings_plain_file(app, &settings)?;
    Ok(settings)
}

fn save_runtime_settings_plain_file(
    app: &tauri::AppHandle,
    settings: &RuntimeSettings,
) -> Result<(), String> {
    let settings_path = runtime_settings_path(app)?;
    let config_dir = settings_path
        .parent()
        .ok_or_else(|| "runtime settings path has no parent".to_string())?;
    fs::create_dir_all(config_dir)
        .map_err(|err| format!("create config directory {}: {err}", config_dir.display()))?;
    let mut persisted = settings.clone();
    persisted.tachyon_tgp_auth_psk.clear();
    let data = serde_json::to_string_pretty(&persisted)
        .map_err(|err| format!("encode runtime settings: {err}"))?;
    write_atomic(&settings_path, &(data + "\n"))?;
    Ok(())
}

fn normalize_runtime_settings(
    app: &tauri::AppHandle,
    settings: RuntimeSettings,
) -> Result<RuntimeSettings, String> {
    let defaults = default_runtime_settings(app)?;
    Ok(RuntimeSettings {
        tachyon_grpc_listen: non_empty_or(
            settings.tachyon_grpc_listen,
            defaults.tachyon_grpc_listen,
        ),
        tachyon_grpc_port: non_zero_u16_or(settings.tachyon_grpc_port, defaults.tachyon_grpc_port),
        tachyon_ipc_listen: non_empty_or(settings.tachyon_ipc_listen, defaults.tachyon_ipc_listen),
        tachyon_ipc_port: non_zero_u16_or(settings.tachyon_ipc_port, defaults.tachyon_ipc_port),
        tachyon_core_binary_path: non_empty_or(
            settings.tachyon_core_binary_path,
            defaults.tachyon_core_binary_path,
        ),
        xray_binary_path: non_empty_or(settings.xray_binary_path, defaults.xray_binary_path),
        tachyon_fec_adapt_window: bounded_u32_or(
            settings.tachyon_fec_adapt_window,
            defaults.tachyon_fec_adapt_window,
            1,
            10000,
        ),
        tachyon_fec_data_shards: bounded_u32_or(
            settings.tachyon_fec_data_shards,
            defaults.tachyon_fec_data_shards,
            1,
            32,
        ),
        tachyon_fec_dynamic: settings.tachyon_fec_dynamic,
        tachyon_fec_group_timeout_ms: bounded_u32_or(
            settings.tachyon_fec_group_timeout_ms,
            defaults.tachyon_fec_group_timeout_ms,
            1,
            1000,
        ),
        tachyon_fec_parity_shards: bounded_u32_or(
            settings.tachyon_fec_parity_shards,
            defaults.tachyon_fec_parity_shards,
            0,
            32,
        ),
        tachyon_connection_migration: settings.tachyon_connection_migration
            || settings.tachyon_multipath,
        tachyon_local_addrs: normalize_address_list(settings.tachyon_local_addrs),
        tachyon_multipath: settings.tachyon_multipath,
        tachyon_server_address: non_empty_or(
            settings.tachyon_server_address,
            defaults.tachyon_server_address,
        ),
        tachyon_tgp_auth_psk: normalize_tgp_auth_psk(settings.tachyon_tgp_auth_psk)?,
        tachyon_tgp_server_address: non_empty_or(
            settings.tachyon_tgp_server_address,
            defaults.tachyon_tgp_server_address,
        ),
        tachyon_telemetry_interval_ms: bounded_u32_or(
            settings.tachyon_telemetry_interval_ms,
            defaults.tachyon_telemetry_interval_ms,
            100,
            10000,
        ),
        tachyon_core_release_channel: normalize_release_channel(
            settings.tachyon_core_release_channel,
            defaults.tachyon_core_release_channel,
        ),
        tachyon_tun_address: non_empty_or(
            settings.tachyon_tun_address,
            defaults.tachyon_tun_address,
        ),
        tachyon_tun_auto_route: settings.tachyon_tun_auto_route,
        tachyon_tun_dns_hijack: settings.tachyon_tun_dns_hijack,
        tachyon_tun_mtu: bounded_u32_or(
            settings.tachyon_tun_mtu,
            defaults.tachyon_tun_mtu,
            576,
            1284,
        ),
        xray_http_listen: non_empty_or(settings.xray_http_listen, defaults.xray_http_listen),
        xray_http_port: non_zero_u16_or(settings.xray_http_port, defaults.xray_http_port),
        xray_socks_listen: non_empty_or(settings.xray_socks_listen, defaults.xray_socks_listen),
        xray_socks_port: non_zero_u16_or(settings.xray_socks_port, defaults.xray_socks_port),
        system_proxy_bypass: non_empty_or(
            settings.system_proxy_bypass,
            defaults.system_proxy_bypass,
        ),
        xray_stats_enabled: settings.xray_stats_enabled,
        xray_stats_listen: non_empty_or(settings.xray_stats_listen, defaults.xray_stats_listen),
        xray_stats_port: non_zero_u16_or(settings.xray_stats_port, defaults.xray_stats_port),
        xray_release_channel: normalize_release_channel(
            settings.xray_release_channel,
            defaults.xray_release_channel,
        ),
        xray_egress_probe_url: normalize_egress_probe_url(
            settings.xray_egress_probe_url,
            defaults.xray_egress_probe_url,
        )?,
        xray_egress_probe_status: normalize_egress_probe_status(
            settings.xray_egress_probe_status,
            defaults.xray_egress_probe_status,
        ),
        xray_egress_probe_nonce: normalize_egress_probe_nonce(settings.xray_egress_probe_nonce)?,
    })
}

fn default_runtime_settings(app: &tauri::AppHandle) -> Result<RuntimeSettings, String> {
    let paths = default_runtime_paths(app)?;
    Ok(RuntimeSettings {
        tachyon_grpc_listen: "127.0.0.1".to_string(),
        tachyon_grpc_port: 50051,
        tachyon_ipc_listen: "127.0.0.1".to_string(),
        tachyon_ipc_port: 55123,
        tachyon_core_binary_path: paths.tachyon_core_binary_path,
        xray_binary_path: paths.xray_binary_path,
        tachyon_fec_adapt_window: 32,
        tachyon_fec_data_shards: 4,
        tachyon_fec_dynamic: true,
        tachyon_fec_group_timeout_ms: 20,
        tachyon_fec_parity_shards: 2,
        tachyon_connection_migration: true,
        tachyon_local_addrs: String::new(),
        tachyon_multipath: false,
        tachyon_server_address: String::new(),
        tachyon_tgp_auth_psk: String::new(),
        tachyon_tgp_server_address: String::new(),
        tachyon_telemetry_interval_ms: 500,
        tachyon_core_release_channel: "preview".to_string(),
        tachyon_tun_address: "198.18.0.1/16".to_string(),
        tachyon_tun_auto_route: false,
        tachyon_tun_dns_hijack: false,
        tachyon_tun_mtu: 1280,
        xray_http_listen: "127.0.0.1".to_string(),
        xray_http_port: 10809,
        xray_socks_listen: "127.0.0.1".to_string(),
        xray_socks_port: 10808,
        system_proxy_bypass: default_system_proxy_bypass(),
        xray_stats_enabled: true,
        xray_stats_listen: "127.0.0.1".to_string(),
        xray_stats_port: 10085,
        xray_release_channel: "stable".to_string(),
        xray_egress_probe_url: String::new(),
        xray_egress_probe_status: default_egress_probe_status(),
        xray_egress_probe_nonce: String::new(),
    })
}

fn default_true() -> bool {
    true
}

fn default_egress_probe_status() -> u16 {
    204
}

fn normalize_egress_probe_url(value: String, fallback: String) -> Result<String, String> {
    let candidate = if value.trim().is_empty() {
        fallback
    } else {
        value.trim().to_string()
    };
    if candidate.trim().is_empty() {
        return Ok(String::new());
    }
    parse_https_egress_probe_url(&candidate).map(|_| candidate)
}

fn normalize_egress_probe_status(value: u16, fallback: u16) -> u16 {
    if (100..=599).contains(&value) {
        value
    } else {
        fallback
    }
}

fn normalize_egress_probe_nonce(value: String) -> Result<String, String> {
    let value = value.trim().to_string();
    if value.len() > 128 || value.bytes().any(|byte| !(0x21..=0x7e).contains(&byte)) {
        return Err(
            "Xray egress probe nonce must be printable ASCII and at most 128 bytes".to_string(),
        );
    }
    Ok(value)
}

fn egress_probe_settings(
    settings: &RuntimeSettings,
) -> Result<xray_generation::EgressProbeSettings, String> {
    let http_listen = parse_managed_listener_ip(&settings.xray_http_listen)?.to_string();
    let socks_listen = parse_managed_listener_ip(&settings.xray_socks_listen)?.to_string();
    Ok(xray_generation::EgressProbeSettings {
        url: settings.xray_egress_probe_url.clone(),
        expected_status: settings.xray_egress_probe_status,
        expected_nonce: settings.xray_egress_probe_nonce.clone(),
        http_listen,
        http_port: settings.xray_http_port,
        socks_listen,
        socks_port: settings.xray_socks_port,
    })
}

fn active_proxy_settings(
    app: &tauri::AppHandle,
    active: &xray_generation::GenerationView,
) -> Result<RuntimeSettings, String> {
    let mut settings = load_runtime_settings(app)?;
    settings.xray_http_listen = active.egress_probe.http_listen.clone();
    settings.xray_http_port = active.egress_probe.http_port;
    settings.xray_socks_listen = active.egress_probe.socks_listen.clone();
    settings.xray_socks_port = active.egress_probe.socks_port;
    Ok(settings)
}

fn normalize_release_channel(value: String, fallback: String) -> String {
    let normalized = normalize_release_channel_value(&value);
    if normalized == "stable" || normalized == "preview" {
        normalized
    } else {
        fallback
    }
}

fn normalize_release_channel_value(value: &str) -> String {
    match value.trim().to_ascii_lowercase().as_str() {
        "stable" => "stable".to_string(),
        "preview" | "pre" | "prerelease" => "preview".to_string(),
        other => other.to_string(),
    }
}

fn non_empty_or(value: String, fallback: String) -> String {
    let cleaned = clean_path_input(&value);
    if cleaned.is_empty() {
        fallback
    } else {
        cleaned
    }
}

fn normalize_address_list(value: String) -> String {
    value
        .split(['\n', ','])
        .map(clean_path_input)
        .filter(|item| !item.is_empty())
        .collect::<Vec<_>>()
        .join("\n")
}

fn normalize_tgp_auth_psk(value: String) -> Result<String, String> {
    let cleaned = value.trim().to_string();
    if cleaned.is_empty() {
        Ok(String::new())
    } else if cleaned.chars().count() < 16 {
        Err("Tachyon TGP PSK must be at least 16 characters".to_string())
    } else {
        Ok(cleaned)
    }
}

fn non_zero_u16_or(value: u16, fallback: u16) -> u16 {
    if value == 0 {
        fallback
    } else {
        value
    }
}

fn bounded_u32_or(value: u32, fallback: u32, min: u32, max: u32) -> u32 {
    if value < min || value > max {
        fallback
    } else {
        value
    }
}

fn clean_path_input(input: &str) -> String {
    let trimmed = input.trim();
    if trimmed.len() >= 2 {
        let first = trimmed.as_bytes()[0] as char;
        let last = trimmed.as_bytes()[trimmed.len() - 1] as char;
        if (first == '"' && last == '"') || (first == '\'' && last == '\'') {
            return trimmed[1..trimmed.len() - 1].trim().to_string();
        }
    }
    trimmed.to_string()
}

fn clean_url_input(input: &str) -> String {
    clean_path_input(input)
}

fn binary_name(base: &str) -> String {
    if cfg!(target_os = "windows") {
        format!("{base}.exe")
    } else {
        base.to_string()
    }
}

#[derive(Copy, Clone, Eq, PartialEq)]
enum ManagedBinaryKind {
    TachyonCore,
    Xray,
}

impl ManagedBinaryKind {
    fn parse(input: &str) -> Result<Self, String> {
        match input {
            "tachyonCore" | "tachyon-core" | "core" => Ok(Self::TachyonCore),
            "xray" | "xrayCore" | "xray-core" => Ok(Self::Xray),
            _ => Err(format!("unknown managed binary kind: {input}")),
        }
    }

    fn key(self) -> &'static str {
        match self {
            Self::TachyonCore => "tachyonCore",
            Self::Xray => "xray",
        }
    }

    fn display_name(self) -> &'static str {
        match self {
            Self::TachyonCore => "Tachyon Core",
            Self::Xray => "Xray Core",
        }
    }

    fn binary_base(self) -> &'static str {
        match self {
            Self::TachyonCore => "tachyon-core",
            Self::Xray => "xray",
        }
    }
}

fn managed_binary_inventory(app: &tauri::AppHandle) -> Result<ManagedBinaryInventory, String> {
    let paths = default_runtime_paths(app)?;
    let settings = load_runtime_settings(app)?;
    Ok(ManagedBinaryInventory {
        bin_dir: paths.bin_dir,
        tachyon_core: managed_binary_info(app, ManagedBinaryKind::TachyonCore, &settings)?,
        xray: managed_binary_info(app, ManagedBinaryKind::Xray, &settings)?,
        runtime_settings: settings,
    })
}

fn managed_binary_info(
    app: &tauri::AppHandle,
    kind: ManagedBinaryKind,
    settings: &RuntimeSettings,
) -> Result<ManagedBinaryInfo, String> {
    let target = managed_binary_target(app, kind)?;
    let configured_path = match kind {
        ManagedBinaryKind::TachyonCore => settings.tachyon_core_binary_path.clone(),
        ManagedBinaryKind::Xray => settings.xray_binary_path.clone(),
    };
    let configured = PathBuf::from(&configured_path);
    let managed_meta = binary_metadata(&target);
    let configured_meta = binary_metadata(&configured);

    Ok(ManagedBinaryInfo {
        kind: kind.key().to_string(),
        display_name: kind.display_name().to_string(),
        target_path: path_string(&target),
        configured_path,
        sidecar_dependencies: sidecar_dependencies(kind, &configured),
        managed_exists: managed_meta.exists,
        configured_exists: configured_meta.exists,
        managed_size_bytes: managed_meta.size_bytes,
        configured_size_bytes: configured_meta.size_bytes,
        managed_modified_at: managed_meta.modified_at,
        configured_modified_at: configured_meta.modified_at,
    })
}

fn sidecar_dependencies(kind: ManagedBinaryKind, binary_path: &Path) -> Vec<SidecarDependencyInfo> {
    if !cfg!(target_os = "windows") || kind != ManagedBinaryKind::TachyonCore {
        return Vec::new();
    }
    let Some(parent) = binary_path.parent() else {
        return Vec::new();
    };
    let path = parent.join("wintun.dll");
    vec![SidecarDependencyInfo {
        name: "wintun.dll".to_string(),
        path: path_string(&path),
        required: true,
        exists: path.is_file(),
    }]
}

fn managed_binary_target(
    app: &tauri::AppHandle,
    kind: ManagedBinaryKind,
) -> Result<PathBuf, String> {
    let config_dir = app
        .path()
        .app_config_dir()
        .map_err(|err| format!("resolve app config directory: {err}"))?;
    Ok(config_dir.join("bin").join(binary_name(kind.binary_base())))
}

fn fetch_latest_xray_release(channel: &str) -> Result<RuntimeReleaseInfo, String> {
    let releases: Vec<GithubRelease> =
        http_get_json("https://api.github.com/repos/XTLS/Xray-core/releases?per_page=20")?;
    latest_xray_release_info(releases, channel)
}

fn install_latest_xray_release(app: &tauri::AppHandle) -> Result<RuntimeInstallResult, String> {
    let settings = load_runtime_settings(app)?;
    let release = fetch_latest_xray_release(&settings.xray_release_channel)?;
    install_release_archive(app, ManagedBinaryKind::Xray, release)
}

fn fetch_latest_tachyon_core_release(channel: &str) -> Result<RuntimeReleaseInfo, String> {
    let releases: Vec<GithubRelease> = http_get_json(
        "https://api.github.com/repos/EarendelArc/tachyon-core/releases?per_page=20",
    )?;
    latest_tachyon_core_release_info(releases, channel)
}

fn install_latest_tachyon_core_release(
    app: &tauri::AppHandle,
) -> Result<RuntimeInstallResult, String> {
    let settings = load_runtime_settings(app)?;
    let release = fetch_latest_tachyon_core_release(&settings.tachyon_core_release_channel)?;
    install_release_archive(app, ManagedBinaryKind::TachyonCore, release)
}

fn install_release_archive(
    app: &tauri::AppHandle,
    kind: ManagedBinaryKind,
    release: RuntimeReleaseInfo,
) -> Result<RuntimeInstallResult, String> {
    let download_dir = app
        .path()
        .app_config_dir()
        .map_err(|err| format!("resolve app config directory: {err}"))?
        .join("downloads")
        .join(kind.key())
        .join(sanitize_file_component(&release.tag_name));
    fs::create_dir_all(&download_dir).map_err(|err| {
        format!(
            "create download directory {}: {err}",
            download_dir.display()
        )
    })?;

    let archive_path = download_dir.join(&release.asset_name);
    let checksum_path = download_dir.join(&release.checksum_asset_name);
    download_to_file(&release.asset_url, &archive_path)?;
    download_to_file(&release.checksum_url, &checksum_path)?;

    let checksum_text = fs::read_to_string(&checksum_path)
        .map_err(|err| format!("read checksum file {}: {err}", checksum_path.display()))?;
    let expected_sha256 = find_checksum_for_asset(&checksum_text, &release.asset_name)?;
    let actual_sha256 = sha256_file(&archive_path)?;
    if !actual_sha256.eq_ignore_ascii_case(&expected_sha256) {
        return Err(format!(
            "checksum mismatch for {}: expected {}, got {}",
            release.asset_name, expected_sha256, actual_sha256
        ));
    }

    let target = managed_binary_target(app, kind)?;
    extract_binary_from_zip(&archive_path, &target, &binary_name(kind.binary_base()))?;
    make_executable(&target)?;

    let mut settings = load_runtime_settings(app)?;
    match kind {
        ManagedBinaryKind::TachyonCore => settings.tachyon_core_binary_path = path_string(&target),
        ManagedBinaryKind::Xray => settings.xray_binary_path = path_string(&target),
    }
    let _ = save_runtime_settings_file(app, settings)?;

    Ok(RuntimeInstallResult {
        release,
        sha256: actual_sha256,
        binary_path: path_string(&target),
        inventory: managed_binary_inventory(app)?,
    })
}

fn build_core_release_diagnostics(
    app: &tauri::AppHandle,
    kind: ManagedBinaryKind,
) -> Result<CoreReleaseDiagnostics, String> {
    let settings = load_runtime_settings(app)?;
    let channel = release_channel_for_kind(kind, &settings).to_string();
    let installed_path = configured_binary_path_for_kind(app, kind, &settings)?;
    let release_result = fetch_core_release_info(kind, &channel);
    let cached_archive_path = release_result
        .as_ref()
        .ok()
        .and_then(|release| cached_release_archive_path(app, kind, release).ok());

    Ok(core_release_diagnostics_from_parts(
        kind,
        &channel,
        &installed_path,
        release_result,
        cached_archive_path.as_deref(),
        |release| http_get_text(&release.checksum_url),
    ))
}

fn core_release_diagnostics_from_parts<F>(
    kind: ManagedBinaryKind,
    selected_channel: &str,
    installed_path: &Path,
    release_result: Result<RuntimeReleaseInfo, String>,
    cached_archive_path: Option<&Path>,
    checksum_text_for: F,
) -> CoreReleaseDiagnostics
where
    F: FnOnce(&RuntimeReleaseInfo) -> Result<String, String>,
{
    let installed_exists = installed_path.is_file();
    let mut diagnostics = CoreReleaseDiagnostics {
        kind: kind.key().to_string(),
        display_name: kind.display_name().to_string(),
        selected_channel: normalize_release_channel_value(selected_channel),
        resolved_tag: None,
        asset_name: None,
        asset_url: None,
        asset_size_bytes: None,
        checksum_asset_name: None,
        checksum_url: None,
        checksum_expected_sha256: None,
        checksum_actual_sha256: None,
        checksum_match: None,
        installed_path: path_string(installed_path),
        installed_exists,
        installed_version: None,
        last_error: None,
    };

    let release = match release_result {
        Ok(release) => release,
        Err(error) => {
            diagnostics.last_error = Some(error);
            return diagnostics;
        }
    };

    diagnostics.resolved_tag = Some(release.tag_name.clone());
    diagnostics.asset_name = Some(release.asset_name.clone());
    diagnostics.asset_url = Some(release.asset_url.clone());
    diagnostics.asset_size_bytes = Some(release.asset_size_bytes);
    diagnostics.checksum_asset_name = Some(release.checksum_asset_name.clone());
    diagnostics.checksum_url = Some(release.checksum_url.clone());

    match checksum_text_for(&release)
        .and_then(|text| find_checksum_for_asset(&text, &release.asset_name))
    {
        Ok(expected_sha256) => {
            diagnostics.checksum_expected_sha256 = Some(expected_sha256.clone());
            if let Some(archive_path) = cached_archive_path.filter(|path| path.is_file()) {
                match sha256_file(archive_path) {
                    Ok(actual_sha256) => {
                        let matches = actual_sha256.eq_ignore_ascii_case(&expected_sha256);
                        diagnostics.checksum_actual_sha256 = Some(actual_sha256.clone());
                        diagnostics.checksum_match = Some(matches);
                        if !matches {
                            append_diagnostic_error(
                                &mut diagnostics.last_error,
                                format!(
                                    "checksum mismatch for {}: expected {}, got {}",
                                    release.asset_name, expected_sha256, actual_sha256
                                ),
                            );
                        }
                    }
                    Err(error) => append_diagnostic_error(&mut diagnostics.last_error, error),
                }
            }
        }
        Err(error) => append_diagnostic_error(&mut diagnostics.last_error, error),
    }

    diagnostics
}

fn release_channel_for_kind(kind: ManagedBinaryKind, settings: &RuntimeSettings) -> &str {
    match kind {
        ManagedBinaryKind::TachyonCore => &settings.tachyon_core_release_channel,
        ManagedBinaryKind::Xray => &settings.xray_release_channel,
    }
}

fn configured_binary_path_for_kind(
    app: &tauri::AppHandle,
    kind: ManagedBinaryKind,
    settings: &RuntimeSettings,
) -> Result<PathBuf, String> {
    let configured = match kind {
        ManagedBinaryKind::TachyonCore => &settings.tachyon_core_binary_path,
        ManagedBinaryKind::Xray => &settings.xray_binary_path,
    };
    let cleaned = clean_path_input(configured);
    if cleaned.is_empty() {
        managed_binary_target(app, kind)
    } else {
        Ok(PathBuf::from(cleaned))
    }
}

fn fetch_core_release_info(
    kind: ManagedBinaryKind,
    channel: &str,
) -> Result<RuntimeReleaseInfo, String> {
    match kind {
        ManagedBinaryKind::TachyonCore => fetch_latest_tachyon_core_release(channel),
        ManagedBinaryKind::Xray => fetch_latest_xray_release(channel),
    }
}

fn cached_release_archive_path(
    app: &tauri::AppHandle,
    kind: ManagedBinaryKind,
    release: &RuntimeReleaseInfo,
) -> Result<PathBuf, String> {
    let config_dir = app
        .path()
        .app_config_dir()
        .map_err(|err| format!("resolve app config directory: {err}"))?;
    Ok(config_dir
        .join("downloads")
        .join(kind.key())
        .join(sanitize_file_component(&release.tag_name))
        .join(&release.asset_name))
}

fn append_diagnostic_error(last_error: &mut Option<String>, error: String) {
    match last_error {
        Some(existing) if !existing.is_empty() => {
            existing.push_str("; ");
            existing.push_str(&error);
        }
        _ => *last_error = Some(error),
    }
}

fn install_wintun_sidecar_file(app: &tauri::AppHandle) -> Result<ManagedBinaryInventory, String> {
    let entry_path = wintun_archive_dll_path()?;
    let settings = load_runtime_settings(app)?;
    let binary_path = clean_path_input(&settings.tachyon_core_binary_path);
    let tachyon_core_path = if binary_path.is_empty() {
        managed_binary_target(app, ManagedBinaryKind::TachyonCore)?
    } else {
        PathBuf::from(binary_path)
    };
    let dependency = sidecar_dependencies(ManagedBinaryKind::TachyonCore, &tachyon_core_path)
        .into_iter()
        .find(|dep| dep.name.eq_ignore_ascii_case("wintun.dll"))
        .ok_or_else(|| "wintun.dll is only required on Windows".to_string())?;
    let target = PathBuf::from(clean_path_input(&dependency.path));
    let download_dir = app
        .path()
        .app_config_dir()
        .map_err(|err| format!("resolve app config directory: {err}"))?
        .join("downloads")
        .join("wintun")
        .join(WINTUN_VERSION);
    fs::create_dir_all(&download_dir).map_err(|err| {
        format!(
            "create Wintun download directory {}: {err}",
            download_dir.display()
        )
    })?;

    let archive_path = download_dir.join(WINTUN_ARCHIVE_NAME);
    download_to_file(WINTUN_DOWNLOAD_URL, &archive_path)?;
    let actual_sha256 = sha256_file(&archive_path)?;
    if !actual_sha256.eq_ignore_ascii_case(WINTUN_SHA256) {
        return Err(format!(
            "checksum mismatch for {WINTUN_ARCHIVE_NAME}: expected {WINTUN_SHA256}, got {actual_sha256}"
        ));
    }

    extract_zip_entry_to_file(&archive_path, entry_path, &target)?;
    managed_binary_inventory(app)
}

fn xray_release_info(release: GithubRelease) -> Result<RuntimeReleaseInfo, String> {
    let marker = xray_platform_asset_marker()?;
    let asset = release
        .assets
        .iter()
        .find(|asset| {
            let name = asset.name.to_ascii_lowercase();
            name.starts_with("xray-") && name.ends_with(".zip") && name.contains(marker)
        })
        .cloned()
        .ok_or_else(|| format!("no Xray asset found for current platform marker {marker}"))?;
    let checksum_asset = release
        .assets
        .iter()
        .find(|candidate| {
            candidate
                .name
                .eq_ignore_ascii_case(&format!("{}.dgst", asset.name))
        })
        .or_else(|| {
            release.assets.iter().find(|candidate| {
                let candidate_name = candidate.name.to_ascii_lowercase();
                candidate_name.ends_with(".dgst")
                    && candidate_name.contains(&asset.name.to_ascii_lowercase())
            })
        })
        .or_else(|| {
            release
                .assets
                .iter()
                .find(|candidate| candidate.name.eq_ignore_ascii_case("Xray-checksums.txt"))
        })
        .or_else(|| {
            release
                .assets
                .iter()
                .find(|candidate| candidate.name.to_ascii_lowercase().contains("checksum"))
        })
        .cloned()
        .ok_or_else(|| "no Xray checksum asset found".to_string())?;

    Ok(RuntimeReleaseInfo {
        tag_name: release.tag_name,
        asset_name: asset.name,
        asset_url: asset.browser_download_url,
        asset_size_bytes: asset.size,
        checksum_asset_name: checksum_asset.name,
        checksum_url: checksum_asset.browser_download_url,
        published_at: release.published_at,
    })
}

fn tachyon_core_release_info(release: GithubRelease) -> Result<RuntimeReleaseInfo, String> {
    let marker = tachyon_core_platform_asset_marker()?;
    let asset = release
        .assets
        .iter()
        .find(|asset| {
            let name = asset.name.to_ascii_lowercase();
            name.starts_with("tachyon-core_") && name.ends_with(".zip") && name.contains(marker)
        })
        .cloned()
        .ok_or_else(|| {
            format!("no Tachyon Core asset found for current platform marker {marker}")
        })?;
    let checksum_asset = release
        .assets
        .iter()
        .find(|candidate| candidate.name.eq_ignore_ascii_case("SHA256SUMS.txt"))
        .or_else(|| {
            release.assets.iter().find(|candidate| {
                let name = candidate.name.to_ascii_lowercase();
                name.contains("sha256") || name.contains("checksum")
            })
        })
        .cloned()
        .ok_or_else(|| "no Tachyon Core checksum asset found".to_string())?;

    Ok(RuntimeReleaseInfo {
        tag_name: release.tag_name,
        asset_name: asset.name,
        asset_url: asset.browser_download_url,
        asset_size_bytes: asset.size,
        checksum_asset_name: checksum_asset.name,
        checksum_url: checksum_asset.browser_download_url,
        published_at: release.published_at,
    })
}

fn latest_xray_release_info(
    releases: Vec<GithubRelease>,
    channel: &str,
) -> Result<RuntimeReleaseInfo, String> {
    for release in release_candidates_for_channel(releases, channel) {
        if !release_channel_allows(&release, channel) {
            continue;
        }
        if let Ok(info) = xray_release_info(release) {
            return Ok(info);
        }
    }
    Err(release_channel_empty_message("Xray", channel))
}

fn latest_tachyon_core_release_info(
    releases: Vec<GithubRelease>,
    channel: &str,
) -> Result<RuntimeReleaseInfo, String> {
    for release in release_candidates_for_channel(releases, channel) {
        if !release_channel_allows(&release, channel) {
            continue;
        }
        if let Ok(info) = tachyon_core_release_info(release) {
            return Ok(info);
        }
    }
    Err(release_channel_empty_message("Tachyon Core", channel))
}

fn release_candidates_for_channel(
    releases: Vec<GithubRelease>,
    channel: &str,
) -> Vec<GithubRelease> {
    match channel.trim().to_ascii_lowercase().as_str() {
        "preview" | "pre" | "prerelease" => {
            let (mut prereleases, stable): (Vec<_>, Vec<_>) =
                releases.into_iter().partition(|release| release.prerelease);
            prereleases.extend(stable);
            prereleases
        }
        _ => releases,
    }
}

fn release_channel_allows(release: &GithubRelease, channel: &str) -> bool {
    match channel.trim().to_ascii_lowercase().as_str() {
        "preview" | "pre" | "prerelease" => true,
        _ => !release.prerelease,
    }
}

fn release_channel_empty_message(name: &str, channel: &str) -> String {
    match channel.trim().to_ascii_lowercase().as_str() {
        "stable" => format!(
            "no compatible {name} stable release found; stable uses full releases only. Switch the release channel to Pre to use prerelease builds."
        ),
        "preview" | "pre" | "prerelease" => {
            format!("no compatible {name} prerelease or stable release found for the Pre channel")
        }
        _ => format!("no compatible {name} release found for channel {channel}"),
    }
}

fn xray_platform_asset_marker() -> Result<&'static str, String> {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("windows", "x86_64") => Ok("windows-64"),
        ("windows", "aarch64") => Ok("windows-arm64"),
        ("linux", "x86_64") => Ok("linux-64"),
        ("linux", "aarch64") => Ok("linux-arm64"),
        ("macos", "x86_64") => Ok("macos-64"),
        ("macos", "aarch64") => Ok("macos-arm64"),
        (os, arch) => Err(format!("unsupported Xray platform: {os}/{arch}")),
    }
}

fn tachyon_core_platform_asset_marker() -> Result<&'static str, String> {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("windows", "x86") => Ok("windows_386"),
        ("windows", "x86_64") => Ok("windows_amd64"),
        ("windows", "aarch64") => Ok("windows_arm64"),
        ("linux", "x86_64") => Ok("linux_amd64"),
        ("linux", "aarch64") => Ok("linux_arm64"),
        ("macos", "x86_64") => Ok("darwin_amd64"),
        ("macos", "aarch64") => Ok("darwin_arm64"),
        (os, arch) => Err(format!("unsupported Tachyon Core platform: {os}/{arch}")),
    }
}

fn wintun_archive_dll_path() -> Result<&'static str, String> {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("windows", "x86") => Ok("wintun/bin/x86/wintun.dll"),
        ("windows", "x86_64") => Ok("wintun/bin/amd64/wintun.dll"),
        ("windows", "aarch64") => Ok("wintun/bin/arm64/wintun.dll"),
        ("windows", "arm") => Ok("wintun/bin/arm/wintun.dll"),
        ("windows", arch) => Err(format!("unsupported Wintun platform: windows/{arch}")),
        (os, _) => Err(format!("Wintun is not required on {os}")),
    }
}

fn http_get_json<T: DeserializeOwned>(url: &str) -> Result<T, String> {
    let agent = http_agent();
    let mut response = agent
        .get(url)
        .header("User-Agent", "Tachyon-Prism/0.1")
        .header("Accept", "application/vnd.github+json")
        .call()
        .map_err(|err| format!("request {url}: {err}"))?;
    response
        .body_mut()
        .read_json::<T>()
        .map_err(|err| format!("decode JSON from {url}: {err}"))
}

fn http_get_text(url: &str) -> Result<String, String> {
    let agent = http_agent();
    let mut response = agent
        .get(url)
        .header("User-Agent", "Tachyon-Prism/0.1")
        .header(
            "Accept",
            "text/plain, application/json, application/octet-stream, */*",
        )
        .call()
        .map_err(|err| format!("request {url}: {err}"))?;
    response
        .body_mut()
        .read_to_string()
        .map_err(|err| format!("read {url}: {err}"))
}

const SUBSCRIPTION_MAX_REDIRECTS: usize = 5;
const SUBSCRIPTION_MAX_HEADER_BYTES: usize = 64 * 1024;
const SUBSCRIPTION_MAX_BODY_BYTES: usize = 16 * 1024 * 1024;
const SUBSCRIPTION_CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const SUBSCRIPTION_IO_TIMEOUT: Duration = Duration::from_secs(15);
const SUBSCRIPTION_TOTAL_TIMEOUT: Duration = Duration::from_secs(45);
const SUBSCRIPTION_ALLOW_PRIVATE_NETWORKS: bool = false;

#[derive(Clone, Debug)]
struct SubscriptionUrl {
    scheme: String,
    host: String,
    authority: String,
    path_and_query: String,
    port: u16,
}

impl SubscriptionUrl {
    fn parse(input: &str) -> Result<Self, String> {
        let (scheme, rest) = input
            .split_once("://")
            .ok_or_else(|| "subscription URL must start with http:// or https://".to_string())?;
        let scheme = scheme.to_ascii_lowercase();
        if scheme != "http" && scheme != "https" {
            return Err("subscription URL must start with http:// or https://".to_string());
        }
        if rest.chars().any(|ch| ch.is_control() || ch == ' ') {
            return Err("subscription URL is invalid".to_string());
        }
        let authority_end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
        let authority = &rest[..authority_end];
        if authority.is_empty() {
            return Err("subscription URL host is required".to_string());
        }
        if authority.contains('@') {
            return Err("subscription URL credentials are not allowed".to_string());
        }
        let default_port = if scheme == "http" { 80 } else { 443 };
        let (host, port) = parse_subscription_authority(authority, default_port)?;
        let suffix = &rest[authority_end..];
        let suffix = suffix.split_once('#').map_or(suffix, |(before, _)| before);
        let path_and_query = if suffix.is_empty() {
            "/".to_string()
        } else if suffix.starts_with('?') {
            format!("/{suffix}")
        } else {
            suffix.to_string()
        };
        let parsed = Self {
            scheme,
            host,
            authority: authority.to_string(),
            path_and_query,
            port,
        };
        parsed
            .to_string()
            .parse::<ureq::http::Uri>()
            .map_err(|_| "subscription URL is invalid".to_string())?;
        Ok(parsed)
    }

    fn resolve(&self, location: &str) -> Result<Self, String> {
        let location = location.trim();
        if location.is_empty() || location.chars().any(char::is_control) {
            return Err("subscription redirect location is invalid".to_string());
        }
        let has_absolute_scheme = location.split_once(':').is_some_and(|(scheme, _)| {
            !scheme.is_empty()
                && scheme.bytes().enumerate().all(|(index, byte)| {
                    byte.is_ascii_alphabetic()
                        || (index > 0
                            && (byte.is_ascii_digit() || matches!(byte, b'+' | b'-' | b'.')))
                })
        });
        if has_absolute_scheme {
            return Self::parse(location);
        }
        if let Some(authority_relative) = location.strip_prefix("//") {
            return Self::parse(&format!("{}://{authority_relative}", self.scheme));
        }

        let location = location
            .split_once('#')
            .map_or(location, |(before, _)| before);
        let next_path = if location.is_empty() {
            self.path_and_query.clone()
        } else if location.starts_with('/') {
            location.to_string()
        } else if location.starts_with('?') {
            format!("{}{}", self.path_only(), location)
        } else {
            let base = self.path_only();
            let directory = base.rsplit_once('/').map_or("/", |(dir, _)| dir);
            normalize_subscription_path(&format!("{directory}/{location}"))
        };
        Self::parse(&format!(
            "{}://{}{}",
            self.scheme, self.authority, next_path
        ))
    }

    fn path_only(&self) -> &str {
        self.path_and_query
            .split_once('?')
            .map_or(&self.path_and_query, |(path, _)| path)
    }
}

impl std::fmt::Display for SubscriptionUrl {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            formatter,
            "{}://{}{}",
            self.scheme, self.authority, self.path_and_query
        )
    }
}

#[derive(Clone, Debug)]
struct ApprovedSubscriptionResolver {
    addresses: Vec<SocketAddr>,
}

impl ureq::unversioned::resolver::Resolver for ApprovedSubscriptionResolver {
    fn resolve(
        &self,
        _uri: &ureq::http::Uri,
        _config: &ureq::config::Config,
        _timeout: ureq::unversioned::transport::NextTimeout,
    ) -> Result<ureq::unversioned::resolver::ResolvedSocketAddrs, ureq::Error> {
        let mut resolved = self.empty();
        for address in &self.addresses {
            resolved.push(*address);
        }
        if resolved.is_empty() {
            Err(ureq::Error::HostNotFound)
        } else {
            Ok(resolved)
        }
    }
}

fn resolve_approved_subscription_addresses(
    url: &SubscriptionUrl,
    allow_private_networks: bool,
) -> Result<Vec<SocketAddr>, String> {
    if is_cloud_metadata_host(&url.host) {
        return Err("subscription URL targets a cloud metadata service".to_string());
    }
    let resolved = (url.host.as_str(), url.port)
        .to_socket_addrs()
        .map_err(|_| "subscription host could not be resolved".to_string())?;
    let mut approved = Vec::new();
    for address in resolved {
        validate_subscription_address(address.ip(), allow_private_networks)?;
        if !approved.contains(&address) {
            approved.push(address);
        }
    }
    if approved.is_empty() {
        return Err("subscription host resolved to no addresses".to_string());
    }
    approved.truncate(16);
    Ok(approved)
}

fn is_cloud_metadata_host(host: &str) -> bool {
    matches!(
        host.trim_end_matches('.').to_ascii_lowercase().as_str(),
        "metadata.google.internal"
            | "metadata.goog"
            | "metadata.azure.internal"
            | "instance-data.ec2.internal"
            | "metadata.oraclecloud.com"
    )
}

fn validate_subscription_address(
    address: IpAddr,
    allow_private_networks: bool,
) -> Result<(), String> {
    let reason = match address {
        IpAddr::V4(address) => forbidden_ipv4_reason(address, allow_private_networks),
        IpAddr::V6(address) => forbidden_ipv6_reason(address, allow_private_networks),
    };
    match reason {
        Some(reason) => Err(format!(
            "subscription destination address {address} is forbidden ({reason})"
        )),
        None => Ok(()),
    }
}

fn forbidden_ipv4_reason(address: Ipv4Addr, allow_private_networks: bool) -> Option<&'static str> {
    if matches!(
        address.octets(),
        [169, 254, 169, 254] | [100, 100, 100, 200] | [192, 0, 0, 192]
    ) {
        return Some("cloud metadata");
    }
    if ipv4_in_prefix(address, [0, 0, 0, 0], 8) {
        return Some("unspecified or current network");
    }
    if ipv4_in_prefix(address, [127, 0, 0, 0], 8) {
        return (!allow_private_networks).then_some("loopback");
    }
    if ipv4_in_prefix(address, [10, 0, 0, 0], 8)
        || ipv4_in_prefix(address, [172, 16, 0, 0], 12)
        || ipv4_in_prefix(address, [192, 168, 0, 0], 16)
    {
        return (!allow_private_networks).then_some("private network");
    }
    for (network, prefix, reason) in [
        ([100, 64, 0, 0], 10, "shared address space"),
        ([169, 254, 0, 0], 16, "link-local"),
        ([192, 0, 0, 0], 24, "IETF protocol assignment"),
        ([192, 0, 2, 0], 24, "documentation"),
        ([192, 31, 196, 0], 24, "reserved service range"),
        ([192, 52, 193, 0], 24, "reserved service range"),
        ([192, 88, 99, 0], 24, "deprecated relay range"),
        ([192, 175, 48, 0], 24, "reserved service range"),
        ([198, 18, 0, 0], 15, "benchmarking"),
        ([198, 51, 100, 0], 24, "documentation"),
        ([203, 0, 113, 0], 24, "documentation"),
        ([224, 0, 0, 0], 4, "multicast"),
        ([240, 0, 0, 0], 4, "reserved"),
    ] {
        if ipv4_in_prefix(address, network, prefix) {
            return Some(reason);
        }
    }
    None
}

fn forbidden_ipv6_reason(address: Ipv6Addr, allow_private_networks: bool) -> Option<&'static str> {
    if address
        == "fd00:ec2::254"
            .parse::<Ipv6Addr>()
            .expect("valid metadata address")
    {
        return Some("cloud metadata");
    }
    if address.is_unspecified() {
        return Some("unspecified");
    }
    if address.is_loopback() {
        return (!allow_private_networks).then_some("loopback");
    }
    if let Some(mapped) = address.to_ipv4_mapped() {
        return forbidden_ipv4_reason(mapped, allow_private_networks);
    }
    if ipv6_in_prefix(address, "fc00::".parse().expect("valid prefix"), 7) {
        return (!allow_private_networks).then_some("private network");
    }
    for (network, prefix, reason) in [
        (
            "::".parse().expect("valid prefix"),
            96,
            "IPv4-compatible or reserved",
        ),
        (
            "64:ff9b::".parse().expect("valid prefix"),
            96,
            "translation prefix",
        ),
        (
            "64:ff9b:1::".parse().expect("valid prefix"),
            48,
            "local translation prefix",
        ),
        ("100::".parse().expect("valid prefix"), 64, "discard-only"),
        (
            "2001::".parse().expect("valid prefix"),
            23,
            "IETF protocol assignment",
        ),
        (
            "2001:db8::".parse().expect("valid prefix"),
            32,
            "documentation",
        ),
        (
            "2002::".parse().expect("valid prefix"),
            16,
            "deprecated 6to4",
        ),
        ("fe80::".parse().expect("valid prefix"), 10, "link-local"),
        ("ff00::".parse().expect("valid prefix"), 8, "multicast"),
    ] {
        if ipv6_in_prefix(address, network, prefix) {
            return Some(reason);
        }
    }
    if !ipv6_in_prefix(address, "2000::".parse().expect("valid prefix"), 3) {
        return Some("reserved");
    }
    None
}

fn ipv4_in_prefix(address: Ipv4Addr, network: [u8; 4], prefix: u32) -> bool {
    let mask = u32::MAX.checked_shl(32 - prefix).unwrap_or(0);
    u32::from(address) & mask == u32::from(Ipv4Addr::from(network)) & mask
}

fn ipv6_in_prefix(address: Ipv6Addr, network: Ipv6Addr, prefix: u32) -> bool {
    let mask = u128::MAX.checked_shl(128 - prefix).unwrap_or(0);
    u128::from(address) & mask == u128::from(network) & mask
}

fn parse_subscription_authority(
    authority: &str,
    default_port: u16,
) -> Result<(String, u16), String> {
    if let Some(rest) = authority.strip_prefix('[') {
        let (host, suffix) = rest
            .split_once(']')
            .ok_or_else(|| "subscription URL IPv6 host is invalid".to_string())?;
        if host.is_empty() {
            return Err("subscription URL host is required".to_string());
        }
        let port = if suffix.is_empty() {
            default_port
        } else {
            parse_subscription_port(
                suffix
                    .strip_prefix(':')
                    .ok_or_else(|| "subscription URL port is invalid".to_string())?,
            )?
        };
        return Ok((host.to_string(), port));
    }
    if authority.matches(':').count() > 1 {
        return Err("subscription URL IPv6 host must use brackets".to_string());
    }
    let (host, port) = match authority.rsplit_once(':') {
        Some((host, port)) => (host, parse_subscription_port(port)?),
        None => (authority, default_port),
    };
    if host.is_empty() {
        return Err("subscription URL host is required".to_string());
    }
    Ok((host.to_string(), port))
}

fn parse_subscription_port(value: &str) -> Result<u16, String> {
    let port = value
        .parse::<u16>()
        .map_err(|_| "subscription URL port is invalid".to_string())?;
    if port == 0 {
        return Err("subscription URL port is invalid".to_string());
    }
    Ok(port)
}

fn normalize_subscription_path(path_and_query: &str) -> String {
    let (path, query) = path_and_query
        .split_once('?')
        .map_or((path_and_query, None), |(path, query)| (path, Some(query)));
    let mut segments = Vec::new();
    for segment in path.split('/') {
        match segment {
            "" | "." => {}
            ".." => {
                segments.pop();
            }
            _ => segments.push(segment),
        }
    }
    let mut normalized = format!("/{}", segments.join("/"));
    if let Some(query) = query {
        normalized.push('?');
        normalized.push_str(query);
    }
    normalized
}

struct SubscriptionResponse {
    status: u16,
    location: Option<String>,
    body: Vec<u8>,
}

fn fetch_subscription_url(input: &str) -> Result<String, String> {
    fetch_subscription_url_with_policy(input, SUBSCRIPTION_ALLOW_PRIVATE_NETWORKS)
}

fn fetch_subscription_url_with_policy(
    input: &str,
    allow_private_networks: bool,
) -> Result<String, String> {
    let mut url = SubscriptionUrl::parse(input)?;
    let started = Instant::now();
    let mut lenient_http = false;

    for redirect_count in 0..=SUBSCRIPTION_MAX_REDIRECTS {
        if started.elapsed() >= SUBSCRIPTION_TOTAL_TIMEOUT {
            return Err("subscription request timed out".to_string());
        }
        let approved = resolve_approved_subscription_addresses(&url, allow_private_networks)?;
        let response = if lenient_http && url.scheme == "http" {
            raw_subscription_request(&url, started, &approved)?
        } else {
            let remaining = SUBSCRIPTION_TOTAL_TIMEOUT.saturating_sub(started.elapsed());
            match strict_subscription_request(&url, remaining, &approved) {
                Ok(response) => response,
                Err(ureq::Error::Protocol(_)) if url.scheme == "http" => {
                    lenient_http = true;
                    raw_subscription_request(&url, started, &approved)?
                }
                Err(error) => return Err(format!("subscription request failed: {error}")),
            }
        };

        if matches!(response.status, 301 | 302 | 303 | 307 | 308) {
            if redirect_count == SUBSCRIPTION_MAX_REDIRECTS {
                return Err("subscription redirect limit exceeded".to_string());
            }
            let location = response
                .location
                .ok_or_else(|| "subscription redirect is missing Location".to_string())?;
            let next_url = url.resolve(&location)?;
            validate_subscription_redirect(&url, &next_url)?;
            url = next_url;
            continue;
        }
        if !(200..300).contains(&response.status) {
            return Err(format!(
                "subscription server returned HTTP {}",
                response.status
            ));
        }
        return String::from_utf8(response.body)
            .map_err(|_| "subscription response is not valid UTF-8".to_string());
    }
    Err("subscription redirect limit exceeded".to_string())
}

fn validate_subscription_redirect(
    current: &SubscriptionUrl,
    next: &SubscriptionUrl,
) -> Result<(), String> {
    if current.scheme == "https" && next.scheme == "http" {
        return Err("subscription redirect cannot downgrade HTTPS to HTTP".to_string());
    }
    Ok(())
}

fn strict_subscription_request(
    url: &SubscriptionUrl,
    timeout: Duration,
    approved: &[SocketAddr],
) -> Result<SubscriptionResponse, ureq::Error> {
    let config = ureq::Agent::config_builder()
        .timeout_global(Some(timeout.max(Duration::from_millis(1))))
        .max_redirects(0)
        .http_status_as_error(false)
        .build();
    let agent = ureq::Agent::with_parts(
        config,
        ureq::unversioned::transport::DefaultConnector::default(),
        ApprovedSubscriptionResolver {
            addresses: approved.to_vec(),
        },
    );
    let mut response = agent
        .get(url.to_string())
        .header("User-Agent", "Tachyon-Prism/0.1")
        .header(
            "Accept",
            "text/plain, application/json, application/octet-stream, */*",
        )
        .call()?;
    let status = response.status().as_u16();
    let location = response
        .headers()
        .get("location")
        .map(|value| value.to_str().map(str::to_string))
        .transpose()
        .map_err(|_| {
            ureq::Error::Io(io::Error::new(
                io::ErrorKind::InvalidData,
                "invalid redirect location",
            ))
        })?;
    let mut body = Vec::new();
    response
        .body_mut()
        .as_reader()
        .take((SUBSCRIPTION_MAX_BODY_BYTES + 1) as u64)
        .read_to_end(&mut body)
        .map_err(ureq::Error::Io)?;
    if body.len() > SUBSCRIPTION_MAX_BODY_BYTES {
        return Err(ureq::Error::BodyExceedsLimit(
            SUBSCRIPTION_MAX_BODY_BYTES as u64,
        ));
    }
    Ok(SubscriptionResponse {
        status,
        location,
        body,
    })
}

fn raw_subscription_request(
    url: &SubscriptionUrl,
    started: Instant,
    approved: &[SocketAddr],
) -> Result<SubscriptionResponse, String> {
    if url.scheme != "http" {
        return Err("internal error: raw subscription transport requires HTTP".to_string());
    }
    let mut last_error = None;
    let mut stream = None;
    for address in approved {
        let remaining = SUBSCRIPTION_TOTAL_TIMEOUT.saturating_sub(started.elapsed());
        if remaining.is_zero() {
            break;
        }
        match TcpStream::connect_timeout(address, SUBSCRIPTION_CONNECT_TIMEOUT.min(remaining)) {
            Ok(connected) => {
                stream = Some(connected);
                break;
            }
            Err(error) => last_error = Some(error),
        }
    }
    let mut stream = stream.ok_or_else(|| {
        if last_error.is_some() {
            "subscription connection failed".to_string()
        } else {
            "subscription request timed out".to_string()
        }
    })?;
    let io_timeout = SUBSCRIPTION_IO_TIMEOUT.min(
        SUBSCRIPTION_TOTAL_TIMEOUT
            .saturating_sub(started.elapsed())
            .max(Duration::from_millis(1)),
    );
    stream
        .set_read_timeout(Some(io_timeout))
        .map_err(|_| "configure subscription read timeout failed".to_string())?;
    stream
        .set_write_timeout(Some(io_timeout))
        .map_err(|_| "configure subscription write timeout failed".to_string())?;
    let request = format!(
        "GET {} HTTP/1.1\r\nHost: {}\r\nUser-Agent: Tachyon-Prism/0.1\r\nAccept: text/plain, application/json, application/octet-stream, */*\r\nConnection: close\r\n\r\n",
        url.path_and_query, url.authority
    );
    stream
        .write_all(request.as_bytes())
        .map_err(|_| "write subscription request failed".to_string())?;
    read_raw_subscription_response(stream)
}

fn read_raw_subscription_response(mut stream: TcpStream) -> Result<SubscriptionResponse, String> {
    let mut received = Vec::new();
    let header_end = loop {
        if let Some(position) = received.windows(4).position(|window| window == b"\r\n\r\n") {
            break position + 4;
        }
        if received.len() >= SUBSCRIPTION_MAX_HEADER_BYTES {
            return Err("subscription response headers are too large".to_string());
        }
        let mut buffer = [0_u8; 4096];
        let count = stream
            .read(&mut buffer)
            .map_err(|_| "read subscription response failed".to_string())?;
        if count == 0 {
            return Err("subscription response ended before headers".to_string());
        }
        received.extend_from_slice(&buffer[..count]);
        if received.len() > SUBSCRIPTION_MAX_HEADER_BYTES + SUBSCRIPTION_MAX_BODY_BYTES {
            return Err("subscription response is too large".to_string());
        }
    };
    if header_end > SUBSCRIPTION_MAX_HEADER_BYTES {
        return Err("subscription response headers are too large".to_string());
    }
    let headers = std::str::from_utf8(&received[..header_end])
        .map_err(|_| "subscription response headers are invalid".to_string())?;
    let mut lines = headers[..headers.len() - 4].split("\r\n");
    let status_line = lines
        .by_ref()
        .find(|line| !line.trim().is_empty())
        .ok_or_else(|| "subscription response status is missing".to_string())?;
    let status = parse_lenient_subscription_status(status_line)?;
    let mut content_length = None;
    let mut chunked = false;
    let mut location = None;
    for line in lines {
        let (name, value) = line
            .split_once(':')
            .ok_or_else(|| "subscription response header is invalid".to_string())?;
        if name.is_empty()
            || !name
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || b"!#$%&'*+-.^_`|~".contains(&byte))
        {
            return Err("subscription response header name is invalid".to_string());
        }
        let value = value.trim();
        if name.eq_ignore_ascii_case("content-length") {
            let length = value
                .parse::<usize>()
                .map_err(|_| "subscription Content-Length is invalid".to_string())?;
            if content_length.replace(length).is_some() {
                return Err("subscription response has duplicate Content-Length".to_string());
            }
        } else if name.eq_ignore_ascii_case("transfer-encoding") {
            if chunked {
                return Err("subscription response has duplicate Transfer-Encoding".to_string());
            }
            if !value.eq_ignore_ascii_case("chunked") {
                return Err("subscription transfer encoding is unsupported".to_string());
            }
            chunked = true;
        } else if name.eq_ignore_ascii_case("location")
            && location.replace(value.to_string()).is_some()
        {
            return Err("subscription response has duplicate Location".to_string());
        }
    }
    if chunked && content_length.is_some() {
        return Err("subscription response framing is ambiguous".to_string());
    }
    if content_length.is_some_and(|length| length > SUBSCRIPTION_MAX_BODY_BYTES) {
        return Err("subscription response is too large".to_string());
    }

    let buffered_body = received.split_off(header_end);
    let chained = io::Cursor::new(buffered_body).chain(stream);
    let mut reader = io::BufReader::new(chained);
    let body = if chunked {
        read_chunked_subscription_body(&mut reader)?
    } else if let Some(length) = content_length {
        let mut body = vec![0; length];
        reader
            .read_exact(&mut body)
            .map_err(|_| "subscription response body ended early".to_string())?;
        body
    } else {
        let mut body = Vec::new();
        reader
            .take((SUBSCRIPTION_MAX_BODY_BYTES + 1) as u64)
            .read_to_end(&mut body)
            .map_err(|_| "read subscription response body failed".to_string())?;
        if body.len() > SUBSCRIPTION_MAX_BODY_BYTES {
            return Err("subscription response is too large".to_string());
        }
        body
    };
    Ok(SubscriptionResponse {
        status,
        location,
        body,
    })
}

fn parse_lenient_subscription_status(line: &str) -> Result<u16, String> {
    let mut parts = line.split_whitespace();
    let first = parts
        .next()
        .ok_or_else(|| "subscription response status is empty".to_string())?;
    let code = if matches!(first, "HTTP/1.0" | "HTTP/1.1" | "HTTP/0.0" | "HTTP/") {
        parts.next()
    } else if let Some(version) = first.strip_prefix("HTTP/") {
        if !version.is_empty()
            && version
                .bytes()
                .all(|byte| byte.is_ascii_digit() || byte == b'.')
        {
            return Err(format!(
                "subscription response HTTP version {version} is unsupported"
            ));
        }
        return Err(format!(
            "subscription response HTTP version token has invalid length {}",
            version.len()
        ));
    } else {
        Some(first)
    }
    .ok_or_else(|| "subscription response status code is missing".to_string())?;
    if code.len() != 3 {
        return Err(format!(
            "subscription response status token has invalid length {}",
            code.len()
        ));
    }
    if !code.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err("subscription response status code is not numeric".to_string());
    }
    let status = code
        .parse::<u16>()
        .map_err(|_| "subscription response status code is invalid".to_string())?;
    if !(100..=599).contains(&status) {
        return Err("subscription response status code is out of range".to_string());
    }
    Ok(status)
}

fn read_chunked_subscription_body<R: io::BufRead>(reader: &mut R) -> Result<Vec<u8>, String> {
    let mut body = Vec::new();
    loop {
        let line = read_bounded_crlf_line(reader, 1024)?;
        let size_text = line.split_once(';').map_or(line.as_str(), |(size, _)| size);
        let size = usize::from_str_radix(size_text.trim(), 16)
            .map_err(|_| "subscription chunk size is invalid".to_string())?;
        if size == 0 {
            loop {
                if read_bounded_crlf_line(reader, SUBSCRIPTION_MAX_HEADER_BYTES)?.is_empty() {
                    return Ok(body);
                }
            }
        }
        if size > SUBSCRIPTION_MAX_BODY_BYTES - body.len() {
            return Err("subscription response is too large".to_string());
        }
        let start = body.len();
        body.resize(start + size, 0);
        reader
            .read_exact(&mut body[start..])
            .map_err(|_| "subscription chunk ended early".to_string())?;
        let mut ending = [0_u8; 2];
        reader
            .read_exact(&mut ending)
            .map_err(|_| "subscription chunk ended early".to_string())?;
        if ending != *b"\r\n" {
            return Err("subscription chunk terminator is invalid".to_string());
        }
    }
}

fn read_bounded_crlf_line<R: io::BufRead>(reader: &mut R, limit: usize) -> Result<String, String> {
    let mut bytes = Vec::new();
    let mut limited = reader.take((limit + 1) as u64);
    io::BufRead::read_until(&mut limited, b'\n', &mut bytes)
        .map_err(|_| "read subscription chunk metadata failed".to_string())?;
    if bytes.len() > limit || !bytes.ends_with(b"\r\n") {
        return Err("subscription chunk metadata is invalid".to_string());
    }
    bytes.truncate(bytes.len() - 2);
    String::from_utf8(bytes).map_err(|_| "subscription chunk metadata is invalid".to_string())
}

fn download_to_file(url: &str, path: &Path) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "download target has no parent".to_string())?;
    fs::create_dir_all(parent)
        .map_err(|err| format!("create download directory {}: {err}", parent.display()))?;

    let temp_path = path.with_extension("download.tmp");
    let agent = http_agent();
    let mut response = agent
        .get(url)
        .header("User-Agent", "Tachyon-Prism/0.1")
        .call()
        .map_err(|err| format!("download {url}: {err}"))?;
    let mut output = fs::File::create(&temp_path)
        .map_err(|err| format!("create {}: {err}", temp_path.display()))?;
    io::copy(&mut response.body_mut().as_reader(), &mut output)
        .map_err(|err| format!("write {}: {err}", temp_path.display()))?;
    if path.exists() {
        fs::remove_file(path).map_err(|err| format!("replace {}: {err}", path.display()))?;
    }
    fs::rename(&temp_path, path).map_err(|err| format!("move {}: {err}", path.display()))
}

fn health_agent_with_timeout(timeout: Duration) -> ureq::Agent {
    let config = ureq::Agent::config_builder()
        .timeout_global(Some(timeout))
        .build();
    config.into()
}

fn http_agent() -> ureq::Agent {
    let config = ureq::Agent::config_builder()
        .timeout_global(Some(Duration::from_secs(120)))
        .build();
    config.into()
}

fn find_checksum_for_asset(checksum_text: &str, asset_name: &str) -> Result<String, String> {
    let aliases = checksum_asset_name_aliases(asset_name);
    for line in checksum_text.lines() {
        let Some(filename) = checksum_line_filename(line) else {
            continue;
        };
        if !aliases.iter().any(|alias| alias == &filename) {
            continue;
        }
        for token in line
            .split(|character: char| character.is_whitespace() || character == '=')
            .map(|token| token.trim_matches(|character: char| !character.is_ascii_hexdigit()))
        {
            if token.len() == 64 && token.chars().all(|character| character.is_ascii_hexdigit()) {
                return Ok(token.to_ascii_lowercase());
            }
        }
    }
    Err(format!("checksum for {asset_name} not found"))
}

fn checksum_line_filename(line: &str) -> Option<String> {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return None;
    }

    if let Some(rest) = trimmed.strip_prefix("SHA256 (") {
        let (filename, _) = rest.split_once(") = ")?;
        return Some(filename.to_string());
    }

    let hash = trimmed.get(..64)?;
    if hash.len() != 64 || !hash.chars().all(|character| character.is_ascii_hexdigit()) {
        return None;
    }

    let rest = trimmed.get(64..)?;
    if !rest.starts_with(char::is_whitespace) {
        return None;
    }

    let filename = rest.trim_start().trim_start_matches('*');
    if filename.is_empty() {
        return None;
    }

    Some(filename.to_string())
}

fn checksum_asset_name_aliases(asset_name: &str) -> Vec<String> {
    let mut aliases = vec![asset_name.to_string()];
    push_unique_string(
        &mut aliases,
        asset_name.replace("Tachyon.Prism", "Tachyon Prism"),
    );
    push_unique_string(
        &mut aliases,
        asset_name.replace("Tachyon Prism", "Tachyon.Prism"),
    );
    aliases
}

fn push_unique_string(values: &mut Vec<String>, value: String) {
    if !values.iter().any(|current| current == &value) {
        values.push(value);
    }
}

fn sha256_file(path: &Path) -> Result<String, String> {
    use sha2::{Digest, Sha256};

    let mut file = fs::File::open(path).map_err(|err| format!("open {}: {err}", path.display()))?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = io::Read::read(&mut file, &mut buffer)
            .map_err(|err| format!("read {}: {err}", path.display()))?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(hex_encode(&hasher.finalize()))
}

fn hex_encode(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        output.push(HEX[(byte >> 4) as usize] as char);
        output.push(HEX[(byte & 0x0f) as usize] as char);
    }
    output
}

fn extract_binary_from_zip(
    archive_path: &Path,
    target: &Path,
    binary_file_name: &str,
) -> Result<(), String> {
    let archive_file = fs::File::open(archive_path)
        .map_err(|err| format!("open archive {}: {err}", archive_path.display()))?;
    let mut archive = zip::ZipArchive::new(archive_file)
        .map_err(|err| format!("read archive {}: {err}", archive_path.display()))?;
    let temp_path = target.with_extension("extract.tmp");

    for index in 0..archive.len() {
        let mut entry = archive
            .by_index(index)
            .map_err(|err| format!("read archive entry {index}: {err}"))?;
        let Some(name) = Path::new(entry.name()).file_name() else {
            continue;
        };
        if name.to_string_lossy() != binary_file_name {
            continue;
        }

        let parent = target
            .parent()
            .ok_or_else(|| "binary target has no parent".to_string())?;
        fs::create_dir_all(parent)
            .map_err(|err| format!("create binary directory {}: {err}", parent.display()))?;
        let mut output = fs::File::create(&temp_path)
            .map_err(|err| format!("create {}: {err}", temp_path.display()))?;
        io::copy(&mut entry, &mut output)
            .map_err(|err| format!("extract {}: {err}", temp_path.display()))?;
        if target.exists() {
            fs::remove_file(target)
                .map_err(|err| format!("replace {}: {err}", target.display()))?;
        }
        return fs::rename(&temp_path, target)
            .map_err(|err| format!("move {}: {err}", target.display()));
    }

    Err(format!(
        "{binary_file_name} not found in {}",
        archive_path.display()
    ))
}

fn extract_zip_entry_to_file(
    archive_path: &Path,
    entry_path: &str,
    target: &Path,
) -> Result<(), String> {
    let archive_file = fs::File::open(archive_path)
        .map_err(|err| format!("open archive {}: {err}", archive_path.display()))?;
    let mut archive = zip::ZipArchive::new(archive_file)
        .map_err(|err| format!("read archive {}: {err}", archive_path.display()))?;
    let temp_path = target.with_extension("extract.tmp");
    let normalized_entry = entry_path.replace('\\', "/");

    for index in 0..archive.len() {
        let mut entry = archive
            .by_index(index)
            .map_err(|err| format!("read archive entry {index}: {err}"))?;
        let entry_name = entry.name().replace('\\', "/");
        if !entry_name.eq_ignore_ascii_case(&normalized_entry) {
            continue;
        }

        let parent = target
            .parent()
            .ok_or_else(|| "sidecar target has no parent".to_string())?;
        fs::create_dir_all(parent)
            .map_err(|err| format!("create sidecar directory {}: {err}", parent.display()))?;
        let mut output = fs::File::create(&temp_path)
            .map_err(|err| format!("create {}: {err}", temp_path.display()))?;
        io::copy(&mut entry, &mut output)
            .map_err(|err| format!("extract {}: {err}", temp_path.display()))?;
        if target.exists() {
            fs::remove_file(target)
                .map_err(|err| format!("replace {}: {err}", target.display()))?;
        }
        return fs::rename(&temp_path, target)
            .map_err(|err| format!("move {}: {err}", target.display()));
    }

    Err(format!(
        "{entry_path} not found in {}",
        archive_path.display()
    ))
}

fn sanitize_file_component(input: &str) -> String {
    let sanitized = input
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '.' | '-' | '_') {
                character
            } else {
                '_'
            }
        })
        .collect::<String>();
    if sanitized.is_empty() {
        "release".to_string()
    } else {
        sanitized
    }
}

struct BinaryMetadata {
    exists: bool,
    size_bytes: Option<u64>,
    modified_at: Option<u64>,
}

fn binary_metadata(path: &Path) -> BinaryMetadata {
    match fs::metadata(path) {
        Ok(metadata) if metadata.is_file() => BinaryMetadata {
            exists: true,
            size_bytes: Some(metadata.len()),
            modified_at: metadata.modified().ok().and_then(epoch_seconds),
        },
        _ => BinaryMetadata {
            exists: false,
            size_bytes: None,
            modified_at: None,
        },
    }
}

fn same_file(source: &Path, target: &Path) -> bool {
    let Ok(source) = source.canonicalize() else {
        return false;
    };
    let Ok(target) = target.canonicalize() else {
        return false;
    };
    source == target
}

fn copy_binary_atomic(source: &Path, target: &Path) -> Result<(), String> {
    let temp_path = target.with_extension(format!(
        "{}.tmp",
        target
            .extension()
            .and_then(|extension| extension.to_str())
            .unwrap_or("copy")
    ));
    fs::copy(source, &temp_path).map_err(|err| {
        format!(
            "copy {} to {}: {err}",
            source.display(),
            temp_path.display()
        )
    })?;
    if target.exists() {
        fs::remove_file(target).map_err(|err| format!("replace {}: {err}", target.display()))?;
    }
    fs::rename(&temp_path, target).map_err(|err| format!("move {}: {err}", target.display()))
}

#[cfg(unix)]
fn make_executable(path: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;

    let mut permissions = fs::metadata(path)
        .map_err(|err| format!("read permissions {}: {err}", path.display()))?
        .permissions();
    permissions.set_mode(0o755);
    fs::set_permissions(path, permissions)
        .map_err(|err| format!("set executable bit {}: {err}", path.display()))
}

#[cfg(not(unix))]
fn make_executable(_path: &Path) -> Result<(), String> {
    Ok(())
}

fn ensure_json_object(label: &str, input: &str) -> Result<(), String> {
    let value: Value =
        serde_json::from_str(input).map_err(|err| format!("{label} is not valid JSON: {err}"))?;
    if value.is_object() {
        Ok(())
    } else {
        Err(format!("{label} must be a JSON object"))
    }
}

trait AtomicFileReplacer {
    fn replace(&self, candidate: &Path, canonical: &Path) -> Result<(), String>;
}

struct PlatformAtomicFileReplacer;

impl AtomicFileReplacer for PlatformAtomicFileReplacer {
    fn replace(&self, candidate: &Path, canonical: &Path) -> Result<(), String> {
        platform_atomic_replace(candidate, canonical)?;
        secure_file_permissions(canonical)
    }
}

struct SyncedTempFile {
    path: PathBuf,
}

impl SyncedTempFile {
    fn create(canonical: &Path, content: &str) -> Result<Self, String> {
        let parent = atomic_parent(canonical);
        fs::create_dir_all(parent).map_err(|error| {
            format!(
                "create atomic write directory {}: {error}",
                parent.display()
            )
        })?;

        for attempt in 0..100_u32 {
            let path = atomic_candidate_path(canonical, attempt)?;
            let mut options = OpenOptions::new();
            options.write(true).create_new(true);
            #[cfg(unix)]
            options.mode(0o600);
            let mut file = match options.open(&path) {
                Ok(file) => file,
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
                Err(error) => {
                    return Err(format!(
                        "create atomic write candidate {}: {error}",
                        path.display()
                    ))
                }
            };
            let candidate = Self { path };
            if let Err(error) = secure_file_permissions(&candidate.path) {
                drop(file);
                return Err(candidate.cleanup_after_failure(error));
            }
            let write_result = file
                .write_all(content.as_bytes())
                .map_err(|error| {
                    format!(
                        "write atomic candidate {}: {error}",
                        candidate.path.display()
                    )
                })
                .and_then(|()| {
                    file.flush().map_err(|error| {
                        format!(
                            "flush atomic candidate {}: {error}",
                            candidate.path.display()
                        )
                    })
                })
                .and_then(|()| {
                    file.sync_all().map_err(|error| {
                        format!(
                            "sync atomic candidate {}: {error}",
                            candidate.path.display()
                        )
                    })
                });
            drop(file);
            if let Err(error) = write_result {
                return Err(candidate.cleanup_after_failure(error));
            }
            return Ok(candidate);
        }

        Err(format!(
            "create unique atomic write candidate for {}",
            canonical.display()
        ))
    }

    fn cleanup_after_failure(&self, failure: String) -> String {
        match fs::remove_file(&self.path) {
            Ok(()) => failure,
            Err(error) if error.kind() == io::ErrorKind::NotFound => failure,
            Err(error) => format!(
                "{failure}; remove failed atomic candidate {}: {error}",
                self.path.display()
            ),
        }
    }
}

#[cfg(unix)]
fn secure_file_permissions(path: &Path) -> Result<(), String> {
    fs::set_permissions(path, fs::Permissions::from_mode(0o600))
        .map_err(|error| format!("secure file permissions {}: {error}", path.display()))
}

#[cfg(target_os = "windows")]
fn secure_file_permissions(path: &Path) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Foundation::{CloseHandle, LocalFree};
    use windows_sys::Win32::Security::Authorization::{
        ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW,
        SetNamedSecurityInfoW, SDDL_REVISION_1, SE_FILE_OBJECT,
    };
    use windows_sys::Win32::Security::{
        GetSecurityDescriptorDacl, GetTokenInformation, TokenUser, DACL_SECURITY_INFORMATION,
        PROTECTED_DACL_SECURITY_INFORMATION, PSECURITY_DESCRIPTOR, TOKEN_QUERY, TOKEN_USER,
    };
    use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

    unsafe {
        let mut token = std::ptr::null_mut();
        if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) == 0 {
            return Err(format!(
                "open current user token for {}: {}",
                path.display(),
                io::Error::last_os_error()
            ));
        }
        let mut required = 0_u32;
        let _ = GetTokenInformation(token, TokenUser, std::ptr::null_mut(), 0, &mut required);
        if required == 0 {
            let error = io::Error::last_os_error();
            CloseHandle(token);
            return Err(format!(
                "size current user token for {}: {error}",
                path.display()
            ));
        }
        let mut token_info = vec![0_u8; required as usize];
        if GetTokenInformation(
            token,
            TokenUser,
            token_info.as_mut_ptr().cast(),
            required,
            &mut required,
        ) == 0
        {
            let error = io::Error::last_os_error();
            CloseHandle(token);
            return Err(format!(
                "read current user token for {}: {error}",
                path.display()
            ));
        }
        CloseHandle(token);

        let token_user = &*(token_info.as_ptr().cast::<TOKEN_USER>());
        let mut sid_text = std::ptr::null_mut();
        if ConvertSidToStringSidW(token_user.User.Sid, &mut sid_text) == 0 {
            return Err(format!(
                "format current user SID for {}: {}",
                path.display(),
                io::Error::last_os_error()
            ));
        }
        let sid_len = (0..).take_while(|index| *sid_text.add(*index) != 0).count();
        let sid = String::from_utf16_lossy(std::slice::from_raw_parts(sid_text, sid_len));
        LocalFree(sid_text.cast());

        let sddl = format!("D:P(A;;FA;;;{sid})(A;;FA;;;SY)(A;;FA;;;BA)");
        let sddl_wide: Vec<u16> = std::ffi::OsStr::new(&sddl)
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();
        let mut descriptor: PSECURITY_DESCRIPTOR = std::ptr::null_mut();
        if ConvertStringSecurityDescriptorToSecurityDescriptorW(
            sddl_wide.as_ptr(),
            SDDL_REVISION_1,
            &mut descriptor,
            std::ptr::null_mut(),
        ) == 0
        {
            return Err(format!(
                "build user-only ACL for {}: {}",
                path.display(),
                io::Error::last_os_error()
            ));
        }
        let mut dacl_present = 0;
        let mut dacl_defaulted = 0;
        let mut dacl = std::ptr::null_mut();
        if GetSecurityDescriptorDacl(
            descriptor,
            &mut dacl_present,
            &mut dacl,
            &mut dacl_defaulted,
        ) == 0
            || dacl_present == 0
            || dacl.is_null()
        {
            let error = io::Error::last_os_error();
            LocalFree(descriptor.cast());
            return Err(format!(
                "read user-only ACL for {}: {error}",
                path.display()
            ));
        }
        let path_wide: Vec<u16> = path
            .as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();
        let result = SetNamedSecurityInfoW(
            path_wide.as_ptr(),
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            dacl,
            std::ptr::null_mut(),
        );
        LocalFree(descriptor.cast());
        if result != 0 {
            return Err(format!(
                "apply user-only ACL to {}: Windows error {result}",
                path.display()
            ));
        }
    }
    Ok(())
}

#[cfg(not(any(unix, target_os = "windows")))]
fn secure_file_permissions(_path: &Path) -> Result<(), String> {
    Ok(())
}

#[cfg(all(test, target_os = "windows"))]
#[derive(Debug)]
struct WindowsFileDaclAudit {
    protected: bool,
    trustees: Vec<String>,
    access_masks: Vec<u32>,
}

#[cfg(all(test, target_os = "windows"))]
fn windows_file_dacl_audit(path: &Path) -> Result<WindowsFileDaclAudit, String> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Authorization::{
        ConvertSidToStringSidW, GetNamedSecurityInfoW, SE_FILE_OBJECT,
    };
    use windows_sys::Win32::Security::{
        GetAce, GetSecurityDescriptorControl, ACCESS_ALLOWED_ACE, ACL, DACL_SECURITY_INFORMATION,
        PSECURITY_DESCRIPTOR, SE_DACL_PROTECTED,
    };
    const ACCESS_ALLOWED_ACE_TYPE_VALUE: u8 = 0;

    let path_wide: Vec<u16> = path
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let mut descriptor: PSECURITY_DESCRIPTOR = std::ptr::null_mut();
    let mut dacl: *mut ACL = std::ptr::null_mut();
    let result = unsafe {
        GetNamedSecurityInfoW(
            path_wide.as_ptr(),
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            &mut dacl,
            std::ptr::null_mut(),
            &mut descriptor,
        )
    };
    if result != 0 {
        return Err(format!("query secure file ACL: Windows error {result}"));
    }
    if dacl.is_null() {
        unsafe { LocalFree(descriptor.cast()) };
        return Err("query secure file ACL: missing DACL".to_string());
    }
    let mut control = 0_u16;
    let mut revision = 0_u32;
    let ok = unsafe { GetSecurityDescriptorControl(descriptor, &mut control, &mut revision) };
    if ok == 0 {
        unsafe { LocalFree(descriptor.cast()) };
        return Err(format!(
            "query secure file ACL control: {}",
            io::Error::last_os_error()
        ));
    }
    let ace_count = unsafe { (*dacl).AceCount };
    let mut trustees = Vec::with_capacity(ace_count as usize);
    let mut access_masks = Vec::with_capacity(ace_count as usize);
    for index in 0..u32::from(ace_count) {
        let mut ace = std::ptr::null_mut();
        if unsafe { GetAce(dacl, index, &mut ace) } == 0 || ace.is_null() {
            unsafe { LocalFree(descriptor.cast()) };
            return Err(format!(
                "query secure file ACL ACE {index}: {}",
                io::Error::last_os_error()
            ));
        }
        let allowed = unsafe { &*(ace.cast::<ACCESS_ALLOWED_ACE>()) };
        if allowed.Header.AceType != ACCESS_ALLOWED_ACE_TYPE_VALUE {
            unsafe { LocalFree(descriptor.cast()) };
            return Err(format!("secure file ACL ACE {index} is not an allow ACE"));
        }
        let sid = std::ptr::addr_of!(allowed.SidStart).cast_mut().cast();
        let mut sid_text = std::ptr::null_mut();
        if unsafe { ConvertSidToStringSidW(sid, &mut sid_text) } == 0 {
            unsafe { LocalFree(descriptor.cast()) };
            return Err(format!(
                "format secure file ACL ACE {index} SID: {}",
                io::Error::last_os_error()
            ));
        }
        let sid_len = unsafe {
            (0..)
                .take_while(|offset| *sid_text.add(*offset) != 0)
                .count()
        };
        trustees.push(unsafe {
            String::from_utf16_lossy(std::slice::from_raw_parts(sid_text, sid_len))
        });
        unsafe { LocalFree(sid_text.cast()) };
        access_masks.push(allowed.Mask);
    }
    unsafe { LocalFree(descriptor.cast()) };
    Ok(WindowsFileDaclAudit {
        protected: control & SE_DACL_PROTECTED != 0,
        trustees,
        access_masks,
    })
}

impl Drop for SyncedTempFile {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.path);
    }
}

fn atomic_candidate_path(canonical: &Path, attempt: u32) -> Result<PathBuf, String> {
    let parent = atomic_parent(canonical);
    let file_stem = canonical
        .file_stem()
        .and_then(|name| name.to_str())
        .ok_or_else(|| {
            format!(
                "atomic write target has no file name: {}",
                canonical.display()
            )
        })?;
    let extension = canonical
        .extension()
        .and_then(|extension| extension.to_str());
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default();
    let unique_name = format!(
        ".{file_stem}.{}.{}.{}.tmp",
        std::process::id(),
        nanos,
        attempt
    );
    Ok(parent.join(match extension {
        Some(extension) => format!("{unique_name}.{extension}"),
        None => unique_name,
    }))
}

fn atomic_parent(canonical: &Path) -> &Path {
    canonical
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."))
}

fn commit_validated_xray_config_file<V, R>(
    canonical: &Path,
    contents: &str,
    validate: V,
    replacer: &R,
) -> Result<ConfigValidationResult, String>
where
    V: FnOnce(&Path) -> Result<ConfigValidationResult, String>,
    R: AtomicFileReplacer,
{
    let size_bytes = contents.len();
    if size_bytes > CANONICAL_XRAY_CONFIG_LIMIT_BYTES {
        return Err(format!(
            "canonical Xray config is {size_bytes} UTF-8 bytes and exceeds the {}-byte UTF-8 limit; no candidate was written or validated",
            CANONICAL_XRAY_CONFIG_LIMIT_BYTES
        ));
    }
    let candidate = SyncedTempFile::create(canonical, contents)?;
    let validation = match validate(&candidate.path) {
        Ok(validation) => validation,
        Err(error) => return Err(candidate.cleanup_after_failure(error)),
    };
    if !validation.ok {
        let details = validation
            .error
            .as_deref()
            .filter(|value| !value.trim().is_empty())
            .or_else(|| {
                (!validation.details.trim().is_empty()).then_some(validation.details.as_str())
            })
            .unwrap_or("xray run -test rejected the candidate");
        return Err(
            candidate.cleanup_after_failure(format!("Xray config validation failed: {details}"))
        );
    }
    if let Err(error) = replacer.replace(&candidate.path, canonical) {
        return Err(candidate.cleanup_after_failure(error));
    }
    Ok(validation)
}

fn write_atomic(path: &Path, content: &str) -> Result<(), String> {
    write_atomic_with(path, content, &PlatformAtomicFileReplacer)
}

fn write_atomic_with<R: AtomicFileReplacer>(
    path: &Path,
    content: &str,
    replacer: &R,
) -> Result<(), String> {
    let candidate = SyncedTempFile::create(path, content)?;
    replacer
        .replace(&candidate.path, path)
        .map_err(|error| candidate.cleanup_after_failure(error))
}

#[cfg(unix)]
fn platform_atomic_replace(candidate: &Path, canonical: &Path) -> Result<(), String> {
    fs::rename(candidate, canonical).map_err(|error| {
        format!(
            "atomically replace {} with {}: {error}",
            canonical.display(),
            candidate.display()
        )
    })?;
    let parent = atomic_parent(canonical);
    fs::File::open(parent)
        .and_then(|directory| directory.sync_all())
        .map_err(|error| format!("sync atomic write directory {}: {error}", parent.display()))
}

#[cfg(target_os = "windows")]
fn platform_atomic_replace(candidate: &Path, canonical: &Path) -> Result<(), String> {
    windows_atomic_replace_with(&WindowsAtomicReplaceApi, candidate, canonical)
}

#[cfg(not(any(unix, target_os = "windows")))]
fn platform_atomic_replace(candidate: &Path, canonical: &Path) -> Result<(), String> {
    fs::rename(candidate, canonical).map_err(|error| {
        format!(
            "atomically replace {} with {}: {error}",
            canonical.display(),
            candidate.display()
        )
    })
}

#[cfg(any(target_os = "windows", test))]
trait WindowsReplaceApi {
    fn replace_existing(&self, candidate: &Path, canonical: &Path) -> io::Result<()>;
    fn move_replacing(&self, candidate: &Path, canonical: &Path) -> io::Result<()>;
}

#[cfg(any(target_os = "windows", test))]
fn windows_atomic_replace_with<A: WindowsReplaceApi>(
    api: &A,
    candidate: &Path,
    canonical: &Path,
) -> Result<(), String> {
    match api.replace_existing(candidate, canonical) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => api
            .move_replacing(candidate, canonical)
            .map_err(|move_error| {
                format!(
                    "atomically install {} as {}: {move_error}",
                    candidate.display(),
                    canonical.display()
                )
            }),
        Err(error) => Err(format!(
            "atomically replace {} with {}: {error}",
            canonical.display(),
            candidate.display()
        )),
    }
}

#[cfg(target_os = "windows")]
struct WindowsAtomicReplaceApi;

#[cfg(target_os = "windows")]
impl WindowsReplaceApi for WindowsAtomicReplaceApi {
    fn replace_existing(&self, candidate: &Path, canonical: &Path) -> io::Result<()> {
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::Storage::FileSystem::{ReplaceFileW, REPLACEFILE_WRITE_THROUGH};

        let candidate: Vec<u16> = candidate.as_os_str().encode_wide().chain(Some(0)).collect();
        let canonical: Vec<u16> = canonical.as_os_str().encode_wide().chain(Some(0)).collect();
        let replaced = unsafe {
            ReplaceFileW(
                canonical.as_ptr(),
                candidate.as_ptr(),
                std::ptr::null(),
                REPLACEFILE_WRITE_THROUGH,
                std::ptr::null(),
                std::ptr::null(),
            )
        };
        if replaced == 0 {
            Err(io::Error::last_os_error())
        } else {
            Ok(())
        }
    }

    fn move_replacing(&self, candidate: &Path, canonical: &Path) -> io::Result<()> {
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::Storage::FileSystem::{
            MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
        };

        let candidate: Vec<u16> = candidate.as_os_str().encode_wide().chain(Some(0)).collect();
        let canonical: Vec<u16> = canonical.as_os_str().encode_wide().chain(Some(0)).collect();
        let moved = unsafe {
            MoveFileExW(
                candidate.as_ptr(),
                canonical.as_ptr(),
                MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
            )
        };
        if moved == 0 {
            Err(io::Error::last_os_error())
        } else {
            Ok(())
        }
    }
}

fn path_string(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

#[cfg(target_os = "windows")]
fn hide_command_window(command: &mut Command) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x08000000;
    command.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(target_os = "windows"))]
fn hide_command_window(_command: &mut Command) {}

impl RuntimeProcesses {
    fn status(&mut self) -> RuntimeStatus {
        RuntimeStatus {
            tachyon_core: self.tachyon_core.status(),
            xray: self.xray.status(),
        }
    }

    fn logs(&self, kind: &str) -> Result<ProcessLogs, String> {
        let (kind, process) = match kind.trim().to_ascii_lowercase().as_str() {
            "xray" | "xray-core" => ("xray", &self.xray),
            "core" | "tachyoncore" | "tachyon-core" => ("tachyonCore", &self.tachyon_core),
            other => return Err(format!("unknown runtime process kind: {other}")),
        };
        let stdout_tail = log_tail_snapshot(&process.stdout_tail);
        let stderr_tail = log_tail_snapshot(&process.stderr_tail);
        let (stdout_tail, stderr_tail, capacity_bytes_per_stream) = (
            sanitize_xray_diagnostic(&stdout_tail).text,
            sanitize_xray_diagnostic(&stderr_tail).text,
            XRAY_DIAGNOSTIC_LIMIT_BYTES,
        );
        Ok(ProcessLogs {
            kind: kind.to_string(),
            stdout_tail,
            stderr_tail,
            capacity_bytes_per_stream,
        })
    }
}

#[cfg(test)]
impl RuntimeStopControl for RuntimeProcesses {
    fn stop_tachyon_core_checked(&mut self) -> Result<(), String> {
        self.tachyon_core.stop("tachyon-core").map(|_| ())
    }

    fn stop_xray_checked(&mut self) -> Result<(), String> {
        self.xray.stop("xray").map(|_| ())
    }
}

#[cfg(test)]
trait StartAllTransaction {
    fn start_xray(&mut self) -> Result<(), String>;
    fn wait_xray_ready(&mut self) -> Result<(), String>;
    fn start_tachyon_core(&mut self) -> Result<(), String>;
    fn wait_tachyon_core_ready(&mut self) -> Result<(), String>;
    fn rollback(&mut self) -> Vec<String>;
}

#[cfg(test)]
fn execute_start_all(transaction: &mut impl StartAllTransaction) -> Result<(), String> {
    if let Err(error) = transaction.start_xray() {
        return Err(start_all_rollback_error(error, transaction.rollback()));
    }
    if let Err(error) = transaction.wait_xray_ready() {
        return Err(start_all_rollback_error(error, transaction.rollback()));
    }
    if let Err(error) = transaction.start_tachyon_core() {
        return Err(start_all_rollback_error(error, transaction.rollback()));
    }
    if let Err(error) = transaction.wait_tachyon_core_ready() {
        return Err(start_all_rollback_error(error, transaction.rollback()));
    }
    Ok(())
}

fn wait_for_readiness(
    label: &str,
    timeout: Duration,
    interval: Duration,
    mut probe: impl FnMut(Duration) -> Result<(), String>,
) -> Result<(), String> {
    let started = Instant::now();
    loop {
        let remaining = timeout.saturating_sub(started.elapsed());
        let last_error = match probe(remaining) {
            Ok(()) => return Ok(()),
            Err(error) => error,
        };
        let elapsed = started.elapsed();
        if elapsed >= timeout {
            return Err(format!(
                "{label} readiness timed out after {}ms: {last_error}",
                timeout.as_millis()
            ));
        }
        thread::sleep(interval.min(timeout - elapsed));
    }
}

fn authorize_xray_config(
    config: &[u8],
    mode: XrayConfigTrustMode,
    advanced_confirmed: bool,
    settings: &RuntimeSettings,
) -> Result<XrayConfigAuthorization, String> {
    if mode == XrayConfigTrustMode::Advanced && !advanced_confirmed {
        return Err("advanced Xray config requires explicit local confirmation".to_string());
    }
    let value: Value = serde_json::from_slice(config)
        .map_err(|_| "Xray config authorization requires a JSON object".to_string())?;
    validate_xray_config_value(&value, mode, settings)?;
    use sha2::{Digest, Sha256};
    Ok(XrayConfigAuthorization {
        digest: Sha256::digest(config).into(),
        mode,
    })
}

fn validate_xray_apply_plan(
    plan: &xray_generation::ApplyPlan,
    mode: XrayConfigTrustMode,
    settings: &RuntimeSettings,
) -> Result<(), String> {
    let value: Value = serde_json::from_slice(plan.config())
        .map_err(|_| "Xray apply plan is not a JSON object".to_string())?;
    validate_xray_config_value(&value, mode, settings)
}

fn validate_xray_config_value(
    config: &Value,
    mode: XrayConfigTrustMode,
    settings: &RuntimeSettings,
) -> Result<(), String> {
    let object = config
        .as_object()
        .ok_or_else(|| "Xray config must be a JSON object".to_string())?;
    if mode == XrayConfigTrustMode::Advanced {
        return Ok(());
    }
    validate_prism_managed_xray_config(object, settings)
}

fn validate_prism_managed_xray_config(
    config: &serde_json::Map<String, Value>,
    settings: &RuntimeSettings,
) -> Result<(), String> {
    use std::collections::HashSet;

    const BASE_FIELDS: &[&str] = &["inbounds", "log", "outbounds", "routing"];
    const STATS_FIELDS: &[&str] = &["api", "policy", "stats"];
    if config.keys().any(|key| {
        !BASE_FIELDS.contains(&key.as_str())
            && !(settings.xray_stats_enabled && STATS_FIELDS.contains(&key.as_str()))
    }) {
        return Err("managed Xray plan contains an untrusted top-level field".to_string());
    }

    let log = config
        .get("log")
        .and_then(Value::as_object)
        .ok_or_else(|| "managed Xray plan requires Prism log settings".to_string())?;
    if log.keys().any(|key| key != "loglevel") || !log.get("loglevel").is_some_and(Value::is_string)
    {
        return Err("managed Xray plan contains unsafe log settings".to_string());
    }

    let inbounds = config
        .get("inbounds")
        .and_then(Value::as_array)
        .ok_or_else(|| "managed Xray plan requires an inbound array".to_string())?;
    let expected_inbound_count = if settings.xray_stats_enabled { 3 } else { 2 };
    if inbounds.len() != expected_inbound_count {
        return Err("managed Xray plan contains an unexpected inbound".to_string());
    }
    let mut inbound_tags = HashSet::new();
    let mut socks_count = 0_usize;
    let mut http_count = 0_usize;
    let mut api_count = 0_usize;
    for inbound in inbounds {
        let inbound = inbound
            .as_object()
            .ok_or_else(|| "managed Xray plan contains an invalid inbound".to_string())?;
        let tag = inbound
            .get("tag")
            .and_then(Value::as_str)
            .filter(|tag| !tag.is_empty())
            .ok_or_else(|| "managed Xray plan inbound is missing its tag".to_string())?;
        if !inbound_tags.insert(tag.to_string()) {
            return Err("managed Xray plan contains a duplicate inbound tag".to_string());
        }
        let protocol = inbound
            .get("protocol")
            .and_then(Value::as_str)
            .ok_or_else(|| "managed Xray plan inbound is missing its protocol".to_string())?;
        let listen = inbound
            .get("listen")
            .and_then(Value::as_str)
            .ok_or_else(|| "managed Xray plan inbound is missing its listen address".to_string())?;
        let listen_ip = parse_managed_listener_ip(listen)?;
        let port = inbound
            .get("port")
            .and_then(Value::as_u64)
            .and_then(|port| u16::try_from(port).ok())
            .filter(|port| *port != 0)
            .ok_or_else(|| "managed Xray plan inbound has an invalid port".to_string())?;
        match protocol {
            "socks"
                if listen_ip == parse_managed_listener_ip(&settings.xray_socks_listen)?
                    && port == settings.xray_socks_port =>
            {
                socks_count += 1;
            }
            "http"
                if listen_ip == parse_managed_listener_ip(&settings.xray_http_listen)?
                    && port == settings.xray_http_port =>
            {
                http_count += 1;
            }
            "tunnel"
                if settings.xray_stats_enabled
                    && listen_ip == parse_managed_listener_ip(&settings.xray_stats_listen)?
                    && port == settings.xray_stats_port =>
            {
                let rewrite = inbound
                    .get("settings")
                    .and_then(Value::as_object)
                    .and_then(|settings| settings.get("rewriteAddress"))
                    .and_then(Value::as_str)
                    .ok_or_else(|| {
                        "managed Xray API inbound is missing its rewrite address".to_string()
                    })?;
                parse_managed_listener_ip(rewrite)?;
                api_count += 1;
            }
            _ => return Err("managed Xray plan contains an unexpected inbound".to_string()),
        }
    }
    if socks_count != 1 || http_count != 1 || api_count != usize::from(settings.xray_stats_enabled)
    {
        return Err("managed Xray listeners do not match Prism settings".to_string());
    }

    let outbounds = config
        .get("outbounds")
        .and_then(Value::as_array)
        .filter(|outbounds| !outbounds.is_empty())
        .ok_or_else(|| "managed Xray plan requires an outbound array".to_string())?;
    let supported_protocols = [
        "blackhole",
        "dns",
        "freedom",
        "http",
        "loopback",
        "shadowsocks",
        "socks",
        "trojan",
        "vless",
        "vmess",
        "hysteria",
        "wireguard",
    ];
    let mut outbound_tags = HashSet::new();
    let mut has_direct = false;
    let mut has_block = false;
    for outbound in outbounds {
        let outbound = outbound
            .as_object()
            .ok_or_else(|| "managed Xray plan contains an invalid outbound".to_string())?;
        let protocol = outbound
            .get("protocol")
            .and_then(Value::as_str)
            .filter(|protocol| supported_protocols.contains(protocol))
            .ok_or_else(|| "managed Xray plan contains an unsupported outbound".to_string())?;
        has_direct |= protocol == "freedom";
        has_block |= protocol == "blackhole";
        let tag = outbound
            .get("tag")
            .and_then(Value::as_str)
            .filter(|tag| !tag.is_empty())
            .ok_or_else(|| "managed Xray plan outbound is missing its tag".to_string())?;
        if !outbound_tags.insert(tag.to_string()) {
            return Err("managed Xray plan contains a duplicate outbound tag".to_string());
        }
    }
    if !has_direct || !has_block {
        return Err("managed Xray plan is missing Prism safety outbounds".to_string());
    }
    for outbound in outbounds {
        let outbound = outbound.as_object().expect("validated outbound object");
        let proxy_tag = outbound
            .get("proxySettings")
            .and_then(Value::as_object)
            .and_then(|settings| settings.get("tag"))
            .and_then(Value::as_str);
        let dialer_tag = outbound
            .get("streamSettings")
            .and_then(Value::as_object)
            .and_then(|settings| settings.get("sockopt"))
            .and_then(Value::as_object)
            .and_then(|sockopt| sockopt.get("dialerProxy"))
            .and_then(Value::as_str);
        if [proxy_tag, dialer_tag]
            .into_iter()
            .flatten()
            .any(|tag| !outbound_tags.contains(tag))
        {
            return Err("managed Xray outbound references an unknown tag".to_string());
        }
    }

    let mut routing_targets = outbound_tags.clone();
    validate_prism_managed_stats(config, settings, &mut routing_targets)?;
    validate_prism_managed_routing(config, &inbound_tags, &routing_targets)
}

fn validate_prism_managed_stats(
    config: &serde_json::Map<String, Value>,
    settings: &RuntimeSettings,
    routing_targets: &mut std::collections::HashSet<String>,
) -> Result<(), String> {
    if !settings.xray_stats_enabled {
        if ["api", "policy", "stats"]
            .into_iter()
            .any(|field| config.contains_key(field))
        {
            return Err("managed Xray plan contains an unexpected API control".to_string());
        }
        return Ok(());
    }
    let api = config
        .get("api")
        .and_then(Value::as_object)
        .ok_or_else(|| "managed Xray plan is missing the Prism API control".to_string())?;
    if api.keys().any(|key| key != "tag" && key != "services") {
        return Err("managed Xray plan contains an unexpected API control".to_string());
    }
    let api_tag = api
        .get("tag")
        .and_then(Value::as_str)
        .filter(|tag| !tag.is_empty())
        .ok_or_else(|| "managed Xray API control is missing its tag".to_string())?;
    let services = api
        .get("services")
        .and_then(Value::as_array)
        .ok_or_else(|| "managed Xray API control has invalid services".to_string())?;
    if services.len() != 1 || services[0].as_str() != Some("StatsService") {
        return Err("managed Xray API control has unexpected services".to_string());
    }
    routing_targets.insert(api_tag.to_string());

    let policy = config
        .get("policy")
        .and_then(Value::as_object)
        .ok_or_else(|| "managed Xray plan is missing the Prism stats policy".to_string())?;
    if policy.len() != 1 || !policy.contains_key("system") {
        return Err("managed Xray plan contains an unexpected stats policy".to_string());
    }
    let system = policy
        .get("system")
        .and_then(Value::as_object)
        .ok_or_else(|| "managed Xray plan has an invalid stats policy".to_string())?;
    let expected = [
        "statsInboundDownlink",
        "statsInboundUplink",
        "statsOutboundDownlink",
        "statsOutboundUplink",
    ];
    if system.len() != expected.len()
        || expected
            .into_iter()
            .any(|key| system.get(key).and_then(Value::as_bool) != Some(true))
    {
        return Err("managed Xray plan contains an unexpected stats policy".to_string());
    }
    if !config
        .get("stats")
        .and_then(Value::as_object)
        .is_some_and(serde_json::Map::is_empty)
    {
        return Err("managed Xray plan contains unexpected stats settings".to_string());
    }
    Ok(())
}

fn validate_prism_managed_routing(
    config: &serde_json::Map<String, Value>,
    inbound_tags: &std::collections::HashSet<String>,
    outbound_tags: &std::collections::HashSet<String>,
) -> Result<(), String> {
    let routing = config
        .get("routing")
        .and_then(Value::as_object)
        .ok_or_else(|| "managed Xray plan requires Prism routing".to_string())?;
    if routing
        .keys()
        .any(|key| !["domainStrategy", "rules"].contains(&key.as_str()))
    {
        return Err("managed Xray plan contains untrusted routing controls".to_string());
    }
    let rules = routing
        .get("rules")
        .and_then(Value::as_array)
        .filter(|rules| !rules.is_empty())
        .ok_or_else(|| "managed Xray plan requires routing rules".to_string())?;
    for rule in rules {
        let rule = rule
            .as_object()
            .ok_or_else(|| "managed Xray plan contains an invalid routing rule".to_string())?;
        if rule.keys().any(|key| {
            ![
                "type",
                "inboundTag",
                "outboundTag",
                "ip",
                "domain",
                "protocol",
            ]
            .contains(&key.as_str())
        }) || rule.get("type").and_then(Value::as_str) != Some("field")
        {
            return Err("managed Xray plan contains untrusted routing controls".to_string());
        }
        let outbound = rule
            .get("outboundTag")
            .and_then(Value::as_str)
            .ok_or_else(|| "managed Xray routing rule is missing its target".to_string())?;
        if !outbound_tags.contains(outbound) {
            return Err("managed Xray routing references an unknown target".to_string());
        }
        if let Some(tags) = rule.get("inboundTag") {
            let tags = tags
                .as_array()
                .ok_or_else(|| "managed Xray routing has invalid inbound tags".to_string())?;
            if tags
                .iter()
                .any(|tag| tag.as_str().is_none_or(|tag| !inbound_tags.contains(tag)))
            {
                return Err("managed Xray routing references an unknown inbound".to_string());
            }
        }
        for field in ["ip", "domain", "protocol"] {
            if let Some(values) = rule.get(field) {
                if !values
                    .as_array()
                    .is_some_and(|values| values.iter().all(Value::is_string))
                {
                    return Err("managed Xray routing contains an invalid matcher".to_string());
                }
            }
        }
    }
    Ok(())
}

fn xray_managed_listener_addresses(
    config: &Value,
    settings: &RuntimeSettings,
) -> Result<Vec<String>, String> {
    let inbounds = config
        .get("inbounds")
        .and_then(Value::as_array)
        .ok_or_else(|| "Xray managed config requires an inbounds array".to_string())?;
    Ok(vec![
        exact_xray_listener(
            inbounds,
            "socks",
            &settings.xray_socks_listen,
            settings.xray_socks_port,
        )?,
        exact_xray_listener(
            inbounds,
            "http",
            &settings.xray_http_listen,
            settings.xray_http_port,
        )?,
    ])
}

fn exact_xray_listener(
    inbounds: &[Value],
    protocol: &str,
    expected_host: &str,
    expected_port: u16,
) -> Result<String, String> {
    let expected_ip = parse_managed_listener_ip(expected_host)?;
    let matching = inbounds
        .iter()
        .filter(|inbound| inbound.get("protocol").and_then(Value::as_str) == Some(protocol))
        .filter(|inbound| {
            let actual_ip = inbound
                .get("listen")
                .and_then(Value::as_str)
                .and_then(|host| parse_managed_listener_ip(host).ok());
            let actual_port = inbound
                .get("port")
                .and_then(Value::as_u64)
                .and_then(|port| u16::try_from(port).ok());
            actual_ip == Some(expected_ip) && actual_port == Some(expected_port)
        })
        .collect::<Vec<_>>();
    if matching.len() != 1 {
        return Err(format!(
            "Xray {protocol} inbound does not uniquely match the managed listener settings"
        ));
    }
    Ok(SocketAddr::new(expected_ip, expected_port).to_string())
}

fn parse_managed_listener_ip(value: &str) -> Result<IpAddr, String> {
    let ip = value
        .trim()
        .trim_start_matches('[')
        .trim_end_matches(']')
        .parse::<IpAddr>()
        .map_err(|_| "managed Xray listeners must use numeric IP addresses".to_string())?;
    if !ip.is_loopback() {
        return Err("managed Xray listeners must use numeric loopback IP addresses".to_string());
    }
    Ok(ip)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct OwnedTcpListener {
    address: SocketAddr,
    pid: u32,
}

fn verify_owned_managed_listeners(
    pid: u32,
    listeners: &[String],
    timeout: Duration,
) -> Result<(), String> {
    if listeners.is_empty() {
        return Err("generation has no managed listeners".to_string());
    }
    let expected = listeners
        .iter()
        .map(|listener| {
            listener
                .parse::<SocketAddr>()
                .map_err(|_| "generation contains an invalid managed listener".to_string())
        })
        .collect::<Result<Vec<_>, _>>()?;
    let started = Instant::now();
    loop {
        let table = owned_tcp_listener_table(pid)?;
        if listeners_owned_by_pid(&table, &expected, pid) {
            return Ok(());
        }
        if started.elapsed() >= timeout {
            return Err(
                "managed listener ownership was not confirmed for candidate PID".to_string(),
            );
        }
        thread::sleep(STARTUP_READINESS_INTERVAL.min(timeout.saturating_sub(started.elapsed())));
    }
}

fn listeners_owned_by_pid(table: &[OwnedTcpListener], expected: &[SocketAddr], pid: u32) -> bool {
    !expected.is_empty()
        && expected.iter().all(|address| {
            table
                .iter()
                .any(|listener| listener.address == *address && listener.pid == pid)
        })
}

fn validate_tcp_table_layout(
    capacity: usize,
    reported: usize,
    count: usize,
    row_size: usize,
) -> Result<usize, String> {
    let header = std::mem::size_of::<u32>();
    if row_size == 0 || reported < header || reported > capacity {
        return Err("TCP listener table reported an invalid buffer length".to_string());
    }
    let rows = count
        .checked_mul(row_size)
        .ok_or_else(|| "TCP listener table row count overflowed".to_string())?;
    let required = header
        .checked_add(rows)
        .ok_or_else(|| "TCP listener table size overflowed".to_string())?;
    if required > reported {
        return Err("TCP listener table row count exceeds returned buffer".to_string());
    }
    Ok(required)
}

#[cfg(target_os = "windows")]
fn owned_tcp_listener_table(_pid: u32) -> Result<Vec<OwnedTcpListener>, String> {
    use windows_sys::Win32::NetworkManagement::IpHelper::{
        GetExtendedTcpTable, MIB_TCP6ROW_OWNER_PID, MIB_TCPROW_OWNER_PID,
        TCP_TABLE_OWNER_PID_LISTENER,
    };
    use windows_sys::Win32::Networking::WinSock::{AF_INET, AF_INET6};

    unsafe fn read_table(family: u32) -> Result<Vec<u8>, String> {
        let mut size = 0_u32;
        let first = unsafe {
            GetExtendedTcpTable(
                std::ptr::null_mut(),
                &mut size,
                0,
                family,
                TCP_TABLE_OWNER_PID_LISTENER,
                0,
            )
        };
        const MAX_TABLE_BYTES: u32 = 64 * 1024 * 1024;
        if first != 122 || size < std::mem::size_of::<u32>() as u32 || size > MAX_TABLE_BYTES {
            return Err("query TCP listener table size failed".to_string());
        }
        let mut bytes = vec![0_u8; size as usize];
        let capacity = bytes.len();
        let result = unsafe {
            GetExtendedTcpTable(
                bytes.as_mut_ptr().cast(),
                &mut size,
                0,
                family,
                TCP_TABLE_OWNER_PID_LISTENER,
                0,
            )
        };
        if result == 0 {
            let returned = usize::try_from(size)
                .map_err(|_| "TCP listener table returned length overflowed".to_string())?;
            if returned > capacity {
                return Err("TCP listener table returned beyond allocated buffer".to_string());
            }
            let count = unsafe { bytes.as_ptr().cast::<u32>().read_unaligned() as usize };
            let row_size = if family == AF_INET as u32 {
                std::mem::size_of::<MIB_TCPROW_OWNER_PID>()
            } else {
                std::mem::size_of::<MIB_TCP6ROW_OWNER_PID>()
            };
            let required = validate_tcp_table_layout(capacity, returned, count, row_size)?;
            bytes.truncate(returned);
            if required > bytes.len() {
                return Err("TCP listener table validation failed".to_string());
            }
            Ok(bytes)
        } else {
            Err("read TCP listener table failed".to_string())
        }
    }

    let mut listeners = Vec::new();
    let ipv4 = unsafe { read_table(AF_INET as u32)? };
    let count = unsafe { ipv4.as_ptr().cast::<u32>().read_unaligned() as usize };
    let rows = unsafe {
        ipv4.as_ptr()
            .add(std::mem::size_of::<u32>())
            .cast::<MIB_TCPROW_OWNER_PID>()
    };
    for index in 0..count {
        let row = unsafe { rows.add(index).read_unaligned() };
        let address = IpAddr::V4(Ipv4Addr::from(row.dwLocalAddr.to_ne_bytes()));
        let port = u16::from_be((row.dwLocalPort & 0xffff) as u16);
        listeners.push(OwnedTcpListener {
            address: SocketAddr::new(address, port),
            pid: row.dwOwningPid,
        });
    }

    let ipv6 = unsafe { read_table(AF_INET6 as u32)? };
    let count = unsafe { ipv6.as_ptr().cast::<u32>().read_unaligned() as usize };
    let rows = unsafe {
        ipv6.as_ptr()
            .add(std::mem::size_of::<u32>())
            .cast::<MIB_TCP6ROW_OWNER_PID>()
    };
    for index in 0..count {
        let row = unsafe { rows.add(index).read_unaligned() };
        let address = IpAddr::V6(Ipv6Addr::from(row.ucLocalAddr));
        let port = u16::from_be((row.dwLocalPort & 0xffff) as u16);
        listeners.push(OwnedTcpListener {
            address: SocketAddr::new(address, port),
            pid: row.dwOwningPid,
        });
    }
    Ok(listeners)
}

#[cfg(target_os = "linux")]
fn owned_tcp_listener_table(pid: u32) -> Result<Vec<OwnedTcpListener>, String> {
    use std::collections::HashSet;

    let fd_dir = PathBuf::from(format!("/proc/{pid}/fd"));
    let mut owned_inodes = HashSet::new();
    for entry in fs::read_dir(fd_dir).map_err(|_| "read candidate socket descriptors failed")? {
        let entry = entry.map_err(|_| "read candidate socket descriptor failed")?;
        let target = fs::read_link(entry.path())
            .map_err(|_| "read candidate socket descriptor target failed")?;
        let target = target.to_string_lossy();
        if let Some(inode) = target
            .strip_prefix("socket:[")
            .and_then(|value| value.strip_suffix(']'))
            .and_then(|value| value.parse::<u64>().ok())
        {
            owned_inodes.insert(inode);
        }
    }
    let mut listeners = parse_linux_tcp_listeners("/proc/net/tcp", false, pid, &owned_inodes)?;
    listeners.extend(parse_linux_tcp_listeners(
        "/proc/net/tcp6",
        true,
        pid,
        &owned_inodes,
    )?);
    Ok(listeners)
}

#[cfg(target_os = "linux")]
fn parse_linux_tcp_listeners(
    path: &str,
    ipv6: bool,
    pid: u32,
    owned_inodes: &std::collections::HashSet<u64>,
) -> Result<Vec<OwnedTcpListener>, String> {
    let raw = fs::read_to_string(path).map_err(|_| "read Linux TCP listener table failed")?;
    let mut listeners = Vec::new();
    for line in raw.lines().skip(1) {
        let fields = line.split_whitespace().collect::<Vec<_>>();
        if fields.len() < 10 || fields[3] != "0A" {
            continue;
        }
        let inode = fields[9]
            .parse::<u64>()
            .map_err(|_| "parse Linux TCP listener inode failed")?;
        if !owned_inodes.contains(&inode) {
            continue;
        }
        let (encoded_ip, encoded_port) = fields[1]
            .split_once(':')
            .ok_or_else(|| "parse Linux TCP listener endpoint failed".to_string())?;
        let port = u16::from_str_radix(encoded_port, 16)
            .map_err(|_| "parse Linux TCP listener port failed")?;
        let address = if ipv6 {
            let mut bytes = [0_u8; 16];
            if encoded_ip.len() != 32 {
                return Err("parse Linux IPv6 listener failed".to_string());
            }
            for (index, chunk) in encoded_ip.as_bytes().chunks_exact(8).enumerate() {
                let chunk =
                    std::str::from_utf8(chunk).map_err(|_| "parse Linux IPv6 listener failed")?;
                bytes[index * 4..index * 4 + 4].copy_from_slice(
                    &u32::from_str_radix(chunk, 16)
                        .map_err(|_| "parse Linux IPv6 listener failed")?
                        .to_le_bytes(),
                );
            }
            IpAddr::V6(Ipv6Addr::from(bytes))
        } else {
            let encoded = u32::from_str_radix(encoded_ip, 16)
                .map_err(|_| "parse Linux IPv4 listener failed")?;
            IpAddr::V4(Ipv4Addr::from(encoded.to_le_bytes()))
        };
        listeners.push(OwnedTcpListener {
            address: SocketAddr::new(address, port),
            pid,
        });
    }
    Ok(listeners)
}

#[cfg(target_os = "macos")]
fn owned_tcp_listener_table(pid: u32) -> Result<Vec<OwnedTcpListener>, String> {
    use libproc::libproc::bsd_info::BSDInfo;
    use libproc::libproc::file_info::{pidfdinfo, ListFDs, ProcFDType};
    use libproc::libproc::net_info::{SocketFDInfo, SocketInfoKind, TcpSIState};
    use libproc::libproc::proc_pid::{listpidinfo, pidinfo};

    const MAX_PROCESS_FDS: usize = 65_536;
    let process = pidinfo::<BSDInfo>(pid as i32, 0)
        .map_err(|_| "macOS libproc process ownership query failed".to_string())?;
    let fd_count = usize::try_from(process.pbi_nfiles)
        .map_err(|_| "macOS libproc file descriptor count overflowed".to_string())?;
    if fd_count > MAX_PROCESS_FDS {
        return Err("macOS libproc file descriptor count is unreasonable".to_string());
    }
    let fds = listpidinfo::<ListFDs>(pid as i32, fd_count)
        .map_err(|_| "macOS libproc file descriptor query failed".to_string())?;
    let mut listeners = Vec::new();
    for fd in fds {
        if !matches!(ProcFDType::from(fd.proc_fdtype), ProcFDType::Socket) {
            continue;
        }
        let socket = match pidfdinfo::<SocketFDInfo>(pid as i32, fd.proc_fd) {
            Ok(socket) => socket,
            Err(_) => continue,
        };
        if !matches!(
            SocketInfoKind::from(socket.psi.soi_kind),
            SocketInfoKind::Tcp
        ) {
            continue;
        }
        let tcp = unsafe { socket.psi.soi_proto.pri_tcp };
        if !matches!(TcpSIState::from(tcp.tcpsi_state), TcpSIState::Listen) {
            continue;
        }
        if let Some(address) = macos_tcp_listener_address(&tcp, socket.psi.soi_family) {
            listeners.push(OwnedTcpListener { address, pid });
        }
    }
    Ok(listeners)
}

#[cfg(target_os = "macos")]
fn macos_tcp_listener_address(
    tcp: &libproc::libproc::net_info::TcpSockInfo,
    family: i32,
) -> Option<SocketAddr> {
    let port = macos_tcp_listener_port(tcp.tcpsi_ini.insi_lport)?;
    if port == 0 {
        return None;
    }
    let ipv4 = unsafe {
        tcp.tcpsi_ini
            .insi_laddr
            .ina_46
            .i46a_addr4
            .s_addr
            .to_ne_bytes()
    };
    let ipv6 = unsafe { tcp.tcpsi_ini.insi_laddr.ina_6.s6_addr };
    macos_tcp_listener_ip(family, tcp.tcpsi_ini.insi_vflag, ipv4, ipv6)
        .map(|address| SocketAddr::new(address, port))
}

#[cfg(any(target_os = "macos", test))]
const MACOS_AF_INET: i32 = 2;
#[cfg(any(target_os = "macos", test))]
const MACOS_AF_INET6: i32 = 30;
#[cfg(any(target_os = "macos", test))]
const MACOS_INI_IPV4: u8 = 0x1;
#[cfg(any(target_os = "macos", test))]
const MACOS_INI_IPV6: u8 = 0x2;

#[cfg(any(target_os = "macos", test))]
fn macos_tcp_listener_ip(family: i32, vflag: u8, ipv4: [u8; 4], ipv6: [u8; 16]) -> Option<IpAddr> {
    match family {
        MACOS_AF_INET if vflag & MACOS_INI_IPV4 != 0 && vflag & MACOS_INI_IPV6 == 0 => {
            Some(IpAddr::V4(Ipv4Addr::from(ipv4)))
        }
        MACOS_AF_INET6 if vflag & MACOS_INI_IPV6 != 0 && vflag & MACOS_INI_IPV4 == 0 => {
            Some(IpAddr::V6(Ipv6Addr::from(ipv6)))
        }
        _ => None,
    }
}

#[allow(dead_code)]
fn macos_tcp_listener_port(network_order: i32) -> Option<u16> {
    u16::try_from(network_order).ok().map(u16::from_be)
}

#[cfg(not(any(target_os = "windows", target_os = "linux", target_os = "macos")))]
fn owned_tcp_listener_table(_pid: u32) -> Result<Vec<OwnedTcpListener>, String> {
    Err("auditable TCP listener ownership is unsupported on this platform".to_string())
}

fn xray_stats_server(settings: &RuntimeSettings) -> Result<String, String> {
    Ok(local_loopback_socket_addr(
        &settings.xray_stats_listen,
        settings.xray_stats_port,
        "Xray stats",
    )?
    .to_string())
}

fn local_loopback_socket_addr(host: &str, port: u16, kind: &str) -> Result<SocketAddr, String> {
    let host = host.trim().trim_start_matches('[').trim_end_matches(']');
    let address = host
        .parse::<IpAddr>()
        .map_err(|_| format!("{kind} must use a numeric loopback address"))?;
    if !address.is_loopback() {
        return Err(format!("{kind} must use a numeric loopback address"));
    }
    Ok(SocketAddr::new(address, port))
}

fn start_all_rollback_error(start_error: String, rollback_errors: Vec<String>) -> String {
    if rollback_errors.is_empty() {
        format!("start_all failed: {start_error}; started cores were rolled back")
    } else {
        format!(
            "start_all failed: {start_error}; rollback failed: {}",
            rollback_errors.join("; ")
        )
    }
}

impl ManagedProcess {
    fn confirm_running(&mut self, label: &str) -> Result<(), String> {
        self.refresh(label)?;
        if self.child.is_some() {
            Ok(())
        } else {
            Err(self
                .last_error
                .clone()
                .unwrap_or_else(|| format!("{label} did not remain running")))
        }
    }

    fn start(
        &mut self,
        label: &str,
        kind: ManagedBinaryKind,
        binary_path: String,
        config_path: String,
        args: &[&str],
    ) -> Result<ProcessStatus, String> {
        let binary = PathBuf::from(clean_path_input(&binary_path));
        if !binary.is_file() {
            return Err(format!("{label} binary not found: {}", binary.display()));
        }
        let config = PathBuf::from(clean_path_input(&config_path));
        if !config.is_file() {
            return Err(format!("{label} config not found: {}", config.display()));
        }
        validate_process_start_inputs(label, kind, &binary, &config)?;
        self.start_prepared(
            label,
            kind,
            binary,
            ManagedConfigDelivery::Path(config),
            args,
        )
    }

    fn start_generation(
        &mut self,
        label: &str,
        kind: ManagedBinaryKind,
        binary_path: String,
        config: &xray_generation::ConfigLease,
        args: &[&str],
    ) -> Result<ProcessStatus, String> {
        let binary = PathBuf::from(clean_path_input(&binary_path));
        validate_process_binary_inputs(label, kind, &binary)?;
        config
            .verify_child_source()
            .map_err(|error| format!("{label} secure config unavailable: {error}"))?;
        self.start_prepared(
            label,
            kind,
            binary,
            ManagedConfigDelivery::Generation(config),
            args,
        )
    }

    fn start_prepared(
        &mut self,
        label: &str,
        kind: ManagedBinaryKind,
        binary: PathBuf,
        delivery: ManagedConfigDelivery<'_>,
        args: &[&str],
    ) -> Result<ProcessStatus, String> {
        self.refresh(label)?;
        if self.child.is_some() {
            return Err(format!("{label} is already running"));
        }
        self.sanitize_diagnostics = matches!(
            kind,
            ManagedBinaryKind::Xray | ManagedBinaryKind::TachyonCore
        );

        let (config_status_path, config_argument, secure_config) = match &delivery {
            ManagedConfigDelivery::Path(path) => (path.as_path(), path.clone(), None),
            ManagedConfigDelivery::Generation(config) => {
                (config.path(), config.child_config_path(), Some(*config))
            }
        };
        let mut command = Command::new(&binary);
        command.args(args);
        command.arg(&config_argument);
        command.stdin(Stdio::null());
        command.stdout(Stdio::piped());
        command.stderr(Stdio::piped());
        let work_dir = if secure_config.is_some() {
            generation_config_work_dir(&binary, config_status_path)
        } else {
            config_status_path.parent().or_else(|| binary.parent())
        };
        if let Some(work_dir) = work_dir {
            command.current_dir(work_dir);
        }
        hide_command_window(&mut command);

        let mut child = match secure_config {
            Some(config) => config.spawn_command(&mut command),
            None => command.spawn(),
        }
        .map_err(|err| format!("start {label}: {err}"))?;
        self.stdout_tail = Arc::new(Mutex::new(String::new()));
        self.stderr_tail = Arc::new(Mutex::new(String::new()));
        self.stdout_reader = child
            .stdout
            .take()
            .map(|stdout| spawn_log_reader(stdout, Arc::clone(&self.stdout_tail)));
        self.stderr_reader = child
            .stderr
            .take()
            .map(|stderr| spawn_log_reader(stderr, Arc::clone(&self.stderr_tail)));
        self.child = Some(child);
        self.binary_path = Some(path_string(&binary));
        self.config_path = Some(path_string(config_status_path));
        self.started_at = Some(now_epoch_seconds());
        self.last_error = None;
        self.exit_code = None;
        self.stop_method = None;
        std::thread::sleep(Duration::from_millis(150));
        self.refresh(label)?;
        if self.child.is_none() {
            return Err(self
                .last_error
                .clone()
                .unwrap_or_else(|| format!("{label} exited immediately")));
        }
        Ok(self.snapshot())
    }

    fn stop(&mut self, label: &str) -> Result<ProcessStatus, String> {
        self.refresh(label)?;
        let Some(mut child) = self.child.take() else {
            return Ok(self.snapshot());
        };
        let graceful_request = request_graceful_stop(&child);
        let deadline = Instant::now() + GRACEFUL_STOP_TIMEOUT;
        let mut forced = false;
        loop {
            #[cfg(test)]
            let try_wait = if self.stop_fault == Some(StopFault::TryWait) {
                Err(io::Error::other("injected try_wait failure"))
            } else {
                child.try_wait()
            };
            #[cfg(not(test))]
            let try_wait = child.try_wait();
            let try_wait = match try_wait {
                Ok(status) => status,
                Err(error) => {
                    self.child = Some(child);
                    self.last_error = Some(format!("poll {label} while stopping: {error}"));
                    self.stop_method = Some("retryPending".to_string());
                    return Err(self.last_error.clone().unwrap_or_default());
                }
            };
            if let Some(status) = try_wait {
                self.exit_code = status.code();
                break;
            }
            if Instant::now() >= deadline {
                #[cfg(test)]
                let kill = if self.stop_fault == Some(StopFault::Kill) {
                    Err(io::Error::other("injected kill failure"))
                } else {
                    child.kill()
                };
                #[cfg(not(test))]
                let kill = child.kill();
                if let Err(error) = kill {
                    self.child = Some(child);
                    self.last_error = Some(format!("force stop {label}: {error}"));
                    self.stop_method = Some("retryPending".to_string());
                    return Err(self.last_error.clone().unwrap_or_default());
                }
                #[cfg(test)]
                let wait = if self.stop_fault == Some(StopFault::Wait) {
                    Err(io::Error::other("injected wait failure"))
                } else {
                    child.wait()
                };
                #[cfg(not(test))]
                let wait = child.wait();
                let status = match wait {
                    Ok(status) => status,
                    Err(error) => {
                        self.child = Some(child);
                        self.last_error =
                            Some(format!("wait for {label} after force stop: {error}"));
                        self.stop_method = Some("retryPending".to_string());
                        return Err(self.last_error.clone().unwrap_or_default());
                    }
                };
                self.exit_code = status.code();
                forced = true;
                break;
            }
            thread::sleep(Duration::from_millis(25));
        }
        self.finish_log_readers();
        self.started_at = None;
        self.last_error = graceful_request.err().filter(|_| forced);
        self.stop_method = Some(if forced {
            "forcedAfterTimeout".to_string()
        } else {
            "graceful".to_string()
        });
        Ok(self.snapshot())
    }

    fn status(&mut self) -> ProcessStatus {
        if let Err(err) = self.refresh("process") {
            self.last_error = Some(err);
            self.stop_method = Some("pollFailedRetryPending".to_string());
        }
        self.snapshot()
    }

    fn refresh(&mut self, label: &str) -> Result<(), String> {
        let exit_status = match self.child.as_mut() {
            Some(child) => child
                .try_wait()
                .map_err(|err| format!("poll {label}: {err}"))?,
            None => return Ok(()),
        };
        if let Some(status) = exit_status {
            self.child = None;
            self.started_at = None;
            self.exit_code = status.code();
            self.finish_log_readers();
            self.last_error = if status.success() {
                None
            } else {
                let stderr = log_tail_snapshot(&self.stderr_tail);
                let detail = stderr
                    .lines()
                    .rev()
                    .find(|line| !line.trim().is_empty())
                    .map(str::trim)
                    .unwrap_or_default();
                let detail = if self.sanitize_diagnostics {
                    sanitize_xray_diagnostic(detail).text
                } else {
                    detail.to_string()
                };
                Some(if detail.is_empty() {
                    format!("{label} exited with {status}")
                } else {
                    format!("{label} exited with {status}: {detail}")
                })
            };
        }
        Ok(())
    }

    fn snapshot(&self) -> ProcessStatus {
        let stdout_tail = log_tail_snapshot(&self.stdout_tail);
        let stderr_tail = log_tail_snapshot(&self.stderr_tail);
        let (stdout_tail, stderr_tail) = if self.sanitize_diagnostics {
            (
                sanitize_xray_diagnostic(&stdout_tail).text,
                sanitize_xray_diagnostic(&stderr_tail).text,
            )
        } else {
            (stdout_tail, stderr_tail)
        };
        let last_error = if self.sanitize_diagnostics {
            self.last_error
                .as_deref()
                .map(|error| sanitize_xray_diagnostic(error).text)
        } else {
            self.last_error.clone()
        };
        ProcessStatus {
            state: if self.child.is_some() {
                "running".to_string()
            } else if self.last_error.is_some() {
                "failed".to_string()
            } else {
                "stopped".to_string()
            },
            pid: self.child.as_ref().map(Child::id),
            binary_path: self.binary_path.clone(),
            config_path: self.config_path.clone(),
            started_at: self.started_at,
            last_error,
            exit_code: self.exit_code,
            stdout_tail,
            stderr_tail,
            stop_method: self.stop_method.clone(),
        }
    }

    fn finish_log_readers(&mut self) {
        if let Some(reader) = self.stdout_reader.take() {
            let _ = reader.join();
        }
        if let Some(reader) = self.stderr_reader.take() {
            let _ = reader.join();
        }
    }
}

fn spawn_log_reader<R>(reader: R, tail: Arc<Mutex<String>>) -> thread::JoinHandle<()>
where
    R: Read + Send + 'static,
{
    thread::spawn(move || {
        let mut reader = reader;
        let mut buffer = [0_u8; 4096];
        loop {
            match reader.read(&mut buffer) {
                Ok(0) => break,
                Ok(read) => append_log_tail(&tail, &String::from_utf8_lossy(&buffer[..read])),
                Err(_) => break,
            }
        }
    })
}

fn append_log_tail(tail: &Mutex<String>, value: &str) {
    let Ok(mut tail) = tail.lock() else {
        return;
    };
    tail.push_str(value);
    if tail.len() <= PROCESS_LOG_TAIL_BYTES {
        return;
    }
    let mut remove_bytes = tail.len() - PROCESS_LOG_TAIL_BYTES;
    while !tail.is_char_boundary(remove_bytes) {
        remove_bytes += 1;
    }
    tail.drain(..remove_bytes);
}

fn log_tail_snapshot(tail: &Mutex<String>) -> String {
    tail.lock().map(|value| value.clone()).unwrap_or_default()
}

#[cfg(target_os = "windows")]
fn request_graceful_stop(child: &Child) -> Result<(), String> {
    let mut command = Command::new("taskkill");
    command.args(["/PID", &child.id().to_string(), "/T"]);
    let output = command_output_with_timeout(command, Duration::from_secs(2))?;
    if output.status.success() {
        Ok(())
    } else {
        Err(format!(
            "request graceful process stop: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ))
    }
}

#[cfg(unix)]
fn request_graceful_stop(child: &Child) -> Result<(), String> {
    let pid = child.id().to_string();
    run_command("kill", &["-TERM", &pid]).map(|_| ())
}

#[cfg(not(any(target_os = "windows", unix)))]
fn request_graceful_stop(_child: &Child) -> Result<(), String> {
    Err("graceful process stop is unsupported on this platform".to_string())
}

fn validate_process_start_inputs(
    label: &str,
    kind: ManagedBinaryKind,
    binary: &Path,
    config: &Path,
) -> Result<(), String> {
    if !config.is_file() {
        return Err(format!("{label} config not found: {}", config.display()));
    }
    validate_process_binary_inputs(label, kind, binary)
}

fn validate_process_binary_inputs(
    label: &str,
    kind: ManagedBinaryKind,
    binary: &Path,
) -> Result<(), String> {
    if !binary.is_file() {
        return Err(format!("{label} binary not found: {}", binary.display()));
    }
    for dep in sidecar_dependencies(kind, binary) {
        if dep.required && !dep.exists {
            return Err(format!(
                "{label} dependency missing: {} at {}",
                dep.name, dep.path
            ));
        }
    }
    Ok(())
}

fn now_epoch_seconds() -> u64 {
    epoch_seconds(SystemTime::now()).unwrap_or_default()
}

fn epoch_seconds(time: SystemTime) -> Option<u64> {
    time.duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .ok()
}

fn cleanup_runtime(handle: &tauri::AppHandle) -> Result<(), String> {
    let proxy_runtime = handle.state::<system_proxy::SystemProxyRuntime>();
    let runtime = handle.state::<RuntimeState>();
    let mut coordinator = runtime
        .xray
        .lock()
        .map_err(|error| format!("lock runtime state during shutdown: {error}"))?;
    let outcome = coordinator.stop_all(handle, &proxy_runtime);
    if outcome.errors.is_empty() {
        Ok(())
    } else {
        Err(outcome.errors.join("; "))
    }
}

#[tauri::command]
fn window_minimize(window: tauri::Window) -> Result<(), String> {
    window.minimize().map_err(|error| error.to_string())
}

#[tauri::command]
fn window_toggle_maximize(window: tauri::Window) -> Result<(), String> {
    let maximized = window.is_maximized().map_err(|error| error.to_string())?;
    if maximized {
        window.unmaximize().map_err(|error| error.to_string())
    } else {
        window.maximize().map_err(|error| error.to_string())
    }
}

#[tauri::command]
fn window_set_maximized(
    window: tauri::Window,
    state: tauri::State<'_, RuntimeState>,
    value: bool,
) -> Result<bool, String> {
    if value {
        let bounds = WindowBounds {
            position: window.outer_position().map_err(|error| error.to_string())?,
            size: window.outer_size().map_err(|error| error.to_string())?,
        };
        let monitor = window
            .current_monitor()
            .map_err(|error| error.to_string())?
            .ok_or_else(|| "No current monitor available".to_string())?;
        *state
            .window_restore_bounds
            .lock()
            .map_err(|error| error.to_string())? = Some(bounds);
        window
            .set_position(tauri::Position::Physical(*monitor.position()))
            .map_err(|error| error.to_string())?;
        window
            .set_size(tauri::Size::Physical(*monitor.size()))
            .map_err(|error| error.to_string())?;
    } else {
        let bounds = state
            .window_restore_bounds
            .lock()
            .map_err(|error| error.to_string())?
            .take();
        if let Some(bounds) = bounds {
            window
                .set_position(tauri::Position::Physical(bounds.position))
                .map_err(|error| error.to_string())?;
            window
                .set_size(tauri::Size::Physical(bounds.size))
                .map_err(|error| error.to_string())?;
        }
    }
    Ok(value)
}

#[tauri::command]
fn window_set_always_on_top(window: tauri::Window, value: bool) -> Result<bool, String> {
    window
        .set_always_on_top(value)
        .map_err(|error| error.to_string())?;
    Ok(value)
}

#[tauri::command]
fn window_close(app: tauri::AppHandle, window: tauri::Window) -> Result<(), String> {
    cleanup_runtime(&app)?;
    window.close().map_err(|error| error.to_string())
}

#[tauri::command]
fn window_start_dragging(window: tauri::Window) -> Result<(), String> {
    window.start_dragging().map_err(|error| error.to_string())
}

#[cfg(test)]
#[allow(clippy::items_after_test_module)]
mod tests {
    use super::*;
    use rustls::pki_types::{PrivateKeyDer, PrivatePkcs8KeyDer};
    use rustls::{ServerConfig, ServerConnection};
    use std::io::copy;
    use std::net::TcpListener;

    fn managed_xray_test_settings() -> RuntimeSettings {
        RuntimeSettings {
            xray_socks_listen: "127.0.0.1".to_string(),
            xray_socks_port: 10808,
            xray_http_listen: "127.0.0.1".to_string(),
            xray_http_port: 10809,
            xray_stats_enabled: false,
            ..RuntimeSettings::default()
        }
    }

    fn managed_xray_test_config() -> Value {
        serde_json::json!({
            "log": { "loglevel": "warning" },
            "inbounds": [
                {
                    "tag": "tachyon-socks",
                    "listen": "127.0.0.1",
                    "port": 10808,
                    "protocol": "socks",
                    "settings": { "auth": "noauth", "udp": true }
                },
                {
                    "tag": "tachyon-http",
                    "listen": "127.0.0.1",
                    "port": 10809,
                    "protocol": "http",
                    "settings": { "allowTransparent": false }
                }
            ],
            "outbounds": [
                {
                    "tag": "tachyon-proxy",
                    "protocol": "vless",
                    "settings": { "fixture": "fixture-sensitive-uuid-and-password" }
                },
                { "tag": "tachyon-direct", "protocol": "freedom" },
                { "tag": "tachyon-block", "protocol": "blackhole" }
            ],
            "routing": {
                "domainStrategy": "IPIfNonMatch",
                "rules": [{ "type": "field", "outboundTag": "tachyon-proxy" }]
            }
        })
    }

    #[test]
    fn managed_xray_apply_plan_accepts_only_prism_owned_controls() {
        let settings = managed_xray_test_settings();
        let bytes = serde_json::to_vec(&managed_xray_test_config()).expect("serialize test config");
        let plan = xray_generation::apply_plan_for_test(bytes);

        assert!(
            validate_xray_apply_plan(&plan, XrayConfigTrustMode::Managed, &settings).is_ok(),
            "valid Prism-managed apply plan was rejected"
        );
    }

    #[test]
    fn managed_xray_apply_plan_rejects_remote_privileged_controls_without_secret_leaks() {
        const SECRET: &str = "fixture-sensitive-uuid-and-password";
        let settings = managed_xray_test_settings();
        let base = managed_xray_test_config();
        let mut cases = Vec::new();

        let mut public_inbound = base.clone();
        public_inbound["inbounds"]
            .as_array_mut()
            .expect("inbounds")
            .push(serde_json::json!({
                "tag": "hostile-public",
                "listen": "0.0.0.0",
                "port": 1080,
                "protocol": "socks"
            }));
        cases.push(public_inbound);

        let mut duplicate_listener = base.clone();
        let duplicate = duplicate_listener["inbounds"][0].clone();
        duplicate_listener["inbounds"]
            .as_array_mut()
            .expect("inbounds")
            .push(duplicate);
        cases.push(duplicate_listener);

        for (field, value) in [
            (
                "api",
                serde_json::json!({ "tag": "hostile-api", "services": ["HandlerService"] }),
            ),
            (
                "reverse",
                serde_json::json!({ "bridges": [{ "tag": "hostile" }] }),
            ),
            (
                "transport",
                serde_json::json!({ "tcpSettings": { "acceptProxyProtocol": true } }),
            ),
            (
                "observatory",
                serde_json::json!({ "subjectSelector": ["hostile"] }),
            ),
            ("unknownTopLevel", serde_json::json!({ "execute": true })),
        ] {
            let mut candidate = base.clone();
            candidate[field] = value;
            cases.push(candidate);
        }

        let mut dangerous_log = base;
        dangerous_log["log"] = serde_json::json!({
            "loglevel": "warning",
            "access": "C:\\hostile-access.log",
            "error": "/tmp/hostile-error.log"
        });
        cases.push(dangerous_log);

        for candidate in cases {
            let bytes = serde_json::to_vec(&candidate).expect("serialize malicious fixture");
            let plan = xray_generation::apply_plan_for_test(bytes);
            let error =
                match validate_xray_apply_plan(&plan, XrayConfigTrustMode::Managed, &settings) {
                    Ok(()) => panic!("malicious managed apply plan was accepted"),
                    Err(error) => error,
                };
            assert!(
                !error.contains(SECRET),
                "managed policy error leaked fixture secret"
            );
        }
    }

    #[test]
    fn advanced_xray_authorization_requires_confirmation_and_preserves_local_json() {
        const SECRET: &str = "fixture-local-advanced-password";
        let settings = managed_xray_test_settings();
        let config = serde_json::to_vec(&serde_json::json!({
            "futureOfficialControl": { "credential": SECRET },
            "reverse": { "bridges": [{ "tag": "locally-authored" }] }
        }))
        .expect("serialize advanced fixture");

        assert!(
            authorize_xray_config(&config, XrayConfigTrustMode::Advanced, false, &settings)
                .is_err(),
            "unconfirmed advanced config was authorized"
        );
        assert!(
            authorize_xray_config(&config, XrayConfigTrustMode::Advanced, true, &settings).is_ok(),
            "confirmed local advanced config was rejected"
        );
    }

    fn test_tls_material() -> (Arc<ServerConfig>, RootCertStore) {
        let certified = rcgen::generate_simple_self_signed(vec!["localhost".to_string()])
            .expect("generate local TLS certificate");
        let certificate = certified.cert.der().clone();
        let private_key = PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(
            certified.signing_key.serialize_der(),
        ));
        let server = ServerConfig::builder()
            .with_no_client_auth()
            .with_single_cert(vec![certificate.clone()], private_key)
            .expect("build local TLS server config");
        let mut roots = RootCertStore::empty();
        roots.add(certificate).expect("trust local TLS certificate");
        (Arc::new(server), roots)
    }

    fn read_fake_headers(stream: &mut impl Read) -> Vec<u8> {
        let mut response = Vec::new();
        let mut byte = [0_u8; 1];
        while response.len() < 64 * 1024 {
            if stream.read_exact(&mut byte).is_err() {
                break;
            }
            response.push(byte[0]);
            if response.ends_with(b"\r\n\r\n") {
                break;
            }
        }
        response
    }

    fn relay_fake_connection(mut left: TcpStream, mut right: TcpStream) {
        let mut left_reader = left.try_clone().expect("clone fake proxy client");
        let mut right_writer = right.try_clone().expect("clone fake target writer");
        let uplink = std::thread::spawn(move || {
            let _ = copy(&mut left_reader, &mut right_writer);
        });
        let _ = copy(&mut right, &mut left);
        let _ = uplink.join();
    }

    fn spawn_fake_tls_target(
        listener: std::net::TcpListener,
        server: Arc<ServerConfig>,
        expected_connections: usize,
        nonce: String,
    ) -> std::thread::JoinHandle<()> {
        std::thread::spawn(move || {
            for _ in 0..expected_connections {
                let (stream, _) = listener.accept().expect("accept fake TLS target");
                let connection = ServerConnection::new(server.clone()).expect("TLS server");
                let mut tls = StreamOwned::new(connection, stream);
                let request = read_fake_headers(&mut tls);
                assert!(request.starts_with(b"GET /health HTTP/1.1"));
                let response = format!(
                    "HTTP/1.1 204 No Content\r\nX-Tachyon-Probe-Nonce: {nonce}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                );
                tls.write_all(response.as_bytes())
                    .expect("fake TLS response");
            }
        })
    }

    fn spawn_fake_http_connect_proxy(
        listener: std::net::TcpListener,
        target: SocketAddr,
    ) -> std::thread::JoinHandle<()> {
        std::thread::spawn(move || {
            let (mut client, _) = listener.accept().expect("accept fake HTTP proxy");
            let request = String::from_utf8_lossy(&read_fake_headers(&mut client)).to_string();
            assert!(request.starts_with("CONNECT localhost:"));
            let target_stream = TcpStream::connect(target).expect("connect fake TLS target");
            client
                .write_all(b"HTTP/1.1 200 Connection Established\r\n\r\n")
                .expect("fake CONNECT response");
            relay_fake_connection(client, target_stream);
        })
    }

    fn spawn_fake_socks5_proxy(
        listener: std::net::TcpListener,
        target: SocketAddr,
    ) -> std::thread::JoinHandle<()> {
        std::thread::spawn(move || {
            let (mut client, _) = listener.accept().expect("accept fake SOCKS5 proxy");
            let mut greeting = [0_u8; 3];
            client.read_exact(&mut greeting).expect("SOCKS greeting");
            assert_eq!(greeting, [0x05, 0x01, 0x00]);
            client
                .write_all(&[0x05, 0x00])
                .expect("SOCKS method response");
            let mut header = [0_u8; 4];
            client.read_exact(&mut header).expect("SOCKS request");
            assert_eq!(header, [0x05, 0x01, 0x00, 0x03]);
            let mut domain_length = [0_u8; 1];
            client
                .read_exact(&mut domain_length)
                .expect("SOCKS domain length");
            let domain_len = domain_length[0] as usize;
            let mut domain = vec![0_u8; domain_len + 2];
            client
                .read_exact(&mut domain)
                .expect("SOCKS domain request");
            assert_eq!(&domain[..domain_len], b"localhost");
            let target_stream = TcpStream::connect(target).expect("connect fake TLS target");
            client
                .write_all(&[0x05, 0x00, 0x00, 0x01, 127, 0, 0, 1, 0, 0])
                .expect("SOCKS connect response");
            relay_fake_connection(client, target_stream);
        })
    }

    struct FailingAtomicFileReplacer;

    impl AtomicFileReplacer for FailingAtomicFileReplacer {
        fn replace(&self, candidate: &Path, _canonical: &Path) -> Result<(), String> {
            assert!(
                candidate.is_file(),
                "replacement must receive the synced candidate"
            );
            Err("injected atomic replacement failure".to_string())
        }
    }

    fn xray_validation(ok: bool) -> ConfigValidationResult {
        ConfigValidationResult {
            ok,
            target: "xray".to_string(),
            command: "xray run -test -config candidate".to_string(),
            details: if ok {
                "Configuration OK.".to_string()
            } else {
                "invalid outbound".to_string()
            },
            error: (!ok).then(|| "invalid outbound".to_string()),
        }
    }

    #[test]
    fn canonical_xray_config_read_returns_exact_utf8_contents() {
        let directory = unique_temp_dir("tachyon-test-read-canonical-xray");
        fs::create_dir_all(&directory).unwrap();
        let canonical = directory.join("xray-client.json");
        let expected = "{\n  \"outbounds\": []\n}\n";
        fs::write(&canonical, expected.as_bytes()).unwrap();

        let result = read_optional_utf8_file_bounded(&canonical, 1024).unwrap();

        assert!(result.exists);
        assert_eq!(result.contents.as_deref(), Some(expected));
        let _ = fs::remove_dir_all(directory);
    }

    #[test]
    fn canonical_xray_config_read_distinguishes_missing_file() {
        let directory = unique_temp_dir("tachyon-test-read-missing-canonical-xray");
        fs::create_dir_all(&directory).unwrap();
        let canonical = directory.join("xray-client.json");

        let result = read_optional_utf8_file_bounded(&canonical, 1024).unwrap();

        assert!(!result.exists);
        assert!(result.contents.is_none());
        let _ = fs::remove_dir_all(directory);
    }

    #[test]
    fn canonical_xray_config_read_distinguishes_empty_existing_file() {
        let directory = unique_temp_dir("tachyon-test-read-empty-canonical-xray");
        fs::create_dir_all(&directory).unwrap();
        let canonical = directory.join("xray-client.json");
        fs::write(&canonical, []).unwrap();

        let result = read_optional_utf8_file_bounded(&canonical, 1024).unwrap();

        assert!(result.exists);
        assert_eq!(result.contents.as_deref(), Some(""));
        let _ = fs::remove_dir_all(directory);
    }

    #[test]
    fn canonical_xray_config_read_rejects_oversized_file() {
        let directory = unique_temp_dir("tachyon-test-read-large-canonical-xray");
        fs::create_dir_all(&directory).unwrap();
        let canonical = directory.join("xray-client.json");
        fs::write(&canonical, b"12345").unwrap();

        let error = read_optional_utf8_file_bounded(&canonical, 4).unwrap_err();

        assert!(error.contains("4-byte UTF-8 limit"));
        let _ = fs::remove_dir_all(directory);
    }

    #[test]
    fn canonical_xray_config_read_rejects_non_utf8_file() {
        let directory = unique_temp_dir("tachyon-test-read-non-utf8-canonical-xray");
        fs::create_dir_all(&directory).unwrap();
        let canonical = directory.join("xray-client.json");
        fs::write(&canonical, [0xff, 0xfe, 0xfd]).unwrap();

        let error = read_optional_utf8_file_bounded(&canonical, 1024).unwrap_err();

        assert!(error.contains("not valid UTF-8"));
        let _ = fs::remove_dir_all(directory);
    }

    #[test]
    fn xray_diagnostics_redact_normalized_sensitive_keys_and_uri_userinfo() {
        let diagnostic = r#"{
  "password":"pw-value",
  "pass":"pass-value",
  "passwd":"passwd-value",
  "token":"token-value",
  "secret":"secret-value",
  "AUTH":"auth-value",
  "psk":"psk-value",
  "privateKey":"private-value",
  "PRIVATE_KEY":"private-snake-value",
  "secretKey":"secret-key-value",
  "SECRET_KEY":"secret-snake-value",
  "secret-key":"secret-kebab-value",
  "preSharedKey":"pre-shared-value",
  "PRE_SHARED_KEY":"pre-shared-snake-value",
  "pre-shared-key":"pre-shared-kebab-value",
  "id":"id-value",
  "uuid":"uuid-value",
  "not_secret_name":"visible-value",
  "uri":"socks5://alice:uri-password@example.test:1080"
}
token=assignment-value
Secret-Key: 'log-secret-value'
pre_shared_key=log-pre-shared-value
escaped=https:\/\/bob:escaped-password@example.test/path"#;

        let sanitized = sanitize_xray_diagnostic(diagnostic);

        for secret in [
            "pw-value",
            "pass-value",
            "passwd-value",
            "token-value",
            "secret-value",
            "auth-value",
            "psk-value",
            "private-value",
            "private-snake-value",
            "secret-key-value",
            "secret-snake-value",
            "secret-kebab-value",
            "pre-shared-value",
            "pre-shared-snake-value",
            "pre-shared-kebab-value",
            "id-value",
            "uuid-value",
            "alice:uri-password",
            "assignment-value",
            "log-secret-value",
            "log-pre-shared-value",
            "bob:escaped-password",
        ] {
            assert!(
                !sanitized.text.contains(secret),
                "diagnostic redaction failed"
            );
        }
        assert!(sanitized.text.contains("<redacted>"));
        assert!(sanitized.text.contains("example.test"));
        assert!(sanitized.text.contains("visible-value"));
        assert!(!sanitized.text.contains("...[truncated]"));
    }

    #[test]
    fn xray_diagnostics_redact_every_sensitive_assignment_after_non_sensitive_prefixes() {
        let keys = [
            "auth",
            "AUTH",
            "id",
            "password",
            "passwd",
            "pass",
            "token",
            "secret",
            "secretKey",
            "SECRET_KEY",
            "secret-key",
            "psk",
            "preSharedKey",
            "PRE_SHARED_KEY",
            "pre-shared-key",
            "privateKey",
            "PRIVATE_KEY",
            "private-key",
            "uuid",
        ];
        let mut diagnostic = String::new();
        let mut secrets = Vec::new();
        for (index, key) in keys.iter().enumerate() {
            let secret = format!("assignment-value-{index}");
            diagnostic.push_str(&format!("wrapper failed: {key}={secret}\n"));
            secrets.push(secret);
        }
        diagnostic.push_str("safe_key=visible-value\n");

        let sanitized = sanitize_xray_diagnostic(&diagnostic);

        for secret in secrets {
            assert!(
                !sanitized.text.contains(&secret),
                "assignment diagnostic redaction failed"
            );
        }
        assert_eq!(sanitized.text.matches("<redacted>").count(), keys.len());
        assert!(sanitized.text.contains("safe_key=visible-value"));
    }

    #[test]
    fn xray_diagnostics_redact_escaped_json_sensitive_keys() {
        let diagnostic = r#"{\"auth\":\"escaped-auth-value\",\"Secret_Key\":\"escaped-secret-value\",\"PRE-SHARED-KEY\":\"escaped-pre-shared-value\",\"private_key\":\"escaped-private-value\",\"token\":\"escaped-token-value\",\"safe\":\"visible-value\"}"#;

        let sanitized = sanitize_xray_diagnostic(diagnostic);

        for secret in [
            "escaped-auth-value",
            "escaped-secret-value",
            "escaped-pre-shared-value",
            "escaped-private-value",
            "escaped-token-value",
        ] {
            assert!(
                !sanitized.text.contains(secret),
                "escaped diagnostic redaction failed"
            );
        }
        assert!(sanitized.text.contains(r#"\"<redacted>\""#));
        assert!(sanitized.text.contains("visible-value"));
    }

    #[test]
    fn xray_validation_stdout_and_stderr_are_redacted_and_bounded() {
        let stdout = format!("AUTH=stdout-secret {}", "A".repeat(20_000));
        let stderr = format!(
            r#"{{\"pre-shared-key\":\"stderr-secret\"}} {}"#,
            "B".repeat(20_000)
        );
        let output = test_output(1, stdout.as_bytes(), stderr.as_bytes());

        let result = config_validation_result(
            "xray",
            "xray run -test -config xray-client.json".to_string(),
            Ok(output),
        );

        assert!(!result.ok);
        assert!(result.details.len() <= XRAY_DIAGNOSTIC_LIMIT_BYTES);
        assert!(result.details.starts_with("stderr:\n"));
        assert!(result.details.contains("\nstdout:\n"));
        assert_eq!(result.details.matches("...[truncated]").count(), 2);
        assert!(result.details.contains(r#"\"<redacted>\""#));
        assert!(result.details.contains("AUTH=<redacted>"));
        assert!(!result.details.contains("stdout-secret"));
        assert!(!result.details.contains("stderr-secret"));
        assert_eq!(result.error.as_deref(), Some(result.details.as_str()));
    }

    #[test]
    fn xray_validation_preserves_both_multibyte_streams_within_combined_byte_budget() {
        let stdout = format!("stdout-marker auth=stdout-secret {}", "界".repeat(4_000));
        let stderr = format!(
            "stderr-marker pre_shared_key=stderr-secret {}",
            "错".repeat(4_000)
        );
        let output = test_output(1, stdout.as_bytes(), stderr.as_bytes());

        let result = config_validation_result(
            "xray",
            "xray run -test -config xray-client.json".to_string(),
            Ok(output),
        );

        assert!(result.details.len() <= XRAY_DIAGNOSTIC_LIMIT_BYTES);
        assert!(result.details.contains("stderr-marker"));
        assert!(result.details.contains("stdout-marker"));
        assert!(result.details.contains("\nstdout:\n"));
        assert_eq!(result.details.matches("...[truncated]").count(), 2);
        assert!(!result.details.contains("stderr-secret"));
        assert!(!result.details.contains("stdout-secret"));
        assert!(std::str::from_utf8(result.details.as_bytes()).is_ok());
    }

    #[test]
    fn xray_start_status_and_logs_redact_and_bound_diagnostics() {
        let raw = format!(
            "failed config: {{\"secret_key\":\"status-secret\",\"AUTH\":\"log-secret\"}} {}",
            "X".repeat(20_000)
        );
        let process = ManagedProcess {
            sanitize_diagnostics: true,
            last_error: Some(raw.clone()),
            ..ManagedProcess::default()
        };
        append_log_tail(&process.stdout_tail, &raw);
        append_log_tail(&process.stderr_tail, &raw);

        let status = process.snapshot();
        let processes = RuntimeProcesses {
            xray: process,
            ..RuntimeProcesses::default()
        };
        let logs = processes.logs("xray").unwrap();

        let last_error = status.last_error.as_deref().unwrap();
        assert!(!last_error.contains("status-secret"));
        assert!(!last_error.contains("log-secret"));
        assert!(status.stderr_tail.len() <= XRAY_DIAGNOSTIC_LIMIT_BYTES);
        assert!(!status.stderr_tail.contains("status-secret"));
        assert!(!status.stderr_tail.contains("log-secret"));
        assert!(status.stderr_tail.contains("...[truncated]"));
        assert_eq!(logs.capacity_bytes_per_stream, XRAY_DIAGNOSTIC_LIMIT_BYTES);
        assert!(!logs.stdout_tail.contains("status-secret"));
        assert!(!logs.stdout_tail.contains("log-secret"));
        assert!(logs.stdout_tail.contains("...[truncated]"));
    }

    #[test]
    fn xray_start_error_is_redacted_and_bounded_for_ui() {
        let raw = format!(
            "start failed: auth=start-secret socks5://alice:password@example.test {}",
            "X".repeat(20_000)
        );

        let sanitized = sanitize_xray_ui_result::<()>(Err(raw)).unwrap_err();

        assert!(sanitized.len() <= XRAY_DIAGNOSTIC_LIMIT_BYTES);
        assert!(sanitized.contains("...[truncated]"));
        assert!(!sanitized.contains("start-secret"));
        assert!(!sanitized.contains("alice:password"));
        assert!(sanitized.contains("example.test"));
    }

    #[test]
    fn xray_start_all_error_chain_redacts_start_and_rollback_diagnostics() {
        let raw = start_all_rollback_error(
            r#"Xray rejected {"secretKey":"start-all-secret"}"#.to_string(),
            vec!["stop Xray: pre_shared_key=rollback-secret".to_string()],
        );

        let sanitized = sanitize_xray_ui_result::<()>(Err(raw)).unwrap_err();

        assert!(sanitized.contains("start_all failed"));
        assert!(sanitized.contains("rollback failed"));
        assert!(!sanitized.contains("start-all-secret"));
        assert!(!sanitized.contains("rollback-secret"));
    }

    #[test]
    fn committed_xray_config_paths_match_frontend_success_contract() {
        let payload = serde_json::to_value(ConfigDraftPaths {
            config_dir: "C:\\Prism\\config".to_string(),
            core_config_path: "C:\\Prism\\config\\client.json".to_string(),
            xray_config_path: "C:\\Prism\\config\\xray-client.json".to_string(),
        })
        .unwrap();

        assert_eq!(payload["configDir"], "C:\\Prism\\config");
        assert_eq!(payload["coreConfigPath"], "C:\\Prism\\config\\client.json");
        assert_eq!(
            payload["xrayConfigPath"],
            "C:\\Prism\\config\\xray-client.json"
        );
    }

    #[test]
    fn system_proxy_is_owned_only_by_xray_across_runtime_matrix() {
        let mut processes = RuntimeProcesses::default();
        let mut status = processes.status();

        status.xray.state = "running".to_string();
        for core_state in ["stopped", "running", "failed"] {
            status.tachyon_core.state = core_state.to_string();
            assert!(
                !should_restore_proxy_for_runtime(&status),
                "Xray-only and dual-core modes must retain the Xray-owned proxy when Core is {core_state}"
            );
        }

        for xray_state in ["stopped", "failed"] {
            status.xray.state = xray_state.to_string();
            for core_state in ["stopped", "running", "failed"] {
                status.tachyon_core.state = core_state.to_string();
                assert!(
                    should_restore_proxy_for_runtime(&status),
                    "Core-only, startup failure, and stopped-Xray states must restore the proxy"
                );
            }
        }
    }

    #[test]
    fn system_proxy_enable_rejects_stopped_or_failed_xray() {
        assert!(validate_system_proxy_owner_state("running").is_ok());
        for state in ["stopped", "failed"] {
            let error = validate_system_proxy_owner_state(state)
                .expect_err("non-running Xray cannot own the system proxy");
            assert!(error.contains("Xray is running"));
        }
    }

    #[test]
    fn xray_stop_restores_proxy_before_stopping_process() {
        let events = std::cell::RefCell::new(Vec::new());
        let result = stop_xray_transaction(
            || {
                events.borrow_mut().push("restoreProxy");
                Ok(())
            },
            || {
                events.borrow_mut().push("stopXray");
                Ok("stopped")
            },
        )
        .unwrap();
        assert_eq!(result, "stopped");
        assert_eq!(*events.borrow(), ["restoreProxy", "stopXray"]);
    }

    #[test]
    fn xray_stop_does_not_orphan_proxy_when_restore_fails() {
        let stopped = std::cell::Cell::new(false);
        let error = stop_xray_transaction(
            || Err("restore failed".to_string()),
            || {
                stopped.set(true);
                Ok(())
            },
        )
        .expect_err("proxy restoration failure must stop the shutdown transaction");
        assert_eq!(error, "restore failed");
        assert!(!stopped.get());
    }

    #[derive(Default)]
    struct FakeStopRuntime {
        core_running: bool,
        xray_running: bool,
        events: Vec<&'static str>,
    }

    impl RuntimeStopControl for FakeStopRuntime {
        fn stop_tachyon_core_checked(&mut self) -> Result<(), String> {
            self.events.push("stopCore");
            self.core_running = false;
            Ok(())
        }

        fn stop_xray_checked(&mut self) -> Result<(), String> {
            self.events.push("stopXray");
            self.xray_running = false;
            Ok(())
        }
    }

    #[test]
    fn stop_all_retries_proxy_restore_and_keeps_xray_alive_on_failure() {
        let mut runtime = FakeStopRuntime {
            core_running: true,
            xray_running: true,
            ..Default::default()
        };
        let attempts = std::cell::Cell::new(0);
        let waits = std::cell::Cell::new(0);

        let outcome = execute_runtime_shutdown(
            &mut runtime,
            || {
                attempts.set(attempts.get() + 1);
                Err("password=shutdown-sentinel".to_string())
            },
            |_| waits.set(waits.get() + 1),
        );

        assert_eq!(attempts.get(), PROXY_RESTORE_ATTEMPTS);
        assert_eq!(waits.get(), PROXY_RESTORE_ATTEMPTS - 1);
        assert_eq!(runtime.events, ["stopCore"]);
        assert!(!runtime.core_running);
        assert!(runtime.xray_running);
        assert!(outcome.xray_stop_blocked);
        assert_eq!(outcome.proxy_restore_status, "failed");
        assert!(!outcome.errors.join(" ").contains("shutdown-sentinel"));
        assert!(outcome.errors.join(" ").contains("<redacted>"));
    }

    #[test]
    fn stop_all_stops_both_cores_after_a_successful_restore_retry() {
        let mut runtime = FakeStopRuntime {
            core_running: true,
            xray_running: true,
            ..Default::default()
        };
        let attempts = std::cell::Cell::new(0);
        let outcome = execute_runtime_shutdown(
            &mut runtime,
            || {
                let attempt = attempts.get() + 1;
                attempts.set(attempt);
                if attempt == 1 {
                    Err("temporary".to_string())
                } else {
                    Ok(true)
                }
            },
            |_| {},
        );

        assert_eq!(attempts.get(), 2);
        assert_eq!(runtime.events, ["stopCore", "stopXray"]);
        assert!(!runtime.core_running && !runtime.xray_running);
        assert!(outcome.proxy_restored);
        assert!(!outcome.xray_stop_blocked);
        assert!(outcome.errors.is_empty());
    }

    #[test]
    fn stop_all_handles_xray_only_core_only_and_dual_core_states() {
        for (core_running, xray_running) in [(false, true), (true, false), (true, true)] {
            let mut runtime = FakeStopRuntime {
                core_running,
                xray_running,
                ..Default::default()
            };
            let outcome = execute_runtime_shutdown(&mut runtime, || Ok(false), |_| {});
            assert!(outcome.errors.is_empty());
            assert_eq!(outcome.proxy_restore_status, "notPending");
            assert!(!runtime.core_running && !runtime.xray_running);
            assert_eq!(runtime.events, ["stopCore", "stopXray"]);
        }
    }

    #[test]
    fn tachyon_core_diagnostics_redact_json_yaml_assignments_uris_and_logs() {
        let sentinel = "core-secret-sentinel";
        let raw = format!(
            "{{\"auth_psk\":\"{sentinel}\",\"safe\":\"visible\"}}\npassword: {sentinel}\napi_token={sentinel}\nrelay: socks5://user:{sentinel}@example.test:1080"
        );
        let validation = config_validation_result(
            "tachyon-core",
            format!("tachyon-core validate token={sentinel}"),
            Ok(test_output(1, raw.as_bytes(), raw.as_bytes())),
        );
        let preflight = tachyon_core_preflight_result(
            "tachyon-core preflight".to_string(),
            Ok(test_output(1, raw.as_bytes(), raw.as_bytes())),
        );
        let mut process = ManagedProcess {
            sanitize_diagnostics: true,
            stdout_tail: Arc::new(Mutex::new(raw.clone())),
            stderr_tail: Arc::new(Mutex::new(raw)),
            last_error: Some(format!("secret={sentinel}")),
            ..Default::default()
        };
        let status = process.status();
        let combined = format!(
            "{} {:?} {} {} {:?}",
            validation.details,
            validation.error,
            preflight.stdout,
            preflight.stderr,
            status.last_error
        );
        assert!(!combined.contains(sentinel));
        assert!(combined.contains("<redacted>"));
        assert!(combined.contains("visible"));
        assert!(combined.contains("example.test"));
    }

    #[test]
    fn tachyon_core_structured_preflight_redacts_sensitive_fields() {
        let sentinel = "structured-core-sentinel";
        let stdout = serde_json::json!({
            "overall": "ok",
            "checks": [{
                "code": "SAFE",
                "status": "ok",
                "message": "diagnostic preserved",
                "details": "relay is reachable",
                "auth_psk": sentinel,
                "nested": { "api_token": sentinel }
            }]
        })
        .to_string();
        let result = tachyon_core_preflight_result(
            "tachyon-core preflight".to_string(),
            Ok(test_output(0, stdout.as_bytes(), b"")),
        );
        let serialized = serde_json::to_string(&result.structured_report).unwrap();
        assert!(!serialized.contains(sentinel));
        assert!(serialized.contains("<redacted>"));
        assert!(serialized.contains("diagnostic preserved"));
    }

    #[test]
    fn tachyon_sse_parser_returns_hello_and_first_snapshot() {
        let stream = concat!(
            "event: hello\n",
            "data: {\"type\":\"hello\",\"seq\":1,\"ts\":\"now\",\"data\":{\"version\":\"v1\",\"platform\":\"windows\"}}\n\n",
            "event: telemetry\n",
            "data: {\"type\":\"telemetry\",\"seq\":2,\"ts\":\"now\",\"data\":{\"packets_read\":9}}\n\n",
            "event: telemetry\n",
            "data: {\"type\":\"telemetry\",\"seq\":3,\"ts\":\"later\",\"data\":{\"packets_read\":10}}\n\n"
        );
        let poll = parse_tachyon_sse_batch(stream.as_bytes()).unwrap();
        assert_eq!(poll.events.len(), 2);
        assert_eq!(poll.events[0].event_type, "hello");
        assert_eq!(poll.events[1].event_type, "telemetry");
        assert_eq!(poll.events[1].data["packets_read"], 9);
    }

    #[test]
    fn tachyon_sse_parser_fails_closed_for_malformed_or_oversized_events() {
        assert_eq!(
            parse_tachyon_sse_batch("data: {not-json}\n\n".as_bytes()).unwrap_err(),
            "tachyon-telemetry-invalid-event"
        );
        let oversized = format!("data: {}\n\n", "x".repeat(TELEMETRY_RESPONSE_LIMIT_BYTES));
        assert_eq!(
            parse_tachyon_sse_batch(oversized.as_bytes()).unwrap_err(),
            "tachyon-telemetry-response-too-large"
        );
    }

    fn atomic_candidates(directory: &Path, canonical_name: &str) -> Vec<PathBuf> {
        let canonical = Path::new(canonical_name);
        let prefix = format!(
            ".{}.",
            canonical
                .file_stem()
                .and_then(|stem| stem.to_str())
                .expect("canonical test name must have a UTF-8 file stem")
        );
        let extension = canonical.extension();
        fs::read_dir(directory)
            .into_iter()
            .flatten()
            .flatten()
            .map(|entry| entry.path())
            .filter(|path| {
                path.file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(|name| name.starts_with(&prefix) && name.contains(".tmp."))
                    && path.extension() == extension
            })
            .collect()
    }

    #[test]
    fn oversized_xray_commit_keeps_first_canonical_absent_and_skips_validation() {
        let directory = unique_temp_dir("tachyon-test-xray-commit-first-oversized");
        fs::create_dir_all(&directory).unwrap();
        let canonical = directory.join("xray-client.json");
        let oversized = "\u{00e9}".repeat(CANONICAL_XRAY_CONFIG_LIMIT_BYTES / 2 + 1);
        let mut validator_called = false;

        let error = commit_validated_xray_config_file(
            &canonical,
            &oversized,
            |_| {
                validator_called = true;
                Ok(xray_validation(true))
            },
            &PlatformAtomicFileReplacer,
        )
        .expect_err("oversized first config must be rejected before validation");

        assert!(oversized.chars().count() < CANONICAL_XRAY_CONFIG_LIMIT_BYTES);
        assert!(oversized.len() > CANONICAL_XRAY_CONFIG_LIMIT_BYTES);
        assert!(error.contains("2097152-byte UTF-8 limit"));
        assert!(error.contains("no candidate was written or validated"));
        assert!(!validator_called);
        assert!(!canonical.exists());
        assert!(atomic_candidates(&directory, "xray-client.json").is_empty());
        let _ = fs::remove_dir_all(directory);
    }

    #[test]
    fn oversized_xray_commit_preserves_existing_canonical_and_skips_validation() {
        let directory = unique_temp_dir("tachyon-test-xray-commit-existing-oversized");
        fs::create_dir_all(&directory).unwrap();
        let canonical = directory.join("xray-client.json");
        fs::write(&canonical, b"old config").unwrap();
        let oversized = "\u{00e9}".repeat(CANONICAL_XRAY_CONFIG_LIMIT_BYTES / 2 + 1);
        let mut validator_called = false;

        let error = commit_validated_xray_config_file(
            &canonical,
            &oversized,
            |_| {
                validator_called = true;
                Ok(xray_validation(true))
            },
            &PlatformAtomicFileReplacer,
        )
        .expect_err("oversized replacement must be rejected before validation");

        assert!(error.contains("2097152-byte UTF-8 limit"));
        assert!(!validator_called);
        assert!(
            fs::read_to_string(&canonical).unwrap() == "old config",
            "existing Xray config changed after oversized commit"
        );
        assert!(atomic_candidates(&directory, "xray-client.json").is_empty());
        let _ = fs::remove_dir_all(directory);
    }

    #[test]
    fn first_invalid_xray_commit_leaves_no_canonical_or_candidate() {
        let directory = unique_temp_dir("tachyon-test-xray-commit-first-invalid");
        fs::create_dir_all(&directory).unwrap();
        let canonical = directory.join("xray-client.json");

        let error = commit_validated_xray_config_file(
            &canonical,
            r#"{"invalid":true}"#,
            |_| Ok(xray_validation(false)),
            &PlatformAtomicFileReplacer,
        )
        .expect_err("invalid first config must not be committed");

        assert!(error.contains("invalid outbound"));
        assert!(!canonical.exists());
        assert!(atomic_candidates(&directory, "xray-client.json").is_empty());
        let _ = fs::remove_dir_all(directory);
    }

    #[test]
    fn first_valid_xray_commit_installs_canonical_without_leftover_candidate() {
        let directory = unique_temp_dir("tachyon-test-xray-commit-first-valid");
        fs::create_dir_all(&directory).unwrap();
        let canonical = directory.join("xray-client.json");

        commit_validated_xray_config_file(
            &canonical,
            "first valid config",
            |_| Ok(xray_validation(true)),
            &PlatformAtomicFileReplacer,
        )
        .expect("valid first config must be installed");

        assert!(
            fs::read_to_string(&canonical).unwrap() == "first valid config",
            "first valid Xray config was not installed"
        );
        assert!(atomic_candidates(&directory, "xray-client.json").is_empty());
        let _ = fs::remove_dir_all(directory);
    }

    #[test]
    fn atomic_runtime_config_is_created_with_private_permissions() {
        let directory = unique_temp_dir("tachyon-test-secure-runtime-config");
        fs::create_dir_all(&directory).unwrap();
        let canonical = directory.join("runtime-with-secret.json");
        write_atomic(&canonical, r#"{"psk":"must-not-appear-in-errors"}"#)
            .expect("secure runtime config write");

        #[cfg(unix)]
        {
            let mode = fs::metadata(&canonical).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600);
        }
        #[cfg(target_os = "windows")]
        assert_private_windows_file_dacl(&canonical);

        assert!(
            fs::read_to_string(&canonical).unwrap() == r#"{"psk":"must-not-appear-in-errors"}"#,
            "private runtime config contents changed"
        );
        let _ = fs::remove_dir_all(directory);
    }

    #[test]
    fn tauri_csp_allows_only_local_runtime_connections_and_ipc() {
        let config: Value = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let csp = config["app"]["security"]["csp"]
            .as_str()
            .expect("CSP must be configured");
        assert!(csp.contains("default-src 'self'"));
        assert!(csp.contains("script-src 'self'"));
        assert!(csp.contains("ipc:"));
        assert!(csp.contains("http://ipc.localhost"));
        assert!(!csp.contains("http://127.0.0.1"));
        assert!(!csp.contains("http://[::1]"));
        assert!(!csp.contains("http://localhost:"));
        assert!(csp.contains("object-src 'none'"));
        assert!(!csp.contains("'unsafe-eval'"));
        assert!(!csp.contains("https:"));
        assert!(!csp.contains("connect-src *"));
        assert!(!csp.contains("http://*:"));

        let renderer_telemetry = include_str!("../../src/domain/telemetry.ts");
        assert!(renderer_telemetry.contains("tachyon_telemetry_events"));
        assert!(!renderer_telemetry.contains("new EventSource"));
        assert!(!renderer_telemetry.contains("/v1/telemetry/sse"));
        assert!(!renderer_telemetry.contains("http://127.0.0.1"));
    }

    #[cfg(target_os = "windows")]
    fn assert_private_windows_file_dacl(path: &Path) {
        use windows_sys::Win32::Foundation::{CloseHandle, LocalFree};
        use windows_sys::Win32::Security::Authorization::ConvertSidToStringSidW;
        use windows_sys::Win32::Security::{
            GetTokenInformation, TokenUser, TOKEN_QUERY, TOKEN_USER,
        };
        use windows_sys::Win32::Storage::FileSystem::FILE_ALL_ACCESS;
        use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

        let audit = windows_file_dacl_audit(path).expect("query and parse protected DACL");
        let current_user_sid = unsafe {
            let mut token = std::ptr::null_mut();
            assert_ne!(
                OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token),
                0
            );
            let mut required = 0_u32;
            let _ = GetTokenInformation(token, TokenUser, std::ptr::null_mut(), 0, &mut required);
            let mut buffer = vec![0_u8; required as usize];
            assert_ne!(
                GetTokenInformation(
                    token,
                    TokenUser,
                    buffer.as_mut_ptr().cast(),
                    required,
                    &mut required
                ),
                0
            );
            CloseHandle(token);
            let user = &*(buffer.as_ptr().cast::<TOKEN_USER>());
            let mut text = std::ptr::null_mut();
            assert_ne!(ConvertSidToStringSidW(user.User.Sid, &mut text), 0);
            let len = (0..).take_while(|offset| *text.add(*offset) != 0).count();
            let sid = String::from_utf16_lossy(std::slice::from_raw_parts(text, len));
            LocalFree(text.cast());
            sid
        };
        assert!(audit.protected, "DACL must be protected from inheritance");
        assert_eq!(
            audit.trustees.len(),
            3,
            "DACL must contain exactly three allow ACEs"
        );
        assert!(
            audit.trustees.iter().any(|sid| sid == &current_user_sid),
            "current user ACE missing"
        );
        assert!(
            audit.trustees.iter().any(|sid| sid == "S-1-5-18"),
            "SYSTEM ACE missing"
        );
        assert!(
            audit.trustees.iter().any(|sid| sid == "S-1-5-32-544"),
            "Administrators ACE missing"
        );
        for forbidden in ["S-1-1-0", "S-1-5-11", "S-1-5-32-545"] {
            assert!(
                !audit.trustees.iter().any(|sid| sid == forbidden),
                "broad trustee {forbidden} must not be present"
            );
        }
        assert!(audit
            .access_masks
            .iter()
            .all(|mask| *mask == FILE_ALL_ACCESS));
    }

    #[test]
    fn first_xray_replacement_failure_keeps_canonical_absent() {
        let directory = unique_temp_dir("tachyon-test-xray-commit-first-replace-failure");
        fs::create_dir_all(&directory).unwrap();
        let canonical = directory.join("xray-client.json");

        commit_validated_xray_config_file(
            &canonical,
            "valid candidate",
            |_| Ok(xray_validation(true)),
            &FailingAtomicFileReplacer,
        )
        .expect_err("failed first replacement must not create canonical config");

        assert!(!canonical.exists());
        assert!(atomic_candidates(&directory, "xray-client.json").is_empty());
        let _ = fs::remove_dir_all(directory);
    }

    #[test]
    fn invalid_xray_commit_preserves_existing_config() {
        let directory = unique_temp_dir("tachyon-test-xray-commit-existing-invalid");
        fs::create_dir_all(&directory).unwrap();
        let canonical = directory.join("xray-client.json");
        fs::write(&canonical, b"old config").unwrap();

        commit_validated_xray_config_file(
            &canonical,
            "invalid candidate",
            |_| Ok(xray_validation(false)),
            &PlatformAtomicFileReplacer,
        )
        .expect_err("invalid replacement must fail");

        assert!(
            fs::read_to_string(&canonical).unwrap() == "old config",
            "invalid commit changed the existing Xray config"
        );
        assert!(atomic_candidates(&directory, "xray-client.json").is_empty());
        let _ = fs::remove_dir_all(directory);
    }

    #[test]
    fn xray_commit_replacement_failure_preserves_existing_config() {
        let directory = unique_temp_dir("tachyon-test-xray-commit-replace-failure");
        fs::create_dir_all(&directory).unwrap();
        let canonical = directory.join("xray-client.json");
        fs::write(&canonical, b"old config").unwrap();

        let error = commit_validated_xray_config_file(
            &canonical,
            "valid candidate",
            |_| Ok(xray_validation(true)),
            &FailingAtomicFileReplacer,
        )
        .expect_err("replacement failure must fail the commit");

        assert!(error.contains("injected atomic replacement failure"));
        assert!(
            fs::read_to_string(&canonical).unwrap() == "old config",
            "replacement failure changed the existing Xray config"
        );
        assert!(atomic_candidates(&directory, "xray-client.json").is_empty());
        let _ = fs::remove_dir_all(directory);
    }

    #[test]
    fn valid_xray_commit_atomically_replaces_existing_config() {
        let directory = unique_temp_dir("tachyon-test-xray-commit-success");
        fs::create_dir_all(&directory).unwrap();
        let canonical = directory.join("xray-client.json");
        fs::write(&canonical, b"old config").unwrap();

        let validation = commit_validated_xray_config_file(
            &canonical,
            "new config",
            |candidate| {
                assert!(
                    fs::read_to_string(candidate).unwrap() == "new config",
                    "Xray validator received different config contents"
                );
                Ok(xray_validation(true))
            },
            &PlatformAtomicFileReplacer,
        )
        .expect("valid candidate must replace the canonical config");

        assert!(validation.ok);
        assert!(
            fs::read_to_string(&canonical).unwrap() == "new config",
            "validated Xray config was not committed"
        );
        assert!(atomic_candidates(&directory, "xray-client.json").is_empty());
        let _ = fs::remove_dir_all(directory);
    }

    #[test]
    fn xray_commit_uses_json_candidate_and_cleans_it_when_validator_errors() {
        let directory = unique_temp_dir("tachyon-test-xray-commit-validator-error");
        fs::create_dir_all(&directory).unwrap();
        let canonical = directory.join("xray-client.json");
        let mut candidate_path = None;

        commit_validated_xray_config_file(
            &canonical,
            "candidate",
            |candidate| {
                candidate_path = Some(candidate.to_path_buf());
                Err("xray binary not found".to_string())
            },
            &PlatformAtomicFileReplacer,
        )
        .expect_err("validator execution error must fail the commit");

        let candidate = candidate_path.expect("validator saw candidate");
        assert_eq!(candidate.parent(), canonical.parent());
        assert_eq!(candidate.extension(), Some(std::ffi::OsStr::new("json")));
        assert!(
            candidate
                .file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.starts_with(".xray-client.")),
            "candidate must remain hidden beside the canonical config"
        );
        assert!(!candidate.exists());
        assert!(atomic_candidates(&directory, "xray-client.json").is_empty());
        let _ = fs::remove_dir_all(directory);
    }

    #[test]
    fn concurrent_xray_candidates_are_unique_json_files_and_cleaned_on_drop() {
        const WORKERS: usize = 8;

        let directory = unique_temp_dir("tachyon-test-xray-candidate-concurrency");
        fs::create_dir_all(&directory).unwrap();
        let canonical = Arc::new(directory.join("xray-client.json"));
        let barrier = Arc::new(std::sync::Barrier::new(WORKERS));
        let handles = (0..WORKERS)
            .map(|_| {
                let canonical = Arc::clone(&canonical);
                let barrier = Arc::clone(&barrier);
                thread::spawn(move || {
                    let candidate = SyncedTempFile::create(&canonical, "{}").unwrap();
                    let path = candidate.path.clone();
                    assert_eq!(path.parent(), canonical.parent());
                    assert_eq!(path.extension(), Some(std::ffi::OsStr::new("json")));
                    barrier.wait();
                    path
                })
            })
            .collect::<Vec<_>>();

        let candidates = handles
            .into_iter()
            .map(|handle| handle.join().expect("candidate worker must complete"))
            .collect::<std::collections::HashSet<_>>();

        assert_eq!(candidates.len(), WORKERS);
        assert!(candidates.iter().all(|candidate| !candidate.exists()));
        assert!(atomic_candidates(&directory, "xray-client.json").is_empty());
        let _ = fs::remove_dir_all(directory);
    }

    #[derive(Default)]
    struct FakeWindowsReplaceApi {
        calls: Mutex<Vec<&'static str>>,
        replace_error: Option<io::ErrorKind>,
        move_error: Option<io::ErrorKind>,
    }

    impl WindowsReplaceApi for FakeWindowsReplaceApi {
        fn replace_existing(&self, _candidate: &Path, _canonical: &Path) -> io::Result<()> {
            self.calls.lock().unwrap().push("replace");
            match self.replace_error {
                Some(kind) => Err(io::Error::from(kind)),
                None => Ok(()),
            }
        }

        fn move_replacing(&self, _candidate: &Path, _canonical: &Path) -> io::Result<()> {
            self.calls.lock().unwrap().push("move");
            match self.move_error {
                Some(kind) => Err(io::Error::from(kind)),
                None => Ok(()),
            }
        }
    }

    #[test]
    fn windows_replace_uses_move_only_when_destination_is_missing() {
        let api = FakeWindowsReplaceApi {
            replace_error: Some(io::ErrorKind::NotFound),
            ..FakeWindowsReplaceApi::default()
        };

        windows_atomic_replace_with(
            &api,
            Path::new("candidate.tmp"),
            Path::new("xray-client.json"),
        )
        .expect("missing destination must use write-through move");

        assert_eq!(*api.calls.lock().unwrap(), ["replace", "move"]);
    }

    #[test]
    fn windows_replace_does_not_move_over_locked_destination() {
        let api = FakeWindowsReplaceApi {
            replace_error: Some(io::ErrorKind::PermissionDenied),
            ..FakeWindowsReplaceApi::default()
        };

        let error = windows_atomic_replace_with(
            &api,
            Path::new("candidate.tmp"),
            Path::new("xray-client.json"),
        )
        .expect_err("locked destination must remain untouched");

        assert!(error.contains("atomically replace"));
        assert_eq!(*api.calls.lock().unwrap(), ["replace"]);
    }

    struct FakeStartAllTransaction {
        events: Vec<&'static str>,
        xray_start: Result<(), String>,
        xray_readiness: Result<(), String>,
        core_start: Result<(), String>,
        core_readiness: Result<(), String>,
        rollback_errors: Vec<String>,
    }

    impl Default for FakeStartAllTransaction {
        fn default() -> Self {
            Self {
                events: Vec::new(),
                xray_start: Ok(()),
                xray_readiness: Ok(()),
                core_start: Ok(()),
                core_readiness: Ok(()),
                rollback_errors: Vec::new(),
            }
        }
    }

    impl StartAllTransaction for FakeStartAllTransaction {
        fn start_xray(&mut self) -> Result<(), String> {
            self.events.push("startXray");
            self.xray_start.clone()
        }

        fn wait_xray_ready(&mut self) -> Result<(), String> {
            self.events.push("waitXray");
            self.xray_readiness.clone()
        }

        fn start_tachyon_core(&mut self) -> Result<(), String> {
            self.events.push("startCore");
            self.core_start.clone()
        }

        fn wait_tachyon_core_ready(&mut self) -> Result<(), String> {
            self.events.push("waitCore");
            self.core_readiness.clone()
        }

        fn rollback(&mut self) -> Vec<String> {
            self.events.push("rollback");
            self.rollback_errors.clone()
        }
    }

    #[test]
    fn start_all_transaction_requires_both_readiness_checks() {
        let mut transaction = FakeStartAllTransaction::default();

        execute_start_all(&mut transaction).expect("both cores are ready");

        assert_eq!(
            transaction.events,
            ["startXray", "waitXray", "startCore", "waitCore"]
        );
    }

    #[test]
    fn xray_start_failure_rolls_back_partial_start() {
        let mut transaction = FakeStartAllTransaction {
            xray_start: Err("poll xray after spawn: access denied".to_string()),
            ..FakeStartAllTransaction::default()
        };

        let error = execute_start_all(&mut transaction).expect_err("startup must fail");

        assert!(error.contains("poll xray after spawn: access denied"));
        assert!(error.contains("started cores were rolled back"));
        assert_eq!(transaction.events, ["startXray", "rollback"]);
    }

    #[test]
    fn readiness_timeout_is_bounded_and_rolls_back_started_xray() {
        let timeout = wait_for_readiness("Xray", Duration::ZERO, Duration::ZERO, |_| {
            Err("connection refused".to_string())
        })
        .expect_err("failed probe must time out");
        let mut transaction = FakeStartAllTransaction {
            xray_readiness: Err(timeout),
            ..FakeStartAllTransaction::default()
        };

        let error = execute_start_all(&mut transaction).expect_err("readiness must fail startup");

        assert!(error.contains("Xray readiness timed out after 0ms"));
        assert!(error.contains("started cores were rolled back"));
        assert_eq!(transaction.events, ["startXray", "waitXray", "rollback"]);
    }

    #[test]
    fn core_readiness_failure_preserves_rollback_errors() {
        let mut transaction = FakeStartAllTransaction {
            core_readiness: Err("Tachyon Core health returned status \"degraded\"".to_string()),
            rollback_errors: vec![
                "stop tachyon-core: access denied".to_string(),
                "stop xray: access denied".to_string(),
            ],
            ..FakeStartAllTransaction::default()
        };

        let error = execute_start_all(&mut transaction).expect_err("core readiness must fail");

        assert!(error.contains("status \"degraded\""));
        assert!(error.contains("stop tachyon-core: access denied"));
        assert!(error.contains("stop xray: access denied"));
        assert_eq!(
            transaction.events,
            ["startXray", "waitXray", "startCore", "waitCore", "rollback"]
        );
    }

    #[test]
    fn readiness_probes_reject_non_local_addresses() {
        assert_eq!(
            local_loopback_socket_addr("127.0.0.1", 1080, "test").unwrap(),
            "127.0.0.1:1080".parse().unwrap()
        );
        assert!(local_loopback_socket_addr("0.0.0.0", 1080, "test").is_err());
        assert!(local_loopback_socket_addr("[::]", 1080, "test").is_err());
        assert!(local_loopback_socket_addr("localhost", 1080, "test").is_err());
        assert!(local_loopback_socket_addr("198.51.100.10", 1080, "test").is_err());
        assert!(local_loopback_socket_addr("example.com", 1080, "test").is_err());
    }

    #[test]
    fn managed_listener_addresses_come_from_exact_generation_endpoints() {
        let settings = RuntimeSettings {
            xray_socks_listen: "127.0.0.1".to_string(),
            xray_socks_port: 10808,
            xray_http_listen: "127.0.0.1".to_string(),
            xray_http_port: 10809,
            ..RuntimeSettings::default()
        };
        let config = serde_json::json!({
            "inbounds": [
                {"tag": "imported-socks", "protocol": "socks", "listen": "127.0.0.2", "port": 20808},
                {"tag": "tachyon-socks", "protocol": "socks", "listen": "127.0.0.1", "port": 10808},
                {"tag": "tachyon-http", "protocol": "http", "listen": "127.0.0.1", "port": 10809}
            ]
        });

        assert_eq!(
            xray_managed_listener_addresses(&config, &settings).unwrap(),
            ["127.0.0.1:10808", "127.0.0.1:10809"]
        );
    }

    #[test]
    fn managed_listener_config_mismatch_and_duplicate_endpoint_fail_closed() {
        let settings = RuntimeSettings {
            xray_socks_listen: "127.0.0.1".to_string(),
            xray_socks_port: 10808,
            xray_http_listen: "127.0.0.1".to_string(),
            xray_http_port: 10809,
            ..RuntimeSettings::default()
        };
        let wrong_port = serde_json::json!({
            "inbounds": [
                {"protocol": "socks", "listen": "127.0.0.1", "port": 10999},
                {"protocol": "http", "listen": "127.0.0.1", "port": 10809}
            ]
        });
        assert!(xray_managed_listener_addresses(&wrong_port, &settings).is_err());

        let duplicate = serde_json::json!({
            "inbounds": [
                {"protocol": "socks", "listen": "127.0.0.1", "port": 10808},
                {"protocol": "socks", "listen": "127.0.0.1", "port": 10808},
                {"protocol": "http", "listen": "127.0.0.1", "port": 10809}
            ]
        });
        assert!(xray_managed_listener_addresses(&duplicate, &settings).is_err());
    }

    #[test]
    fn managed_listener_generation_requires_numeric_loopback_addresses() {
        let hostname = RuntimeSettings {
            xray_socks_listen: "localhost".to_string(),
            ..RuntimeSettings::default()
        };
        assert!(egress_probe_settings(&hostname).is_err());

        let non_loopback = RuntimeSettings {
            xray_http_listen: "0.0.0.0".to_string(),
            ..RuntimeSettings::default()
        };
        assert!(egress_probe_settings(&non_loopback).is_err());

        let numeric = egress_probe_settings(&RuntimeSettings {
            xray_http_listen: "127.0.0.1".to_string(),
            xray_socks_listen: "127.0.0.1".to_string(),
            ..RuntimeSettings::default()
        })
        .unwrap();
        assert_eq!(numeric.http_listen, "127.0.0.1");
        assert_eq!(numeric.socks_listen, "127.0.0.1");
    }

    #[test]
    fn listener_readiness_requires_every_endpoint_to_belong_to_candidate_pid() {
        let expected = [
            "127.0.0.1:10808".parse::<SocketAddr>().unwrap(),
            "127.0.0.1:10809".parse::<SocketAddr>().unwrap(),
        ];
        let occupied_by_other_process = [
            OwnedTcpListener {
                address: expected[0],
                pid: 9001,
            },
            OwnedTcpListener {
                address: expected[1],
                pid: 4200,
            },
        ];
        assert!(!listeners_owned_by_pid(
            &occupied_by_other_process,
            &expected,
            4200
        ));

        let candidate_owned = [
            OwnedTcpListener {
                address: expected[0],
                pid: 4200,
            },
            OwnedTcpListener {
                address: expected[1],
                pid: 4200,
            },
        ];
        assert!(listeners_owned_by_pid(&candidate_owned, &expected, 4200));
        assert!(!listeners_owned_by_pid(&candidate_owned, &expected, 4201));
    }

    #[test]
    fn watchdog_tcp_listener_fixture_child() {
        let Ok(port) = std::env::var("TACHYON_WATCHDOG_FIXTURE_PORT") else {
            return;
        };
        let ready_path = PathBuf::from(
            std::env::var_os("TACHYON_WATCHDOG_FIXTURE_READY")
                .expect("watchdog fixture ready path"),
        );
        let port = port.parse::<u16>().expect("watchdog fixture port");
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, port))
            .expect("fixture must own the requested TCP port");
        fs::write(&ready_path, format!("{}\n{}\n", std::process::id(), port))
            .expect("publish fixture PID");
        std::mem::forget(listener);
        loop {
            thread::sleep(Duration::from_millis(50));
        }
    }

    #[test]
    fn watchdog_recovers_mock_proxy_after_real_pid_kill_and_port_reoccupation() {
        let directory = unique_temp_dir("tachyon-test-proxy-watchdog");
        fs::create_dir_all(&directory).unwrap();
        let ready_a = directory.join("a.ready");
        let ready_b = directory.join("b.ready");
        let reservation = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let port = reservation.local_addr().unwrap().port();
        drop(reservation);

        let spawn_fixture = |ready: &Path| {
            Command::new(std::env::current_exe().expect("current test binary"))
                .args([
                    "--exact",
                    "tests::watchdog_tcp_listener_fixture_child",
                    "--nocapture",
                ])
                .env("TACHYON_WATCHDOG_FIXTURE_PORT", port.to_string())
                .env("TACHYON_WATCHDOG_FIXTURE_READY", ready)
                .spawn()
                .expect("spawn real TCP fixture")
        };
        let wait_ready = |ready: &Path| -> u32 {
            let deadline = Instant::now() + Duration::from_secs(5);
            loop {
                if let Ok(raw) = fs::read_to_string(ready) {
                    let mut lines = raw.lines();
                    let pid = lines
                        .next()
                        .and_then(|value| value.parse::<u32>().ok())
                        .expect("fixture PID");
                    let reported_port = lines
                        .next()
                        .and_then(|value| value.parse::<u16>().ok())
                        .expect("fixture port");
                    assert_eq!(reported_port, port);
                    if owned_tcp_listener_table(pid)
                        .map(|table| {
                            listeners_owned_by_pid(
                                &table,
                                &[SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), port)],
                                pid,
                            )
                        })
                        .unwrap_or(false)
                    {
                        return pid;
                    }
                }
                assert!(
                    Instant::now() < deadline,
                    "real TCP fixture did not become owned"
                );
                thread::sleep(Duration::from_millis(25));
            }
        };

        let mut first = spawn_fixture(&ready_a);
        let first_pid = wait_ready(&ready_a);
        let generation_id = {
            let mut runtime = xray_generation::GenerationRuntime::default();
            runtime
                .select_desired(b"{}", "fixture".to_string(), "1".to_string(), vec![])
                .unwrap()
        };
        let listener = SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), port);
        let active = xray_generation::GenerationView {
            generation_id: generation_id.clone(),
            config_sha256: "fixture".to_string(),
            node_id: "fixture".to_string(),
            routing_revision: "1".to_string(),
            pid: Some(first_pid),
            managed_listener_addresses: vec![listener.to_string()],
            egress_probe: xray_generation::EgressProbeSettings::default(),
            egress_verified: true,
            readiness: xray_generation::ReadinessLevel::EgressReady,
        };
        let status = xray_generation::GenerationStatus {
            desired: None,
            active: Some(active),
            proxy_generation: Some(xray_generation::ProxyGenerationView {
                generation_id: generation_id.clone(),
                pid: first_pid,
            }),
            phase: xray_generation::GenerationPhase::Idle,
            proxy_ready: true,
            last_error_code: None,
        };
        let proxy_settings = RuntimeSettings {
            xray_http_listen: "127.0.0.1".to_string(),
            xray_http_port: 10809,
            xray_socks_listen: "127.0.0.1".to_string(),
            xray_socks_port: 10808,
            system_proxy_bypass: "localhost;127.*;<local>".to_string(),
            ..RuntimeSettings::default()
        };
        let proxy_runtime = system_proxy::SystemProxyRuntime::default();
        let registry =
            system_proxy::TestRegistryOps::from_state(true, "existing.proxy:3128", "localhost");
        let journal_path = directory.join("system-proxy-transaction.json");
        let applied =
            system_proxy::apply_with_registry(&registry, &proxy_settings, &journal_path, true)
                .expect("apply isolated system proxy transaction");
        let applied_readback =
            system_proxy::readback_with_registry(&registry, &proxy_settings, &journal_path)
                .expect("read isolated system proxy transaction");
        assert_eq!(
            applied_readback
                .pending_transaction
                .as_ref()
                .map(|pending| pending.transaction_id.as_str()),
            Some(applied.transaction_id.as_str())
        );
        assert!(applied_readback.current.enabled);
        assert!(journal_path.exists());
        assert!(watchdog_binding_is_current(
            &status,
            &generation_id,
            first_pid,
            true,
            true,
            true,
        ));

        first.kill().unwrap();
        first.wait().unwrap();
        let mut second = spawn_fixture(&ready_b);
        let second_pid = wait_ready(&ready_b);
        assert_ne!(first_pid, second_pid);
        let first_listener_owned = owned_tcp_listener_table(first_pid)
            .map(|table| listeners_owned_by_pid(&table, &[listener], first_pid))
            .unwrap_or(false);
        let second_listener_owned = owned_tcp_listener_table(second_pid)
            .map(|table| listeners_owned_by_pid(&table, &[listener], second_pid))
            .unwrap_or(false);
        assert!(
            !first_listener_owned,
            "the killed PID must lose listener ownership"
        );
        assert!(
            second_listener_owned,
            "the replacement PID must own the port"
        );

        let healthy = watchdog_binding_is_current(
            &status,
            &generation_id,
            first_pid,
            false,
            first_listener_owned,
            true,
        );
        assert!(
            !healthy,
            "watchdog must reject a dead PID and reoccupied listener"
        );
        assert!(!healthy);
        let mut recovery_runtime = xray_generation::GenerationRuntime::default();
        recovery_runtime
            .select_desired(b"{}", "fixture".to_string(), "1".to_string(), vec![])
            .unwrap();
        recover_proxy_binding_after_watchdog(&mut recovery_runtime, || {
            system_proxy::restore_if_pending_with_registry(
                &proxy_runtime,
                &registry,
                &proxy_settings,
                &journal_path,
            )
        });
        let recovered = recovery_runtime.status();
        let restored_readback =
            system_proxy::readback_with_registry(&registry, &proxy_settings, &journal_path)
                .expect("read restored isolated system proxy transaction");
        assert!(!recovered.proxy_ready);
        assert!(recovered.proxy_generation.is_none());
        assert_eq!(recovered.phase, xray_generation::GenerationPhase::Degraded);
        assert_eq!(
            recovered.last_error_code.as_deref(),
            Some("proxyWatchdogFailed")
        );
        assert_eq!(
            restored_readback.current.proxy_server,
            "existing.proxy:3128"
        );
        assert_eq!(restored_readback.current.bypass, "localhost");
        assert!(restored_readback.current.enabled);
        assert!(!restored_readback.current.matches_prism);
        assert!(restored_readback.pending_transaction.is_none());
        assert!(!journal_path.exists());

        second.kill().unwrap();
        second.wait().unwrap();
        let _ = fs::remove_dir_all(directory);
    }

    #[test]
    fn xray_stats_server_uses_local_connectable_addresses() {
        let ipv4 = RuntimeSettings {
            xray_stats_listen: "0.0.0.0".to_string(),
            xray_stats_port: 10085,
            ..RuntimeSettings::default()
        };
        assert!(xray_stats_server(&ipv4).is_err());

        let ipv6 = RuntimeSettings {
            xray_stats_listen: "::1".to_string(),
            xray_stats_port: 10086,
            ..RuntimeSettings::default()
        };
        assert_eq!(xray_stats_server(&ipv6).unwrap(), "[::1]:10086");

        let remote = RuntimeSettings {
            xray_stats_listen: "198.51.100.10".to_string(),
            xray_stats_port: 10085,
            ..RuntimeSettings::default()
        };
        assert!(xray_stats_server(&remote).is_err());

        let hostname = RuntimeSettings {
            xray_stats_listen: "localhost".to_string(),
            xray_stats_port: 10085,
            ..RuntimeSettings::default()
        };
        assert!(xray_stats_server(&hostname).is_err());
    }

    #[test]
    fn process_log_tail_is_utf8_safe_and_bounded() {
        let tail = Mutex::new(String::new());
        append_log_tail(&tail, &"日志".repeat(PROCESS_LOG_TAIL_BYTES));
        let snapshot = log_tail_snapshot(&tail);

        assert!(snapshot.len() <= PROCESS_LOG_TAIL_BYTES);
        assert!(snapshot.is_char_boundary(0));
        assert!(snapshot.ends_with("日志"));
    }

    #[test]
    fn process_logs_query_rejects_unknown_kind() {
        let processes = RuntimeProcesses::default();
        assert!(processes.logs("not-a-core").is_err());
    }

    #[test]
    fn production_xray_commands_have_no_process_bypass() {
        let source = include_str!("lib.rs");
        let forbidden_deref = ["impl std::ops::Deref", " for XrayCoordinator"].concat();
        assert!(!source.contains(&forbidden_deref));
        for (name, expected) in [
            ("start_xray", "coordinator.apply_xray"),
            ("stop_xray", "coordinator.stop_xray"),
            ("start_all", "coordinator.start_all"),
            ("stop_all", "coordinator.stop_all"),
        ] {
            let body = tauri_command_body(source, name);
            assert!(body.contains(expected), "{name} must call {expected}");
            assert!(!body.contains(".processes.xray.start"));
            assert!(!body.contains(".processes.xray.stop"));
        }
        let cleanup = rust_function_body(source, "fn cleanup_runtime(");
        assert!(cleanup.contains("coordinator.stop_all"));
        assert!(!cleanup.contains(".processes.xray.stop"));
    }

    fn tauri_command_body<'a>(source: &'a str, name: &str) -> &'a str {
        rust_function_body(source, &format!("#[tauri::command]\nfn {name}("))
    }

    fn rust_function_body<'a>(source: &'a str, marker: &str) -> &'a str {
        let start = source.find(marker).expect("function marker");
        let open = source[start..].find('{').expect("function open") + start;
        let mut depth = 0_i32;
        for (offset, character) in source[open..].char_indices() {
            match character {
                '{' => depth += 1,
                '}' => {
                    depth -= 1;
                    if depth == 0 {
                        return &source[open..=open + offset];
                    }
                }
                _ => {}
            }
        }
        panic!("unterminated function for {marker}")
    }

    #[test]
    fn selects_tachyon_core_asset_for_current_platform() {
        let marker = tachyon_core_platform_asset_marker().expect("supported test platform");
        let release = GithubRelease {
            tag_name: "v0.1.0-alpha.1".to_string(),
            published_at: Some("2026-06-05T00:00:00Z".to_string()),
            prerelease: true,
            assets: vec![
                asset("tachyon-core_v0.1.0-alpha.1_windows_386.zip", 101),
                asset("tachyon-core_v0.1.0-alpha.1_windows_amd64.zip", 102),
                asset("tachyon-core_v0.1.0-alpha.1_windows_arm64.zip", 103),
                asset("tachyon-core_v0.1.0-alpha.1_darwin_amd64.zip", 104),
                asset("tachyon-core_v0.1.0-alpha.1_darwin_arm64.zip", 105),
                asset("tachyon-core_v0.1.0-alpha.1_linux_amd64.zip", 106),
                asset("tachyon-core_v0.1.0-alpha.1_linux_arm64.zip", 107),
                asset("SHA256SUMS.txt", 512),
            ],
        };

        let info = tachyon_core_release_info(release).expect("release info");

        assert!(info.asset_name.contains(marker));
        assert_eq!(info.checksum_asset_name, "SHA256SUMS.txt");
        assert_eq!(info.tag_name, "v0.1.0-alpha.1");
    }

    #[test]
    fn parses_checksum_line_for_asset() {
        let checksum = find_checksum_for_asset(
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa  tachyon-core_v0.1.0-alpha.1_windows_amd64.zip\n",
            "tachyon-core_v0.1.0-alpha.1_windows_amd64.zip",
        )
        .expect("checksum");

        assert_eq!(
            checksum,
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        );
    }

    #[test]
    fn reports_wintun_sidecar_for_tachyon_core_on_windows() {
        let binary_path = if cfg!(target_os = "windows") {
            Path::new("C:\\Tachyon\\tachyon-core.exe")
        } else {
            Path::new("/opt/tachyon/tachyon-core")
        };
        let deps = sidecar_dependencies(ManagedBinaryKind::TachyonCore, binary_path);

        if cfg!(target_os = "windows") {
            assert_eq!(deps.len(), 1);
            assert_eq!(deps[0].name, "wintun.dll");
            assert!(deps[0].path.ends_with("wintun.dll"));
            assert!(deps[0].required);
        } else {
            assert!(deps.is_empty());
        }
    }

    #[test]
    fn parses_steam_library_paths() {
        let raw = r#"
        "libraryfolders"
        {
          "0"
          {
            "path" "C:\\Program Files (x86)\\Steam"
          }
          "1"
          {
            "path" "D:\\SteamLibrary"
          }
        }
        "#;

        let paths = vdf_values_for_key(raw, "path");

        assert_eq!(
            paths,
            vec![
                "C:\\Program Files (x86)\\Steam".to_string(),
                "D:\\SteamLibrary".to_string()
            ]
        );
    }

    #[test]
    fn parses_steam_app_manifest() {
        let raw = r#"
        "AppState"
        {
          "appid" "730"
          "Universe" "1"
          "name" "Counter-Strike 2"
          "StateFlags" "4"
          "installdir" "Counter-Strike Global Offensive"
        }
        "#;

        let app = parse_steam_app_manifest(raw, Path::new("D:\\SteamLibrary")).expect("manifest");

        assert_eq!(app.app_id, 730);
        assert_eq!(app.name, "Counter-Strike 2");
        assert_eq!(app.install_dir, "Counter-Strike Global Offensive");
        assert_eq!(app.state_flags, 4);
    }

    #[test]
    fn validates_game_profile_rejects_empty_id() {
        let profile = GameProfile {
            id: "".to_string(),
            display_name: "Test".to_string(),
            enabled: true,
            manual: true,
            priority: 100,
            match_rule: MatchRule {
                process_names: vec!["test.exe".to_string()],
                paths: Vec::new(),
                path_prefixes: Vec::new(),
                sha256: Vec::new(),
                steam_app_ids: Vec::new(),
            },
            udp_policy: "tgp".to_string(),
            tcp_policy: "auto".to_string(),
        };
        assert!(validate_game_profile(&profile).is_err());
    }

    #[test]
    fn validates_game_profile_rejects_empty_display_name() {
        let profile = GameProfile {
            id: "test".to_string(),
            display_name: "  ".to_string(),
            enabled: true,
            manual: true,
            priority: 100,
            match_rule: MatchRule {
                process_names: vec!["test.exe".to_string()],
                paths: Vec::new(),
                path_prefixes: Vec::new(),
                sha256: Vec::new(),
                steam_app_ids: Vec::new(),
            },
            udp_policy: "tgp".to_string(),
            tcp_policy: "auto".to_string(),
        };
        assert!(validate_game_profile(&profile).is_err());
    }

    #[test]
    fn validates_game_profile_rejects_no_match_rules() {
        let profile = GameProfile {
            id: "test".to_string(),
            display_name: "Test".to_string(),
            enabled: true,
            manual: true,
            priority: 100,
            match_rule: MatchRule {
                process_names: Vec::new(),
                paths: Vec::new(),
                path_prefixes: Vec::new(),
                sha256: Vec::new(),
                steam_app_ids: Vec::new(),
            },
            udp_policy: "tgp".to_string(),
            tcp_policy: "auto".to_string(),
        };
        assert!(validate_game_profile(&profile).is_err());
    }

    #[test]
    fn validates_game_profile_accepts_any_single_match_rule() {
        let profile = GameProfile {
            id: "test".to_string(),
            display_name: "Test".to_string(),
            enabled: true,
            manual: true,
            priority: 100,
            match_rule: MatchRule {
                process_names: vec!["test.exe".to_string()],
                paths: Vec::new(),
                path_prefixes: Vec::new(),
                sha256: Vec::new(),
                steam_app_ids: Vec::new(),
            },
            udp_policy: "tgp".to_string(),
            tcp_policy: "auto".to_string(),
        };
        assert!(validate_game_profile(&profile).is_ok());
    }

    #[test]
    fn sorts_game_profiles_by_priority_desc_then_name_asc() {
        let mut profiles = vec![
            GameProfile {
                id: "b".to_string(),
                display_name: "B Game".to_string(),
                enabled: true,
                manual: true,
                priority: 50,
                match_rule: MatchRule {
                    process_names: vec!["b.exe".to_string()],
                    paths: Vec::new(),
                    path_prefixes: Vec::new(),
                    sha256: Vec::new(),
                    steam_app_ids: Vec::new(),
                },
                udp_policy: "tgp".to_string(),
                tcp_policy: "auto".to_string(),
            },
            GameProfile {
                id: "a".to_string(),
                display_name: "A Game".to_string(),
                enabled: true,
                manual: true,
                priority: 100,
                match_rule: MatchRule {
                    process_names: vec!["a.exe".to_string()],
                    paths: Vec::new(),
                    path_prefixes: Vec::new(),
                    sha256: Vec::new(),
                    steam_app_ids: Vec::new(),
                },
                udp_policy: "tgp".to_string(),
                tcp_policy: "auto".to_string(),
            },
            GameProfile {
                id: "c".to_string(),
                display_name: "A Game 2".to_string(),
                enabled: true,
                manual: true,
                priority: 50,
                match_rule: MatchRule {
                    process_names: vec!["c.exe".to_string()],
                    paths: Vec::new(),
                    path_prefixes: Vec::new(),
                    sha256: Vec::new(),
                    steam_app_ids: Vec::new(),
                },
                udp_policy: "tgp".to_string(),
                tcp_policy: "auto".to_string(),
            },
        ];
        sort_game_profiles(&mut profiles);
        assert_eq!(profiles[0].id, "a");
        assert_eq!(profiles[0].priority, 100);
        assert_eq!(profiles[1].id, "c");
        assert_eq!(profiles[2].id, "b");
    }

    #[test]
    fn sanitize_replaces_special_characters() {
        assert_eq!(sanitize_file_component("v1.0.0"), "v1.0.0");
        assert_eq!(sanitize_file_component("hello world!"), "hello_world_");
        assert_eq!(sanitize_file_component(""), "release");
        assert_eq!(sanitize_file_component("abc/def\\ghi"), "abc_def_ghi");
    }

    #[test]
    fn vdf_parses_empty_input() {
        let values = vdf_values_for_key("", "path");
        assert!(values.is_empty());
    }

    #[test]
    fn vdf_parses_multiple_values_for_same_key() {
        let raw = r#""key" "first" "key" "second" "other" "skip""#;
        let values: Vec<_> = vdf_values_for_key(raw, "key");
        assert_eq!(values, vec!["first".to_string(), "second".to_string()]);
    }

    #[test]
    fn vdf_handles_case_insensitive_key_matching() {
        let raw = r#""AppId" "730" "appid" "440""#;
        assert_eq!(first_vdf_value(raw, "appid").unwrap(), "730");
        assert_eq!(first_vdf_value(raw, "APPID").unwrap(), "730");
    }

    #[test]
    fn steam_app_manifest_skips_non_manifest_files() {
        assert!(parse_steam_app_manifest("no appid here", Path::new("C:\\Steam")).is_none());
    }

    #[test]
    fn steam_profile_from_app_sets_steam_prefix_id() {
        let app = SteamAppManifest {
            app_id: 570,
            name: "Dota 2".to_string(),
            install_dir: "dota 2 beta".to_string(),
            universe: "1".to_string(),
            state_flags: 4,
            library_path: "D:\\SteamLibrary".to_string(),
        };
        let profile = steam_profile_from_app(&app);
        assert_eq!(profile.id, "steam-570");
        assert_eq!(profile.display_name, "Dota 2");
        assert!(!profile.manual);
        assert!(profile.match_rule.steam_app_ids.contains(&570));
        assert!(profile
            .match_rule
            .path_prefixes
            .iter()
            .any(|p| p.contains("dota 2 beta")));
    }

    #[test]
    fn checksum_find_handles_various_formats() {
        let hash = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
        let checksum = find_checksum_for_asset(&format!("{hash} *binary.zip"), "binary.zip")
            .expect("checksum with star");
        assert_eq!(checksum, hash);
    }

    #[test]
    fn checksum_find_handles_equals_separator() {
        let hash = "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
        let checksum =
            find_checksum_for_asset(&format!("SHA256 (binary.zip) = {hash}"), "binary.zip")
                .expect("checksum with equals");
        assert_eq!(checksum, hash);
    }

    #[test]
    fn checksum_find_accepts_prism_space_dot_filename_alias() {
        let hash = "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";
        let checksum = find_checksum_for_asset(
            &format!("{hash}  tachyon-prism-windows-x64_Tachyon Prism_0.1.0_x64-setup.exe"),
            "tachyon-prism-windows-x64_Tachyon.Prism_0.1.0_x64-setup.exe",
        )
        .expect("checksum with Prism filename alias");

        assert_eq!(checksum, hash);
    }

    #[test]
    fn checksum_find_requires_exact_filename_or_alias() {
        let wrong_hash = "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
        let right_hash = "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";
        let checksum = find_checksum_for_asset(
            &format!("{wrong_hash}  binary.zip.sig\n{right_hash}  binary.zip"),
            "binary.zip",
        )
        .expect("checksum");

        assert_eq!(checksum, right_hash);
    }

    #[test]
    fn sha256_computes_deterministic_hash() {
        let dir = std::env::temp_dir().join("tachyon-test-sha256");
        let _ = std::fs::create_dir_all(&dir);
        let file = dir.join("test.bin");
        std::fs::write(&file, b"hello tachyon").unwrap();
        let hash1 = sha256_file(&file).expect("hash1");
        let hash2 = sha256_file(&file).expect("hash2");
        assert_eq!(hash1, hash2);
        assert_eq!(hash1.len(), 64);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn managed_binary_kind_parse_rejects_unknown() {
        assert!(ManagedBinaryKind::parse("unknown").is_err());
        assert!(ManagedBinaryKind::parse("").is_err());
    }

    #[test]
    fn managed_binary_kind_parses_valid_kinds() {
        assert!(ManagedBinaryKind::parse("tachyonCore").is_ok());
        assert!(ManagedBinaryKind::parse("xray").is_ok());
    }

    #[test]
    fn xray_asset_marker_is_valid_on_any_platform() {
        let result = xray_platform_asset_marker();
        assert!(result.is_ok(), "xray asset marker failed: {result:?}");
    }

    #[test]
    fn tachyon_core_asset_marker_is_valid_on_any_platform() {
        let result = tachyon_core_platform_asset_marker();
        assert!(
            result.is_ok(),
            "tachyon core asset marker failed: {result:?}"
        );
    }

    #[test]
    fn tachyon_core_release_info_errors_on_empty_assets() {
        let release = GithubRelease {
            tag_name: "v0.1.0".to_string(),
            published_at: None,
            prerelease: false,
            assets: vec![],
        };
        assert!(tachyon_core_release_info(release).is_err());
    }

    #[test]
    fn latest_tachyon_core_release_skips_incompatible_releases() {
        let marker = tachyon_core_platform_asset_marker().expect("supported test platform");
        let incompatible = GithubRelease {
            tag_name: "v0.1.0-alpha.4".to_string(),
            published_at: Some("2026-06-12T00:00:00Z".to_string()),
            prerelease: true,
            assets: vec![asset("notes.txt", 10)],
        };
        let compatible = GithubRelease {
            tag_name: "v0.1.0-alpha.3".to_string(),
            published_at: Some("2026-06-11T00:00:00Z".to_string()),
            prerelease: true,
            assets: vec![
                asset(&format!("tachyon-core_v0.1.0-alpha.3_{marker}.zip"), 123),
                asset("SHA256SUMS.txt", 512),
            ],
        };

        let info = latest_tachyon_core_release_info(vec![incompatible, compatible], "preview")
            .expect("compatible release");

        assert_eq!(info.tag_name, "v0.1.0-alpha.3");
        assert!(info.asset_name.contains(marker));
    }

    #[test]
    fn stable_release_channel_skips_prereleases() {
        let marker = tachyon_core_platform_asset_marker().expect("supported test platform");
        let preview = GithubRelease {
            tag_name: "v0.2.0-alpha.1".to_string(),
            published_at: Some("2026-06-12T00:00:00Z".to_string()),
            prerelease: true,
            assets: vec![
                asset(&format!("tachyon-core_v0.2.0-alpha.1_{marker}.zip"), 123),
                asset("SHA256SUMS.txt", 512),
            ],
        };
        let stable = GithubRelease {
            tag_name: "v0.1.0".to_string(),
            published_at: Some("2026-06-01T00:00:00Z".to_string()),
            prerelease: false,
            assets: vec![
                asset(&format!("tachyon-core_v0.1.0_{marker}.zip"), 123),
                asset("SHA256SUMS.txt", 512),
            ],
        };

        let info = latest_tachyon_core_release_info(vec![preview, stable], "stable")
            .expect("stable release");

        assert_eq!(info.tag_name, "v0.1.0");
    }

    #[test]
    fn stable_release_channel_explains_when_only_prereleases_exist() {
        let marker = tachyon_core_platform_asset_marker().expect("supported test platform");
        let preview = GithubRelease {
            tag_name: "v0.2.0-alpha.1".to_string(),
            published_at: Some("2026-06-12T00:00:00Z".to_string()),
            prerelease: true,
            assets: vec![
                asset(&format!("tachyon-core_v0.2.0-alpha.1_{marker}.zip"), 123),
                asset("SHA256SUMS.txt", 512),
            ],
        };

        let error = match latest_tachyon_core_release_info(vec![preview], "stable") {
            Ok(_) => panic!("stable should not silently select prerelease builds"),
            Err(error) => error,
        };

        assert!(error.contains("stable release"));
        assert!(error.contains("Switch the release channel to Pre"));
    }

    #[test]
    fn preview_release_channel_allows_prereleases() {
        let marker = tachyon_core_platform_asset_marker().expect("supported test platform");
        let preview = GithubRelease {
            tag_name: "v0.1.0-alpha.8".to_string(),
            published_at: Some("2026-06-30T00:00:00Z".to_string()),
            prerelease: true,
            assets: vec![
                asset(&format!("tachyon-core_v0.1.0-alpha.8_{marker}.zip"), 123),
                asset("SHA256SUMS.txt", 512),
            ],
        };
        let stable = GithubRelease {
            tag_name: "v0.1.0".to_string(),
            published_at: Some("2026-06-01T00:00:00Z".to_string()),
            prerelease: false,
            assets: vec![
                asset(&format!("tachyon-core_v0.1.0_{marker}.zip"), 123),
                asset("SHA256SUMS.txt", 512),
            ],
        };

        let info = latest_tachyon_core_release_info(vec![preview, stable], "pre")
            .expect("preview release");

        assert_eq!(info.tag_name, "v0.1.0-alpha.8");
        assert!(info.asset_name.contains(marker));
    }

    #[test]
    fn preview_release_channel_prefers_prereleases_before_stable() {
        let marker = tachyon_core_platform_asset_marker().expect("supported test platform");
        let stable = GithubRelease {
            tag_name: "v0.1.0".to_string(),
            published_at: Some("2026-06-01T00:00:00Z".to_string()),
            prerelease: false,
            assets: vec![
                asset(&format!("tachyon-core_v0.1.0_{marker}.zip"), 123),
                asset("SHA256SUMS.txt", 512),
            ],
        };
        let preview = GithubRelease {
            tag_name: "v0.1.0-alpha.12".to_string(),
            published_at: Some("2026-07-03T00:00:00Z".to_string()),
            prerelease: true,
            assets: vec![
                asset(&format!("tachyon-core_v0.1.0-alpha.12_{marker}.zip"), 123),
                asset("SHA256SUMS.txt", 512),
            ],
        };

        let info = latest_tachyon_core_release_info(vec![stable, preview], "pre")
            .expect("preview release");

        assert_eq!(info.tag_name, "v0.1.0-alpha.12");
        assert!(info.asset_name.contains(marker));
    }

    #[test]
    fn xray_release_info_errors_on_empty_assets() {
        let release = GithubRelease {
            tag_name: "v0.1.0".to_string(),
            published_at: None,
            prerelease: false,
            assets: vec![],
        };
        assert!(xray_release_info(release).is_err());
    }

    #[test]
    fn release_diagnostics_keeps_preview_prerelease_selection() {
        let marker = tachyon_core_platform_asset_marker().expect("supported test platform");
        let preview = GithubRelease {
            tag_name: "v0.2.0-alpha.1".to_string(),
            published_at: Some("2026-07-03T00:00:00Z".to_string()),
            prerelease: true,
            assets: vec![
                asset(&format!("tachyon-core_v0.2.0-alpha.1_{marker}.zip"), 123),
                asset("SHA256SUMS.txt", 512),
            ],
        };
        let release = latest_tachyon_core_release_info(vec![preview], "preview");

        let diagnostics = core_release_diagnostics_from_parts(
            ManagedBinaryKind::TachyonCore,
            "preview",
            Path::new("missing-tachyon-core"),
            release,
            None,
            |_| {
                Ok(format!(
                    "{}  tachyon-core_v0.2.0-alpha.1_{marker}.zip",
                    "a".repeat(64)
                ))
            },
        );

        assert_eq!(diagnostics.selected_channel, "preview");
        assert_eq!(diagnostics.resolved_tag.as_deref(), Some("v0.2.0-alpha.1"));
        assert!(diagnostics.asset_name.as_deref().unwrap().contains(marker));
        assert_eq!(diagnostics.checksum_match, None);
    }

    #[test]
    fn release_diagnostics_reports_stable_empty_state() {
        let marker = tachyon_core_platform_asset_marker().expect("supported test platform");
        let preview = GithubRelease {
            tag_name: "v0.2.0-alpha.1".to_string(),
            published_at: Some("2026-07-03T00:00:00Z".to_string()),
            prerelease: true,
            assets: vec![
                asset(&format!("tachyon-core_v0.2.0-alpha.1_{marker}.zip"), 123),
                asset("SHA256SUMS.txt", 512),
            ],
        };
        let release = latest_tachyon_core_release_info(vec![preview], "stable");

        let diagnostics = core_release_diagnostics_from_parts(
            ManagedBinaryKind::TachyonCore,
            "stable",
            Path::new("missing-tachyon-core"),
            release,
            None,
            |_| unreachable!("checksum is not fetched when release resolution fails"),
        );

        assert_eq!(diagnostics.selected_channel, "stable");
        assert!(diagnostics.resolved_tag.is_none());
        assert!(diagnostics.asset_name.is_none());
        assert!(diagnostics
            .last_error
            .as_deref()
            .unwrap()
            .contains("stable release"));
    }

    #[test]
    fn release_diagnostics_shows_selected_asset_name() {
        let release = RuntimeReleaseInfo {
            tag_name: "v-test".to_string(),
            asset_name: "xray-windows-64.zip".to_string(),
            asset_url: "https://example.invalid/xray-windows-64.zip".to_string(),
            asset_size_bytes: 4096,
            checksum_asset_name: "xray-windows-64.zip.dgst".to_string(),
            checksum_url: "https://example.invalid/xray-windows-64.zip.dgst".to_string(),
            published_at: None,
        };

        let diagnostics = core_release_diagnostics_from_parts(
            ManagedBinaryKind::Xray,
            "stable",
            Path::new("missing-xray"),
            Ok(release),
            None,
            |_| Ok(format!("{}  xray-windows-64.zip", "b".repeat(64))),
        );

        assert_eq!(diagnostics.resolved_tag.as_deref(), Some("v-test"));
        assert_eq!(
            diagnostics.asset_name.as_deref(),
            Some("xray-windows-64.zip")
        );
        assert_eq!(
            diagnostics.checksum_asset_name.as_deref(),
            Some("xray-windows-64.zip.dgst")
        );
    }

    #[test]
    fn release_diagnostics_reports_checksum_match_for_cached_archive() {
        let dir = unique_temp_dir("tachyon-test-diagnostic-checksum");
        let archive = dir.join("binary.zip");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(&archive, b"diagnostic archive").unwrap();
        let hash = sha256_file(&archive).unwrap();
        let release = test_release_info("binary.zip");

        let diagnostics = core_release_diagnostics_from_parts(
            ManagedBinaryKind::Xray,
            "stable",
            Path::new("missing-xray"),
            Ok(release),
            Some(&archive),
            |_| Ok(format!("{hash}  binary.zip")),
        );

        assert_eq!(
            diagnostics.checksum_expected_sha256.as_deref(),
            Some(hash.as_str())
        );
        assert_eq!(
            diagnostics.checksum_actual_sha256.as_deref(),
            Some(hash.as_str())
        );
        assert_eq!(diagnostics.checksum_match, Some(true));
        assert!(diagnostics.last_error.is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn release_diagnostics_does_not_spawn_installed_binary_for_version() {
        let dir = unique_temp_dir("tachyon-test-diagnostic-no-spawn");
        std::fs::create_dir_all(&dir).unwrap();
        let spawn_marker = dir.join("spawned.txt");
        let installed = dir.join(if cfg!(windows) {
            "diagnostic-version-sentinel.cmd"
        } else {
            "diagnostic-version-sentinel"
        });

        #[cfg(windows)]
        std::fs::write(
            &installed,
            "@echo off\r\n> \"%~dp0spawned.txt\" echo spawned\r\necho sentinel version\r\n",
        )
        .unwrap();

        #[cfg(not(windows))]
        {
            std::fs::write(
                &installed,
                "#!/bin/sh\necho spawned > \"$(dirname \"$0\")/spawned.txt\"\necho sentinel version\n",
            )
            .unwrap();
            make_executable(&installed).unwrap();
        }

        let release = test_release_info("binary.zip");
        let diagnostics = core_release_diagnostics_from_parts(
            ManagedBinaryKind::Xray,
            "stable",
            &installed,
            Ok(release),
            None,
            |_| Ok(format!("{}  binary.zip", "c".repeat(64))),
        );

        assert!(diagnostics.installed_exists);
        assert_eq!(diagnostics.installed_path, path_string(&installed));
        assert!(diagnostics.installed_version.is_none());
        assert!(diagnostics.last_error.is_none());
        assert!(!spawn_marker.exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn release_diagnostics_uses_checksum_aliases() {
        let dir = unique_temp_dir("tachyon-test-diagnostic-alias");
        let archive = dir.join("tachyon-prism-windows-x64_Tachyon.Prism_0.1.0_x64-setup.exe");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(&archive, b"diagnostic alias archive").unwrap();
        let hash = sha256_file(&archive).unwrap();
        let release =
            test_release_info("tachyon-prism-windows-x64_Tachyon.Prism_0.1.0_x64-setup.exe");

        let diagnostics = core_release_diagnostics_from_parts(
            ManagedBinaryKind::Xray,
            "stable",
            Path::new("missing-xray"),
            Ok(release),
            Some(&archive),
            |_| {
                Ok(format!(
                    "{hash}  tachyon-prism-windows-x64_Tachyon Prism_0.1.0_x64-setup.exe"
                ))
            },
        );

        assert_eq!(diagnostics.checksum_match, Some(true));
        assert_eq!(
            diagnostics.checksum_expected_sha256.as_deref(),
            Some(hash.as_str())
        );
        assert!(diagnostics.last_error.is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn release_diagnostics_keeps_checksum_download_error() {
        let release = test_release_info("binary.zip");

        let diagnostics = core_release_diagnostics_from_parts(
            ManagedBinaryKind::Xray,
            "stable",
            Path::new("missing-xray"),
            Ok(release),
            None,
            |_| Err("request https://example.invalid/SHA256SUMS.txt: network down".to_string()),
        );

        assert_eq!(diagnostics.resolved_tag.as_deref(), Some("v-test"));
        assert!(diagnostics.checksum_expected_sha256.is_none());
        assert!(diagnostics
            .last_error
            .as_deref()
            .unwrap()
            .contains("network down"));
    }

    #[test]
    fn ensure_json_object_rejects_arrays() {
        assert!(ensure_json_object("test", "[]").is_err());
        assert!(ensure_json_object("test", "[1, 2]").is_err());
    }

    #[test]
    fn ensure_json_object_rejects_non_json() {
        assert!(ensure_json_object("test", "not json").is_err());
    }

    #[test]
    fn ensure_json_object_accepts_objects() {
        assert!(ensure_json_object("test", "{}").is_ok());
        assert!(ensure_json_object("test", "{\"key\": \"value\"}").is_ok());
    }

    #[test]
    fn binary_metadata_reports_missing_file() {
        let path = std::env::temp_dir().join("tachyon-test-nonexistent.exe");
        let meta = binary_metadata(&path);
        assert!(!meta.exists);
        assert!(meta.size_bytes.is_none());
        assert!(meta.modified_at.is_none());
    }

    #[test]
    fn binary_metadata_reports_existing_file() {
        let dir = std::env::temp_dir().join("tachyon-test-meta");
        let _ = std::fs::create_dir_all(&dir);
        let file = dir.join("real.exe");
        std::fs::write(&file, b"binary content").unwrap();
        let meta = binary_metadata(&file);
        assert!(meta.exists);
        assert!(meta.size_bytes.is_some());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn start_input_validation_checks_required_sidecars() {
        let dir = std::env::temp_dir().join("tachyon-test-start-inputs");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let binary = dir.join(binary_name("tachyon-core"));
        let config = dir.join("client.json");
        std::fs::write(&binary, b"binary").unwrap();
        std::fs::write(&config, b"{}").unwrap();

        let result = validate_process_start_inputs(
            "tachyon-core",
            ManagedBinaryKind::TachyonCore,
            &binary,
            &config,
        );

        if cfg!(target_os = "windows") {
            let err = result.expect_err("missing wintun.dll must block Windows startup");
            assert!(err.contains("wintun.dll"), "unexpected error: {err}");
            std::fs::write(dir.join("wintun.dll"), b"wintun").unwrap();
            validate_process_start_inputs(
                "tachyon-core",
                ManagedBinaryKind::TachyonCore,
                &binary,
                &config,
            )
            .expect("wintun.dll satisfies startup preflight");
        } else {
            result.expect("non-Windows Tachyon Core has no required sidecar");
        }

        validate_process_start_inputs("xray", ManagedBinaryKind::Xray, &binary, &config)
            .expect("Xray does not require Tachyon sidecars");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn egress_probe_url_rejects_credentials_query_and_non_https() {
        assert!(parse_https_egress_probe_url("http://example.test/").is_err());
        assert!(parse_https_egress_probe_url("https://user:secret@example.test/").is_err());
        assert!(parse_https_egress_probe_url("https://example.test/?token=secret").is_err());
        assert!(parse_https_egress_probe_url("https://example.test/%0d%0aHost:%20evil").is_err());
        assert!(parse_https_egress_probe_url("https://example.test/health\r\nHost: evil").is_err());
        let target = parse_https_egress_probe_url("https://example.test/health").unwrap();
        assert_eq!(target.host, "example.test");
        assert_eq!(target.port, 443);
        assert_eq!(target.path, "/health");
    }

    #[test]
    fn egress_probe_uses_real_http_connect_and_socks_remote_dns_with_tls_nonce() {
        let (server, roots) = test_tls_material();
        let target_listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let target = target_listener.local_addr().unwrap();
        let http_listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let socks_listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let http_addr = http_listener.local_addr().unwrap();
        let socks_addr = socks_listener.local_addr().unwrap();
        let target_thread =
            spawn_fake_tls_target(target_listener, server, 2, "fixture-nonce".to_string());
        let http_thread = spawn_fake_http_connect_proxy(http_listener, target);
        let socks_thread = spawn_fake_socks5_proxy(socks_listener, target);

        let settings = RuntimeSettings {
            xray_http_listen: "127.0.0.1".to_string(),
            xray_http_port: http_addr.port(),
            xray_socks_listen: "127.0.0.1".to_string(),
            xray_socks_port: socks_addr.port(),
            xray_egress_probe_url: format!("https://localhost:{}/health", target.port()),
            xray_egress_probe_status: 204,
            xray_egress_probe_nonce: "fixture-nonce".to_string(),
            ..RuntimeSettings::default()
        };

        probe_xray_egress_with_roots(
            &egress_probe_settings(&settings).unwrap(),
            Duration::from_secs(3),
            roots,
        )
        .expect("both managed proxies must pass the real local HTTPS probe");
        http_thread.join().unwrap();
        socks_thread.join().unwrap();
        target_thread.join().unwrap();
    }

    #[test]
    fn egress_probe_fails_closed_for_auth_blackhole_bad_certificate_and_missing_listener() {
        let target = HttpsProbeTarget {
            host: "localhost".to_string(),
            host_header: "localhost:443".to_string(),
            path: "/health".to_string(),
            port: 443,
        };
        let roots = RootCertStore::empty();

        let http_auth = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let http_auth_addr = http_auth.local_addr().unwrap();
        let http_auth_thread = std::thread::spawn(move || {
            let (mut stream, _) = http_auth.accept().unwrap();
            let _ = read_fake_headers(&mut stream);
            stream
                .write_all(
                    b"HTTP/1.1 407 Proxy Authentication Required\r\nConnection: close\r\n\r\n",
                )
                .unwrap();
        });
        assert!(probe_https_via_http_proxy(
            "127.0.0.1",
            http_auth_addr.port(),
            &target,
            204,
            "",
            &roots,
            Instant::now() + Duration::from_secs(1),
        )
        .is_err());
        http_auth_thread.join().unwrap();

        let socks_auth = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let socks_auth_addr = socks_auth.local_addr().unwrap();
        let socks_auth_thread = std::thread::spawn(move || {
            let (mut stream, _) = socks_auth.accept().unwrap();
            let mut greeting = [0_u8; 3];
            stream.read_exact(&mut greeting).unwrap();
            stream.write_all(&[0x05, 0x02]).unwrap();
        });
        assert!(probe_https_via_socks5(
            "127.0.0.1",
            socks_auth_addr.port(),
            &target,
            204,
            "",
            &roots,
            Instant::now() + Duration::from_secs(1),
        )
        .is_err());
        socks_auth_thread.join().unwrap();

        let blackhole = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let blackhole_addr = blackhole.local_addr().unwrap();
        let blackhole_thread = std::thread::spawn(move || {
            let (_stream, _) = blackhole.accept().unwrap();
            std::thread::sleep(Duration::from_millis(250));
        });
        assert!(probe_https_via_http_proxy(
            "127.0.0.1",
            blackhole_addr.port(),
            &target,
            204,
            "",
            &roots,
            Instant::now() + Duration::from_millis(50),
        )
        .is_err());
        blackhole_thread.join().unwrap();

        assert!(probe_https_via_http_proxy(
            "127.0.0.1",
            1,
            &target,
            204,
            "",
            &roots,
            Instant::now() + Duration::from_millis(100),
        )
        .is_err());

        let occupied = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let occupied_port = occupied.local_addr().unwrap().port();
        assert!(probe_https_via_http_proxy(
            "127.0.0.1",
            occupied_port,
            &target,
            204,
            "",
            &roots,
            Instant::now() + Duration::from_millis(100),
        )
        .is_err());
    }

    #[test]
    fn egress_probe_deadline_bounds_slow_tls_and_byte_stream() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let _ = read_fake_headers(&mut stream);
            stream
                .write_all(b"HTTP/1.1 200 Connection Established\r\n\r\n")
                .unwrap();
            std::thread::sleep(Duration::from_millis(250));
            let _ = stream.write_all(&[0x16]);
        });
        let target = HttpsProbeTarget {
            host: "localhost".to_string(),
            host_header: "localhost:443".to_string(),
            path: "/health".to_string(),
            port: 443,
        };
        let started = Instant::now();
        assert!(probe_https_via_http_proxy(
            "127.0.0.1",
            port,
            &target,
            204,
            "",
            &RootCertStore::empty(),
            started + Duration::from_millis(80),
        )
        .is_err());
        assert!(started.elapsed() < Duration::from_millis(220));
        server.join().unwrap();
    }

    #[test]
    fn egress_header_deadline_bounds_slow_drip_multi_byte_response() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            for byte in b"HTTP/1.1 204 No Content\r\n\r\n" {
                let _ = stream.write_all(&[*byte]);
                std::thread::sleep(Duration::from_millis(8));
            }
        });
        let mut stream = TcpStream::connect(address).unwrap();
        let started = Instant::now();
        assert!(read_http_headers(&mut stream, started + Duration::from_millis(45)).is_err());
        assert!(started.elapsed() < Duration::from_millis(180));
        server.join().unwrap();
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_libproc_ownership_fixture_matches_current_ipv4_listener() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let expected = listener.local_addr().unwrap();
        let listeners = owned_tcp_listener_table(std::process::id()).unwrap();
        assert!(listeners
            .iter()
            .any(|listener| listener.address == expected && listener.pid == std::process::id()));
    }

    #[test]
    fn macos_listener_port_decodes_network_order_as_u16() {
        for port in [1_u16, 80, 443, 10808, 65535] {
            assert_eq!(macos_tcp_listener_port(i32::from(port.to_be())), Some(port));
        }
        assert_eq!(macos_tcp_listener_port(0), Some(0));
    }

    #[test]
    fn macos_listener_port_rejects_signed_or_wider_mock_values() {
        assert_eq!(macos_tcp_listener_port(-1), None);
        assert_eq!(macos_tcp_listener_port(i32::from(u16::MAX) + 1), None);
        assert_eq!(macos_tcp_listener_port(i32::MAX), None);
    }

    #[test]
    fn macos_listener_address_uses_family_and_ini_flags() {
        let ipv4 = [127, 0, 0, 1];
        let ipv6 = Ipv6Addr::LOCALHOST.octets();
        assert_eq!(
            macos_tcp_listener_ip(MACOS_AF_INET, MACOS_INI_IPV4, ipv4, ipv6),
            Some(IpAddr::V4(Ipv4Addr::LOCALHOST))
        );
        assert_eq!(
            macos_tcp_listener_ip(MACOS_AF_INET6, MACOS_INI_IPV6, ipv4, ipv6),
            Some(IpAddr::V6(Ipv6Addr::LOCALHOST))
        );
        for invalid in [
            (MACOS_AF_INET, 0),
            (MACOS_AF_INET, MACOS_INI_IPV6),
            (MACOS_AF_INET6, MACOS_INI_IPV4),
            (MACOS_AF_INET6, MACOS_INI_IPV4 | MACOS_INI_IPV6),
            (0, MACOS_INI_IPV4),
        ] {
            assert_eq!(
                macos_tcp_listener_ip(invalid.0, invalid.1, ipv4, ipv6),
                None
            );
        }
    }

    #[test]
    fn windows_tcp_table_layout_validation_rejects_truncation_and_overflow() {
        assert!(validate_tcp_table_layout(4 + 2 * 8, 4 + 2 * 8, 2, 8).is_ok());
        assert!(validate_tcp_table_layout(4 + 8, 4 + 8, 2, 8).is_err());
        assert!(validate_tcp_table_layout(4, 4, usize::MAX, usize::MAX).is_err());
        assert!(validate_tcp_table_layout(4 + 8, 4 + 16, 1, 8).is_err());
    }

    #[cfg(test)]
    #[test]
    fn managed_process_keeps_child_after_try_wait_failure_for_retry() {
        let child = if cfg!(target_os = "windows") {
            Command::new(std::env::var_os("ComSpec").unwrap_or_else(|| "cmd.exe".into()))
                .args(["/C", "ping -n 20 127.0.0.1 > nul"])
                .spawn()
                .unwrap()
        } else {
            Command::new("sh").args(["-c", "sleep 20"]).spawn().unwrap()
        };
        let mut process = ManagedProcess {
            child: Some(child),
            stop_fault: Some(StopFault::TryWait),
            ..ManagedProcess::default()
        };
        assert!(process.stop("injected").is_err());
        assert!(process.child.is_some());
        process.stop_fault = None;
        process.stop("injected").unwrap();
        assert!(process.child.is_none());
    }

    #[test]
    fn managed_process_reports_immediate_exit_as_start_failure() {
        let dir = std::env::temp_dir().join("tachyon-test-immediate-exit");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let config = dir.join("xray-client.json");
        std::fs::write(&config, b"{}").unwrap();
        let binary = std::env::current_exe().expect("current test binary");
        let mut process = ManagedProcess::default();

        let error = match process.start(
            "xray",
            ManagedBinaryKind::Xray,
            path_string(&binary),
            path_string(&config),
            &["--help"],
        ) {
            Ok(_) => panic!("short-lived child must not be reported as running"),
            Err(error) => error,
        };

        assert!(
            error.contains("exited immediately") || error.contains("exited with"),
            "unexpected error: {error}",
        );
        assert_ne!(process.status().state, "running");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn wintun_archive_path_matches_current_platform() {
        let result = wintun_archive_dll_path();
        if cfg!(target_os = "windows") {
            let path = result.expect("Windows must have a Wintun archive path");
            assert!(path.starts_with("wintun/bin/"));
            assert!(path.ends_with("/wintun.dll"));
        } else {
            assert!(result.is_err());
        }
    }

    #[test]
    fn extracts_exact_zip_entry_to_file() {
        use zip::write::SimpleFileOptions;

        let dir = std::env::temp_dir().join("tachyon-test-zip-entry");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let archive = dir.join("sidecars.zip");
        let file = std::fs::File::create(&archive).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        let options =
            SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
        zip.start_file("wintun/bin/x86/wintun.dll", options)
            .unwrap();
        zip.write_all(b"x86").unwrap();
        zip.start_file("wintun/bin/amd64/wintun.dll", options)
            .unwrap();
        zip.write_all(b"amd64").unwrap();
        zip.finish().unwrap();

        let target = dir.join("wintun.dll");
        extract_zip_entry_to_file(&archive, "wintun/bin/amd64/wintun.dll", &target)
            .expect("extract exact entry");

        assert_eq!(std::fs::read(&target).unwrap(), b"amd64");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn push_unique_path_adds_when_empty() {
        let mut paths = Vec::new();
        push_unique_path(&mut paths, PathBuf::from("/tmp/a"));
        assert_eq!(paths.len(), 1);
    }

    #[test]
    fn push_unique_path_deduplicates_by_lossy_compare() {
        let mut paths = Vec::new();
        push_unique_path(&mut paths, PathBuf::from("/tmp/a"));
        push_unique_path(&mut paths, PathBuf::from("/tmp/a"));
        assert_eq!(paths.len(), 1);
    }

    #[test]
    fn push_unique_path_normalizes_components() {
        let mut paths = Vec::new();
        push_unique_path(&mut paths, PathBuf::from("/tmp/./a/b/.."));
        let got = path_string(&paths[0]);
        assert!(!got.contains("./"));
    }

    #[test]
    fn clean_path_input_trims_whitespace() {
        assert_eq!(clean_path_input("  /usr/bin  "), "/usr/bin");
        assert_eq!(clean_path_input("\tpath\t"), "path");
    }

    #[test]
    fn clean_path_input_returns_empty_for_whitespace_only() {
        assert_eq!(clean_path_input("   "), "");
        assert_eq!(clean_path_input(""), "");
    }

    #[test]
    fn clean_url_input_strips_quotes() {
        assert_eq!(
            clean_url_input("  \"https://example.com/sub\"  "),
            "https://example.com/sub"
        );
    }

    #[test]
    fn fetch_subscription_text_rejects_non_http_urls() {
        let error = fetch_subscription_text("file:///tmp/sub.txt".to_string())
            .expect_err("non-http subscription should fail before network");
        assert!(error.contains("http:// or https://"));
    }

    fn spawn_subscription_server(
        listener: std::net::TcpListener,
        responses: Vec<Vec<u8>>,
    ) -> std::thread::JoinHandle<()> {
        std::thread::spawn(move || {
            for response in responses {
                let (mut stream, _) = listener.accept().unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(2)))
                    .unwrap();
                let mut request = [0_u8; 2048];
                let _ = stream.read(&mut request).unwrap();
                stream.write_all(&response).unwrap();
            }
        })
    }

    #[test]
    fn subscription_fallback_follows_malformed_307_and_decodes_chunked_body() {
        let target_listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let target_port = target_listener.local_addr().unwrap().port();
        let target_response =
            b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n5\r\nhello\r\n6\r\n world\r\n0\r\n\r\n"
                .to_vec();
        let target_handle = spawn_subscription_server(target_listener, vec![target_response]);

        let source_listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let source_port = source_listener.local_addr().unwrap().port();
        let malformed_redirect = format!(
            "HTTP/0.0 307 Temporary Redirect\r\nLocation: http://127.0.0.1:{target_port}/final\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
        )
        .into_bytes();
        let source_handle = spawn_subscription_server(
            source_listener,
            vec![malformed_redirect.clone(), malformed_redirect],
        );

        let text = fetch_subscription_url_with_policy(
            &format!("http://127.0.0.1:{source_port}/start"),
            true,
        )
        .expect("malformed redirect should use bounded HTTP fallback");
        assert_eq!(text, "hello world");
        source_handle.join().unwrap();
        target_handle.join().unwrap();
    }

    #[test]
    fn subscription_fallback_rejects_oversized_content_length() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let response = format!(
            " 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            SUBSCRIPTION_MAX_BODY_BYTES + 1
        )
        .into_bytes();
        let handle = spawn_subscription_server(listener, vec![response.clone(), response]);

        let error =
            fetch_subscription_url_with_policy(&format!("http://127.0.0.1:{port}/large"), true)
                .expect_err("oversized subscription must fail");
        assert!(error.contains("too large"));
        handle.join().unwrap();
    }

    #[test]
    fn subscription_fallback_rejects_redirect_loop() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let response = b" 307 Temporary Redirect\r\nLocation: /loop\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_vec();
        let handle = spawn_subscription_server(listener, vec![response; 7]);

        let error =
            fetch_subscription_url_with_policy(&format!("http://127.0.0.1:{port}/loop"), true)
                .expect_err("redirect loop must fail");
        assert!(error.contains("redirect limit"));
        handle.join().unwrap();
    }

    #[test]
    fn subscription_fallback_rejects_invalid_response() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let response = b"definitely not HTTP\r\nContent-Length: 0\r\n\r\n".to_vec();
        let handle = spawn_subscription_server(listener, vec![response.clone(), response]);

        let error =
            fetch_subscription_url_with_policy(&format!("http://127.0.0.1:{port}/invalid"), true)
                .expect_err("invalid response must fail");
        assert!(error.contains("status"));
        handle.join().unwrap();
    }

    #[test]
    fn subscription_url_credentials_are_rejected_without_echoing_them() {
        let secret = "private-token";
        let error =
            fetch_subscription_text(format!("http://subscriber:{secret}@127.0.0.1/subscription"))
                .expect_err("URL credentials must be rejected before network access");
        assert!(error.contains("credentials are not allowed"));
        assert!(!error.contains(secret));
    }

    #[test]
    fn subscription_redirect_rejects_non_http_scheme_and_https_downgrade() {
        let http = SubscriptionUrl::parse("http://example.test/sub").unwrap();
        assert!(http.resolve("file:/tmp/subscription").is_err());

        let https = SubscriptionUrl::parse("https://example.test/sub").unwrap();
        let downgraded = SubscriptionUrl::parse("http://example.test/sub").unwrap();
        let error = validate_subscription_redirect(&https, &downgraded)
            .expect_err("HTTPS redirect downgrade must fail");
        assert!(error.contains("cannot downgrade"));
    }

    #[test]
    fn subscription_destination_policy_rejects_special_ranges_by_default() {
        let forbidden = [
            ("0.0.0.0", "unspecified"),
            ("10.1.2.3", "private"),
            ("127.0.0.1", "loopback"),
            ("100.64.0.1", "shared"),
            ("169.254.1.1", "link-local"),
            ("192.0.2.1", "documentation"),
            ("198.18.0.1", "benchmarking"),
            ("203.0.113.9", "documentation"),
            ("224.0.0.1", "multicast"),
            ("255.255.255.255", "reserved"),
            ("::", "unspecified"),
            ("::1", "loopback"),
            ("fc00::1", "private"),
            ("fe80::1", "link-local"),
            ("ff02::1", "multicast"),
            ("2001:db8::1", "documentation"),
            ("::ffff:127.0.0.1", "loopback"),
        ];
        for (address, expected_reason) in forbidden {
            let error = validate_subscription_address(address.parse().unwrap(), false)
                .expect_err("special-use destination must be rejected");
            assert!(
                error.contains(expected_reason),
                "{address} returned unexpected error: {error}"
            );
        }

        for address in ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"] {
            validate_subscription_address(address.parse().unwrap(), false)
                .unwrap_or_else(|error| panic!("public address {address} was rejected: {error}"));
        }
    }

    #[test]
    fn explicit_private_policy_never_allows_metadata_or_other_special_ranges() {
        for address in ["10.1.2.3", "127.0.0.1", "192.168.50.2", "fd12::1"] {
            validate_subscription_address(address.parse().unwrap(), true)
                .unwrap_or_else(|error| panic!("explicit private address was rejected: {error}"));
        }
        for address in [
            "169.254.169.254",
            "100.100.100.200",
            "192.0.0.192",
            "fd00:ec2::254",
            "fe80::1",
            "224.0.0.1",
            "2001:db8::1",
        ] {
            assert!(
                validate_subscription_address(address.parse().unwrap(), true).is_err(),
                "metadata and non-private special range {address} must remain forbidden"
            );
        }
        assert!(is_cloud_metadata_host("metadata.google.internal."));
        assert!(is_cloud_metadata_host("INSTANCE-DATA.EC2.INTERNAL"));
    }

    #[test]
    fn default_subscription_fetch_rejects_loopback_before_connecting() {
        let error = fetch_subscription_url("http://127.0.0.1:9/subscription")
            .expect_err("default subscription policy must reject loopback");
        assert!(error.contains("loopback"));
    }

    #[test]
    fn redirect_destination_is_revalidated_before_second_connection() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let response = b"HTTP/1.1 302 Found\r\nLocation: http://169.254.169.254/latest/meta-data\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_vec();
        let handle = spawn_subscription_server(listener, vec![response]);

        let error =
            fetch_subscription_url_with_policy(&format!("http://127.0.0.1:{port}/start"), true)
                .expect_err("redirect to metadata must be rejected before connection");
        assert!(error.contains("cloud metadata"));
        handle.join().unwrap();
    }

    #[test]
    fn strict_subscription_transport_uses_only_preapproved_addresses() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let response =
            b"HTTP/1.1 200 OK\r\nContent-Length: 5\r\nConnection: close\r\n\r\nhello".to_vec();
        let handle = spawn_subscription_server(listener, vec![response]);
        let url = SubscriptionUrl::parse(&format!(
            "http://dns-name-that-must-not-resolve.invalid:{}/subscription",
            address.port()
        ))
        .unwrap();

        let response = strict_subscription_request(&url, Duration::from_secs(2), &[address])
            .expect("approved resolver must bind the connection to the validated address");
        assert_eq!(response.status, 200);
        assert_eq!(response.body, b"hello");
        handle.join().unwrap();
    }

    #[test]
    #[ignore = "requires TACHYON_LIVE_SUBSCRIPTION_URL and explicit live network access"]
    fn live_subscription_download_returns_non_empty_text() {
        let Ok(url) = std::env::var("TACHYON_LIVE_SUBSCRIPTION_URL") else {
            eprintln!("live subscription test skipped: environment variable is not set");
            return;
        };

        let text = fetch_subscription_text(url)
            .unwrap_or_else(|error| panic!("live subscription download failed: {error}"));
        assert!(
            !text.trim().is_empty(),
            "live subscription download returned empty text"
        );
    }

    #[test]
    fn non_empty_or_falls_back_when_empty() {
        assert_eq!(
            non_empty_or("".to_string(), "default".to_string()),
            "default"
        );
        assert_eq!(
            non_empty_or("  ".to_string(), "default".to_string()),
            "default"
        );
    }

    #[test]
    fn non_empty_or_keeps_non_empty_value() {
        assert_eq!(
            non_empty_or("value".to_string(), "default".to_string()),
            "value"
        );
    }

    #[test]
    fn normalize_address_list_trims_empty_lines_and_commas() {
        assert_eq!(
            normalize_address_list(" 127.0.0.1:0\n\n, 192.168.1.10:0 ".to_string()),
            "127.0.0.1:0\n192.168.1.10:0"
        );
    }

    #[test]
    fn normalize_tgp_auth_psk_trims_and_validates_length() {
        assert!(
            normalize_tgp_auth_psk(" 0123456789abcdef ".to_string()).unwrap() == "0123456789abcdef",
            "normalized TGP PSK changed"
        );
        assert_eq!(normalize_tgp_auth_psk("   ".to_string()).unwrap(), "");
        assert!(normalize_tgp_auth_psk("too-short".to_string())
            .expect_err("short PSK should fail")
            .contains("PSK"));
    }

    #[test]
    fn non_zero_u16_or_falls_back_only_for_zero() {
        assert_eq!(non_zero_u16_or(0, 10808), 10808);
        assert_eq!(non_zero_u16_or(10085, 10808), 10085);
    }

    #[test]
    fn bounded_u32_or_enforces_bounds() {
        assert_eq!(bounded_u32_or(250, 500, 100, 10000), 250);
        assert_eq!(bounded_u32_or(50, 500, 100, 10000), 500);
        assert_eq!(bounded_u32_or(20000, 500, 100, 10000), 500);
    }

    #[test]
    fn serde_defaults_enable_adaptive_tachyon_fec() {
        let missing: RuntimeSettings = serde_json::from_str("{}").expect("settings");
        assert!(missing.tachyon_fec_dynamic);
        assert!(missing.tachyon_connection_migration);
        assert!(!missing.tachyon_multipath);
        assert!(missing.tachyon_tgp_auth_psk.is_empty());
        assert!(!missing.tachyon_tun_auto_route);
        assert!(!missing.tachyon_tun_dns_hijack);
        assert!(RuntimeSettings::default().tachyon_tgp_auth_psk.is_empty());

        let disabled: RuntimeSettings =
            serde_json::from_str(r#"{"tachyonFecDynamic":false}"#).expect("settings");
        assert!(!disabled.tachyon_fec_dynamic);
    }

    #[test]
    fn parses_xray_stats_query_output_and_ignores_api_traffic() {
        let raw = r#"
stat: <
  name: "outbound>>>tachyon-proxy>>>traffic>>>uplink"
  value: 1024
>
stat: <
  name: "outbound>>>tachyon-proxy>>>traffic>>>downlink"
  value: 2048
>
stat: <
  name: "inbound>>>tachyon-socks>>>traffic>>>uplink"
  value: 300
>
stat: <
  name: "outbound>>>tachyon-xray-api>>>traffic>>>uplink"
  value: 999999
>
"#;
        let stats = parse_xray_stats_query_output(raw);
        assert_eq!(stats.bytes_sent, 1024);
        assert_eq!(stats.bytes_received, 2048);
        assert!(stats.queried_at.is_none());
    }

    #[test]
    fn tcp_latency_rejects_missing_endpoint_parts() {
        assert!(test_tcp_latency("".to_string(), 443, None).is_err());
        assert!(test_tcp_latency("127.0.0.1".to_string(), 0, None).is_err());
    }

    #[test]
    fn proxy_probe_url_requires_http() {
        assert!(parse_http_probe_url("https://example.com").is_err());
        assert!(parse_http_probe_url("file:///tmp/test").is_err());
    }

    #[test]
    fn proxy_probe_url_keeps_absolute_form() {
        let target = parse_http_probe_url(" http://example.com:8080/path?q=1 ").unwrap();
        assert_eq!(target.absolute_url, "http://example.com:8080/path?q=1");
        assert_eq!(target.host, "example.com");
        assert_eq!(target.host_header, "example.com:8080");
        assert_eq!(target.path_and_query, "/path?q=1");
        assert_eq!(target.port, 8080);
    }

    #[test]
    fn proxy_probe_url_defaults_to_http_port() {
        let target = parse_http_probe_url("http://example.com/probe").unwrap();
        assert_eq!(target.host, "example.com");
        assert_eq!(target.port, 80);
    }

    #[test]
    fn core_health_url_uses_runtime_ipc_settings() {
        let settings = RuntimeSettings {
            tachyon_ipc_listen: "127.0.0.6".to_string(),
            tachyon_ipc_port: 55124,
            ..RuntimeSettings::default()
        };
        assert_eq!(
            core_health_url(&settings).unwrap(),
            "http://127.0.0.6:55124/v1/health"
        );
    }

    #[test]
    fn core_health_url_wraps_ipv6_hosts() {
        let settings = RuntimeSettings {
            tachyon_ipc_listen: "::1".to_string(),
            tachyon_ipc_port: 55123,
            ..RuntimeSettings::default()
        };
        assert_eq!(
            core_health_url(&settings).unwrap(),
            "http://[::1]:55123/v1/health"
        );
    }

    #[test]
    fn core_health_url_rejects_wildcard_and_hostname_addresses() {
        let wildcard = RuntimeSettings {
            tachyon_ipc_listen: "::".to_string(),
            tachyon_ipc_port: 55123,
            ..RuntimeSettings::default()
        };
        assert!(core_health_url(&wildcard).is_err());

        let hostname = RuntimeSettings {
            tachyon_ipc_listen: "localhost".to_string(),
            tachyon_ipc_port: 55123,
            ..RuntimeSettings::default()
        };
        assert!(core_health_url(&hostname).is_err());

        let remote = RuntimeSettings {
            tachyon_ipc_listen: "198.51.100.10".to_string(),
            tachyon_ipc_port: 55123,
            ..RuntimeSettings::default()
        };
        assert!(core_health_url(&remote).is_err());
    }

    #[test]
    fn parses_http_status_code_from_proxy_response() {
        assert_eq!(
            parse_http_status_code("HTTP/1.1 204 No Content\r\nConnection: close\r\n\r\n"),
            Some(204)
        );
        assert_eq!(parse_http_status_code(""), None);
    }

    #[test]
    fn proxy_probe_uses_local_http_proxy_absolute_form() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let handle = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut buffer = [0_u8; 1024];
            let size = stream.read(&mut buffer).unwrap();
            let request = String::from_utf8_lossy(&buffer[..size]).to_string();
            stream
                .write_all(b"HTTP/1.1 204 No Content\r\nConnection: close\r\n\r\n")
                .unwrap();
            request
        });

        let result = probe_http_via_proxy(
            "127.0.0.1",
            port,
            "http://example.test/probe",
            Duration::from_secs(2),
        )
        .unwrap();
        let request = handle.join().unwrap();

        assert!(result.ok);
        assert_eq!(result.status_code, Some(204));
        assert!(request.starts_with("GET http://example.test/probe HTTP/1.1"));
        assert!(request.contains("Host: example.test"));
    }

    #[test]
    fn proxy_probe_uses_local_socks5_connect() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let handle = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut greeting = [0_u8; 3];
            stream.read_exact(&mut greeting).unwrap();
            assert_eq!(greeting, [0x05, 0x01, 0x00]);
            stream.write_all(&[0x05, 0x00]).unwrap();

            let mut header = [0_u8; 4];
            stream.read_exact(&mut header).unwrap();
            assert_eq!(&header[..3], &[0x05, 0x01, 0x00]);
            match header[3] {
                0x03 => {
                    let mut len = [0_u8; 1];
                    stream.read_exact(&mut len).unwrap();
                    let mut host = vec![0_u8; len[0] as usize];
                    stream.read_exact(&mut host).unwrap();
                    assert_eq!(String::from_utf8(host).unwrap(), "example.test");
                }
                other => panic!("unexpected SOCKS address type: {other}"),
            }
            let mut target_port = [0_u8; 2];
            stream.read_exact(&mut target_port).unwrap();
            assert_eq!(u16::from_be_bytes(target_port), 80);
            stream
                .write_all(&[0x05, 0x00, 0x00, 0x01, 127, 0, 0, 1, 0x20, 0x00])
                .unwrap();

            let mut buffer = [0_u8; 1024];
            let size = stream.read(&mut buffer).unwrap();
            let request = String::from_utf8_lossy(&buffer[..size]).to_string();
            stream
                .write_all(b"HTTP/1.1 204 No Content\r\nConnection: close\r\n\r\n")
                .unwrap();
            request
        });

        let result = probe_http_via_socks5(
            "127.0.0.1",
            port,
            "http://example.test/probe",
            Duration::from_secs(2),
        )
        .unwrap();
        let request = handle.join().unwrap();

        assert!(result.ok);
        assert_eq!(result.status_code, Some(204));
        assert!(request.starts_with("GET /probe HTTP/1.1"));
        assert!(request.contains("Host: example.test"));
    }

    #[test]
    fn local_proxy_report_checks_http_and_socks_inbounds() {
        let http_listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let http_port = http_listener.local_addr().unwrap().port();
        let http_handle = std::thread::spawn(move || {
            let (mut stream, _) = http_listener.accept().unwrap();
            let mut buffer = [0_u8; 1024];
            let _ = stream.read(&mut buffer).unwrap();
            stream
                .write_all(b"HTTP/1.1 204 No Content\r\nConnection: close\r\n\r\n")
                .unwrap();
        });

        let socks_listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let socks_port = socks_listener.local_addr().unwrap().port();
        let socks_handle = std::thread::spawn(move || {
            let (mut stream, _) = socks_listener.accept().unwrap();
            let mut greeting = [0_u8; 3];
            stream.read_exact(&mut greeting).unwrap();
            stream.write_all(&[0x05, 0x00]).unwrap();
            let mut header = [0_u8; 4];
            stream.read_exact(&mut header).unwrap();
            if header[3] == 0x03 {
                let mut len = [0_u8; 1];
                stream.read_exact(&mut len).unwrap();
                let mut host = vec![0_u8; len[0] as usize];
                stream.read_exact(&mut host).unwrap();
            }
            let mut target_port = [0_u8; 2];
            stream.read_exact(&mut target_port).unwrap();
            stream
                .write_all(&[0x05, 0x00, 0x00, 0x01, 127, 0, 0, 1, 0x20, 0x00])
                .unwrap();
            let mut buffer = [0_u8; 1024];
            let _ = stream.read(&mut buffer).unwrap();
            stream
                .write_all(b"HTTP/1.1 204 No Content\r\nConnection: close\r\n\r\n")
                .unwrap();
        });

        let settings = RuntimeSettings {
            xray_http_listen: "127.0.0.1".to_string(),
            xray_http_port: http_port,
            xray_socks_listen: "127.0.0.1".to_string(),
            xray_socks_port: socks_port,
            ..RuntimeSettings::default()
        };
        let report = probe_xray_local_proxies(
            &settings,
            "http://example.test/probe",
            Duration::from_secs(2),
        )
        .unwrap();

        assert!(report.ok);
        assert!(report.http.ok);
        assert!(report.socks.ok);
        assert_eq!(report.target_url, "http://example.test/probe");
        assert!(report.checked_at.is_some());
        http_handle.join().unwrap();
        socks_handle.join().unwrap();
    }

    #[test]
    fn validation_command_line_quotes_paths_with_spaces() {
        let binary = Path::new("C:\\Program Files\\Xray\\xray.exe");
        let config = Path::new("C:\\Users\\Test User\\xray-client.json");
        let line = validation_command_line(binary, &["run", "-test", "-config"], config);
        assert!(line.contains("\"C:\\Program Files\\Xray\\xray.exe\""));
        assert!(line.contains("run -test -config"));
        assert!(line.contains("\"C:\\Users\\Test User\\xray-client.json\""));
    }

    #[test]
    fn inherited_xray_config_fd_always_uses_explicit_json_format() {
        assert_eq!(XRAY_RUN_CONFIG_ARGS, ["run", "-format", "json", "-config"]);
        assert_eq!(
            XRAY_TEST_CONFIG_ARGS,
            ["run", "-test", "-format", "json", "-config"]
        );
    }

    #[cfg(unix)]
    #[test]
    fn generation_process_cwd_uses_binary_parent_for_unix_fd_delivery() {
        let binary = Path::new("/opt/tachyon/bin/xray");
        let config = Path::new("/home/user/.config/tachyon/generation.json");
        assert_eq!(
            generation_config_work_dir(binary, config),
            Some(Path::new("/opt/tachyon/bin"))
        );
    }

    #[cfg(not(unix))]
    #[test]
    fn generation_process_cwd_uses_config_parent_on_windows() {
        let binary = Path::new(r"C:\Program Files\Tachyon\xray.exe");
        let config = Path::new(r"C:\Users\Test\AppData\Tachyon\generation.json");
        assert_eq!(
            generation_config_work_dir(binary, config),
            Some(Path::new(r"C:\Users\Test\AppData\Tachyon"))
        );
    }

    #[test]
    fn preflight_command_line_uses_basename_for_foreign_paths() {
        let windows_line = preflight_command_line(
            Path::new("C:\\Users\\alice\\bin\\tachyon-core.exe"),
            Path::new("C:\\Users\\alice\\AppData\\Roaming\\tachyon-prism\\client.json"),
        );
        assert_eq!(
            windows_line,
            "tachyon-core.exe preflight --config client.json --json"
        );
        assert!(!windows_line.contains("C:\\Users\\alice"));

        let unix_line = preflight_command_line(
            Path::new("/Users/alice/bin/tachyon-core"),
            Path::new("/home/alice/.config/tachyon-prism/client.json"),
        );
        assert_eq!(
            unix_line,
            "tachyon-core preflight --config client.json --json"
        );
        assert!(!unix_line.contains("/Users/alice"));
        assert!(!unix_line.contains("/home/alice"));
    }

    #[test]
    fn validation_details_prefers_combined_output_when_available() {
        assert_eq!(
            validation_details("stdout ok", "stderr note"),
            "stdout ok\nstderr note"
        );
        assert_eq!(validation_details("", "stderr only"), "stderr only");
        assert_eq!(
            validation_details("", ""),
            "validation command finished without output"
        );
    }

    #[test]
    fn config_validation_result_reports_spawn_error() {
        let result = config_validation_result(
            "xray",
            "xray run -test -config config.json".to_string(),
            Err("spawn failed".to_string()),
        );
        assert!(!result.ok);
        assert_eq!(result.target, "xray");
        assert_eq!(result.error.as_deref(), Some("spawn failed"));
    }

    #[test]
    fn tachyon_core_preflight_parses_json_checks() {
        let output = test_output(
            1,
            br#"{
  "overall": "error",
  "checks": [
    {"code": "CONFIG_VALID", "status": "ok", "message": "config parsed"},
    {"code": "TUN_PRIVILEGE", "status": "error", "message": "administrator required", "details": "Run Prism as administrator"}
  ]
}"#,
            b"",
        );

        let result = tachyon_core_preflight_result(
            "tachyon-core preflight --config client.json --json".to_string(),
            Ok(output),
        );

        assert!(result.supported);
        assert!(!result.ok);
        assert_eq!(result.overall, "error");
        assert_eq!(result.checks.len(), 2);
        assert_eq!(result.checks[1].code, "TUN_PRIVILEGE");
        assert_eq!(result.checks[1].status, "error");
        assert!(result.error.unwrap().contains("administrator required"));
    }

    #[test]
    fn tachyon_core_preflight_parses_core_doctor_json_contract() {
        let output = test_output(
            0,
            br#"{
  "overall_status": "warn",
  "client_requires_tun": true,
  "auto_route": false,
  "checks": [
    {"id": "CLIENT_REQUIRES_TUN", "status": "ok", "message": "Client mode starts a TUN device before the packet pipeline.", "remediation": ""},
    {"id": "AUTO_ROUTE_DISABLED", "status": "warn", "message": "auto_route=false means Core will not take over the system default route; it does not mean TUN is unnecessary in client mode.", "remediation": "Keep auto_route=false for Prism/Xray-owned general proxy traffic."}
  ]
}"#,
            b"",
        );

        let result = tachyon_core_preflight_result(
            "tachyon-core preflight --config client.json --json".to_string(),
            Ok(output),
        );

        assert!(result.supported);
        assert!(result.ok);
        assert_eq!(result.overall, "warn");
        assert_eq!(result.checks[0].code, "CLIENT_REQUIRES_TUN");
        assert_eq!(result.checks[1].code, "AUTO_ROUTE_DISABLED");
        assert_eq!(result.checks[1].status, "warn");
        assert!(result.checks[1].details.contains("Prism/Xray-owned"));
        assert!(result
            .structured_report
            .get("client_requires_tun")
            .is_some());
    }

    #[test]
    fn tachyon_core_preflight_truncates_long_stderr() {
        let long_stderr = "stderr line\n".repeat(900);
        let output = test_output(1, b"not-json", long_stderr.as_bytes());

        let result = tachyon_core_preflight_result(
            "tachyon-core preflight --config client.json --json".to_string(),
            Ok(output),
        );

        assert!(!result.ok);
        assert!(result.stderr_truncated);
        assert!(result.stderr.len() <= PREFLIGHT_OUTPUT_LIMIT_BYTES);
        assert!(result.error.unwrap().len() <= PREFLIGHT_OUTPUT_LIMIT_BYTES + "not-json\n".len());
    }

    #[test]
    fn tachyon_core_preflight_redacts_user_and_config_paths() {
        let output = test_output(
            1,
            br#"{
  "overall": "error",
  "stdout": "raw stdout should not be retained",
  "checks": [
    {"code": "CONFIG_VALID", "status": "error", "message": "config failed at C:\\Users\\alice\\AppData\\Roaming\\tachyon-prism\\client.json", "details": "see /Users/alice/.config/tachyon-prism/client.json and /home/alice/.config/tachyon-prism/client.json and C:/Users/alice/AppData/Roaming/tachyon-prism/client.json", "command": "tachyon-core --config C:\\Users\\alice\\client.json"}
  ]
}"#,
            b"C:\\Users\\alice\\AppData\\Roaming\\tachyon-prism\\client.json failed; /home/alice/.config/tachyon-prism/client.json failed",
        );

        let result = tachyon_core_preflight_result(
            preflight_command_line(
                Path::new("C:\\Users\\alice\\bin\\tachyon-core.exe"),
                Path::new("C:\\Users\\alice\\AppData\\Roaming\\tachyon-prism\\client.json"),
            ),
            Ok(output),
        );

        let serialized = serde_json::to_string(&result).expect("preflight result serializes");
        let structured_report =
            serde_json::to_string(&result.structured_report).expect("structured report serializes");
        assert!(serialized.contains("<user-dir>"));
        assert!(!serialized.contains("C:\\\\Users\\\\alice"));
        assert!(!serialized.contains("C:/Users/alice"));
        assert!(!serialized.contains("/Users/alice"));
        assert!(!serialized.contains("/home/alice"));
        assert!(!structured_report.contains("raw stdout should not be retained"));
        assert_eq!(
            result.command,
            "tachyon-core.exe preflight --config client.json --json"
        );
    }

    #[test]
    fn tachyon_core_preflight_keeps_structured_checks_available() {
        let output = test_output(
            0,
            br#"{
  "overall_status": "warn",
  "client_requires_tun": true,
  "checks": [
    {"id": "AUTO_ROUTE_DISABLED", "status": "warn", "message": "auto_route=false", "remediation": "expected in Prism"}
  ]
}"#,
            b"",
        );

        let result = tachyon_core_preflight_result(
            "tachyon-core preflight --config client.json --json".to_string(),
            Ok(output),
        );

        assert_eq!(result.checks[0].code, "AUTO_ROUTE_DISABLED");
        assert_eq!(
            result.structured_report["checks"][0]["id"],
            Value::String("AUTO_ROUTE_DISABLED".to_string())
        );
        assert_eq!(
            result.structured_report["client_requires_tun"],
            Value::Bool(true)
        );
    }

    #[test]
    fn tachyon_core_preflight_reports_old_core_as_supported_fallback() {
        let output = test_output(2, b"", b"error: unrecognized subcommand 'preflight'\n");

        let result = tachyon_core_preflight_result(
            "tachyon-core preflight --config client.json --json".to_string(),
            Ok(output),
        );

        assert!(!result.supported);
        assert!(result.ok);
        assert_eq!(result.overall, "unsupported");
        assert_eq!(
            result.error.as_deref(),
            Some("Core version lacks preflight; validate only"),
        );
    }

    #[test]
    fn legacy_core_preflight_fails_closed_for_non_empty_game_routes() {
        let output = test_output(2, b"", b"error: unrecognized subcommand 'preflight'\n");
        let fallback = tachyon_core_preflight_result(
            "tachyon-core preflight --config client.json --json".to_string(),
            Ok(output),
        );

        let result = fail_closed_legacy_selective_routes(fallback, true);

        assert!(!result.supported);
        assert!(!result.ok);
        assert_eq!(result.overall, "error");
        assert_eq!(result.checks.len(), 1);
        assert_eq!(result.checks[0].code, "SELECTIVE_ROUTES_SUPPORTED");
        assert_eq!(result.checks[0].status, "error");
    }

    #[test]
    fn legacy_core_preflight_keeps_empty_game_routes_in_validate_only_mode() {
        let output = test_output(2, b"", b"error: unrecognized subcommand 'preflight'\n");
        let fallback = tachyon_core_preflight_result(
            "tachyon-core preflight --config client.json --json".to_string(),
            Ok(output),
        );

        let result = fail_closed_legacy_selective_routes(fallback, false);

        assert!(!result.supported);
        assert!(result.ok);
        assert_eq!(result.overall, "unsupported");
        assert!(result.checks.is_empty());
    }

    #[test]
    fn preflight_fallback_reads_non_empty_game_routes_from_prism_json() {
        let dir = unique_temp_dir("tachyon-preflight-game-routes");
        std::fs::create_dir_all(&dir).unwrap();
        let config = dir.join("client.json");
        std::fs::write(
            &config,
            br#"{"client":{"tun":{"game_routes":["203.0.113.0/24"]}}}"#,
        )
        .unwrap();
        assert!(prism_config_has_non_empty_game_routes(&config).unwrap());

        std::fs::write(&config, br#"{"client":{"tun":{"game_routes":[]}}}"#).unwrap();
        assert!(!prism_config_has_non_empty_game_routes(&config).unwrap());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[cfg(unix)]
    fn test_output(code: i32, stdout: &[u8], stderr: &[u8]) -> Output {
        use std::os::unix::process::ExitStatusExt;
        Output {
            status: std::process::ExitStatus::from_raw(code << 8),
            stdout: stdout.to_vec(),
            stderr: stderr.to_vec(),
        }
    }

    #[cfg(windows)]
    fn test_output(code: u32, stdout: &[u8], stderr: &[u8]) -> Output {
        use std::os::windows::process::ExitStatusExt;
        Output {
            status: std::process::ExitStatus::from_raw(code),
            stdout: stdout.to_vec(),
            stderr: stderr.to_vec(),
        }
    }

    #[test]
    fn runtime_privilege_status_from_flag_marks_tun_capability() {
        let elevated = runtime_privilege_status_from_flag("windows", true, "ok");
        assert!(elevated.elevated);
        assert!(elevated.can_manage_tun);
        assert_eq!(elevated.platform, "windows");

        let limited = runtime_privilege_status_from_flag("windows", false, "needs admin");
        assert!(!limited.elevated);
        assert!(!limited.can_manage_tun);
        assert_eq!(limited.message, "needs admin");
    }

    #[test]
    fn expected_system_proxy_server_uses_http_and_socks_inbounds() {
        let settings = RuntimeSettings {
            xray_http_listen: "127.0.0.2".to_string(),
            xray_http_port: 18080,
            xray_socks_listen: "127.0.0.3".to_string(),
            xray_socks_port: 18081,
            ..RuntimeSettings::default()
        };

        assert_eq!(
            expected_system_proxy_server(&settings),
            "http=127.0.0.2:18080;https=127.0.0.2:18080;socks=127.0.0.3:18081"
        );
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn linux_ignore_hosts_formats_gsettings_array() {
        assert_eq!(
            linux_ignore_hosts("localhost;127.*;<local>"),
            "['localhost', '127.*']"
        );
    }

    #[test]
    fn path_string_round_trips() {
        let path = Path::new(if cfg!(target_os = "windows") {
            "C:\\test"
        } else {
            "/test"
        });
        let s = path_string(path);
        assert!(!s.is_empty());
    }

    #[test]
    fn same_file_detects_identity() {
        let dir = std::env::temp_dir().join("tachyon-test-same");
        let _ = std::fs::create_dir_all(&dir);
        let a = dir.join("a.txt");
        let b = dir.join("b.txt");
        std::fs::write(&a, b"test").unwrap();
        std::fs::write(&b, b"test").unwrap();
        assert!(same_file(&a, &a));
        assert!(!same_file(&a, &b));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn epoch_seconds_converts_system_time() {
        let now = std::time::SystemTime::now();
        let seconds = epoch_seconds(now);
        assert!(seconds.is_some());
        assert!(seconds.unwrap() > 1_700_000_000); // after 2023
    }

    fn asset(name: &str, size: u64) -> GithubAsset {
        GithubAsset {
            name: name.to_string(),
            browser_download_url: format!("https://example.invalid/{name}"),
            size,
        }
    }

    fn test_release_info(asset_name: &str) -> RuntimeReleaseInfo {
        RuntimeReleaseInfo {
            tag_name: "v-test".to_string(),
            asset_name: asset_name.to_string(),
            asset_url: format!("https://example.invalid/{asset_name}"),
            asset_size_bytes: 123,
            checksum_asset_name: "SHA256SUMS.txt".to_string(),
            checksum_url: "https://example.invalid/SHA256SUMS.txt".to_string(),
            published_at: None,
        }
    }

    fn unique_temp_dir(prefix: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!("{prefix}-{nanos}"))
    }
}

pub fn run() {
    tauri::Builder::default()
        .manage(RuntimeState::default())
        .manage(system_proxy::SystemProxyRuntime::default())
        .setup(|app| {
            let paths = draft_paths(app.handle())?;
            let generation_dir = PathBuf::from(paths.config_dir).join("xray-generations");
            let clock_path = generation_dir.join("clock.json");
            let runtime = app.state::<RuntimeState>();
            let mut coordinator = runtime
                .xray
                .lock()
                .map_err(|error| format!("lock Xray coordinator during setup: {error}"))?;
            coordinator.generations = xray_generation::GenerationRuntime::with_persistent_storage(
                clock_path,
                generation_dir,
            )?;
            drop(coordinator);

            let window_config = app
                .config()
                .app
                .windows
                .iter()
                .find(|window| window.label == "main")
                .ok_or_else(|| "missing main window config".to_string())?;

            let window =
                tauri::WebviewWindowBuilder::from_config(app.handle(), window_config)?.build()?;
            let _ = window;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            core_status,
            list_game_profiles,
            save_game_profile,
            remove_game_profile,
            scan_steam_library,
            config_paths,
            read_canonical_xray_config,
            save_config_drafts,
            save_config_draft,
            runtime_paths,
            runtime_settings,
            save_runtime_settings,
            managed_binaries,
            install_managed_binary,
            latest_xray_release,
            install_latest_xray,
            latest_tachyon_core_release,
            install_latest_tachyon_core,
            core_release_diagnostics,
            install_wintun_sidecar,
            fetch_subscription_text,
            load_secure_vault,
            save_secure_vault_section,
            migrate_secure_vault,
            clear_secure_vault,
            runtime_status,
            xray_generation_status,
            runtime_process_logs,
            runtime_privilege_status,
            xray_traffic_stats,
            tachyon_telemetry_events,
            test_tcp_latency,
            test_xray_proxy,
            test_xray_local_proxies,
            validate_xray_config,
            commit_validated_xray_config,
            validate_tachyon_core_config,
            tachyon_core_preflight,
            system_proxy_capability,
            system_proxy_query,
            system_proxy_apply,
            system_proxy_restore,
            system_proxy_status,
            enable_system_proxy,
            disable_system_proxy,
            start_xray,
            stop_xray,
            start_tachyon_core,
            stop_tachyon_core,
            start_all,
            stop_all,
            window_minimize,
            window_toggle_maximize,
            window_set_maximized,
            window_set_always_on_top,
            window_close,
            window_start_dragging
        ])
        .build(tauri::generate_context!())
        .expect("failed to build Tachyon Prism")
        .run(|handle, event| {
            if matches!(&event, tauri::RunEvent::Ready) {
                let proxy_runtime = handle.state::<system_proxy::SystemProxyRuntime>();
                let runtime = handle.state::<RuntimeState>();
                let mut coordinator = runtime
                    .xray
                    .lock()
                    .expect("lock Xray coordinator during startup recovery");
                if let Err(error) = coordinator.set_proxy_binding(handle, &proxy_runtime, false) {
                    let sanitized = sanitize_xray_ui_error(error);
                    eprintln!("Tachyon Prism startup proxy recovery failed: {sanitized}");
                    let _ = handle.emit("runtime-cleanup-error", sanitized);
                }
                drop(coordinator);
                for (_, window) in handle.webview_windows() {
                    let default_size = tauri::Size::Logical(tauri::LogicalSize {
                        width: 800.0,
                        height: 540.0,
                    });
                    let _ = window.set_min_size(Some(default_size));
                    let _ = window.set_size(default_size);
                    let _ = window.center();
                    let _ = window.show();
                    let _ = window.set_focus();
                    native_titlebar::install(&window)
                        .expect("failed to install native borderless titlebar");
                }
            }
            match event {
                tauri::RunEvent::ExitRequested { api, .. } => {
                    if let Err(error) = cleanup_runtime(handle) {
                        api.prevent_exit();
                        let sanitized = sanitize_xray_ui_error(error);
                        eprintln!("Tachyon Prism shutdown blocked: {sanitized}");
                        let _ = handle.emit("runtime-cleanup-error", sanitized);
                    }
                }
                tauri::RunEvent::Exit => {
                    if let Err(error) = cleanup_runtime(handle) {
                        eprintln!(
                            "Tachyon Prism final cleanup failed: {}",
                            sanitize_xray_ui_error(error)
                        );
                    }
                }
                _ => {}
            }
        });
}
