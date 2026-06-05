use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};
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
    let settings = normalize_runtime_settings(&app, settings)?;
    let settings_path = runtime_settings_path(&app)?;
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
    let trimmed = value.trim();
    if trimmed.is_empty() {
        fallback
    } else {
        trimmed.to_string()
    }
}

fn binary_name(base: &str) -> String {
    if cfg!(target_os = "windows") {
        format!("{base}.exe")
    } else {
        base.to_string()
    }
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

        let binary = PathBuf::from(binary_path.trim());
        if !binary.is_file() {
            return Err(format!("{label} binary not found: {}", binary.display()));
        }
        let config = PathBuf::from(config_path.trim());
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
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or_default()
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
            runtime_status,
            start_xray,
            stop_xray,
            start_tachyon_core,
            stop_tachyon_core
        ])
        .run(tauri::generate_context!())
        .expect("failed to run Tachyon Prism");
}
