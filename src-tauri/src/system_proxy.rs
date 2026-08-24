#[cfg(target_os = "windows")]
use super::run_command;
use super::{
    default_runtime_settings, expected_system_proxy_server, load_runtime_settings,
    normalize_proxy_server, now_epoch_seconds, write_atomic, RuntimeSettings,
};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use tauri::Manager;

const JOURNAL_FILE_NAME: &str = "system-proxy-transaction.json";

pub(crate) struct SystemProxyRuntime {
    transaction: Mutex<()>,
    audit: SystemProxyAudit,
}

impl Default for SystemProxyRuntime {
    fn default() -> Self {
        Self {
            transaction: Mutex::new(()),
            audit: SystemProxyAudit::default(),
        }
    }
}

#[derive(Default)]
struct SystemProxyAudit {
    sequence: AtomicU64,
    capture_count: AtomicU64,
    restore_count: AtomicU64,
    bind_count: AtomicU64,
    mutation_count: AtomicU64,
    events: Mutex<Vec<SystemProxyAuditEvent>>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SystemProxyAuditEvent {
    sequence: u64,
    operation: String,
    mutation: bool,
    at_epoch_seconds: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SystemProxyAuditSnapshot {
    capture_count: u64,
    restore_count: u64,
    bind_count: u64,
    mutation_count: u64,
    events: Vec<SystemProxyAuditEvent>,
}

impl SystemProxyRuntime {
    fn record_platform_call(&self, operation: &str, mutation: bool) {
        match operation {
            "capture" => {
                self.audit.capture_count.fetch_add(1, Ordering::SeqCst);
            }
            "restore" => {
                self.audit.restore_count.fetch_add(1, Ordering::SeqCst);
            }
            "bind" => {
                self.audit.bind_count.fetch_add(1, Ordering::SeqCst);
            }
            _ => {}
        }
        if mutation {
            self.audit.mutation_count.fetch_add(1, Ordering::SeqCst);
        }
        let event = SystemProxyAuditEvent {
            sequence: self.audit.sequence.fetch_add(1, Ordering::SeqCst) + 1,
            operation: operation.to_string(),
            mutation,
            at_epoch_seconds: now_epoch_seconds(),
        };
        if let Ok(mut events) = self.audit.events.lock() {
            const MAX_AUDIT_EVENTS: usize = 128;
            if events.len() == MAX_AUDIT_EVENTS {
                events.remove(0);
            }
            events.push(event);
        }
    }

    pub(crate) fn audit_snapshot(&self) -> SystemProxyAuditSnapshot {
        let _transaction = self
            .transaction
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        SystemProxyAuditSnapshot {
            capture_count: self.audit.capture_count.load(Ordering::SeqCst),
            restore_count: self.audit.restore_count.load(Ordering::SeqCst),
            bind_count: self.audit.bind_count.load(Ordering::SeqCst),
            mutation_count: self.audit.mutation_count.load(Ordering::SeqCst),
            events: self
                .audit
                .events
                .lock()
                .map(|events| events.clone())
                .unwrap_or_default(),
        }
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SystemProxyCapability {
    platform: String,
    supported: bool,
    can_query: bool,
    can_apply: bool,
    can_restore: bool,
    scope: String,
    backend: String,
    requires_elevation: bool,
    reason: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SystemProxyState {
    pub(crate) supported: bool,
    pub(crate) enabled: bool,
    pub(crate) matches_prism: bool,
    pub(crate) proxy_server: String,
    pub(crate) expected_proxy_server: String,
    pub(crate) bypass: String,
    pub(crate) error: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SystemProxyQuery {
    capability: SystemProxyCapability,
    pub(crate) current: SystemProxyState,
    pub(crate) pending_transaction: Option<PendingSystemProxyTransaction>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PendingSystemProxyTransaction {
    pub(crate) transaction_id: String,
    created_at: u64,
    desired_enabled: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SystemProxyTransactionResult {
    pub(crate) transaction_id: String,
    phase: String,
    previous: SystemProxyState,
    pub(crate) current: SystemProxyState,
    rollback_available: bool,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(tag = "platform", rename_all = "camelCase")]
pub(crate) enum PlatformProxySnapshot {
    Windows(WindowsProxySnapshot),
    #[cfg(test)]
    Test(TestProxySnapshot),
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WindowsProxySnapshot {
    proxy_enable: Option<u32>,
    proxy_server: Option<String>,
    proxy_override: Option<String>,
}

#[cfg(test)]
#[derive(Clone, Debug, Default, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TestProxySnapshot {
    enabled: bool,
    proxy_server: String,
    bypass: String,
}

#[cfg(test)]
pub(crate) struct TestRegistryOps {
    snapshot: Mutex<TestProxySnapshot>,
}

#[cfg(test)]
impl TestRegistryOps {
    pub(crate) fn from_state(
        enabled: bool,
        proxy_server: impl Into<String>,
        bypass: impl Into<String>,
    ) -> Self {
        Self {
            snapshot: Mutex::new(TestProxySnapshot {
                enabled,
                proxy_server: proxy_server.into(),
                bypass: bypass.into(),
            }),
        }
    }
}

#[cfg(test)]
impl RegistryOps for TestRegistryOps {
    fn capability(&self) -> SystemProxyCapability {
        SystemProxyCapability {
            platform: "test".to_string(),
            supported: true,
            can_query: true,
            can_apply: true,
            can_restore: true,
            scope: "isolated-test".to_string(),
            backend: "inMemoryRegistryOps".to_string(),
            requires_elevation: false,
            reason: None,
        }
    }

    fn snapshot(&self) -> Result<PlatformProxySnapshot, String> {
        Ok(PlatformProxySnapshot::Test(
            self.snapshot
                .lock()
                .map_err(|error| format!("lock test registry: {error}"))?
                .clone(),
        ))
    }

    fn query(&self, settings: &RuntimeSettings) -> Result<SystemProxyState, String> {
        let snapshot = self
            .snapshot
            .lock()
            .map_err(|error| format!("lock test registry: {error}"))?;
        Ok(proxy_state(
            settings,
            true,
            snapshot.enabled,
            snapshot.proxy_server.clone(),
            snapshot.bypass.clone(),
            None,
        ))
    }

    fn apply(&self, settings: &RuntimeSettings, enabled: bool) -> Result<(), String> {
        let mut snapshot = self
            .snapshot
            .lock()
            .map_err(|error| format!("lock test registry: {error}"))?;
        snapshot.enabled = enabled;
        if enabled {
            snapshot.proxy_server = expected_system_proxy_server(settings);
            snapshot.bypass = settings.system_proxy_bypass.clone();
        }
        Ok(())
    }

    fn restore(&self, snapshot: &PlatformProxySnapshot) -> Result<(), String> {
        let PlatformProxySnapshot::Test(snapshot) = snapshot else {
            return Err("unexpected test registry snapshot".to_string());
        };
        *self
            .snapshot
            .lock()
            .map_err(|error| format!("lock test registry: {error}"))? = snapshot.clone();
        Ok(())
    }
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct SystemProxyJournal {
    version: u32,
    transaction_id: String,
    created_at: u64,
    desired_enabled: bool,
    snapshot: PlatformProxySnapshot,
}

pub(crate) trait RegistryOps {
    fn capability(&self) -> SystemProxyCapability;
    fn snapshot(&self) -> Result<PlatformProxySnapshot, String>;
    fn query(&self, settings: &RuntimeSettings) -> Result<SystemProxyState, String>;
    fn apply(&self, settings: &RuntimeSettings, enabled: bool) -> Result<(), String>;
    fn restore(&self, snapshot: &PlatformProxySnapshot) -> Result<(), String>;
}

struct PlatformProxyBackend;

struct AuditedRegistryOps<'a, B> {
    runtime: &'a SystemProxyRuntime,
    backend: B,
}

impl<B: RegistryOps> RegistryOps for AuditedRegistryOps<'_, B> {
    fn capability(&self) -> SystemProxyCapability {
        self.backend.capability()
    }

    fn snapshot(&self) -> Result<PlatformProxySnapshot, String> {
        self.runtime.record_platform_call("capture", false);
        self.backend.snapshot()
    }

    fn query(&self, settings: &RuntimeSettings) -> Result<SystemProxyState, String> {
        self.backend.query(settings)
    }

    fn apply(&self, settings: &RuntimeSettings, enabled: bool) -> Result<(), String> {
        self.runtime
            .record_platform_call(if enabled { "bind" } else { "unbind" }, true);
        self.backend.apply(settings, enabled)
    }

    fn restore(&self, snapshot: &PlatformProxySnapshot) -> Result<(), String> {
        self.runtime.record_platform_call("restore", true);
        self.backend.restore(snapshot)
    }
}

pub(crate) fn capability() -> SystemProxyCapability {
    PlatformProxyBackend.capability()
}

pub(crate) fn query(
    app: &tauri::AppHandle,
    runtime: &SystemProxyRuntime,
) -> Result<SystemProxyQuery, String> {
    let _guard = runtime
        .transaction
        .lock()
        .map_err(|error| format!("lock system proxy transaction: {error}"))?;
    let settings = load_runtime_settings(app)?;
    let backend = PlatformProxyBackend;
    let current = query_or_error_state(&backend, &settings);
    let pending_transaction =
        read_optional_journal(&journal_path(app)?)?.map(|journal| PendingSystemProxyTransaction {
            transaction_id: journal.transaction_id,
            created_at: journal.created_at,
            desired_enabled: journal.desired_enabled,
        });
    Ok(SystemProxyQuery {
        capability: backend.capability(),
        current,
        pending_transaction,
    })
}

pub(crate) fn apply_with_settings(
    app: &tauri::AppHandle,
    runtime: &SystemProxyRuntime,
    settings: &RuntimeSettings,
    enabled: bool,
) -> Result<SystemProxyTransactionResult, String> {
    let _guard = runtime
        .transaction
        .lock()
        .map_err(|error| format!("lock system proxy transaction: {error}"))?;
    validate_desired_settings(settings, enabled)?;
    let backend = AuditedRegistryOps {
        runtime,
        backend: PlatformProxyBackend,
    };
    apply_transaction(&backend, settings, &journal_path(app)?, enabled)
}

pub(crate) fn query_with_settings(
    app: &tauri::AppHandle,
    runtime: &SystemProxyRuntime,
    settings: &RuntimeSettings,
) -> Result<SystemProxyQuery, String> {
    let _guard = runtime
        .transaction
        .lock()
        .map_err(|error| format!("lock system proxy transaction: {error}"))?;
    let backend = PlatformProxyBackend;
    let current = query_or_error_state(&backend, settings);
    let pending_transaction =
        read_optional_journal(&journal_path(app)?)?.map(|journal| PendingSystemProxyTransaction {
            transaction_id: journal.transaction_id,
            created_at: journal.created_at,
            desired_enabled: journal.desired_enabled,
        });
    Ok(SystemProxyQuery {
        capability: backend.capability(),
        current,
        pending_transaction,
    })
}

pub(crate) fn restore_if_pending(
    app: &tauri::AppHandle,
    runtime: &SystemProxyRuntime,
) -> Result<bool, String> {
    let _guard = runtime
        .transaction
        .lock()
        .map_err(|error| format!("lock system proxy transaction: {error}"))?;
    let path = journal_path(app)?;
    if read_optional_journal(&path)?.is_none() {
        return Ok(false);
    }
    let settings = load_runtime_settings(app).or_else(|_| default_runtime_settings(app))?;
    let backend = AuditedRegistryOps {
        runtime,
        backend: PlatformProxyBackend,
    };
    restore_if_pending_at_path(&backend, &settings, &path)
}

fn restore_if_pending_at_path<B: RegistryOps>(
    backend: &B,
    settings: &RuntimeSettings,
    path: &Path,
) -> Result<bool, String> {
    if read_optional_journal(path)?.is_none() {
        return Ok(false);
    }
    restore_transaction(backend, settings, path, None)?;
    Ok(true)
}

#[cfg(test)]
pub(crate) fn restore_if_pending_with_registry<B: RegistryOps>(
    runtime: &SystemProxyRuntime,
    backend: &B,
    settings: &RuntimeSettings,
    path: &Path,
) -> Result<bool, String> {
    let _guard = runtime
        .transaction
        .lock()
        .map_err(|error| format!("lock system proxy transaction: {error}"))?;
    restore_if_pending_at_path(backend, settings, path)
}

#[cfg(test)]
pub(crate) fn readback_with_registry<B: RegistryOps>(
    backend: &B,
    settings: &RuntimeSettings,
    path: &Path,
) -> Result<SystemProxyQuery, String> {
    let current = backend.query(settings)?;
    let pending_transaction =
        read_optional_journal(path)?.map(|journal| PendingSystemProxyTransaction {
            transaction_id: journal.transaction_id,
            created_at: journal.created_at,
            desired_enabled: journal.desired_enabled,
        });
    Ok(SystemProxyQuery {
        capability: backend.capability(),
        current,
        pending_transaction,
    })
}

fn apply_transaction<B: RegistryOps>(
    backend: &B,
    settings: &RuntimeSettings,
    journal_path: &Path,
    enabled: bool,
) -> Result<SystemProxyTransactionResult, String> {
    let capability = backend.capability();
    if !capability.can_apply || !capability.can_restore {
        return Err(capability
            .reason
            .unwrap_or_else(|| "system proxy transactions are unsupported".to_string()));
    }
    if let Some(pending) = read_optional_journal(journal_path)? {
        return Err(format!(
            "system proxy transaction {} is pending; restore it before applying another change",
            pending.transaction_id
        ));
    }

    let snapshot = backend.snapshot()?;
    let previous = backend.query(settings)?;
    let journal = SystemProxyJournal {
        version: 1,
        transaction_id: transaction_id(),
        created_at: now_epoch_seconds(),
        desired_enabled: enabled,
        snapshot: snapshot.clone(),
    };
    write_journal(journal_path, &journal)?;

    if let Err(error) = backend.apply(settings, enabled) {
        return rollback_failed_apply(backend, journal_path, &snapshot, error);
    }
    let current = match backend.query(settings) {
        Ok(current) => current,
        Err(error) => {
            return rollback_failed_apply(
                backend,
                journal_path,
                &snapshot,
                format!("query after apply: {error}"),
            )
        }
    };
    if !desired_state_matches(&current, enabled) {
        return rollback_failed_apply(
            backend,
            journal_path,
            &snapshot,
            format!(
                "system proxy verification failed: enabled={}, matchesPrism={}",
                current.enabled, current.matches_prism
            ),
        );
    }

    Ok(SystemProxyTransactionResult {
        transaction_id: journal.transaction_id,
        phase: "applied".to_string(),
        previous,
        current,
        rollback_available: true,
    })
}

#[cfg(test)]
pub(crate) fn apply_with_registry<B: RegistryOps>(
    backend: &B,
    settings: &RuntimeSettings,
    path: &Path,
    enabled: bool,
) -> Result<SystemProxyTransactionResult, String> {
    apply_transaction(backend, settings, path, enabled)
}

fn restore_transaction<B: RegistryOps>(
    backend: &B,
    settings: &RuntimeSettings,
    journal_path: &Path,
    requested_transaction_id: Option<&str>,
) -> Result<SystemProxyTransactionResult, String> {
    let journal = read_optional_journal(journal_path)?
        .ok_or_else(|| "no system proxy transaction is pending".to_string())?;
    if let Some(requested) = requested_transaction_id {
        if requested != journal.transaction_id {
            return Err(format!(
                "system proxy transaction mismatch: requested {requested}, pending {}",
                journal.transaction_id
            ));
        }
    }

    let previous = backend.query(settings)?;
    backend
        .restore(&journal.snapshot)
        .map_err(|error| format!("restore system proxy transaction: {error}"))?;
    let restored_snapshot = backend.snapshot()?;
    if restored_snapshot != journal.snapshot {
        return Err(
            "system proxy restore verification failed; recovery journal was retained".to_string(),
        );
    }
    let current = backend.query(settings)?;
    remove_journal(journal_path)?;

    Ok(SystemProxyTransactionResult {
        transaction_id: journal.transaction_id,
        phase: "restored".to_string(),
        previous,
        current,
        rollback_available: false,
    })
}

fn rollback_failed_apply<B: RegistryOps>(
    backend: &B,
    journal_path: &Path,
    snapshot: &PlatformProxySnapshot,
    apply_error: String,
) -> Result<SystemProxyTransactionResult, String> {
    match backend.restore(snapshot) {
        Ok(()) => match backend.snapshot() {
            Ok(restored) if &restored == snapshot => {
                remove_journal(journal_path)?;
                Err(format!(
                    "{apply_error}; original proxy settings were restored"
                ))
            }
            Ok(_) => Err(format!(
                "{apply_error}; rollback verification failed and the recovery journal was retained"
            )),
            Err(error) => Err(format!(
                "{apply_error}; query after rollback failed: {error}; recovery journal was retained"
            )),
        },
        Err(error) => Err(format!(
            "{apply_error}; rollback failed: {error}; recovery journal was retained"
        )),
    }
}

fn desired_state_matches(state: &SystemProxyState, enabled: bool) -> bool {
    if enabled {
        state.enabled && state.matches_prism && state.error.is_none()
    } else {
        !state.enabled && state.error.is_none()
    }
}

fn validate_desired_settings(settings: &RuntimeSettings, enabled: bool) -> Result<(), String> {
    if !enabled {
        return Ok(());
    }
    if settings.xray_http_listen.trim().is_empty() || settings.xray_socks_listen.trim().is_empty() {
        return Err("system proxy listen addresses must not be empty".to_string());
    }
    if settings.xray_http_port == 0 || settings.xray_socks_port == 0 {
        return Err("system proxy ports must be greater than zero".to_string());
    }
    Ok(())
}

fn query_or_error_state<B: RegistryOps>(
    backend: &B,
    settings: &RuntimeSettings,
) -> SystemProxyState {
    backend.query(settings).unwrap_or_else(|error| {
        let capability = backend.capability();
        proxy_state(
            settings,
            capability.supported,
            false,
            String::new(),
            String::new(),
            Some(error),
        )
    })
}

fn proxy_state(
    settings: &RuntimeSettings,
    supported: bool,
    enabled: bool,
    proxy_server: String,
    bypass: String,
    error: Option<String>,
) -> SystemProxyState {
    let expected_proxy_server = expected_system_proxy_server(settings);
    let matches_prism = enabled
        && normalize_proxy_server(&proxy_server) == normalize_proxy_server(&expected_proxy_server)
        && normalize_bypass(&bypass) == normalize_bypass(&settings.system_proxy_bypass);
    SystemProxyState {
        supported,
        enabled,
        matches_prism,
        proxy_server,
        expected_proxy_server,
        bypass,
        error,
    }
}

fn normalize_bypass(value: &str) -> String {
    value
        .split(';')
        .map(str::trim)
        .filter(|item| !item.is_empty())
        .map(|item| item.to_ascii_lowercase())
        .collect::<Vec<_>>()
        .join(";")
}

fn journal_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_config_dir()
        .map(|directory| directory.join(JOURNAL_FILE_NAME))
        .map_err(|error| format!("resolve system proxy journal path: {error}"))
}

fn write_journal(path: &Path, journal: &SystemProxyJournal) -> Result<(), String> {
    let content = serde_json::to_string_pretty(journal)
        .map_err(|error| format!("encode system proxy journal: {error}"))?;
    write_atomic(path, &content).map_err(|error| format!("commit system proxy journal: {error}"))
}

fn read_optional_journal(path: &Path) -> Result<Option<SystemProxyJournal>, String> {
    if !path.exists() {
        return Ok(None);
    }
    let content = fs::read(path).map_err(|error| format!("read system proxy journal: {error}"))?;
    let journal: SystemProxyJournal = serde_json::from_slice(&content)
        .map_err(|error| format!("decode system proxy recovery journal: {error}"))?;
    if journal.version != 1 {
        return Err(format!(
            "unsupported system proxy journal version {}",
            journal.version
        ));
    }
    Ok(Some(journal))
}

fn remove_journal(path: &Path) -> Result<(), String> {
    if path.exists() {
        fs::remove_file(path).map_err(|error| format!("remove system proxy journal: {error}"))?;
    }
    Ok(())
}

fn transaction_id() -> String {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default();
    format!("proxy-{}-{nanos}", std::process::id())
}

#[cfg(target_os = "windows")]
impl RegistryOps for PlatformProxyBackend {
    fn capability(&self) -> SystemProxyCapability {
        SystemProxyCapability {
            platform: "windows".to_string(),
            supported: true,
            can_query: true,
            can_apply: true,
            can_restore: true,
            scope: "currentUser".to_string(),
            backend: "wininetRegistry".to_string(),
            requires_elevation: false,
            reason: None,
        }
    }

    fn snapshot(&self) -> Result<PlatformProxySnapshot, String> {
        let raw = run_command("reg", &["query", WINDOWS_INTERNET_SETTINGS_KEY])?;
        parse_windows_proxy_snapshot(&raw).map(PlatformProxySnapshot::Windows)
    }

    fn query(&self, settings: &RuntimeSettings) -> Result<SystemProxyState, String> {
        #[cfg(not(test))]
        let PlatformProxySnapshot::Windows(snapshot) = self.snapshot()?;
        #[cfg(test)]
        let snapshot = match self.snapshot()? {
            PlatformProxySnapshot::Windows(snapshot) => snapshot,
            PlatformProxySnapshot::Test(_) => {
                return Err("unexpected system proxy snapshot platform".to_string())
            }
        };
        Ok(proxy_state(
            settings,
            true,
            snapshot.proxy_enable.unwrap_or_default() != 0,
            snapshot.proxy_server.unwrap_or_default(),
            snapshot.proxy_override.unwrap_or_default(),
            None,
        ))
    }

    fn apply(&self, settings: &RuntimeSettings, enabled: bool) -> Result<(), String> {
        if enabled {
            set_windows_registry_string("ProxyServer", &expected_system_proxy_server(settings))?;
            set_windows_registry_string("ProxyOverride", &settings.system_proxy_bypass)?;
        }
        set_windows_registry_dword("ProxyEnable", u32::from(enabled))?;
        notify_windows_proxy_changed()?;
        Ok(())
    }

    fn restore(&self, snapshot: &PlatformProxySnapshot) -> Result<(), String> {
        #[cfg(not(test))]
        let PlatformProxySnapshot::Windows(snapshot) = snapshot;
        #[cfg(test)]
        let snapshot = match snapshot {
            PlatformProxySnapshot::Windows(snapshot) => snapshot,
            PlatformProxySnapshot::Test(_) => {
                return Err("cannot restore a non-Windows proxy snapshot on Windows".to_string())
            }
        };
        restore_windows_registry_string("ProxyServer", snapshot.proxy_server.as_deref())?;
        restore_windows_registry_string("ProxyOverride", snapshot.proxy_override.as_deref())?;
        restore_windows_registry_dword("ProxyEnable", snapshot.proxy_enable)?;
        notify_windows_proxy_changed()?;
        Ok(())
    }
}

#[cfg(not(target_os = "windows"))]
impl RegistryOps for PlatformProxyBackend {
    fn capability(&self) -> SystemProxyCapability {
        let platform = std::env::consts::OS.to_string();
        SystemProxyCapability {
            platform: platform.clone(),
            supported: false,
            can_query: false,
            can_apply: false,
            can_restore: false,
            scope: "unsupported".to_string(),
            backend: "none".to_string(),
            requires_elevation: false,
            reason: Some(format!(
                "transactional system proxy management is not implemented for {platform}"
            )),
        }
    }

    fn snapshot(&self) -> Result<PlatformProxySnapshot, String> {
        Err(self.capability().reason.unwrap())
    }

    fn query(&self, _settings: &RuntimeSettings) -> Result<SystemProxyState, String> {
        Err(self.capability().reason.unwrap())
    }

    fn apply(&self, _settings: &RuntimeSettings, _enabled: bool) -> Result<(), String> {
        Err(self.capability().reason.unwrap())
    }

    fn restore(&self, _snapshot: &PlatformProxySnapshot) -> Result<(), String> {
        Err(self.capability().reason.unwrap())
    }
}

#[cfg(target_os = "windows")]
const WINDOWS_INTERNET_SETTINGS_KEY: &str =
    r"HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings";

fn parse_windows_proxy_snapshot(raw: &str) -> Result<WindowsProxySnapshot, String> {
    let mut snapshot = WindowsProxySnapshot::default();
    for line in raw.lines() {
        let parts: Vec<_> = line.split_whitespace().collect();
        if parts.len() < 2 {
            continue;
        }
        match parts[0] {
            "ProxyEnable" => {
                let Some(raw_value) = parts.get(2) else {
                    return Err("Windows ProxyEnable value is missing".to_string());
                };
                let value = raw_value
                    .strip_prefix("0x")
                    .map(|hex| u32::from_str_radix(hex, 16))
                    .unwrap_or_else(|| raw_value.parse::<u32>())
                    .map_err(|error| format!("parse Windows ProxyEnable value: {error}"))?;
                snapshot.proxy_enable = Some(value);
            }
            "ProxyServer" if parts[1] == "REG_SZ" => {
                snapshot.proxy_server = Some(parts[2..].join(" "))
            }
            "ProxyOverride" if parts[1] == "REG_SZ" => {
                snapshot.proxy_override = Some(parts[2..].join(" "))
            }
            _ => {}
        }
    }
    Ok(snapshot)
}

#[cfg(target_os = "windows")]
fn set_windows_registry_string(name: &str, value: &str) -> Result<(), String> {
    run_command(
        "reg",
        &[
            "add",
            WINDOWS_INTERNET_SETTINGS_KEY,
            "/v",
            name,
            "/t",
            "REG_SZ",
            "/d",
            value,
            "/f",
        ],
    )
    .map(|_| ())
}

#[cfg(target_os = "windows")]
fn set_windows_registry_dword(name: &str, value: u32) -> Result<(), String> {
    run_command(
        "reg",
        &[
            "add",
            WINDOWS_INTERNET_SETTINGS_KEY,
            "/v",
            name,
            "/t",
            "REG_DWORD",
            "/d",
            &value.to_string(),
            "/f",
        ],
    )
    .map(|_| ())
}

#[cfg(target_os = "windows")]
fn restore_windows_registry_string(name: &str, value: Option<&str>) -> Result<(), String> {
    match value {
        Some(value) => set_windows_registry_string(name, value),
        None => delete_windows_registry_value_if_present(name),
    }
}

#[cfg(target_os = "windows")]
fn restore_windows_registry_dword(name: &str, value: Option<u32>) -> Result<(), String> {
    match value {
        Some(value) => set_windows_registry_dword(name, value),
        None => delete_windows_registry_value_if_present(name),
    }
}

#[cfg(target_os = "windows")]
fn delete_windows_registry_value_if_present(name: &str) -> Result<(), String> {
    #[cfg(not(test))]
    let PlatformProxySnapshot::Windows(snapshot) = PlatformProxyBackend.snapshot()?;
    #[cfg(test)]
    let snapshot = match PlatformProxyBackend.snapshot()? {
        PlatformProxySnapshot::Windows(snapshot) => snapshot,
        PlatformProxySnapshot::Test(_) => {
            return Err("unexpected system proxy snapshot platform".to_string())
        }
    };
    let present = match name {
        "ProxyEnable" => snapshot.proxy_enable.is_some(),
        "ProxyServer" => snapshot.proxy_server.is_some(),
        "ProxyOverride" => snapshot.proxy_override.is_some(),
        _ => false,
    };
    if !present {
        return Ok(());
    }
    run_command(
        "reg",
        &["delete", WINDOWS_INTERNET_SETTINGS_KEY, "/v", name, "/f"],
    )
    .map(|_| ())
}

#[cfg(target_os = "windows")]
fn notify_windows_proxy_changed() -> Result<(), String> {
    use windows_sys::Win32::Networking::WinInet::{
        InternetSetOptionW, INTERNET_OPTION_REFRESH, INTERNET_OPTION_SETTINGS_CHANGED,
    };

    for option in [INTERNET_OPTION_SETTINGS_CHANGED, INTERNET_OPTION_REFRESH] {
        let ok =
            unsafe { InternetSetOptionW(std::ptr::null_mut(), option, std::ptr::null_mut(), 0) };
        if ok == 0 {
            return Err(format!(
                "notify Windows system proxy change: {}",
                std::io::Error::last_os_error()
            ));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    #[derive(Clone, Copy, Default)]
    enum FailureMode {
        #[default]
        None,
        Apply,
        Restore,
        ApplyWithoutDesiredState,
    }

    struct InMemoryRegistryOps {
        snapshot: Mutex<TestProxySnapshot>,
        failure: FailureMode,
    }

    impl InMemoryRegistryOps {
        fn new(snapshot: TestProxySnapshot, failure: FailureMode) -> Self {
            Self {
                snapshot: Mutex::new(snapshot),
                failure,
            }
        }
    }

    impl RegistryOps for InMemoryRegistryOps {
        fn capability(&self) -> SystemProxyCapability {
            SystemProxyCapability {
                platform: "test".to_string(),
                supported: true,
                can_query: true,
                can_apply: true,
                can_restore: true,
                scope: "test".to_string(),
                backend: "fake".to_string(),
                requires_elevation: false,
                reason: None,
            }
        }

        fn snapshot(&self) -> Result<PlatformProxySnapshot, String> {
            Ok(PlatformProxySnapshot::Test(
                self.snapshot.lock().unwrap().clone(),
            ))
        }

        fn query(&self, settings: &RuntimeSettings) -> Result<SystemProxyState, String> {
            let snapshot = self.snapshot.lock().unwrap();
            Ok(proxy_state(
                settings,
                true,
                snapshot.enabled,
                snapshot.proxy_server.clone(),
                snapshot.bypass.clone(),
                None,
            ))
        }

        fn apply(&self, settings: &RuntimeSettings, enabled: bool) -> Result<(), String> {
            if matches!(self.failure, FailureMode::Apply) {
                return Err("injected apply failure".to_string());
            }
            if matches!(self.failure, FailureMode::ApplyWithoutDesiredState) {
                return Ok(());
            }
            let mut snapshot = self.snapshot.lock().unwrap();
            snapshot.enabled = enabled;
            if enabled {
                snapshot.proxy_server = expected_system_proxy_server(settings);
                snapshot.bypass = settings.system_proxy_bypass.clone();
            }
            Ok(())
        }

        fn restore(&self, snapshot: &PlatformProxySnapshot) -> Result<(), String> {
            if matches!(self.failure, FailureMode::Restore) {
                return Err("injected restore failure".to_string());
            }
            let PlatformProxySnapshot::Test(snapshot) = snapshot else {
                return Err("unexpected test snapshot".to_string());
            };
            *self.snapshot.lock().unwrap() = snapshot.clone();
            Ok(())
        }
    }

    fn settings() -> RuntimeSettings {
        RuntimeSettings {
            xray_http_listen: "127.0.0.1".to_string(),
            xray_http_port: 10809,
            xray_socks_listen: "127.0.0.1".to_string(),
            xray_socks_port: 10808,
            system_proxy_bypass: "localhost;127.*;<local>".to_string(),
            ..RuntimeSettings::default()
        }
    }

    fn original_snapshot() -> TestProxySnapshot {
        TestProxySnapshot {
            enabled: true,
            proxy_server: "existing.proxy:3128".to_string(),
            bypass: "localhost".to_string(),
        }
    }

    fn journal_path(name: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "tachyon-prism-proxy-{name}-{}-{}.json",
            std::process::id(),
            transaction_id()
        ));
        let _ = fs::remove_file(&path);
        path
    }

    #[test]
    fn audit_counts_real_registry_boundaries_without_changing_transactions() {
        let runtime = SystemProxyRuntime::default();
        let backend = AuditedRegistryOps {
            runtime: &runtime,
            backend: InMemoryRegistryOps::new(original_snapshot(), FailureMode::None),
        };
        let path = journal_path("audit-boundaries");

        let before = runtime.audit_snapshot();
        assert_eq!(before.capture_count, 0);
        assert_eq!(before.restore_count, 0);
        assert_eq!(before.bind_count, 0);
        assert_eq!(before.mutation_count, 0);
        assert!(before.events.is_empty());

        let applied = apply_transaction(&backend, &settings(), &path, true).unwrap();
        restore_transaction(&backend, &settings(), &path, Some(&applied.transaction_id)).unwrap();

        let after = runtime.audit_snapshot();
        assert_eq!(after.capture_count, 2);
        assert_eq!(after.restore_count, 1);
        assert_eq!(after.bind_count, 1);
        assert_eq!(after.mutation_count, 2);
        assert_eq!(
            after
                .events
                .iter()
                .map(|event| event.operation.as_str())
                .collect::<Vec<_>>(),
            ["capture", "bind", "restore", "capture"]
        );
        assert_eq!(
            runtime.audit_snapshot().mutation_count,
            after.mutation_count
        );
        let _ = fs::remove_file(path);
    }

    #[test]
    fn apply_persists_snapshot_and_restore_recovers_exact_state() {
        let original = original_snapshot();
        let backend = InMemoryRegistryOps::new(original.clone(), FailureMode::None);
        let path = journal_path("restore");

        let applied = apply_transaction(&backend, &settings(), &path, true).unwrap();
        assert_eq!(applied.phase, "applied");
        assert!(applied.rollback_available);
        assert!(path.exists());
        assert_ne!(
            backend.snapshot().unwrap(),
            PlatformProxySnapshot::Test(original.clone())
        );

        let restored =
            restore_transaction(&backend, &settings(), &path, Some(&applied.transaction_id))
                .unwrap();
        assert_eq!(restored.phase, "restored");
        assert_eq!(
            backend.snapshot().unwrap(),
            PlatformProxySnapshot::Test(original)
        );
        assert!(!path.exists());
    }

    #[test]
    fn apply_failure_rolls_back_and_removes_journal() {
        let original = original_snapshot();
        let backend = InMemoryRegistryOps::new(original.clone(), FailureMode::Apply);
        let path = journal_path("apply-failure");

        let error = apply_transaction(&backend, &settings(), &path, true).unwrap_err();
        assert!(error.contains("original proxy settings were restored"));
        assert_eq!(
            backend.snapshot().unwrap(),
            PlatformProxySnapshot::Test(original)
        );
        assert!(!path.exists());
    }

    #[test]
    fn verification_failure_rolls_back() {
        let original = original_snapshot();
        let backend =
            InMemoryRegistryOps::new(original.clone(), FailureMode::ApplyWithoutDesiredState);
        let path = journal_path("verify-failure");

        let error = apply_transaction(&backend, &settings(), &path, true).unwrap_err();
        assert!(error.contains("verification failed"));
        assert_eq!(
            backend.snapshot().unwrap(),
            PlatformProxySnapshot::Test(original)
        );
        assert!(!path.exists());
    }

    #[test]
    fn failed_rollback_retains_recovery_journal() {
        let backend = InMemoryRegistryOps::new(original_snapshot(), FailureMode::Restore);
        let path = journal_path("rollback-failure");
        let snapshot = backend.snapshot().unwrap();
        write_journal(
            &path,
            &SystemProxyJournal {
                version: 1,
                transaction_id: transaction_id(),
                created_at: now_epoch_seconds(),
                desired_enabled: true,
                snapshot: snapshot.clone(),
            },
        )
        .unwrap();

        let error = rollback_failed_apply(&backend, &path, &snapshot, "apply failed".to_string())
            .unwrap_err();
        assert!(error.contains("rollback failed"));
        assert!(path.exists());
        let _ = fs::remove_file(path);
    }

    #[test]
    fn rejects_second_apply_while_recovery_is_pending() {
        let backend = InMemoryRegistryOps::new(original_snapshot(), FailureMode::None);
        let path = journal_path("pending");
        let first = apply_transaction(&backend, &settings(), &path, true).unwrap();

        let error = apply_transaction(&backend, &settings(), &path, false).unwrap_err();
        assert!(error.contains(&first.transaction_id));
        let _ = restore_transaction(&backend, &settings(), &path, None).unwrap();
    }

    #[test]
    fn parses_windows_registry_snapshot_without_assuming_missing_values() {
        let raw = r#"
HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Internet Settings
    ProxyEnable    REG_DWORD    0x1
    ProxyServer    REG_SZ    http=127.0.0.1:10809; socks=127.0.0.1:10808
"#;
        let snapshot = parse_windows_proxy_snapshot(raw).unwrap();
        assert_eq!(snapshot.proxy_enable, Some(1));
        assert_eq!(
            snapshot.proxy_server.as_deref(),
            Some("http=127.0.0.1:10809; socks=127.0.0.1:10808")
        );
        assert_eq!(snapshot.proxy_override, None);
    }

    #[test]
    fn parses_present_empty_windows_registry_strings() {
        let raw = r#"
HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Internet Settings
    ProxyEnable    REG_DWORD    0x0
    ProxyServer    REG_SZ
    ProxyOverride    REG_SZ
"#;
        let snapshot = parse_windows_proxy_snapshot(raw).unwrap();
        assert_eq!(snapshot.proxy_enable, Some(0));
        assert_eq!(snapshot.proxy_server.as_deref(), Some(""));
        assert_eq!(snapshot.proxy_override.as_deref(), Some(""));
    }
}
