use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs;
use std::io::{self, Read, Write};
use std::net::{Shutdown, TcpStream, ToSocketAddrs};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Output, Stdio};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::Manager;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ConfigDraftPaths {
    config_dir: String,
    core_config_path: String,
    xray_config_path: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RuntimePaths {
    bin_dir: String,
    tachyon_core_binary_path: String,
    xray_binary_path: String,
    runtime_settings_path: String,
}

#[derive(Default, Deserialize, Serialize)]
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

#[derive(Serialize)]
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
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeStatus {
    tachyon_core: ProcessStatus,
    xray: ProcessStatus,
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
struct ConfigValidationResult {
    ok: bool,
    target: String,
    command: String,
    details: String,
    error: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SystemProxyState {
    supported: bool,
    enabled: bool,
    matches_prism: bool,
    proxy_server: String,
    expected_proxy_server: String,
    bypass: String,
    error: Option<String>,
}

const WINTUN_VERSION: &str = "0.14.1";
const WINTUN_ARCHIVE_NAME: &str = "wintun-0.14.1.zip";
const WINTUN_DOWNLOAD_URL: &str = "https://www.wintun.net/builds/wintun-0.14.1.zip";
const WINTUN_SHA256: &str = "07c256185d6ee3652e09fa55c0b673e2624b565e02c4b9091c79ca7d2f24ef51";

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
    processes: Mutex<RuntimeProcesses>,
    window_restore_bounds: Mutex<Option<WindowBounds>>,
}

#[derive(Clone, Copy)]
struct WindowBounds {
    position: tauri::PhysicalPosition<i32>,
    size: tauri::PhysicalSize<u32>,
}

impl Default for RuntimeState {
    fn default() -> Self {
        Self {
            processes: Mutex::new(RuntimeProcesses::default()),
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
}

#[tauri::command]
fn core_status() -> String {
    match core_health_check() {
        Ok(status) => status,
        Err(_) => "disconnected".to_string(),
    }
}

fn core_health_check() -> Result<String, String> {
    let mut response = health_agent()
        .get("http://127.0.0.1:55123/v1/health")
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
fn install_wintun_sidecar(app: tauri::AppHandle) -> Result<ManagedBinaryInventory, String> {
    install_wintun_sidecar_file(&app)
}

#[tauri::command]
fn fetch_subscription_text(source_url: String) -> Result<String, String> {
    let url = clean_url_input(&source_url);
    if url.is_empty() {
        return Err("subscription URL is required".to_string());
    }
    if !url.starts_with("http://") && !url.starts_with("https://") {
        return Err("subscription URL must start with http:// or https://".to_string());
    }
    http_get_text(&url)
}

#[tauri::command]
fn runtime_status(state: tauri::State<RuntimeState>) -> Result<RuntimeStatus, String> {
    let mut processes = state
        .processes
        .lock()
        .map_err(|err| format!("lock runtime state: {err}"))?;
    Ok(processes.status())
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

    let server = format!(
        "{}:{}",
        settings.xray_stats_listen, settings.xray_stats_port
    );
    let output = run_xray_stats_query(&binary, &server)?;
    let mut stats = parse_xray_stats_query_output(&output);
    stats.queried_at = epoch_seconds(SystemTime::now());
    Ok(stats)
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
fn system_proxy_status(app: tauri::AppHandle) -> Result<SystemProxyState, String> {
    let settings = load_runtime_settings(&app)?;
    Ok(platform_system_proxy_status(&settings))
}

#[tauri::command]
fn enable_system_proxy(app: tauri::AppHandle) -> Result<SystemProxyState, String> {
    let settings = load_runtime_settings(&app)?;
    platform_enable_system_proxy(&settings)?;
    Ok(platform_system_proxy_status(&settings))
}

#[tauri::command]
fn disable_system_proxy(app: tauri::AppHandle) -> Result<SystemProxyState, String> {
    let settings = load_runtime_settings(&app)?;
    platform_disable_system_proxy(&settings)?;
    Ok(platform_system_proxy_status(&settings))
}

#[tauri::command]
fn start_xray(
    state: tauri::State<RuntimeState>,
    binary_path: String,
    config_path: String,
) -> Result<ProcessStatus, String> {
    let mut processes = state
        .processes
        .lock()
        .map_err(|err| format!("lock runtime state: {err}"))?;
    processes.xray.start(
        "xray",
        ManagedBinaryKind::Xray,
        binary_path,
        config_path.clone(),
        &["run", "-config", &config_path],
    )
}

#[tauri::command]
fn stop_xray(state: tauri::State<RuntimeState>) -> Result<ProcessStatus, String> {
    let mut processes = state
        .processes
        .lock()
        .map_err(|err| format!("lock runtime state: {err}"))?;
    processes.xray.stop("xray")
}

#[tauri::command]
fn start_tachyon_core(
    state: tauri::State<RuntimeState>,
    binary_path: String,
    config_path: String,
) -> Result<ProcessStatus, String> {
    let mut processes = state
        .processes
        .lock()
        .map_err(|err| format!("lock runtime state: {err}"))?;
    processes.tachyon_core.start(
        "tachyon-core",
        ManagedBinaryKind::TachyonCore,
        binary_path,
        config_path.clone(),
        &["run", "--config", &config_path],
    )
}

#[tauri::command]
fn stop_tachyon_core(state: tauri::State<RuntimeState>) -> Result<ProcessStatus, String> {
    let mut processes = state
        .processes
        .lock()
        .map_err(|err| format!("lock runtime state: {err}"))?;
    processes.tachyon_core.stop("tachyon-core")
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
    match output {
        Ok(output) => {
            let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
            let details = validation_details(&stdout, &stderr);
            let ok = output.status.success();
            ConfigValidationResult {
                ok,
                target: target.to_string(),
                command,
                details,
                error: if ok {
                    None
                } else {
                    Some(validation_details(&stdout, &stderr))
                },
            }
        }
        Err(error) => ConfigValidationResult {
            ok: false,
            target: target.to_string(),
            command,
            details: String::new(),
            error: Some(error),
        },
    }
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
    let output = command_output_with_timeout(command, Duration::from_secs(2))?;
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
    let proxy = format!("{}:{}", proxy_host.trim(), proxy_port);
    let addrs: Vec<_> = proxy
        .to_socket_addrs()
        .map_err(|err| format!("resolve local proxy {proxy}: {err}"))?
        .collect();
    if addrs.is_empty() {
        return Err(format!("resolve local proxy {proxy}: no addresses"));
    }

    let started = Instant::now();
    let mut last_error = String::new();
    for addr in addrs {
        match TcpStream::connect_timeout(&addr, timeout) {
            Ok(mut stream) => {
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
                return Ok(ProxyProbeResult {
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
                });
            }
            Err(err) => {
                last_error = err.to_string();
            }
        }
    }

    Ok(ProxyProbeResult {
        ok: false,
        status_code: None,
        latency_ms: None,
        via: proxy,
        target_url: target.absolute_url,
        error: Some(last_error),
    })
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

fn default_system_proxy_bypass() -> String {
    "localhost;127.*;10.*;172.16.*;172.17.*;172.18.*;172.19.*;172.20.*;172.21.*;172.22.*;172.23.*;172.24.*;172.25.*;172.26.*;172.27.*;172.28.*;172.29.*;172.30.*;172.31.*;192.168.*;<local>".to_string()
}

fn system_proxy_state(
    settings: &RuntimeSettings,
    supported: bool,
    enabled: bool,
    proxy_server: String,
    bypass: String,
    error: Option<String>,
) -> SystemProxyState {
    let expected = expected_system_proxy_server(settings);
    let matches_prism =
        enabled && normalize_proxy_server(&proxy_server) == normalize_proxy_server(&expected);
    SystemProxyState {
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

#[cfg(target_os = "windows")]
fn platform_system_proxy_status(settings: &RuntimeSettings) -> SystemProxyState {
    match windows_reg_query_internet_settings() {
        Ok(raw) => {
            let parsed = parse_windows_proxy_settings(&raw);
            system_proxy_state(
                settings,
                true,
                parsed.proxy_enable,
                parsed.proxy_server,
                parsed.proxy_override,
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
    }
}

#[cfg(target_os = "windows")]
fn platform_enable_system_proxy(settings: &RuntimeSettings) -> Result<(), String> {
    let server = expected_system_proxy_server(settings);
    run_command(
        "reg",
        &[
            "add",
            WINDOWS_INTERNET_SETTINGS_KEY,
            "/v",
            "ProxyEnable",
            "/t",
            "REG_DWORD",
            "/d",
            "1",
            "/f",
        ],
    )?;
    run_command(
        "reg",
        &[
            "add",
            WINDOWS_INTERNET_SETTINGS_KEY,
            "/v",
            "ProxyServer",
            "/t",
            "REG_SZ",
            "/d",
            &server,
            "/f",
        ],
    )?;
    run_command(
        "reg",
        &[
            "add",
            WINDOWS_INTERNET_SETTINGS_KEY,
            "/v",
            "ProxyOverride",
            "/t",
            "REG_SZ",
            "/d",
            &settings.system_proxy_bypass,
            "/f",
        ],
    )?;
    notify_windows_proxy_changed();
    Ok(())
}

#[cfg(target_os = "windows")]
fn platform_disable_system_proxy(_settings: &RuntimeSettings) -> Result<(), String> {
    run_command(
        "reg",
        &[
            "add",
            WINDOWS_INTERNET_SETTINGS_KEY,
            "/v",
            "ProxyEnable",
            "/t",
            "REG_DWORD",
            "/d",
            "0",
            "/f",
        ],
    )?;
    notify_windows_proxy_changed();
    Ok(())
}

#[cfg(target_os = "windows")]
const WINDOWS_INTERNET_SETTINGS_KEY: &str =
    r"HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings";

#[cfg(target_os = "windows")]
fn windows_reg_query_internet_settings() -> Result<String, String> {
    run_command("reg", &["query", WINDOWS_INTERNET_SETTINGS_KEY])
}

#[derive(Default)]
struct WindowsProxySettings {
    proxy_enable: bool,
    proxy_server: String,
    proxy_override: String,
}

fn parse_windows_proxy_settings(raw: &str) -> WindowsProxySettings {
    let mut settings = WindowsProxySettings::default();
    for line in raw.lines() {
        let parts: Vec<_> = line.split_whitespace().collect();
        if parts.len() < 3 {
            continue;
        }
        match parts[0] {
            "ProxyEnable" => {
                settings.proxy_enable = parts[2] == "0x1" || parts[2] == "1";
            }
            "ProxyServer" => {
                settings.proxy_server = parts[2..].join(" ");
            }
            "ProxyOverride" => {
                settings.proxy_override = parts[2..].join(" ");
            }
            _ => {}
        }
    }
    settings
}

#[cfg(target_os = "windows")]
fn notify_windows_proxy_changed() {
    let _ = run_command(
        "rundll32.exe",
        &["user32.dll,UpdatePerUserSystemParameters"],
    );
}

#[cfg(target_os = "macos")]
fn platform_system_proxy_status(settings: &RuntimeSettings) -> SystemProxyState {
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
fn platform_system_proxy_status(settings: &RuntimeSettings) -> SystemProxyState {
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
fn platform_system_proxy_status(settings: &RuntimeSettings) -> SystemProxyState {
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
    let mut child = command
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|err| format!("spawn command: {err}"))?;
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
    host_header: String,
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
    Ok(HttpProbeTarget {
        absolute_url: format!("http://{authority}{path}"),
        host_header: authority.to_string(),
    })
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
    let settings_path = runtime_settings_path(app)?;
    let config_dir = settings_path
        .parent()
        .ok_or_else(|| "runtime settings path has no parent".to_string())?;
    fs::create_dir_all(config_dir)
        .map_err(|err| format!("create config directory {}: {err}", config_dir.display()))?;
    let data = serde_json::to_string_pretty(&settings)
        .map_err(|err| format!("encode runtime settings: {err}"))?;
    write_atomic(&settings_path, &(data + "\n"))?;
    Ok(settings)
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
            9500,
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
        tachyon_tgp_server_address: String::new(),
        tachyon_telemetry_interval_ms: 500,
        tachyon_core_release_channel: "preview".to_string(),
        tachyon_tun_address: "198.18.0.1/16".to_string(),
        tachyon_tun_auto_route: false,
        tachyon_tun_dns_hijack: false,
        tachyon_tun_mtu: 9000,
        xray_http_listen: "127.0.0.1".to_string(),
        xray_http_port: 10809,
        xray_socks_listen: "127.0.0.1".to_string(),
        xray_socks_port: 10808,
        system_proxy_bypass: default_system_proxy_bypass(),
        xray_stats_enabled: true,
        xray_stats_listen: "127.0.0.1".to_string(),
        xray_stats_port: 10085,
        xray_release_channel: "stable".to_string(),
    })
}

fn default_true() -> bool {
    true
}

fn normalize_release_channel(value: String, fallback: String) -> String {
    match value.trim().to_ascii_lowercase().as_str() {
        "stable" => "stable".to_string(),
        "preview" | "pre" | "prerelease" => "preview".to_string(),
        _ => fallback,
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
        .split(|ch| ch == '\n' || ch == ',')
        .map(clean_path_input)
        .filter(|item| !item.is_empty())
        .collect::<Vec<_>>()
        .join("\n")
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
    Ok(managed_binary_inventory(app)?)
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
    for release in releases {
        if !release_channel_allows(&release, channel) {
            continue;
        }
        if let Ok(info) = xray_release_info(release) {
            return Ok(info);
        }
    }
    Err(format!(
        "no compatible Xray release found for channel {channel}"
    ))
}

fn latest_tachyon_core_release_info(
    releases: Vec<GithubRelease>,
    channel: &str,
) -> Result<RuntimeReleaseInfo, String> {
    for release in releases {
        if !release_channel_allows(&release, channel) {
            continue;
        }
        if let Ok(info) = tachyon_core_release_info(release) {
            return Ok(info);
        }
    }
    Err(format!(
        "no compatible Tachyon Core release found for channel {channel}"
    ))
}

fn release_channel_allows(release: &GithubRelease, channel: &str) -> bool {
    match channel.trim().to_ascii_lowercase().as_str() {
        "preview" | "pre" | "prerelease" => true,
        _ => !release.prerelease,
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

fn health_agent() -> ureq::Agent {
    let config = ureq::Agent::config_builder()
        .timeout_global(Some(Duration::from_secs(3)))
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
    for line in checksum_text.lines() {
        if !line.contains(asset_name) {
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

fn write_atomic(path: &Path, content: &str) -> Result<(), String> {
    let temp_path = path.with_extension("json.tmp");
    fs::write(&temp_path, content).map_err(|err| format!("write {}: {err}", path.display()))?;
    if path.exists() {
        fs::remove_file(path).map_err(|err| format!("replace {}: {err}", path.display()))?;
    }
    fs::rename(&temp_path, path).map_err(|err| format!("move {}: {err}", path.display()))
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
}

impl ManagedProcess {
    fn start(
        &mut self,
        label: &str,
        kind: ManagedBinaryKind,
        binary_path: String,
        config_path: String,
        args: &[&str],
    ) -> Result<ProcessStatus, String> {
        self.refresh(label)?;
        if self.child.is_some() {
            return Err(format!("{label} is already running"));
        }

        let binary = PathBuf::from(clean_path_input(&binary_path));
        if !binary.is_file() {
            return Err(format!("{label} binary not found: {}", binary.display()));
        }
        let config = PathBuf::from(clean_path_input(&config_path));
        if !config.is_file() {
            return Err(format!("{label} config not found: {}", config.display()));
        }
        validate_process_start_inputs(label, kind, &binary, &config)?;

        let mut command = Command::new(&binary);
        command.args(args);
        command.stdin(Stdio::null());
        command.stdout(Stdio::null());
        command.stderr(Stdio::null());
        if let Some(work_dir) = config.parent().or_else(|| binary.parent()) {
            command.current_dir(work_dir);
        }
        hide_command_window(&mut command);

        let child = command
            .spawn()
            .map_err(|err| format!("start {label}: {err}"))?;
        self.child = Some(child);
        self.binary_path = Some(path_string(&binary));
        self.config_path = Some(path_string(&config));
        self.started_at = Some(now_epoch_seconds());
        self.last_error = None;
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
        child.kill().map_err(|err| format!("stop {label}: {err}"))?;
        let _ = child.wait();
        self.started_at = None;
        self.last_error = None;
        Ok(self.snapshot())
    }

    fn status(&mut self) -> ProcessStatus {
        if let Err(err) = self.refresh("process") {
            self.child = None;
            self.started_at = None;
            self.last_error = Some(err);
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
            self.last_error = if status.success() {
                None
            } else {
                Some(format!("{label} exited with {status}"))
            };
        }
        Ok(())
    }

    fn snapshot(&self) -> ProcessStatus {
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
            last_error: self.last_error.clone(),
        }
    }
}

fn validate_process_start_inputs(
    label: &str,
    kind: ManagedBinaryKind,
    binary: &Path,
    config: &Path,
) -> Result<(), String> {
    if !binary.is_file() {
        return Err(format!("{label} binary not found: {}", binary.display()));
    }
    if !config.is_file() {
        return Err(format!("{label} config not found: {}", config.display()));
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
fn window_close(window: tauri::Window) -> Result<(), String> {
    window.close().map_err(|error| error.to_string())
}

#[tauri::command]
fn window_start_dragging(window: tauri::Window) -> Result<(), String> {
    window.start_dragging().map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

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
        assert!(!missing.tachyon_tun_auto_route);
        assert!(!missing.tachyon_tun_dns_hijack);

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
        assert_eq!(target.host_header, "example.com:8080");
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
    fn validation_command_line_quotes_paths_with_spaces() {
        let binary = Path::new("C:\\Program Files\\Xray\\xray.exe");
        let config = Path::new("C:\\Users\\Test User\\xray-client.json");
        let line = validation_command_line(binary, &["run", "-test", "-config"], config);
        assert!(line.contains("\"C:\\Program Files\\Xray\\xray.exe\""));
        assert!(line.contains("run -test -config"));
        assert!(line.contains("\"C:\\Users\\Test User\\xray-client.json\""));
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

    #[test]
    fn parses_windows_proxy_registry_output() {
        let raw = r#"
HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Internet Settings
    ProxyEnable    REG_DWORD    0x1
    ProxyServer    REG_SZ    http=127.0.0.1:10809;https=127.0.0.1:10809;socks=127.0.0.1:10808
    ProxyOverride    REG_SZ    localhost;127.*;<local>
"#;
        let parsed = parse_windows_proxy_settings(raw);
        assert!(parsed.proxy_enable);
        assert_eq!(
            parsed.proxy_server,
            "http=127.0.0.1:10809;https=127.0.0.1:10809;socks=127.0.0.1:10808"
        );
        assert_eq!(parsed.proxy_override, "localhost;127.*;<local>");
    }

    #[test]
    fn system_proxy_state_detects_prism_match() {
        let settings = RuntimeSettings {
            xray_http_listen: "127.0.0.1".to_string(),
            xray_http_port: 10809,
            xray_socks_listen: "127.0.0.1".to_string(),
            xray_socks_port: 10808,
            ..RuntimeSettings::default()
        };
        let state = system_proxy_state(
            &settings,
            true,
            true,
            "HTTP=127.0.0.1:10809;HTTPS=127.0.0.1:10809;SOCKS=127.0.0.1:10808".to_string(),
            default_system_proxy_bypass(),
            None,
        );
        assert!(state.matches_prism);
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
}

pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let window_config = app
                .config()
                .app
                .windows
                .iter()
                .find(|window| window.label == "main")
                .ok_or_else(|| "missing main window config".to_string())?;

            tauri::WebviewWindowBuilder::from_config(app.handle(), window_config)?.build()?;
            Ok(())
        })
        .manage(RuntimeState::default())
        .invoke_handler(tauri::generate_handler![
            core_status,
            list_game_profiles,
            save_game_profile,
            remove_game_profile,
            scan_steam_library,
            config_paths,
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
            install_wintun_sidecar,
            fetch_subscription_text,
            runtime_status,
            runtime_privilege_status,
            xray_traffic_stats,
            test_tcp_latency,
            test_xray_proxy,
            validate_xray_config,
            validate_tachyon_core_config,
            system_proxy_status,
            enable_system_proxy,
            disable_system_proxy,
            start_xray,
            stop_xray,
            start_tachyon_core,
            stop_tachyon_core,
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
            if matches!(event, tauri::RunEvent::Ready) {
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
                }
            }
        });
}
