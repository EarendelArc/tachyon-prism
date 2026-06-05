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
    tachyon_core_binary_path: String,
    xray_binary_path: String,
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
    managed_exists: bool,
    configured_exists: bool,
    managed_size_bytes: Option<u64>,
    configured_size_bytes: Option<u64>,
    managed_modified_at: Option<u64>,
    configured_modified_at: Option<u64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct XrayReleaseInfo {
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
struct XrayInstallResult {
    release: XrayReleaseInfo,
    sha256: String,
    binary_path: String,
    inventory: ManagedBinaryInventory,
}

#[derive(Deserialize)]
struct GithubRelease {
    tag_name: String,
    published_at: Option<String>,
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
    "disconnected".to_string()
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
fn latest_xray_release() -> Result<XrayReleaseInfo, String> {
    fetch_latest_xray_release()
}

#[tauri::command]
fn install_latest_xray(app: tauri::AppHandle) -> Result<XrayInstallResult, String> {
    install_latest_xray_release(&app)
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
    })
}

fn default_runtime_settings(app: &tauri::AppHandle) -> Result<RuntimeSettings, String> {
    let paths = default_runtime_paths(app)?;
    Ok(RuntimeSettings {
        tachyon_core_binary_path: paths.tachyon_core_binary_path,
        xray_binary_path: paths.xray_binary_path,
    })
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

fn binary_name(base: &str) -> String {
    if cfg!(target_os = "windows") {
        format!("{base}.exe")
    } else {
        base.to_string()
    }
}

#[derive(Copy, Clone)]
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
        managed_exists: managed_meta.exists,
        configured_exists: configured_meta.exists,
        managed_size_bytes: managed_meta.size_bytes,
        configured_size_bytes: configured_meta.size_bytes,
        managed_modified_at: managed_meta.modified_at,
        configured_modified_at: configured_meta.modified_at,
    })
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

fn fetch_latest_xray_release() -> Result<XrayReleaseInfo, String> {
    let release: GithubRelease =
        http_get_json("https://api.github.com/repos/XTLS/Xray-core/releases/latest")?;
    xray_release_info(release)
}

fn install_latest_xray_release(app: &tauri::AppHandle) -> Result<XrayInstallResult, String> {
    let release = fetch_latest_xray_release()?;
    let download_dir = app
        .path()
        .app_config_dir()
        .map_err(|err| format!("resolve app config directory: {err}"))?
        .join("downloads")
        .join("xray")
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

    let target = managed_binary_target(app, ManagedBinaryKind::Xray)?;
    extract_binary_from_zip(&archive_path, &target, &binary_name("xray"))?;
    make_executable(&target)?;

    let mut settings = load_runtime_settings(app)?;
    settings.xray_binary_path = path_string(&target);
    let _ = save_runtime_settings_file(app, settings)?;

    Ok(XrayInstallResult {
        release,
        sha256: actual_sha256,
        binary_path: path_string(&target),
        inventory: managed_binary_inventory(app)?,
    })
}

fn xray_release_info(release: GithubRelease) -> Result<XrayReleaseInfo, String> {
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

    Ok(XrayReleaseInfo {
        tag_name: release.tag_name,
        asset_name: asset.name,
        asset_url: asset.browser_download_url,
        asset_size_bytes: asset.size,
        checksum_asset_name: checksum_asset.name,
        checksum_url: checksum_asset.browser_download_url,
        published_at: release.published_at,
    })
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

pub fn run() {
    tauri::Builder::default()
        .manage(RuntimeState::default())
        .invoke_handler(tauri::generate_handler![
            core_status,
            config_paths,
            save_config_drafts,
            runtime_paths,
            runtime_settings,
            save_runtime_settings,
            managed_binaries,
            install_managed_binary,
            latest_xray_release,
            install_latest_xray,
            runtime_status,
            start_xray,
            stop_xray,
            start_tachyon_core,
            stop_tachyon_core
        ])
        .run(tauri::generate_context!())
        .expect("failed to run Tachyon Prism");
}
