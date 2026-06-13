use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
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

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeSettings {
    #[serde(default)]
    tachyon_core_binary_path: String,
    #[serde(default)]
    xray_binary_path: String,
    #[serde(default)]
    tachyon_core_release_channel: String,
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
}

impl Default for RuntimeState {
    fn default() -> Self {
        Self {
            processes: Mutex::new(RuntimeProcesses::default()),
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
        tachyon_core_binary_path: non_empty_or(
            settings.tachyon_core_binary_path,
            defaults.tachyon_core_binary_path,
        ),
        xray_binary_path: non_empty_or(settings.xray_binary_path, defaults.xray_binary_path),
        tachyon_core_release_channel: normalize_release_channel(
            settings.tachyon_core_release_channel,
            defaults.tachyon_core_release_channel,
        ),
        xray_release_channel: normalize_release_channel(
            settings.xray_release_channel,
            defaults.xray_release_channel,
        ),
    })
}

fn default_runtime_settings(app: &tauri::AppHandle) -> Result<RuntimeSettings, String> {
    let paths = default_runtime_paths(app)?;
    Ok(RuntimeSettings {
        tachyon_core_binary_path: paths.tachyon_core_binary_path,
        xray_binary_path: paths.xray_binary_path,
        tachyon_core_release_channel: "preview".to_string(),
        xray_release_channel: "stable".to_string(),
    })
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

        let mut command = Command::new(&binary);
        command.args(args);
        command.stdin(Stdio::null());
        command.stdout(Stdio::null());
        command.stderr(Stdio::null());
        if let Some(work_dir) = config.parent().or_else(|| binary.parent()) {
            command.current_dir(work_dir);
        }
        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x08000000;
            command.creation_flags(CREATE_NO_WINDOW);
        }

        let child = command
            .spawn()
            .map_err(|err| format!("start {label}: {err}"))?;
        self.child = Some(child);
        self.binary_path = Some(path_string(&binary));
        self.config_path = Some(path_string(&config));
        self.started_at = Some(now_epoch_seconds());
        self.last_error = None;
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

fn now_epoch_seconds() -> u64 {
    epoch_seconds(SystemTime::now()).unwrap_or_default()
}

fn epoch_seconds(time: SystemTime) -> Option<u64> {
    time.duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .ok()
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
        .manage(RuntimeState::default())
        .invoke_handler(tauri::generate_handler![
            core_status,
            list_game_profiles,
            save_game_profile,
            remove_game_profile,
            scan_steam_library,
            config_paths,
            save_config_drafts,
            runtime_paths,
            runtime_settings,
            save_runtime_settings,
            managed_binaries,
            install_managed_binary,
            latest_xray_release,
            install_latest_xray,
            latest_tachyon_core_release,
            install_latest_tachyon_core,
            fetch_subscription_text,
            runtime_status,
            start_xray,
            stop_xray,
            start_tachyon_core,
            stop_tachyon_core
        ])
        .run(tauri::generate_context!())
        .expect("failed to run Tachyon Prism");
}
