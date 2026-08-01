use crate::write_atomic;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashSet;
#[cfg(unix)]
use std::ffi::{OsStr, OsString};
use std::fs;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command};
use std::sync::{Arc, Mutex};

const CLOCK_VERSION: u32 = 1;
const RETAINED_GENERATIONS: usize = 3;
const ORPHAN_JOURNAL_FILE: &str = "orphan-journal.json";
const ORPHAN_RECOVERY_FAILURE_FILE: &str = "orphan-recovery-failed.json";
const INSTANCE_LEASE_FILE: &str = "instance-lease.json";

#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize)]
#[serde(transparent)]
pub struct GenerationId(String);

impl GenerationId {
    fn new(epoch: &str, counter: u64) -> Self {
        Self(format!("{epoch}-{counter:016x}"))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ReadinessLevel {
    Desired,
    ConfigValidated,
    ProcessReady,
    ListenerReady,
    EgressReady,
    Degraded,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EgressProbeSettings {
    pub url: String,
    pub expected_status: u16,
    pub expected_nonce: String,
    pub http_listen: String,
    pub http_port: u16,
    pub socks_listen: String,
    pub socks_port: u16,
}

impl EgressProbeSettings {
    pub fn is_configured(&self) -> bool {
        !self.url.trim().is_empty()
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum GenerationPhase {
    Idle,
    PendingApply,
    Switching,
    RollingBack,
    Degraded,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GenerationView {
    pub generation_id: GenerationId,
    pub config_sha256: String,
    pub node_id: String,
    pub routing_revision: String,
    pub pid: Option<u32>,
    pub managed_listener_addresses: Vec<String>,
    pub egress_probe: EgressProbeSettings,
    pub egress_verified: bool,
    pub readiness: ReadinessLevel,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProxyGenerationView {
    pub generation_id: GenerationId,
    pub pid: u32,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GenerationStatus {
    pub desired: Option<GenerationView>,
    pub active: Option<GenerationView>,
    pub proxy_generation: Option<ProxyGenerationView>,
    pub phase: GenerationPhase,
    pub proxy_ready: bool,
    pub last_error_code: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RunnerHandle {
    pub pid: u32,
    pub runner_token: String,
}

#[derive(Debug)]
pub struct ConfigLease {
    path: PathBuf,
    #[cfg(unix)]
    name: OsString,
    #[cfg(not(unix))]
    orphan_journal: PathBuf,
    #[cfg(not(unix))]
    orphan_recovery_failure: PathBuf,
    recovery_failure: std::sync::Arc<std::sync::atomic::AtomicBool>,
    leased_paths: Arc<Mutex<HashSet<PathBuf>>>,
    root_binding: Option<ConfigRootBinding>,
    #[cfg(unix)]
    config_file: File,
    #[cfg(test)]
    race_hook: GenerationRaceHook,
}

#[derive(Debug)]
struct ConfigRootBinding {
    #[cfg(not(unix))]
    path: PathBuf,
    directory: File,
    #[cfg(unix)]
    _anchor: File,
}

#[cfg(test)]
#[derive(Clone, Default)]
struct GenerationRaceHook(Arc<Mutex<Option<GenerationRaceSwap>>>);

#[cfg(test)]
struct GenerationRaceSwap {
    before: Box<dyn FnOnce() + Send>,
    after: Box<dyn FnOnce() + Send>,
}

#[cfg(test)]
impl std::fmt::Debug for GenerationRaceHook {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("GenerationRaceHook")
    }
}

#[cfg(test)]
fn with_generation_race<T>(hook: &GenerationRaceHook, operation: impl FnOnce() -> T) -> T {
    let swap = hook.0.lock().ok().and_then(|mut value| value.take());
    if let Some(swap) = swap {
        (swap.before)();
        let result = operation();
        (swap.after)();
        result
    } else {
        operation()
    }
}

impl ConfigLease {
    pub fn path(&self) -> &Path {
        &self.path
    }

    pub(crate) fn child_config_path(&self) -> PathBuf {
        #[cfg(unix)]
        {
            PathBuf::from(format!("/dev/fd/{XRAY_CONFIG_CHILD_FD}"))
        }
        #[cfg(not(unix))]
        {
            self.path.clone()
        }
    }

    pub(crate) fn spawn_command(&self, command: &mut Command) -> std::io::Result<Child> {
        self.prepare_child_command(command)?;
        #[cfg(test)]
        let mut child = with_generation_race(&self.race_hook, || command.spawn())?;
        #[cfg(not(test))]
        let mut child = command.spawn()?;
        if let Err(error) = self.verify_child_source() {
            let _ = child.kill();
            let _ = child.wait();
            return Err(error);
        }
        Ok(child)
    }

    fn prepare_child_command(&self, _command: &mut Command) -> std::io::Result<()> {
        self.verify_child_source()?;
        #[cfg(unix)]
        {
            use std::os::fd::AsRawFd;
            use std::os::unix::process::CommandExt;

            let command = _command;
            let source = self.config_file.as_raw_fd();
            unsafe {
                command.pre_exec(move || {
                    if libc::dup2(source, XRAY_CONFIG_CHILD_FD) < 0 {
                        return Err(std::io::Error::last_os_error());
                    }
                    if libc::fcntl(XRAY_CONFIG_CHILD_FD, libc::F_SETFD, 0) < 0 {
                        return Err(std::io::Error::last_os_error());
                    }
                    Ok(())
                });
            }
        }
        Ok(())
    }

    pub(crate) fn verify_child_source(&self) -> std::io::Result<()> {
        #[cfg(unix)]
        {
            crate::unix_generation_fs::validate_open_regular(&self.config_file)?;
            let binding = self.root_binding.as_ref().ok_or_else(|| {
                std::io::Error::new(std::io::ErrorKind::PermissionDenied, "missing root binding")
            })?;
            let linked = crate::unix_generation_fs::open_read(&binding.directory, &self.name)?;
            let opened = crate::unix_generation_fs::validate_open_regular(&self.config_file)?;
            let current = crate::unix_generation_fs::validate_open_regular(&linked)?;
            if opened.st_dev != current.st_dev || opened.st_ino != current.st_ino {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::PermissionDenied,
                    "generation config entry no longer matches its retained descriptor",
                ));
            }
        }
        #[cfg(not(unix))]
        {
            if !self.path.is_file() {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::NotFound,
                    "generation config is missing",
                ));
            }
        }
        Ok(())
    }
}

#[cfg(unix)]
const XRAY_CONFIG_CHILD_FD: i32 = 198;

impl Drop for ConfigLease {
    fn drop(&mut self) {
        if let Ok(mut paths) = self.leased_paths.lock() {
            paths.remove(&self.path);
        }
        #[cfg(unix)]
        {
            if verify_config_root_binding(self.root_binding.as_ref()).is_err()
                || self.verify_child_source().is_err()
            {
                self.recovery_failure
                    .store(true, std::sync::atomic::Ordering::Release);
                return;
            }
            let operation = || {
                release_config_lease_unix(
                    &self.name,
                    &self.recovery_failure,
                    self.root_binding.as_ref(),
                )
            };
            #[cfg(test)]
            with_generation_race(&self.race_hook, operation);
            #[cfg(not(test))]
            operation();
        }
        #[cfg(not(unix))]
        release_config_lease_path(
            &self.path,
            &self.orphan_journal,
            &self.orphan_recovery_failure,
            &self.recovery_failure,
            self.root_binding.as_ref(),
            remove_config_file,
        );
    }
}

#[cfg(not(unix))]
fn remove_config_file(path: &Path) -> std::io::Result<()> {
    fs::remove_file(path)
}

#[cfg(unix)]
fn release_config_lease_unix(
    name: &OsStr,
    recovery_failure: &std::sync::Arc<std::sync::atomic::AtomicBool>,
    root_binding: Option<&ConfigRootBinding>,
) {
    let Some(binding) = root_binding else {
        recovery_failure.store(true, std::sync::atomic::Ordering::Release);
        return;
    };
    match crate::unix_generation_fs::remove(&binding.directory, name) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(_) => {
            if crate::unix_generation_fs::replace(
                &binding.directory,
                OsStr::new(ORPHAN_JOURNAL_FILE),
                b"{\"version\":1,\"pending\":true}\n",
            )
            .is_err()
            {
                recovery_failure.store(true, std::sync::atomic::Ordering::Release);
                let _ = crate::unix_generation_fs::replace(
                    &binding.directory,
                    OsStr::new(ORPHAN_RECOVERY_FAILURE_FILE),
                    b"{\"version\":1,\"pending\":true,\"reason\":\"orphanJournalWriteFailed\"}\n",
                );
            }
        }
    }
}

#[cfg(any(not(unix), test))]
fn release_config_lease_path(
    path: &Path,
    orphan_journal: &Path,
    orphan_recovery_failure: &Path,
    recovery_failure: &std::sync::Arc<std::sync::atomic::AtomicBool>,
    root_binding: Option<&ConfigRootBinding>,
    remove: impl FnOnce(&Path) -> std::io::Result<()>,
) {
    match guarded_config_root_io(root_binding, || remove(path)) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(_) => {
            if guarded_config_root_io(root_binding, || {
                write_atomic(orphan_journal, "{\"version\":1,\"pending\":true}\n")
                    .map_err(std::io::Error::other)
            })
            .is_err()
            {
                recovery_failure.store(true, std::sync::atomic::Ordering::Release);
                let _ = guarded_config_root_io(root_binding, || {
                    write_atomic(
                        orphan_recovery_failure,
                        "{\"version\":1,\"pending\":true,\"reason\":\"orphanJournalWriteFailed\"}\n",
                    )
                    .map_err(std::io::Error::other)
                });
            }
        }
    }
    if verify_config_root_binding(root_binding).is_err() {
        recovery_failure.store(true, std::sync::atomic::Ordering::Release);
    }
}

#[cfg(any(not(unix), test))]
fn guarded_config_root_io<T>(
    binding: Option<&ConfigRootBinding>,
    operation: impl FnOnce() -> std::io::Result<T>,
) -> std::io::Result<T> {
    verify_config_root_binding(binding).map_err(std::io::Error::other)?;
    let result = operation();
    verify_config_root_binding(binding).map_err(std::io::Error::other)?;
    result
}

fn verify_config_root_binding(binding: Option<&ConfigRootBinding>) -> Result<(), String> {
    let Some(binding) = binding else {
        return Ok(());
    };
    #[cfg(unix)]
    {
        crate::unix_generation_fs::validate_open_regular(&binding._anchor)
            .map_err(|_| "generation-anchor-fd-invalid".to_string())?;
        crate::unix_generation_fs::validate_root(&binding.directory)
            .map_err(|_| "generation-root-fd-invalid".to_string())?;
        Ok(())
    }
    #[cfg(not(unix))]
    verify_root_directory_binding(&binding.path, &binding.directory)
}

#[derive(Debug)]
pub struct CandidateHandle {
    runner: RunnerHandle,
    config: ConfigLease,
}

impl CandidateHandle {
    pub fn pid(&self) -> u32 {
        self.runner.pid
    }

    #[cfg(test)]
    pub fn runner_token(&self) -> &str {
        &self.runner.runner_token
    }

    pub fn config_path(&self) -> &Path {
        self.config.path()
    }

    pub(crate) fn config_lease(&self) -> &ConfigLease {
        &self.config
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ProxyReadback {
    Restored,
    Bound(ProxyGenerationView),
    Unknown,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProxySnapshotHandle {
    pub token: String,
}

#[derive(Debug)]
pub struct RollbackFailure {
    pub runner: Option<RunnerHandle>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BackendFailure {
    Failed,
    #[allow(dead_code)]
    Cancelled,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ApplyFailure {
    Busy,
    NoDesired,
    GenerationCounterOverflow,
    TransactionCounterOverflow,
    StaleTransaction,
    ConfigValidationFailed,
    GenerationPersistFailed,
    ProxyRestoreFailed,
    ActiveStopFailed,
    CandidateStartFailed,
    ProcessReadinessFailed,
    ListenerReadinessFailed,
    EgressReadinessFailed,
    EgressProbeRequired,
    CandidateCleanupFailed,
    RollbackFailed,
    ProxyConfirmationFailed,
    Cancelled,
}

pub trait ApplyBackend {
    fn validate_config(
        &mut self,
        plan: &ApplyPlan,
        config: &ConfigLease,
    ) -> Result<(), BackendFailure>;
    fn capture_proxy_snapshot(&mut self) -> Result<Option<ProxySnapshotHandle>, BackendFailure>;
    fn restore_proxy_snapshot(
        &mut self,
        snapshot: &ProxySnapshotHandle,
    ) -> Result<ProxyReadback, BackendFailure>;
    fn stop_active(&mut self, active: &CandidateHandle) -> Result<(), BackendFailure>;
    fn confirm_exit(&mut self, handle: &CandidateHandle) -> Result<(), BackendFailure>;
    fn start_candidate(
        &mut self,
        plan: &ApplyPlan,
        config: &ConfigLease,
    ) -> Result<RunnerHandle, BackendFailure>;
    fn stop_candidate(&mut self, handle: &CandidateHandle) -> Result<(), BackendFailure>;
    fn confirm_process_identity(
        &mut self,
        generation_id: &GenerationId,
        handle: &CandidateHandle,
    ) -> Result<(), BackendFailure>;
    fn confirm_listener_readiness(
        &mut self,
        generation_id: &GenerationId,
        handle: &CandidateHandle,
        listeners: &[String],
    ) -> Result<(), BackendFailure>;
    fn confirm_egress_ready(
        &mut self,
        generation_id: &GenerationId,
        handle: &CandidateHandle,
        listeners: &[String],
        probe: &EgressProbeSettings,
    ) -> Result<bool, BackendFailure>;
    fn rollback(
        &mut self,
        active: &GenerationView,
        previous_handle: &CandidateHandle,
    ) -> Result<RunnerHandle, RollbackFailure>;
    fn bind_proxy(
        &mut self,
        generation_id: &GenerationId,
        handle: &CandidateHandle,
        active: &GenerationView,
    ) -> Result<ProxyReadback, BackendFailure>;
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClockWatermark {
    version: u32,
    boot_epoch: String,
    counter: u64,
}

struct GenerationClock {
    boot_epoch: String,
    counter: u64,
    watermark_path: Option<PathBuf>,
}

impl GenerationClock {
    fn ephemeral() -> Self {
        Self {
            boot_epoch: random_epoch(),
            counter: 0,
            watermark_path: None,
        }
    }

    fn open(path: PathBuf) -> Result<Self, String> {
        if path.exists() {
            let raw = fs::read_to_string(&path)
                .map_err(|_| "generation-clock-read-failed".to_string())?;
            let previous: ClockWatermark =
                serde_json::from_str(&raw).map_err(|_| "generation-clock-invalid".to_string())?;
            if previous.version != CLOCK_VERSION
                || previous.boot_epoch.len() != 32
                || !previous
                    .boot_epoch
                    .bytes()
                    .all(|byte| byte.is_ascii_hexdigit())
            {
                return Err("generation-clock-invalid".to_string());
            }
        }
        let clock = Self {
            boot_epoch: random_epoch(),
            counter: 0,
            watermark_path: Some(path),
        };
        clock.persist()?;
        Ok(clock)
    }

    #[cfg(test)]
    fn deterministic(epoch: &str, counter: u64, watermark_path: Option<PathBuf>) -> Self {
        Self {
            boot_epoch: epoch.to_string(),
            counter,
            watermark_path,
        }
    }

    fn next(&mut self) -> Result<GenerationId, ApplyFailure> {
        let next = self
            .counter
            .checked_add(1)
            .ok_or(ApplyFailure::GenerationCounterOverflow)?;
        let previous = self.counter;
        self.counter = next;
        if self.persist().is_err() {
            self.counter = previous;
            return Err(ApplyFailure::GenerationPersistFailed);
        }
        Ok(GenerationId::new(&self.boot_epoch, next))
    }

    fn persist(&self) -> Result<(), String> {
        let Some(path) = &self.watermark_path else {
            return Ok(());
        };
        let value = serde_json::to_string(&ClockWatermark {
            version: CLOCK_VERSION,
            boot_epoch: self.boot_epoch.clone(),
            counter: self.counter,
        })
        .map_err(|_| "generation-clock-encode-failed".to_string())?;
        write_atomic(path, &(value + "\n")).map_err(|_| "generation-clock-write-failed".to_string())
    }
}

fn random_epoch() -> String {
    rand::random::<[u8; 16]>()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

struct DesiredRecord {
    view: GenerationView,
    config: Vec<u8>,
}

pub struct ApplyPlan {
    transaction_id: u64,
    desired: GenerationView,
    config: Vec<u8>,
    previous_active: Option<GenerationView>,
    previous_handle: Option<CandidateHandle>,
    previous_proxy: Option<ProxyGenerationView>,
    proxy_snapshot: Option<ProxySnapshotHandle>,
}

impl ApplyPlan {
    pub fn generation_id(&self) -> &GenerationId {
        &self.desired.generation_id
    }

    pub fn config(&self) -> &[u8] {
        &self.config
    }

    pub fn managed_listener_addresses(&self) -> &[String] {
        &self.desired.managed_listener_addresses
    }
}

pub struct GenerationRuntime {
    clock: GenerationClock,
    store: GenerationStore,
    next_transaction_id: u64,
    desired: Option<DesiredRecord>,
    active: Option<GenerationView>,
    active_handle: Option<CandidateHandle>,
    proxy_generation: Option<ProxyGenerationView>,
    phase: GenerationPhase,
    in_flight_transaction: Option<u64>,
    last_error_code: Option<String>,
}

impl Default for GenerationRuntime {
    fn default() -> Self {
        Self {
            clock: GenerationClock::ephemeral(),
            store: GenerationStore::new(
                std::env::temp_dir().join(format!("tachyon-prism-xray-{}", random_epoch())),
            ),
            next_transaction_id: 0,
            desired: None,
            active: None,
            active_handle: None,
            proxy_generation: None,
            phase: GenerationPhase::Idle,
            in_flight_transaction: None,
            last_error_code: None,
        }
    }
}

impl GenerationRuntime {
    pub fn with_persistent_storage(path: PathBuf, generation_dir: PathBuf) -> Result<Self, String> {
        let store = GenerationStore::new(generation_dir);
        store.sweep_orphans()?;
        Ok(Self {
            clock: GenerationClock::open(path)?,
            store,
            ..Self::default()
        })
    }

    #[cfg(test)]
    pub fn select_desired(
        &mut self,
        config: &[u8],
        node_id: String,
        routing_revision: String,
        managed_listener_addresses: Vec<String>,
    ) -> Result<GenerationId, ApplyFailure> {
        self.select_desired_with_probe(
            config,
            node_id,
            routing_revision,
            managed_listener_addresses,
            EgressProbeSettings::default(),
        )
    }

    pub fn select_desired_with_probe(
        &mut self,
        config: &[u8],
        node_id: String,
        routing_revision: String,
        managed_listener_addresses: Vec<String>,
        egress_probe: EgressProbeSettings,
    ) -> Result<GenerationId, ApplyFailure> {
        let generation_id = self.clock.next()?;
        self.desired = Some(DesiredRecord {
            view: GenerationView {
                generation_id: generation_id.clone(),
                config_sha256: sha256_bytes(config),
                node_id,
                routing_revision,
                pid: None,
                managed_listener_addresses,
                egress_probe,
                egress_verified: false,
                readiness: ReadinessLevel::Desired,
            },
            config: config.to_vec(),
        });
        if self.in_flight_transaction.is_none() {
            self.phase = GenerationPhase::PendingApply;
        }
        Ok(generation_id)
    }

    #[cfg(test)]
    pub fn restore_desired_after_restart(
        &mut self,
        config: &[u8],
        node_id: String,
        routing_revision: String,
        managed_listener_addresses: Vec<String>,
    ) -> Result<GenerationId, ApplyFailure> {
        self.active = None;
        self.active_handle = None;
        self.proxy_generation = None;
        self.select_desired(
            config,
            node_id,
            routing_revision,
            managed_listener_addresses,
        )
    }

    pub fn status(&self) -> GenerationStatus {
        let recovery_failed = self
            .store
            .recovery_failure
            .load(std::sync::atomic::Ordering::Acquire);
        let active = self.active.clone().map(|mut active| {
            if recovery_failed {
                active.readiness = ReadinessLevel::Degraded;
            }
            active
        });
        let proxy_ready = matches!(
            (&active, &self.active_handle, &self.proxy_generation),
            (Some(active), Some(handle), Some(proxy))
                if !recovery_failed
                    && active.egress_verified
                    && active.generation_id == proxy.generation_id
                    && active.pid == Some(proxy.pid)
                    && handle.pid() == proxy.pid
        );
        GenerationStatus {
            desired: self.desired.as_ref().map(|desired| desired.view.clone()),
            active,
            proxy_generation: self.proxy_generation.clone(),
            phase: if recovery_failed {
                GenerationPhase::Degraded
            } else {
                self.phase.clone()
            },
            proxy_ready,
            last_error_code: if recovery_failed {
                Some("orphanJournalWriteFailed".to_string())
            } else {
                self.last_error_code.clone()
            },
        }
    }

    pub fn revalidate_active<B: ApplyBackend>(
        &mut self,
        backend: &mut B,
    ) -> Result<(), ApplyFailure> {
        let (Some(active), Some(handle)) = (self.active.clone(), self.active_handle.as_ref())
        else {
            if self.proxy_generation.is_some() {
                self.proxy_generation = None;
                self.phase = GenerationPhase::Degraded;
                self.last_error_code = Some("processReadinessFailed".to_string());
                return Err(ApplyFailure::ProcessReadinessFailed);
            }
            return Ok(());
        };
        let checks = backend
            .confirm_process_identity(&active.generation_id, handle)
            .map_err(|_| ApplyFailure::ProcessReadinessFailed)
            .and_then(|()| {
                backend
                    .confirm_listener_readiness(
                        &active.generation_id,
                        handle,
                        &active.managed_listener_addresses,
                    )
                    .map_err(|_| ApplyFailure::ListenerReadinessFailed)
            })
            .and_then(|()| {
                backend
                    .confirm_egress_ready(
                        &active.generation_id,
                        handle,
                        &active.managed_listener_addresses,
                        &active.egress_probe,
                    )
                    .map_err(|_| ApplyFailure::EgressReadinessFailed)
            });
        let egress_verified = match checks {
            Ok(verified) => verified,
            Err(failure) => {
                self.proxy_generation = None;
                if let Some(active) = self.active.as_mut() {
                    active.egress_verified = false;
                    active.readiness = ReadinessLevel::Degraded;
                }
                self.phase = GenerationPhase::Degraded;
                self.last_error_code = Some(failure_code(failure).to_string());
                return Err(failure);
            }
        };
        if !egress_verified {
            if self.proxy_generation.is_some() {
                self.proxy_generation = None;
                if let Some(active) = self.active.as_mut() {
                    active.egress_verified = false;
                    active.readiness = ReadinessLevel::Degraded;
                }
                self.phase = GenerationPhase::Degraded;
                self.last_error_code = Some("egressReadinessFailed".to_string());
                return Err(ApplyFailure::EgressReadinessFailed);
            }
            if let Some(active) = self.active.as_mut() {
                active.egress_verified = false;
                active.readiness = ReadinessLevel::ListenerReady;
            }
            return Ok(());
        }
        if let Some(active) = self.active.as_mut() {
            active.egress_verified = true;
            active.readiness = ReadinessLevel::EgressReady;
        }
        Ok(())
    }

    fn begin_apply(&mut self) -> Result<ApplyPlan, ApplyFailure> {
        if self.in_flight_transaction.is_some() {
            return Err(ApplyFailure::Busy);
        }
        let desired = self.desired.as_ref().ok_or(ApplyFailure::NoDesired)?;
        let transaction_id = self
            .next_transaction_id
            .checked_add(1)
            .ok_or(ApplyFailure::TransactionCounterOverflow)?;
        self.next_transaction_id = transaction_id;
        self.in_flight_transaction = Some(transaction_id);
        self.phase = GenerationPhase::Switching;
        self.last_error_code = None;
        Ok(ApplyPlan {
            transaction_id,
            desired: desired.view.clone(),
            config: desired.config.clone(),
            previous_active: self.active.take(),
            previous_handle: self.active_handle.take(),
            previous_proxy: self.proxy_generation.clone(),
            proxy_snapshot: None,
        })
    }

    pub fn execute_latest<B: ApplyBackend>(
        &mut self,
        backend: &mut B,
    ) -> Result<GenerationStatus, ApplyFailure> {
        let mut plan = self.begin_apply()?;
        plan.proxy_snapshot = match backend.capture_proxy_snapshot() {
            Ok(snapshot) => snapshot,
            Err(_) => return self.finish_proxy_uncertain(plan, ApplyFailure::ProxyRestoreFailed),
        };
        let config_lease = match self.store.stage(&plan) {
            Ok(lease) => lease,
            Err(_) => {
                return self.finish_before_proxy_change(plan, ApplyFailure::GenerationPersistFailed)
            }
        };
        if backend.validate_config(&plan, &config_lease).is_err() {
            return self.finish_before_proxy_change(plan, ApplyFailure::ConfigValidationFailed);
        }
        self.set_desired_readiness(&plan, ReadinessLevel::ConfigValidated)?;
        if let Some(snapshot) = &plan.proxy_snapshot {
            match backend.restore_proxy_snapshot(snapshot) {
                Ok(ProxyReadback::Restored) => self.proxy_generation = None,
                _ => return self.finish_proxy_uncertain(plan, ApplyFailure::ProxyRestoreFailed),
            }
        }
        if let Some(active_handle) = &plan.previous_handle {
            let stop_result = backend.stop_active(active_handle);
            let exit_result = backend.confirm_exit(active_handle);
            if stop_result.is_err() || exit_result.is_err() {
                return self.finish_proxy_uncertain(plan, ApplyFailure::ActiveStopFailed);
            }
        }
        self.active = None;
        self.active_handle = None;
        let runner = match backend.start_candidate(&plan, &config_lease) {
            Ok(runner) => runner,
            Err(BackendFailure::Cancelled) => {
                return self.rollback_previous(plan, backend, ApplyFailure::Cancelled, false)
            }
            Err(BackendFailure::Failed) => {
                return self.rollback_previous(
                    plan,
                    backend,
                    ApplyFailure::CandidateStartFailed,
                    false,
                )
            }
        };
        let candidate = CandidateHandle {
            runner,
            config: config_lease,
        };
        let readiness_failure =
            match backend.confirm_process_identity(plan.generation_id(), &candidate) {
                Ok(()) => {
                    self.set_desired_readiness(&plan, ReadinessLevel::ProcessReady)?;
                    backend
                        .confirm_listener_readiness(
                            plan.generation_id(),
                            &candidate,
                            plan.managed_listener_addresses(),
                        )
                        .err()
                        .map(|failure| match failure {
                            BackendFailure::Cancelled => ApplyFailure::Cancelled,
                            BackendFailure::Failed => ApplyFailure::ListenerReadinessFailed,
                        })
                }
                Err(BackendFailure::Cancelled) => Some(ApplyFailure::Cancelled),
                Err(BackendFailure::Failed) => Some(ApplyFailure::ProcessReadinessFailed),
            };
        if let Some(failure) = readiness_failure {
            return self.cleanup_candidate_and_rollback(plan, backend, candidate, failure, false);
        }
        self.set_desired_readiness(&plan, ReadinessLevel::ListenerReady)?;
        let egress_verified = backend
            .confirm_egress_ready(
                plan.generation_id(),
                &candidate,
                plan.managed_listener_addresses(),
                &plan.desired.egress_probe,
            )
            .map_err(|failure| match failure {
                BackendFailure::Cancelled => ApplyFailure::Cancelled,
                BackendFailure::Failed => ApplyFailure::EgressReadinessFailed,
            })?;
        if egress_verified {
            let post_egress_failure = self
                .require_current(&plan)
                .err()
                .or_else(|| {
                    backend
                        .confirm_process_identity(plan.generation_id(), &candidate)
                        .err()
                        .map(|failure| match failure {
                            BackendFailure::Cancelled => ApplyFailure::Cancelled,
                            BackendFailure::Failed => ApplyFailure::ProcessReadinessFailed,
                        })
                })
                .or_else(|| {
                    backend
                        .confirm_listener_readiness(
                            plan.generation_id(),
                            &candidate,
                            plan.managed_listener_addresses(),
                        )
                        .err()
                        .map(|failure| match failure {
                            BackendFailure::Cancelled => ApplyFailure::Cancelled,
                            BackendFailure::Failed => ApplyFailure::ListenerReadinessFailed,
                        })
                });
            if let Some(failure) = post_egress_failure {
                return self
                    .cleanup_candidate_and_rollback(plan, backend, candidate, failure, false);
            }
            self.set_desired_readiness(&plan, ReadinessLevel::EgressReady)?;
        }
        self.require_current(&plan)?;
        let proxy_binding = if egress_verified && plan.proxy_snapshot.is_some() {
            match backend.bind_proxy(plan.generation_id(), &candidate, &plan.desired) {
                Ok(ProxyReadback::Bound(binding))
                    if binding.generation_id == *plan.generation_id()
                        && binding.pid == candidate.pid() =>
                {
                    Some(binding)
                }
                _ => {
                    return self.cleanup_candidate_and_rollback(
                        plan,
                        backend,
                        candidate,
                        ApplyFailure::ProxyConfirmationFailed,
                        true,
                    )
                }
            }
        } else {
            None
        };
        self.finish_success(plan, candidate, egress_verified, proxy_binding)
    }

    pub fn stop_active<B: ApplyBackend>(
        &mut self,
        backend: &mut B,
    ) -> Result<GenerationStatus, ApplyFailure> {
        if self.in_flight_transaction.is_some() {
            return Err(ApplyFailure::Busy);
        }
        let snapshot = backend
            .capture_proxy_snapshot()
            .map_err(|_| ApplyFailure::ProxyRestoreFailed)?;
        if let Some(snapshot) = snapshot {
            if !matches!(
                backend.restore_proxy_snapshot(&snapshot),
                Ok(ProxyReadback::Restored)
            ) {
                self.proxy_generation = None;
                self.phase = GenerationPhase::Degraded;
                self.last_error_code = Some("proxyRestoreFailed".to_string());
                return Err(ApplyFailure::ProxyRestoreFailed);
            }
        }
        self.proxy_generation = None;
        let Some(handle) = self.active_handle.take() else {
            self.active = None;
            self.phase = if self.desired.is_some() {
                GenerationPhase::PendingApply
            } else {
                GenerationPhase::Idle
            };
            return Ok(self.status());
        };
        let stop_result = backend.stop_active(&handle);
        let exit_result = backend.confirm_exit(&handle);
        if stop_result.is_err() || exit_result.is_err() {
            self.active_handle = Some(handle);
            if let Some(active) = self.active.as_mut() {
                active.readiness = ReadinessLevel::Degraded;
            }
            self.phase = GenerationPhase::Degraded;
            self.last_error_code = Some("activeStopFailed".to_string());
            return Err(ApplyFailure::ActiveStopFailed);
        }
        drop(handle);
        self.active = None;
        self.phase = if self.desired.is_some() {
            GenerationPhase::PendingApply
        } else {
            GenerationPhase::Idle
        };
        self.last_error_code = None;
        Ok(self.status())
    }

    pub fn bind_proxy_active<B: ApplyBackend>(
        &mut self,
        backend: &mut B,
    ) -> Result<GenerationStatus, ApplyFailure> {
        if self.in_flight_transaction.is_some() {
            return Err(ApplyFailure::Busy);
        }
        let (Some(active), Some(handle)) = (&self.active, &self.active_handle) else {
            return Err(ApplyFailure::NoDesired);
        };
        if active.readiness != ReadinessLevel::EgressReady {
            return Err(if active.egress_probe.is_configured() {
                ApplyFailure::EgressReadinessFailed
            } else {
                ApplyFailure::EgressProbeRequired
            });
        }
        let generation_id = active.generation_id.clone();
        let listeners = active.managed_listener_addresses.clone();
        backend
            .confirm_process_identity(&generation_id, handle)
            .map_err(|_| ApplyFailure::ProcessReadinessFailed)?;
        backend
            .confirm_listener_readiness(&generation_id, handle, &listeners)
            .map_err(|_| ApplyFailure::ListenerReadinessFailed)?;
        let egress_verified = backend
            .confirm_egress_ready(&generation_id, handle, &listeners, &active.egress_probe)
            .map_err(|_| ApplyFailure::EgressReadinessFailed)?;
        if !egress_verified {
            return Err(ApplyFailure::EgressReadinessFailed);
        }
        match backend.bind_proxy(&active.generation_id, handle, active) {
            Ok(ProxyReadback::Bound(binding))
                if self.in_flight_transaction.is_none()
                    && self.active.as_ref().is_some_and(|current| {
                        current.generation_id == generation_id
                            && current.readiness == ReadinessLevel::EgressReady
                            && current.egress_verified
                            && current.pid == Some(handle.pid())
                    })
                    && binding.generation_id == active.generation_id
                    && binding.pid == handle.pid() =>
            {
                self.proxy_generation = Some(binding);
                self.last_error_code = None;
                Ok(self.status())
            }
            _ => {
                self.proxy_generation = None;
                self.phase = GenerationPhase::Degraded;
                self.last_error_code = Some("proxyConfirmationFailed".to_string());
                Err(ApplyFailure::ProxyConfirmationFailed)
            }
        }
    }

    pub fn restore_proxy<B: ApplyBackend>(
        &mut self,
        backend: &mut B,
    ) -> Result<GenerationStatus, ApplyFailure> {
        if self.in_flight_transaction.is_some() {
            return Err(ApplyFailure::Busy);
        }
        let snapshot = backend
            .capture_proxy_snapshot()
            .map_err(|_| ApplyFailure::ProxyRestoreFailed)?;
        if let Some(snapshot) = snapshot {
            if !matches!(
                backend.restore_proxy_snapshot(&snapshot),
                Ok(ProxyReadback::Restored)
            ) {
                self.proxy_generation = None;
                self.phase = GenerationPhase::Degraded;
                self.last_error_code = Some("proxyRestoreFailed".to_string());
                return Err(ApplyFailure::ProxyRestoreFailed);
            }
        }
        self.proxy_generation = None;
        self.last_error_code = None;
        Ok(self.status())
    }

    pub fn degrade_proxy_binding(&mut self, error_code: &str) {
        self.proxy_generation = None;
        if let Some(active) = self.active.as_mut() {
            active.egress_verified = false;
            active.readiness = ReadinessLevel::Degraded;
        }
        self.phase = GenerationPhase::Degraded;
        self.last_error_code = Some(error_code.to_string());
    }

    fn cleanup_candidate_and_rollback<B: ApplyBackend>(
        &mut self,
        plan: ApplyPlan,
        backend: &mut B,
        candidate: CandidateHandle,
        failure: ApplyFailure,
        proxy_uncertain: bool,
    ) -> Result<GenerationStatus, ApplyFailure> {
        let stop_result = backend.stop_candidate(&candidate);
        let exit_result = backend.confirm_exit(&candidate);
        if stop_result.is_err() || exit_result.is_err() {
            self.require_current(&plan)?;
            let mut active = plan.desired.clone();
            active.pid = Some(candidate.pid());
            active.readiness = ReadinessLevel::Degraded;
            self.active = Some(active);
            self.active_handle = Some(candidate);
            self.proxy_generation = None;
            self.in_flight_transaction = None;
            self.phase = GenerationPhase::Degraded;
            self.last_error_code = Some("candidateCleanupFailed".to_string());
            return Err(ApplyFailure::CandidateCleanupFailed);
        }
        self.rollback_previous(plan, backend, failure, proxy_uncertain)
    }

    fn rollback_previous<B: ApplyBackend>(
        &mut self,
        mut plan: ApplyPlan,
        backend: &mut B,
        failure: ApplyFailure,
        proxy_uncertain: bool,
    ) -> Result<GenerationStatus, ApplyFailure> {
        self.require_current(&plan)?;
        self.phase = GenerationPhase::RollingBack;
        self.proxy_generation = None;
        match (&plan.previous_active, plan.previous_handle.as_mut()) {
            (Some(previous), Some(previous_handle)) => {
                match backend.rollback(previous, previous_handle) {
                    Ok(runner) => {
                        previous_handle.runner = runner.clone();
                        let egress_ready = backend
                            .confirm_egress_ready(
                                &previous.generation_id,
                                previous_handle,
                                &previous.managed_listener_addresses,
                                &previous.egress_probe,
                            )
                            .map_err(|_| ApplyFailure::RollbackFailed)?;
                        let mut active = previous.clone();
                        active.pid = Some(runner.pid);
                        active.egress_verified = egress_ready;
                        active.readiness = if proxy_uncertain {
                            ReadinessLevel::Degraded
                        } else if egress_ready {
                            ReadinessLevel::EgressReady
                        } else {
                            ReadinessLevel::ListenerReady
                        };
                        self.active = Some(active);
                        self.active_handle = plan.previous_handle.take();
                        self.in_flight_transaction = None;
                        self.phase = if proxy_uncertain {
                            GenerationPhase::Degraded
                        } else {
                            GenerationPhase::PendingApply
                        };
                        self.last_error_code = Some(failure_code(failure).to_string());
                        Err(failure)
                    }
                    Err(mut rollback_failure) => {
                        if let Some(runner) = rollback_failure.runner.take() {
                            let mut active = previous.clone();
                            active.pid = Some(runner.pid);
                            active.readiness = ReadinessLevel::Degraded;
                            previous_handle.runner = runner;
                            self.active = Some(active);
                            self.active_handle = plan.previous_handle.take();
                            self.proxy_generation = None;
                            self.in_flight_transaction = None;
                            self.phase = GenerationPhase::Degraded;
                            self.last_error_code = Some("rollbackFailed".to_string());
                            Err(ApplyFailure::RollbackFailed)
                        } else {
                            self.finish_degraded(plan, ApplyFailure::RollbackFailed)
                        }
                    }
                }
            }
            _ => self.finish_degraded(plan, failure),
        }
    }

    fn finish_success(
        &mut self,
        plan: ApplyPlan,
        candidate: CandidateHandle,
        egress_verified: bool,
        proxy_binding: Option<ProxyGenerationView>,
    ) -> Result<GenerationStatus, ApplyFailure> {
        self.require_current(&plan)?;
        let mut active = plan.desired.clone();
        active.pid = Some(candidate.pid());
        active.egress_verified = egress_verified;
        active.readiness = if egress_verified {
            ReadinessLevel::EgressReady
        } else {
            ReadinessLevel::ListenerReady
        };
        let active_pid = active.pid;
        let active_readiness = active.readiness.clone();
        self.active = Some(active);
        self.active_handle = Some(candidate);
        self.proxy_generation = proxy_binding;
        if let Some(desired) = self.desired.as_mut() {
            if desired.view.generation_id == *plan.generation_id() {
                desired.view.pid = active_pid;
                desired.view.egress_verified = egress_verified;
                desired.view.readiness = active_readiness;
            }
        }
        self.in_flight_transaction = None;
        self.phase = if self.desired_generation_id() == Some(plan.generation_id()) {
            GenerationPhase::Idle
        } else {
            GenerationPhase::PendingApply
        };
        self.last_error_code = None;
        Ok(self.status())
    }

    fn finish_before_proxy_change(
        &mut self,
        mut plan: ApplyPlan,
        failure: ApplyFailure,
    ) -> Result<GenerationStatus, ApplyFailure> {
        self.require_current(&plan)?;
        self.in_flight_transaction = None;
        self.active = plan.previous_active.clone();
        self.active_handle = plan.previous_handle.take();
        self.proxy_generation = plan.previous_proxy.clone();
        self.phase = GenerationPhase::PendingApply;
        self.last_error_code = Some(failure_code(failure).to_string());
        Err(failure)
    }

    fn finish_proxy_uncertain(
        &mut self,
        mut plan: ApplyPlan,
        failure: ApplyFailure,
    ) -> Result<GenerationStatus, ApplyFailure> {
        self.require_current(&plan)?;
        self.proxy_generation = None;
        self.in_flight_transaction = None;
        self.active = plan.previous_active.clone().map(|mut active| {
            active.readiness = ReadinessLevel::Degraded;
            active
        });
        self.active_handle = plan.previous_handle.take();
        self.phase = GenerationPhase::Degraded;
        self.last_error_code = Some(failure_code(failure).to_string());
        Err(failure)
    }

    fn finish_degraded(
        &mut self,
        plan: ApplyPlan,
        failure: ApplyFailure,
    ) -> Result<GenerationStatus, ApplyFailure> {
        self.require_current(&plan)?;
        self.active = None;
        self.active_handle = None;
        self.proxy_generation = None;
        self.in_flight_transaction = None;
        self.phase = GenerationPhase::Degraded;
        self.last_error_code = Some(failure_code(failure).to_string());
        Err(failure)
    }

    fn require_current(&self, plan: &ApplyPlan) -> Result<(), ApplyFailure> {
        if self.in_flight_transaction == Some(plan.transaction_id) {
            Ok(())
        } else {
            Err(ApplyFailure::StaleTransaction)
        }
    }

    fn set_desired_readiness(
        &mut self,
        plan: &ApplyPlan,
        readiness: ReadinessLevel,
    ) -> Result<(), ApplyFailure> {
        self.require_current(plan)?;
        if let Some(desired) = self.desired.as_mut() {
            if desired.view.generation_id == *plan.generation_id() {
                desired.view.readiness = readiness;
            }
        }
        Ok(())
    }

    fn desired_generation_id(&self) -> Option<&GenerationId> {
        self.desired
            .as_ref()
            .map(|desired| &desired.view.generation_id)
    }
}

pub struct GenerationStore {
    root: PathBuf,
    retained: usize,
    recovery_failure: std::sync::Arc<std::sync::atomic::AtomicBool>,
    instance_lease: Option<InstanceLease>,
    leased_paths: Arc<Mutex<HashSet<PathBuf>>>,
    #[cfg(test)]
    race_hook: GenerationRaceHook,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct InstanceLeaseMetadata {
    version: u32,
    boot_epoch: String,
    pid: u32,
    creation_token: String,
}

#[derive(Debug)]
struct InstanceLease {
    _file: File,
    _parent_dir: File,
    #[cfg(not(unix))]
    root: PathBuf,
    #[cfg(unix)]
    _anchor_file: File,
    #[cfg(target_os = "windows")]
    file_identity: WindowsFileIdentity,
    #[cfg(target_os = "windows")]
    parent_identity: WindowsFileIdentity,
    creation_token: String,
}

struct LockedInstanceFile {
    file: File,
    parent_dir: File,
    #[cfg(unix)]
    anchor_file: File,
    #[cfg(target_os = "windows")]
    file_identity: WindowsFileIdentity,
    #[cfg(target_os = "windows")]
    parent_identity: WindowsFileIdentity,
}

#[cfg(target_os = "windows")]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct WindowsFileIdentity {
    volume_serial: u32,
    index_high: u32,
    index_low: u32,
}

#[cfg(target_os = "windows")]
fn verify_windows_file_identity(
    file: &File,
    expected: WindowsFileIdentity,
    expect_directory: bool,
) -> Result<(), String> {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::{
        GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION, FILE_ATTRIBUTE_DIRECTORY,
        FILE_ATTRIBUTE_REPARSE_POINT,
    };
    let mut info = BY_HANDLE_FILE_INFORMATION {
        dwFileAttributes: 0,
        ftCreationTime: Default::default(),
        ftLastAccessTime: Default::default(),
        ftLastWriteTime: Default::default(),
        dwVolumeSerialNumber: 0,
        nFileSizeHigh: 0,
        nFileSizeLow: 0,
        nNumberOfLinks: 0,
        nFileIndexHigh: 0,
        nFileIndexLow: 0,
    };
    let result = unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut info) };
    let is_directory = info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY != 0;
    if result == 0
        || info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0
        || is_directory != expect_directory
    {
        return Err("generation-instance-lease-identity-invalid".to_string());
    }
    let actual = WindowsFileIdentity {
        volume_serial: info.dwVolumeSerialNumber,
        index_high: info.nFileIndexHigh,
        index_low: info.nFileIndexLow,
    };
    if actual != expected {
        return Err("generation-instance-lease-identity-mismatch".to_string());
    }
    Ok(())
}

impl InstanceLease {
    fn verify(&self) -> Result<(), String> {
        #[cfg(not(unix))]
        verify_root_directory_binding(&self.root, &self._parent_dir)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;

            crate::unix_generation_fs::validate_open_regular(&self._anchor_file)
                .map_err(|_| "generation-instance-anchor-invalid".to_string())?;
            unsafe extern "C" {
                fn geteuid() -> u32;
            }
            let uid = unsafe { geteuid() };
            let parent = self
                ._parent_dir
                .metadata()
                .map_err(|_| "generation-instance-lease-parent-read-failed".to_string())?;
            if !parent.is_dir() || parent.uid() != uid || parent.mode() & 0o077 != 0 {
                return Err("generation-instance-lease-parent-invalid".to_string());
            }
            let file = self
                ._file
                .metadata()
                .map_err(|_| "generation-instance-lease-read-failed".to_string())?;
            if !file.is_file() || file.uid() != uid || file.nlink() != 1 || file.mode() & 0o077 != 0
            {
                return Err("generation-instance-lease-file-invalid".to_string());
            }
        }
        #[cfg(target_os = "windows")]
        {
            verify_windows_file_identity(&self._file, self.file_identity, false)?;
            verify_windows_file_identity(&self._parent_dir, self.parent_identity, true)?;
        }
        let mut file = self
            ._file
            .try_clone()
            .map_err(|_| "generation-instance-lease-read-failed".to_string())?;
        file.seek(SeekFrom::Start(0))
            .map_err(|_| "generation-instance-lease-read-failed".to_string())?;
        let mut raw = String::new();
        file.read_to_string(&mut raw)
            .map_err(|_| "generation-instance-lease-read-failed".to_string())?;
        let metadata: InstanceLeaseMetadata = serde_json::from_str(&raw)
            .map_err(|_| "generation-instance-lease-invalid".to_string())?;
        if metadata.creation_token != self.creation_token {
            return Err("generation-instance-lease-token-mismatch".to_string());
        }
        Ok(())
    }
}

fn acquire_instance_lease(root: &Path) -> Option<InstanceLease> {
    if fs::create_dir_all(root).is_err() {
        return None;
    }
    let path = root.join(INSTANCE_LEASE_FILE);
    let LockedInstanceFile {
        mut file,
        parent_dir,
        #[cfg(unix)]
        anchor_file,
        #[cfg(target_os = "windows")]
        file_identity,
        #[cfg(target_os = "windows")]
        parent_identity,
    } = open_locked_instance_file(&path).ok()?;
    let creation_token = random_epoch();
    let metadata = InstanceLeaseMetadata {
        version: 1,
        boot_epoch: random_epoch(),
        pid: std::process::id(),
        creation_token: creation_token.clone(),
    };
    let data = serde_json::to_vec(&metadata).ok()?;
    write_instance_lease_metadata(&mut file, &data).ok()?;
    Some(InstanceLease {
        _file: file,
        _parent_dir: parent_dir,
        #[cfg(not(unix))]
        root: root.to_path_buf(),
        #[cfg(unix)]
        _anchor_file: anchor_file,
        #[cfg(target_os = "windows")]
        file_identity,
        #[cfg(target_os = "windows")]
        parent_identity,
        creation_token,
    })
}

fn write_instance_lease_metadata(file: &mut File, data: &[u8]) -> std::io::Result<()> {
    file.set_len(0)?;
    file.seek(SeekFrom::Start(0))?;
    file.write_all(data)?;
    file.sync_data()
}

#[cfg(not(unix))]
fn verify_root_directory_binding(root: &Path, directory: &File) -> Result<(), String> {
    let _ = (root, directory);
    Ok(())
}

#[cfg(unix)]
fn open_locked_instance_file(path: &Path) -> std::io::Result<LockedInstanceFile> {
    use std::os::fd::{AsRawFd, FromRawFd};
    use std::os::unix::fs::{MetadataExt, OpenOptionsExt};

    let parent_path = path
        .parent()
        .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::InvalidInput, "lease parent"))?;
    let anchor_file = open_unix_root_anchor(parent_path)?;
    let path_metadata = fs::symlink_metadata(parent_path)?;
    if path_metadata.file_type().is_symlink() || !path_metadata.is_dir() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::PermissionDenied,
            "lease parent must be a real directory",
        ));
    }
    let parent = fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(parent_path)?;
    let parent_metadata = parent.metadata()?;
    if !parent_metadata.is_dir()
        || parent_metadata.dev() != path_metadata.dev()
        || parent_metadata.ino() != path_metadata.ino()
    {
        return Err(std::io::Error::new(
            std::io::ErrorKind::PermissionDenied,
            "lease parent changed while opening",
        ));
    }
    unsafe extern "C" {
        fn geteuid() -> u32;
        fn fchmod(fd: i32, mode: u32) -> i32;
        fn openat(dirfd: i32, pathname: *const i8, flags: i32, mode: u32) -> i32;
        fn flock(fd: i32, operation: i32) -> i32;
    }
    if parent_metadata.uid() != unsafe { geteuid() } {
        return Err(std::io::Error::new(
            std::io::ErrorKind::PermissionDenied,
            "lease parent directory owner mismatch",
        ));
    }
    if unsafe { fchmod(parent.as_raw_fd(), 0o700) } != 0 {
        return Err(std::io::Error::last_os_error());
    }
    if parent.metadata()?.mode() & 0o077 != 0 {
        return Err(std::io::Error::new(
            std::io::ErrorKind::PermissionDenied,
            "lease parent directory is not private",
        ));
    }
    if fs::symlink_metadata(path).is_ok_and(|metadata| metadata.file_type().is_symlink()) {
        return Err(std::io::Error::new(
            std::io::ErrorKind::PermissionDenied,
            "lease file must not be a symlink",
        ));
    }
    let name = b"instance-lease.json\0";
    let fd = unsafe {
        openat(
            parent.as_raw_fd(),
            name.as_ptr().cast(),
            libc::O_RDWR | libc::O_CREAT | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            0o600,
        )
    };
    if fd < 0 {
        return Err(std::io::Error::last_os_error());
    }
    let file = unsafe { File::from_raw_fd(fd) };
    let metadata = file.metadata()?;
    if !metadata.is_file() || metadata.uid() != unsafe { geteuid() } || metadata.nlink() != 1 {
        return Err(std::io::Error::new(
            std::io::ErrorKind::PermissionDenied,
            "lease path is not an owned regular file",
        ));
    }
    if unsafe { fchmod(file.as_raw_fd(), 0o600) } != 0 {
        return Err(std::io::Error::last_os_error());
    }
    if file.metadata()?.mode() & 0o077 != 0 {
        return Err(std::io::Error::new(
            std::io::ErrorKind::PermissionDenied,
            "lease file is not private",
        ));
    }
    if unsafe { flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(LockedInstanceFile {
        file,
        parent_dir: parent,
        anchor_file,
    })
}

#[cfg(unix)]
fn open_unix_root_anchor(root: &Path) -> std::io::Result<File> {
    use std::os::fd::{AsRawFd, FromRawFd};
    use std::os::unix::ffi::OsStrExt;
    use std::os::unix::fs::{MetadataExt, OpenOptionsExt};

    let parent_path = root
        .parent()
        .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::InvalidInput, "root parent"))?;
    let parent = fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(parent_path)?;
    let canonical_key = sha256_bytes(root.as_os_str().as_bytes());
    let anchor_name = format!(".tachyon-generation-{canonical_key}.lock\0");
    let fd = unsafe {
        libc::openat(
            parent.as_raw_fd(),
            anchor_name.as_ptr().cast(),
            libc::O_RDWR | libc::O_CREAT | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            0o600,
        )
    };
    if fd < 0 {
        return Err(std::io::Error::last_os_error());
    }
    let anchor = unsafe { File::from_raw_fd(fd) };
    let metadata = anchor.metadata()?;
    let uid = unsafe { libc::geteuid() };
    if !metadata.is_file() || metadata.uid() != uid || metadata.nlink() != 1 {
        return Err(std::io::Error::new(
            std::io::ErrorKind::PermissionDenied,
            "generation anchor is not an owned regular file",
        ));
    }
    if unsafe { libc::fchmod(anchor.as_raw_fd(), 0o600) } != 0 {
        return Err(std::io::Error::last_os_error());
    }
    if anchor.metadata()?.mode() & 0o077 != 0 {
        return Err(std::io::Error::new(
            std::io::ErrorKind::PermissionDenied,
            "generation anchor is not private",
        ));
    }
    if unsafe { libc::flock(anchor.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(anchor)
}

#[cfg(target_os = "windows")]
fn open_locked_instance_file(path: &Path) -> std::io::Result<LockedInstanceFile> {
    use std::os::windows::ffi::OsStrExt;
    use std::os::windows::io::FromRawHandle;
    use windows_sys::Win32::Foundation::INVALID_HANDLE_VALUE;
    use windows_sys::Win32::Storage::FileSystem::{
        CreateFileW, GetFileInformationByHandle, LockFileEx, BY_HANDLE_FILE_INFORMATION,
        FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_NORMAL, FILE_ATTRIBUTE_REPARSE_POINT,
        FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT, FILE_GENERIC_READ,
        FILE_GENERIC_WRITE, FILE_SHARE_NONE, FILE_SHARE_READ, FILE_SHARE_WRITE,
        LOCKFILE_EXCLUSIVE_LOCK, LOCKFILE_FAIL_IMMEDIATELY, OPEN_ALWAYS, OPEN_EXISTING,
    };
    use windows_sys::Win32::System::IO::OVERLAPPED;

    let parent_path = path
        .parent()
        .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::InvalidInput, "lease parent"))?;
    let parent_wide = parent_path
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let parent_handle = unsafe {
        CreateFileW(
            parent_wide.as_ptr(),
            FILE_GENERIC_READ,
            FILE_SHARE_READ | FILE_SHARE_WRITE,
            std::ptr::null(),
            OPEN_EXISTING,
            FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
            std::ptr::null_mut(),
        )
    };
    if parent_handle == INVALID_HANDLE_VALUE {
        return Err(std::io::Error::last_os_error());
    }
    let parent = unsafe { File::from_raw_handle(parent_handle) };
    let mut parent_info = BY_HANDLE_FILE_INFORMATION {
        dwFileAttributes: 0,
        ftCreationTime: Default::default(),
        ftLastAccessTime: Default::default(),
        ftLastWriteTime: Default::default(),
        dwVolumeSerialNumber: 0,
        nFileSizeHigh: 0,
        nFileSizeLow: 0,
        nNumberOfLinks: 0,
        nFileIndexHigh: 0,
        nFileIndexLow: 0,
    };
    if unsafe { GetFileInformationByHandle(parent_handle, &mut parent_info) } == 0
        || parent_info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY == 0
        || parent_info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0
    {
        return Err(std::io::Error::new(
            std::io::ErrorKind::PermissionDenied,
            "lease parent is not a real directory",
        ));
    }
    let wide = path
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let handle = unsafe {
        CreateFileW(
            wide.as_ptr(),
            FILE_GENERIC_READ | FILE_GENERIC_WRITE,
            FILE_SHARE_NONE,
            std::ptr::null(),
            OPEN_ALWAYS,
            FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT,
            std::ptr::null_mut(),
        )
    };
    if handle == INVALID_HANDLE_VALUE {
        return Err(std::io::Error::last_os_error());
    }
    let mut info = BY_HANDLE_FILE_INFORMATION {
        dwFileAttributes: 0,
        ftCreationTime: Default::default(),
        ftLastAccessTime: Default::default(),
        ftLastWriteTime: Default::default(),
        dwVolumeSerialNumber: 0,
        nFileSizeHigh: 0,
        nFileSizeLow: 0,
        nNumberOfLinks: 0,
        nFileIndexHigh: 0,
        nFileIndexLow: 0,
    };
    if unsafe { GetFileInformationByHandle(handle, &mut info) } == 0
        || info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0
        || info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY != 0
    {
        unsafe {
            windows_sys::Win32::Foundation::CloseHandle(handle);
        }
        return Err(std::io::Error::new(
            std::io::ErrorKind::PermissionDenied,
            "lease path is a reparse point or directory",
        ));
    }
    let mut overlapped = unsafe { std::mem::zeroed::<OVERLAPPED>() };
    let locked = unsafe {
        LockFileEx(
            handle,
            LOCKFILE_EXCLUSIVE_LOCK | LOCKFILE_FAIL_IMMEDIATELY,
            0,
            1,
            0,
            &mut overlapped,
        ) != 0
    };
    if !locked {
        unsafe {
            windows_sys::Win32::Foundation::CloseHandle(handle);
        }
        return Err(std::io::Error::last_os_error());
    }
    Ok(LockedInstanceFile {
        file: unsafe { File::from_raw_handle(handle) },
        parent_dir: parent,
        file_identity: WindowsFileIdentity {
            volume_serial: info.dwVolumeSerialNumber,
            index_high: info.nFileIndexHigh,
            index_low: info.nFileIndexLow,
        },
        parent_identity: WindowsFileIdentity {
            volume_serial: parent_info.dwVolumeSerialNumber,
            index_high: parent_info.nFileIndexHigh,
            index_low: parent_info.nFileIndexLow,
        },
    })
}

#[cfg(not(any(unix, target_os = "windows")))]
fn open_locked_instance_file(_path: &Path) -> std::io::Result<LockedInstanceFile> {
    Err(std::io::Error::new(
        std::io::ErrorKind::Unsupported,
        "OS instance locking is unsupported on this platform",
    ))
}

impl GenerationStore {
    pub fn new(root: PathBuf) -> Self {
        let root = if root.is_absolute() {
            root
        } else {
            std::env::current_dir()
                .map(|current| current.join(&root))
                .unwrap_or(root)
        };
        let instance_lease = acquire_instance_lease(&root);
        Self {
            root,
            retained: RETAINED_GENERATIONS,
            recovery_failure: std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
            instance_lease,
            leased_paths: Arc::new(Mutex::new(HashSet::new())),
            #[cfg(test)]
            race_hook: GenerationRaceHook::default(),
        }
    }

    #[cfg(all(test, unix))]
    fn set_race_hook(
        &self,
        before: impl FnOnce() + Send + 'static,
        after: impl FnOnce() + Send + 'static,
    ) {
        *self.race_hook.0.lock().unwrap() = Some(GenerationRaceSwap {
            before: Box::new(before),
            after: Box::new(after),
        });
    }

    pub fn stage(&self, plan: &ApplyPlan) -> Result<ConfigLease, String> {
        self.verify_instance_lease()?;
        #[cfg(test)]
        return with_generation_race(&self.race_hook, || self.stage_inner(plan));
        #[cfg(not(test))]
        self.stage_inner(plan)
    }

    #[cfg(unix)]
    fn stage_inner(&self, plan: &ApplyPlan) -> Result<ConfigLease, String> {
        let name = OsString::from(format!("generation-{}.json", plan.generation_id().as_str()));
        let instance_lease = self
            .instance_lease
            .as_ref()
            .ok_or_else(|| "generation-instance-lease-unavailable".to_string())?;
        let config_file =
            crate::unix_generation_fs::write_new(&instance_lease._parent_dir, &name, plan.config())
                .map_err(|_| "generation-config-write-failed".to_string())?;
        let path = self.root.join(&name);
        let lease = ConfigLease {
            path,
            name: name.clone(),
            recovery_failure: std::sync::Arc::clone(&self.recovery_failure),
            leased_paths: Arc::clone(&self.leased_paths),
            root_binding: Some(ConfigRootBinding {
                directory: instance_lease
                    ._parent_dir
                    .try_clone()
                    .map_err(|_| "generation-root-fd-clone-failed".to_string())?,
                _anchor: instance_lease
                    ._anchor_file
                    .try_clone()
                    .map_err(|_| "generation-anchor-fd-clone-failed".to_string())?,
            }),
            config_file,
            #[cfg(test)]
            race_hook: self.race_hook.clone(),
        };
        self.leased_paths
            .lock()
            .map_err(|_| "generation-lease-state-failed".to_string())?
            .insert(lease.path.clone());
        self.cleanup_stale_unix(&name)?;
        Ok(lease)
    }

    #[cfg(not(unix))]
    fn stage_inner(&self, plan: &ApplyPlan) -> Result<ConfigLease, String> {
        let path = self
            .root
            .join(format!("generation-{}.json", plan.generation_id().as_str()));
        let config = std::str::from_utf8(plan.config())
            .map_err(|_| "generation-config-not-utf8".to_string())?;
        self.guarded_root_io("generation-config-write-failed", || {
            write_atomic(&path, config).map_err(std::io::Error::other)
        })?;
        let instance_lease = self
            .instance_lease
            .as_ref()
            .ok_or_else(|| "generation-instance-lease-unavailable".to_string())?;
        let lease = ConfigLease {
            path,
            orphan_journal: self.root.join(ORPHAN_JOURNAL_FILE),
            orphan_recovery_failure: self.root.join(ORPHAN_RECOVERY_FAILURE_FILE),
            recovery_failure: std::sync::Arc::clone(&self.recovery_failure),
            leased_paths: Arc::clone(&self.leased_paths),
            root_binding: Some(ConfigRootBinding {
                path: self.root.clone(),
                directory: instance_lease
                    ._parent_dir
                    .try_clone()
                    .map_err(|_| "generation-root-fd-clone-failed".to_string())?,
            }),
            #[cfg(test)]
            race_hook: self.race_hook.clone(),
        };
        self.leased_paths
            .lock()
            .map_err(|_| "generation-lease-state-failed".to_string())?
            .insert(lease.path.clone());
        self.cleanup_stale_path(lease.path())?;
        self.verify_instance_lease()?;
        Ok(lease)
    }

    pub fn sweep_orphans(&self) -> Result<(), String> {
        self.verify_instance_lease()?;
        #[cfg(test)]
        return with_generation_race(&self.race_hook, || self.sweep_orphans_inner());
        #[cfg(not(test))]
        self.sweep_orphans_inner()
    }

    #[cfg(unix)]
    fn sweep_orphans_inner(&self) -> Result<(), String> {
        let root = &self
            .instance_lease
            .as_ref()
            .ok_or_else(|| "generation-instance-lease-unavailable".to_string())?
            ._parent_dir;
        let entries = crate::unix_generation_fs::list(root)
            .map_err(|_| "generation-dir-read-failed".to_string())?;
        for entry in entries {
            let path = self.root.join(&entry.name);
            let is_generation = entry
                .name
                .to_str()
                .is_some_and(|name| name.starts_with("generation-") && name.ends_with(".json"));
            let leased = self
                .leased_paths
                .lock()
                .map_err(|_| "generation-lease-state-failed".to_string())?
                .contains(&path);
            if is_generation && !leased {
                crate::unix_generation_fs::remove(root, &entry.name)
                    .map_err(|_| "generation-orphan-cleanup-failed".to_string())?;
            }
        }
        self.remove_optional_unix(
            root,
            OsStr::new(ORPHAN_JOURNAL_FILE),
            "generation-orphan-journal-cleanup-failed",
        )?;
        self.remove_optional_unix(
            root,
            OsStr::new(ORPHAN_RECOVERY_FAILURE_FILE),
            "generation-orphan-recovery-marker-cleanup-failed",
        )?;
        self.recovery_failure
            .store(false, std::sync::atomic::Ordering::Release);
        Ok(())
    }

    #[cfg(unix)]
    fn remove_optional_unix(
        &self,
        root: &File,
        name: &OsStr,
        error_code: &'static str,
    ) -> Result<(), String> {
        match crate::unix_generation_fs::remove(root, name) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(_) => Err(error_code.to_string()),
        }
    }

    #[cfg(not(unix))]
    fn sweep_orphans_inner(&self) -> Result<(), String> {
        let entries = self.guarded_root_io("generation-dir-read-failed", || {
            fs::read_dir(&self.root)?
                .map(|entry| entry.map(|value| value.path()))
                .collect::<std::io::Result<Vec<_>>>()
        })?;
        for path in entries {
            let is_generation = path
                .file_name()
                .and_then(|value| value.to_str())
                .is_some_and(|name| name.starts_with("generation-") && name.ends_with(".json"));
            let leased = self
                .leased_paths
                .lock()
                .map_err(|_| "generation-lease-state-failed".to_string())?
                .contains(&path);
            if is_generation && !leased {
                self.guarded_root_io("generation-orphan-cleanup-failed", || {
                    fs::remove_file(&path)
                })?;
            }
        }
        let journal = self.root.join(ORPHAN_JOURNAL_FILE);
        match self.guarded_root_result(|| fs::remove_file(&journal))? {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return Err("generation-orphan-journal-cleanup-failed".to_string()),
        }
        let marker = self.root.join(ORPHAN_RECOVERY_FAILURE_FILE);
        match self.guarded_root_result(|| fs::remove_file(&marker))? {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return Err("generation-orphan-recovery-marker-cleanup-failed".to_string()),
        }
        self.recovery_failure
            .store(false, std::sync::atomic::Ordering::Release);
        self.verify_instance_lease()?;
        Ok(())
    }

    fn verify_instance_lease(&self) -> Result<(), String> {
        self.instance_lease
            .as_ref()
            .ok_or_else(|| "generation-instance-lease-unavailable".to_string())?
            .verify()
    }

    #[cfg(not(unix))]
    fn guarded_root_result<T>(
        &self,
        operation: impl FnOnce() -> std::io::Result<T>,
    ) -> Result<std::io::Result<T>, String> {
        self.verify_instance_lease()?;
        let result = operation();
        self.verify_instance_lease()?;
        Ok(result)
    }

    #[cfg(not(unix))]
    fn guarded_root_io<T>(
        &self,
        error_code: &'static str,
        operation: impl FnOnce() -> std::io::Result<T>,
    ) -> Result<T, String> {
        self.guarded_root_result(operation)?
            .map_err(|_| error_code.to_string())
    }

    #[cfg(unix)]
    fn cleanup_stale_unix(&self, current: &OsStr) -> Result<(), String> {
        let root = &self
            .instance_lease
            .as_ref()
            .ok_or_else(|| "generation-instance-lease-unavailable".to_string())?
            ._parent_dir;
        let mut files = crate::unix_generation_fs::list(root)
            .map_err(|_| "generation-dir-read-failed".to_string())?
            .into_iter()
            .filter(|entry| {
                entry
                    .name
                    .to_str()
                    .is_some_and(|name| name.starts_with("generation-") && name.ends_with(".json"))
            })
            .collect::<Vec<_>>();
        let leased_paths = self
            .leased_paths
            .lock()
            .map_err(|_| "generation-lease-state-failed".to_string())?
            .clone();
        files.retain(|entry| {
            entry.name != current && !leased_paths.contains(&self.root.join(&entry.name))
        });
        files.sort_by_key(|entry| {
            (
                entry.modified_seconds,
                entry.modified_nanoseconds,
                entry.name.clone(),
            )
        });
        let keep = self.retained.max(1);
        let remove_count = files.len().saturating_sub(keep - 1);
        for entry in files.into_iter().take(remove_count) {
            crate::unix_generation_fs::remove(root, &entry.name)
                .map_err(|_| "generation-stale-cleanup-failed".to_string())?;
        }
        Ok(())
    }

    #[cfg(not(unix))]
    fn cleanup_stale_path(&self, current: &Path) -> Result<(), String> {
        let mut files = self.guarded_root_io("generation-dir-read-failed", || {
            fs::read_dir(&self.root)?
                .filter_map(Result::ok)
                .map(|entry| entry.path())
                .filter(|path| {
                    path.extension().and_then(|value| value.to_str()) == Some("json")
                        && path
                            .file_name()
                            .and_then(|value| value.to_str())
                            .is_some_and(|name| name.starts_with("generation-"))
                })
                .map(|path| {
                    let modified = fs::metadata(&path)?.modified().ok();
                    Ok((path, modified))
                })
                .collect::<std::io::Result<Vec<_>>>()
        })?;
        let leased_paths = self
            .leased_paths
            .lock()
            .map_err(|_| "generation-lease-state-failed".to_string())?
            .clone();
        files.retain(|(path, _)| path != current && !leased_paths.contains(path));
        files.sort_by_key(|(path, modified)| (*modified, path.clone()));
        let keep = self.retained.max(1);
        let remove_count = files.len().saturating_sub(keep - 1);
        for (path, _) in files.into_iter().take(remove_count) {
            self.guarded_root_io("generation-stale-cleanup-failed", || fs::remove_file(&path))?;
        }
        Ok(())
    }
}

fn sha256_bytes(value: &[u8]) -> String {
    let digest = Sha256::digest(value);
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn failure_code(failure: ApplyFailure) -> &'static str {
    match failure {
        ApplyFailure::Busy => "applyBusy",
        ApplyFailure::NoDesired => "noDesiredGeneration",
        ApplyFailure::GenerationCounterOverflow => "generationCounterOverflow",
        ApplyFailure::TransactionCounterOverflow => "transactionCounterOverflow",
        ApplyFailure::StaleTransaction => "staleTransaction",
        ApplyFailure::ConfigValidationFailed => "configValidationFailed",
        ApplyFailure::GenerationPersistFailed => "generationPersistFailed",
        ApplyFailure::ProxyRestoreFailed => "proxyRestoreFailed",
        ApplyFailure::ActiveStopFailed => "activeStopFailed",
        ApplyFailure::CandidateStartFailed => "candidateStartFailed",
        ApplyFailure::ProcessReadinessFailed => "processReadinessFailed",
        ApplyFailure::ListenerReadinessFailed => "listenerReadinessFailed",
        ApplyFailure::EgressReadinessFailed => "egressReadinessFailed",
        ApplyFailure::EgressProbeRequired => "egressProbeRequired",
        ApplyFailure::CandidateCleanupFailed => "candidateCleanupFailed",
        ApplyFailure::RollbackFailed => "rollbackFailed",
        ApplyFailure::ProxyConfirmationFailed => "proxyConfirmationFailed",
        ApplyFailure::Cancelled => "applyCancelled",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    struct FakeBackend {
        events: Vec<String>,
        live: Vec<String>,
        proxy_enabled: bool,
        restore_readback: ProxyReadback,
        bind_readback: Option<ProxyReadback>,
        validate_failure: Option<BackendFailure>,
        start_failure: Option<BackendFailure>,
        process_failure: Option<BackendFailure>,
        listener_failure: Option<BackendFailure>,
        egress_failure: Option<BackendFailure>,
        egress_verified: bool,
        last_probe: Option<EgressProbeSettings>,
        stop_active_fails: bool,
        stop_candidate_fails: bool,
        confirm_exit_fails: bool,
        rollback_fails: bool,
        rollback_readiness_fails: bool,
        rollback_cleanup_fails: bool,
        kill_after_egress: bool,
        final_bind_fault: Option<FinalBindFault>,
        next_pid: u32,
    }

    #[derive(Clone, Copy)]
    enum FinalBindFault {
        ProcessKilled,
        ListenerReoccupied,
    }

    impl Default for FakeBackend {
        fn default() -> Self {
            Self {
                events: vec![],
                live: vec![],
                proxy_enabled: false,
                restore_readback: ProxyReadback::Restored,
                bind_readback: None,
                validate_failure: None,
                start_failure: None,
                process_failure: None,
                listener_failure: None,
                egress_failure: None,
                egress_verified: true,
                last_probe: None,
                stop_active_fails: false,
                stop_candidate_fails: false,
                confirm_exit_fails: false,
                rollback_fails: false,
                rollback_readiness_fails: false,
                rollback_cleanup_fails: false,
                kill_after_egress: false,
                final_bind_fault: None,
                next_pid: 4000,
            }
        }
    }

    impl FakeBackend {
        fn handle(&mut self, token: String) -> RunnerHandle {
            self.next_pid += 1;
            self.live.push(token.clone());
            RunnerHandle {
                pid: self.next_pid,
                runner_token: token,
            }
        }
    }

    impl ApplyBackend for FakeBackend {
        fn validate_config(
            &mut self,
            plan: &ApplyPlan,
            _config: &ConfigLease,
        ) -> Result<(), BackendFailure> {
            self.events
                .push(format!("validate:{}", plan.generation_id().as_str()));
            self.validate_failure.take().map_or(Ok(()), Err)
        }

        fn capture_proxy_snapshot(
            &mut self,
        ) -> Result<Option<ProxySnapshotHandle>, BackendFailure> {
            self.events.push("captureProxy".to_string());
            Ok(self.proxy_enabled.then(|| ProxySnapshotHandle {
                token: "snapshot-1".to_string(),
            }))
        }

        fn restore_proxy_snapshot(
            &mut self,
            snapshot: &ProxySnapshotHandle,
        ) -> Result<ProxyReadback, BackendFailure> {
            assert_eq!(snapshot.token, "snapshot-1");
            self.events.push("restoreProxy".to_string());
            Ok(self.restore_readback.clone())
        }

        fn stop_active(&mut self, active: &CandidateHandle) -> Result<(), BackendFailure> {
            self.events
                .push(format!("stopActive:{}", active.runner_token()));
            if self.stop_active_fails {
                Err(BackendFailure::Failed)
            } else {
                self.live.retain(|token| token != active.runner_token());
                Ok(())
            }
        }

        fn confirm_exit(&mut self, handle: &CandidateHandle) -> Result<(), BackendFailure> {
            self.events
                .push(format!("confirmExit:{}", handle.runner_token()));
            if self.confirm_exit_fails
                || self.live.iter().any(|token| token == handle.runner_token())
            {
                Err(BackendFailure::Failed)
            } else {
                Ok(())
            }
        }

        fn start_candidate(
            &mut self,
            plan: &ApplyPlan,
            config: &ConfigLease,
        ) -> Result<RunnerHandle, BackendFailure> {
            self.events.push(format!(
                "start:{}:{}",
                plan.generation_id().as_str(),
                config.path().display()
            ));
            if let Some(failure) = self.start_failure.take() {
                Err(failure)
            } else {
                Ok(self.handle(format!("candidate:{}", plan.generation_id().as_str())))
            }
        }

        fn stop_candidate(&mut self, handle: &CandidateHandle) -> Result<(), BackendFailure> {
            self.events
                .push(format!("stopCandidate:{}", handle.runner_token()));
            if self.stop_candidate_fails {
                Err(BackendFailure::Failed)
            } else {
                self.live.retain(|token| token != handle.runner_token());
                Ok(())
            }
        }

        fn confirm_process_identity(
            &mut self,
            _generation_id: &GenerationId,
            handle: &CandidateHandle,
        ) -> Result<(), BackendFailure> {
            self.events.push("processReady".to_string());
            if !self.live.iter().any(|token| token == handle.runner_token()) {
                return Err(BackendFailure::Failed);
            }
            self.process_failure.take().map_or(Ok(()), Err)
        }

        fn confirm_listener_readiness(
            &mut self,
            _generation_id: &GenerationId,
            _handle: &CandidateHandle,
            _listeners: &[String],
        ) -> Result<(), BackendFailure> {
            self.events.push("listenersReady".to_string());
            self.listener_failure.take().map_or(Ok(()), Err)
        }

        fn confirm_egress_ready(
            &mut self,
            _generation_id: &GenerationId,
            handle: &CandidateHandle,
            _listeners: &[String],
            probe: &EgressProbeSettings,
        ) -> Result<bool, BackendFailure> {
            self.events.push("egressReady".to_string());
            self.last_probe = Some(probe.clone());
            if !probe.is_configured() {
                return Ok(false);
            }
            if self.kill_after_egress {
                self.live.retain(|token| token != handle.runner_token());
            }
            self.egress_failure
                .take()
                .map_or(Ok(self.egress_verified), Err)
        }

        fn rollback(
            &mut self,
            active: &GenerationView,
            _previous_handle: &CandidateHandle,
        ) -> Result<RunnerHandle, RollbackFailure> {
            self.events
                .push(format!("rollback:{}", active.generation_id.as_str()));
            if self.rollback_fails {
                return Err(RollbackFailure { runner: None });
            }
            let runner = self.handle(format!("active:{}", active.generation_id.as_str()));
            if !self.rollback_readiness_fails {
                return Ok(runner);
            }
            self.events.push("rollbackReadinessFailed".to_string());
            if self.rollback_cleanup_fails {
                self.events.push("rollbackCleanupFailed".to_string());
                Err(RollbackFailure {
                    runner: Some(runner),
                })
            } else {
                self.live.retain(|token| token != &runner.runner_token);
                self.events.push("rollbackStopped".to_string());
                self.events.push("rollbackExitConfirmed".to_string());
                Err(RollbackFailure { runner: None })
            }
        }

        fn bind_proxy(
            &mut self,
            generation_id: &GenerationId,
            handle: &CandidateHandle,
            _active: &GenerationView,
        ) -> Result<ProxyReadback, BackendFailure> {
            self.events.push("bindProxy".to_string());
            if let Some(fault) = self.final_bind_fault.take() {
                self.events.push("finalEgressProbe".to_string());
                match fault {
                    FinalBindFault::ProcessKilled => {
                        self.live.retain(|token| token != handle.runner_token());
                    }
                    FinalBindFault::ListenerReoccupied => {
                        self.listener_failure = Some(BackendFailure::Failed);
                    }
                }
                self.confirm_process_identity(generation_id, handle)?;
                self.confirm_listener_readiness(generation_id, handle, &[])?;
            }
            Ok(self.bind_readback.clone().unwrap_or_else(|| {
                ProxyReadback::Bound(ProxyGenerationView {
                    generation_id: generation_id.clone(),
                    pid: handle.pid(),
                })
            }))
        }
    }

    fn runtime(epoch: &str) -> GenerationRuntime {
        GenerationRuntime {
            clock: GenerationClock::deterministic(epoch, 0, None),
            ..GenerationRuntime::default()
        }
    }

    fn generation_files(root: &Path) -> Vec<PathBuf> {
        fs::read_dir(root)
            .unwrap()
            .filter_map(Result::ok)
            .map(|entry| entry.path())
            .filter(|path| {
                path.file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(|name| name.starts_with("generation-") && name.ends_with(".json"))
            })
            .collect()
    }

    #[test]
    fn instance_lease_child_helper() {
        let Ok(root) = std::env::var("TACHYON_INSTANCE_LEASE_CHILD_ROOT") else {
            return;
        };
        let result = std::env::var("TACHYON_INSTANCE_LEASE_CHILD_RESULT").unwrap();
        let store = GenerationStore::new(PathBuf::from(root));
        fs::write(
            result,
            if store.instance_lease.is_some() {
                "owner"
            } else {
                "blocked"
            },
        )
        .unwrap();
    }

    fn run_instance_lease_child(root: &Path, result: &Path) -> std::process::Output {
        Command::new(std::env::current_exe().unwrap())
            .arg("--exact")
            .arg("xray_generation::tests::instance_lease_child_helper")
            .arg("--nocapture")
            .env("TACHYON_INSTANCE_LEASE_CHILD_ROOT", root)
            .env("TACHYON_INSTANCE_LEASE_CHILD_RESULT", result)
            .output()
            .unwrap()
    }

    #[test]
    fn instance_lease_is_exclusive_across_processes_and_released_by_drop() {
        let root = tempfile::tempdir().unwrap();
        let first = GenerationStore::new(root.path().to_path_buf());
        assert!(first.instance_lease.is_some());

        let blocked_result = root.path().join("blocked.txt");
        let blocked = run_instance_lease_child(root.path(), &blocked_result);
        assert!(blocked.status.success(), "child failed: {blocked:?}");
        assert_eq!(fs::read_to_string(blocked_result).unwrap(), "blocked");

        drop(first);
        let owner_result = root.path().join("owner.txt");
        let owner = run_instance_lease_child(root.path(), &owner_result);
        assert!(owner.status.success(), "child failed: {owner:?}");
        assert_eq!(fs::read_to_string(owner_result).unwrap(), "owner");
    }

    #[test]
    fn instance_lease_token_is_verified_before_stage_and_sweep() {
        let root = tempfile::tempdir().unwrap();
        let store = GenerationStore::new(root.path().to_path_buf());
        assert!(store.instance_lease.is_some());
        let mut tampered = store
            .instance_lease
            .as_ref()
            .unwrap()
            ._file
            .try_clone()
            .unwrap();
        write_instance_lease_metadata(
            &mut tampered,
            br#"{"version":1,"bootEpoch":"tampered","pid":1,"creationToken":"tampered"}"#,
        )
        .unwrap();
        assert_eq!(
            store.sweep_orphans().unwrap_err(),
            "generation-instance-lease-token-mismatch"
        );
        let mut runtime = GenerationRuntime::default();
        select(&mut runtime, "A", 1);
        let plan = runtime.begin_apply().unwrap();
        assert_eq!(
            store.stage(&plan).unwrap_err(),
            "generation-instance-lease-token-mismatch"
        );
    }

    #[cfg(any(target_os = "linux", target_os = "macos"))]
    #[test]
    fn instance_lease_open_flags_use_platform_libc_constants() {
        let flags = libc::O_RDWR | libc::O_CREAT | libc::O_NOFOLLOW | libc::O_CLOEXEC;
        let directory_flags = libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC;
        assert_eq!(flags & libc::O_RDWR, libc::O_RDWR);
        assert_eq!(flags & libc::O_CREAT, libc::O_CREAT);
        assert_eq!(flags & libc::O_NOFOLLOW, libc::O_NOFOLLOW);
        assert_eq!(flags & libc::O_CLOEXEC, libc::O_CLOEXEC);
        assert_eq!(directory_flags & libc::O_DIRECTORY, libc::O_DIRECTORY);
        assert_eq!(directory_flags & libc::O_CLOEXEC, libc::O_CLOEXEC);
    }

    #[cfg(any(target_os = "linux", target_os = "macos"))]
    #[test]
    fn every_generation_lease_descriptor_is_close_on_exec() {
        use std::os::fd::AsRawFd;

        let close_on_exec = |file: &File| {
            let flags = unsafe { libc::fcntl(file.as_raw_fd(), libc::F_GETFD) };
            assert!(flags >= 0);
            assert_eq!(flags & libc::FD_CLOEXEC, libc::FD_CLOEXEC);
        };
        let parent = tempfile::tempdir().unwrap();
        let store = GenerationStore::new(parent.path().join("generations"));
        let instance = store.instance_lease.as_ref().unwrap();
        close_on_exec(&instance._anchor_file);
        close_on_exec(&instance._parent_dir);
        close_on_exec(&instance._file);

        let mut runtime = GenerationRuntime::default();
        select(&mut runtime, "A", 1);
        let lease = store.stage(&runtime.begin_apply().unwrap()).unwrap();
        let binding = lease.root_binding.as_ref().unwrap();
        close_on_exec(&binding._anchor);
        close_on_exec(&binding.directory);
        close_on_exec(&lease.config_file);
    }

    #[cfg(any(target_os = "linux", target_os = "macos"))]
    fn install_root_swap_hook(
        store: &GenerationStore,
        root: &Path,
        moved: &Path,
        wait_for: Option<PathBuf>,
    ) -> Arc<std::sync::atomic::AtomicBool> {
        let untouched = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let before_root = root.to_path_buf();
        let before_moved = moved.to_path_buf();
        let after_root = root.to_path_buf();
        let after_moved = moved.to_path_buf();
        let after_untouched = Arc::clone(&untouched);
        store.set_race_hook(
            move || {
                fs::rename(&before_root, &before_moved).unwrap();
                fs::create_dir(&before_root).unwrap();
                fs::write(before_root.join("replacement-sentinel"), b"replacement").unwrap();
            },
            move || {
                if let Some(path) = wait_for {
                    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
                    while !path.is_file() && std::time::Instant::now() < deadline {
                        std::thread::sleep(std::time::Duration::from_millis(10));
                    }
                }
                let mut names = fs::read_dir(&after_root)
                    .unwrap()
                    .map(|entry| entry.unwrap().file_name())
                    .collect::<Vec<_>>();
                names.sort();
                after_untouched.store(
                    names == [OsString::from("replacement-sentinel")],
                    std::sync::atomic::Ordering::Release,
                );
                fs::remove_dir_all(&after_root).unwrap();
                fs::rename(&after_moved, &after_root).unwrap();
            },
        );
        untouched
    }

    #[cfg(any(target_os = "linux", target_os = "macos"))]
    #[test]
    fn replaced_root_blocks_second_instance() {
        let parent = tempfile::tempdir().unwrap();
        let root = parent.path().join("generations");
        let moved = parent.path().join("moved-generations");
        let first = GenerationStore::new(root.clone());
        assert!(first.instance_lease.is_some());

        fs::rename(&root, &moved).unwrap();
        fs::create_dir(&root).unwrap();
        let second = GenerationStore::new(root.clone());
        assert!(second.instance_lease.is_none());
        fs::remove_dir(&root).unwrap();
        fs::rename(&moved, &root).unwrap();
        drop(first);
    }

    #[cfg(any(target_os = "linux", target_os = "macos"))]
    #[test]
    fn stage_uses_retained_root_fd_during_deterministic_swap() {
        let parent = tempfile::tempdir().unwrap();
        let root = parent.path().join("generations");
        let moved = parent.path().join("moved-generations");
        let store = GenerationStore::new(root.clone());
        let untouched = install_root_swap_hook(&store, &root, &moved, None);
        let mut runtime = GenerationRuntime::default();
        select(&mut runtime, "A", 1);
        let lease = store.stage(&runtime.begin_apply().unwrap()).unwrap();
        assert!(untouched.load(std::sync::atomic::Ordering::Acquire));
        assert_eq!(fs::read(lease.path()).unwrap(), b"config");
    }

    #[cfg(any(target_os = "linux", target_os = "macos"))]
    #[test]
    fn sweep_uses_retained_root_fd_during_deterministic_swap() {
        let parent = tempfile::tempdir().unwrap();
        let root = parent.path().join("generations");
        let moved = parent.path().join("moved-generations");
        let store = GenerationStore::new(root.clone());
        let orphan = root.join("generation-orphan.json");
        write_atomic(&orphan, "{}").unwrap();
        let untouched = install_root_swap_hook(&store, &root, &moved, None);
        store.sweep_orphans().unwrap();
        assert!(untouched.load(std::sync::atomic::Ordering::Acquire));
        assert!(!orphan.exists());
    }

    #[cfg(any(target_os = "linux", target_os = "macos"))]
    #[test]
    fn stale_cleanup_deletes_only_from_retained_root_during_deterministic_swap() {
        let parent = tempfile::tempdir().unwrap();
        let root = parent.path().join("generations");
        let moved = parent.path().join("moved-generations");
        let mut store = GenerationStore::new(root.clone());
        store.retained = 2;
        for index in 0..3 {
            let path = root.join(format!("generation-old-{index}.json"));
            write_atomic(&path, "{}").unwrap();
            std::thread::sleep(std::time::Duration::from_millis(2));
        }
        let untouched = install_root_swap_hook(&store, &root, &moved, None);
        let mut runtime = GenerationRuntime::default();
        select(&mut runtime, "A", 1);
        let current = store.stage(&runtime.begin_apply().unwrap()).unwrap();
        assert!(untouched.load(std::sync::atomic::Ordering::Acquire));
        assert_eq!(fs::read(current.path()).unwrap(), b"config");
        let remaining_old = fs::read_dir(&root)
            .unwrap()
            .filter_map(Result::ok)
            .filter(|entry| {
                entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with("generation-old-")
            })
            .count();
        assert_eq!(remaining_old, 1);
    }

    #[cfg(any(target_os = "linux", target_os = "macos"))]
    #[test]
    fn lease_release_uses_retained_root_fd_during_deterministic_swap() {
        let parent = tempfile::tempdir().unwrap();
        let root = parent.path().join("generations");
        let moved = parent.path().join("moved-generations");
        let store = GenerationStore::new(root.clone());
        let mut runtime = GenerationRuntime::default();
        select(&mut runtime, "A", 1);
        let lease = store.stage(&runtime.begin_apply().unwrap()).unwrap();
        let generation = lease.path().to_path_buf();
        let untouched = install_root_swap_hook(&store, &root, &moved, None);
        drop(lease);
        assert!(untouched.load(std::sync::atomic::Ordering::Acquire));
        assert!(!generation.exists());
        assert!(!store
            .recovery_failure
            .load(std::sync::atomic::Ordering::Acquire));
    }

    #[cfg(any(target_os = "linux", target_os = "macos"))]
    #[test]
    fn child_reads_retained_config_fd_during_deterministic_swap() {
        use std::process::Stdio;

        let parent = tempfile::tempdir().unwrap();
        let root = parent.path().join("generations");
        let moved = parent.path().join("moved-generations");
        let output = parent.path().join("child-config.json");
        let store = GenerationStore::new(root.clone());
        let mut runtime = GenerationRuntime::default();
        select(&mut runtime, "A", 1);
        let lease = store.stage(&runtime.begin_apply().unwrap()).unwrap();
        let untouched = install_root_swap_hook(&store, &root, &moved, Some(output.clone()));
        let mut command = Command::new("sh");
        command
            .args(["-c", "cat \"$1\" > \"$2\"", "tachyon-config-reader"])
            .arg(lease.child_config_path())
            .arg(&output)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        let mut child = lease.spawn_command(&mut command).unwrap();
        assert!(child.wait().unwrap().success());
        assert!(untouched.load(std::sync::atomic::Ordering::Acquire));
        assert_eq!(fs::read(output).unwrap(), b"config");
    }

    #[cfg(any(target_os = "linux", target_os = "macos"))]
    #[test]
    fn post_spawn_identity_failure_kills_and_reaps_child() {
        use std::process::Stdio;

        let parent = tempfile::tempdir().unwrap();
        let root = parent.path().join("generations");
        let output = parent.path().join("child-survived");
        let saved = parent.path().join("saved-generation.json");
        let store = GenerationStore::new(root);
        let mut runtime = GenerationRuntime::default();
        select(&mut runtime, "A", 1);
        let lease = store.stage(&runtime.begin_apply().unwrap()).unwrap();
        let generation = lease.path().to_path_buf();
        let swap_generation = generation.clone();
        let swap_saved = saved.clone();
        store.set_race_hook(
            || {},
            move || {
                fs::rename(&swap_generation, &swap_saved).unwrap();
                write_atomic(&swap_generation, "{}").unwrap();
            },
        );
        let mut command = Command::new("sh");
        command
            .args(["-c", "sleep 1; printf survived > \"$1\"", "tachyon-child"])
            .arg(&output)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        assert!(lease.spawn_command(&mut command).is_err());
        fs::remove_file(&generation).unwrap();
        fs::rename(&saved, &generation).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(50));
        assert!(!output.exists());
    }

    #[cfg(any(target_os = "linux", target_os = "macos"))]
    #[test]
    fn stage_and_sweep_reject_hardlink_anomalies_without_touching_target() {
        use std::os::unix::fs::PermissionsExt;

        let parent = tempfile::tempdir().unwrap();
        let root = parent.path().join("generations");
        let store = GenerationStore::new(root.clone());
        let target = parent.path().join("target.json");
        fs::write(&target, b"target-secret").unwrap();
        fs::set_permissions(&target, fs::Permissions::from_mode(0o600)).unwrap();
        let mut runtime = GenerationRuntime::default();
        let generation_id = select(&mut runtime, "A", 1);
        let malicious = root.join(format!("generation-{}.json", generation_id.as_str()));
        fs::hard_link(&target, &malicious).unwrap();
        let plan = runtime.begin_apply().unwrap();
        assert_eq!(
            store.stage(&plan).unwrap_err(),
            "generation-config-write-failed"
        );
        assert_eq!(fs::read(&target).unwrap(), b"target-secret");
        assert_eq!(
            store.sweep_orphans().unwrap_err(),
            "generation-dir-read-failed"
        );
        assert_eq!(fs::read(&target).unwrap(), b"target-secret");
    }

    #[cfg(any(target_os = "linux", target_os = "macos"))]
    #[test]
    fn lease_descriptors_do_not_survive_exec() {
        use std::process::Stdio;

        let parent = tempfile::tempdir().unwrap();
        let root = parent.path().join("generations");
        let first = GenerationStore::new(root.clone());
        assert!(first.instance_lease.is_some());
        let mut child = Command::new("sh")
            .args(["-c", "sleep 5"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();

        drop(first);
        let second = GenerationStore::new(root);
        let acquired = second.instance_lease.is_some();
        let _ = child.kill();
        let _ = child.wait();
        assert!(
            acquired,
            "exec child inherited a generation lease descriptor"
        );
    }

    #[cfg(any(target_os = "linux", target_os = "macos"))]
    #[test]
    fn instance_lease_accepts_real_private_parent_directory() {
        let root = tempfile::tempdir().unwrap();
        let store = GenerationStore::new(root.path().join("real"));
        assert!(store.instance_lease.is_some());
    }

    #[cfg(any(target_os = "linux", target_os = "macos"))]
    #[test]
    fn instance_lease_rejects_symlinked_parent_directory() {
        use std::os::unix::fs::symlink;

        let root = tempfile::tempdir().unwrap();
        let real = root.path().join("real");
        let link = root.path().join("link");
        fs::create_dir(&real).unwrap();
        symlink(&real, &link).unwrap();
        let error = open_locked_instance_file(&link.join(INSTANCE_LEASE_FILE))
            .err()
            .expect("symlinked lease parent must be rejected");
        assert_eq!(error.kind(), std::io::ErrorKind::PermissionDenied);
        assert!(GenerationStore::new(link).instance_lease.is_none());
    }

    #[cfg(any(target_os = "linux", target_os = "macos"))]
    #[test]
    fn instance_lease_rejects_symlinked_lease_file() {
        use std::os::unix::fs::symlink;

        let root = tempfile::tempdir().unwrap();
        let target = root.path().join("target.json");
        fs::write(&target, b"do-not-overwrite").unwrap();
        let lease_path = root.path().join(INSTANCE_LEASE_FILE);
        symlink(&target, &lease_path).unwrap();
        let error = open_locked_instance_file(&lease_path)
            .err()
            .expect("symlinked lease file must be rejected");
        assert_eq!(error.kind(), std::io::ErrorKind::PermissionDenied);
        assert_eq!(fs::read(&target).unwrap(), b"do-not-overwrite");
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn instance_lease_rejects_reparse_parent_when_supported() {
        use std::os::windows::fs::symlink_dir;

        let root = tempfile::tempdir().unwrap();
        let real = root.path().join("real");
        let link = root.path().join("link");
        fs::create_dir(&real).unwrap();
        if symlink_dir(&real, &link).is_err() {
            return;
        }
        assert!(GenerationStore::new(link).instance_lease.is_none());
    }

    fn select(runtime: &mut GenerationRuntime, node: &str, revision: u64) -> GenerationId {
        select_with_probe(
            runtime,
            node,
            revision,
            EgressProbeSettings {
                url: "https://fixture.invalid/health".to_string(),
                expected_status: 204,
                ..EgressProbeSettings::default()
            },
        )
    }

    fn select_with_probe(
        runtime: &mut GenerationRuntime,
        node: &str,
        revision: u64,
        probe: EgressProbeSettings,
    ) -> GenerationId {
        runtime
            .select_desired_with_probe(
                format!(r#"{{"node":"{node}","secret":"hidden-{node}"}}"#).as_bytes(),
                node.to_string(),
                revision.to_string(),
                vec!["127.0.0.1:10808".to_string()],
                probe,
            )
            .unwrap()
    }

    fn activate(
        runtime: &mut GenerationRuntime,
        backend: &mut FakeBackend,
        node: &str,
    ) -> GenerationStatus {
        select(runtime, node, 1);
        runtime.execute_latest(backend).unwrap()
    }

    #[test]
    fn empty_egress_url_keeps_listener_ready_but_never_binds_proxy() {
        let mut runtime = runtime("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
        let mut backend = FakeBackend {
            proxy_enabled: true,
            ..FakeBackend::default()
        };
        runtime
            .select_desired(b"{}", "A".to_string(), "1".to_string(), vec![])
            .unwrap();
        let status = runtime.execute_latest(&mut backend).unwrap();
        let active = status.active.unwrap();
        assert_eq!(active.readiness, ReadinessLevel::ListenerReady);
        assert!(!active.egress_verified);
        assert!(status.proxy_generation.is_none());
        assert!(!status.proxy_ready);
        assert_eq!(status.phase, GenerationPhase::Idle);
    }

    #[test]
    fn configured_egress_url_promotes_listener_to_egress_verified() {
        let mut runtime = runtime("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
        let mut backend = FakeBackend {
            proxy_enabled: true,
            ..FakeBackend::default()
        };
        let probe = EgressProbeSettings {
            url: "https://fixture.invalid/health".to_string(),
            http_port: 18080,
            socks_port: 18081,
            ..EgressProbeSettings::default()
        };
        select_with_probe(&mut runtime, "A", 1, probe.clone());
        let status = runtime.execute_latest(&mut backend).unwrap();
        assert_eq!(
            status.active.unwrap().readiness,
            ReadinessLevel::EgressReady
        );
        assert!(status.proxy_ready);
        assert_eq!(backend.last_probe, Some(probe));
    }

    #[test]
    fn egress_probe_without_proxy_rechecks_process_before_marking_ready() {
        let mut runtime = runtime("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
        let mut backend = FakeBackend {
            kill_after_egress: true,
            ..FakeBackend::default()
        };
        select(&mut runtime, "A", 1);
        assert_eq!(
            runtime.execute_latest(&mut backend),
            Err(ApplyFailure::ProcessReadinessFailed)
        );
        assert!(runtime.status().active.is_none());
        assert!(runtime.status().proxy_generation.is_none());
        assert_eq!(runtime.status().phase, GenerationPhase::Degraded);
    }

    #[test]
    fn final_bind_probe_rejects_a_killed_process_and_degrades() {
        let mut runtime = runtime("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
        let mut backend = FakeBackend::default();
        activate(&mut runtime, &mut backend, "A");
        runtime.proxy_generation = None;
        backend.final_bind_fault = Some(FinalBindFault::ProcessKilled);

        assert_eq!(
            runtime.bind_proxy_active(&mut backend),
            Err(ApplyFailure::ProxyConfirmationFailed)
        );
        let status = runtime.status();
        assert_eq!(status.phase, GenerationPhase::Degraded);
        assert!(status.proxy_generation.is_none());
        assert!(!status.proxy_ready);
        assert!(backend.events.contains(&"finalEgressProbe".to_string()));
    }

    #[test]
    fn final_bind_probe_rejects_a_reoccupied_listener_and_degrades() {
        let mut runtime = runtime("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
        let mut backend = FakeBackend::default();
        activate(&mut runtime, &mut backend, "A");
        runtime.proxy_generation = None;
        backend.final_bind_fault = Some(FinalBindFault::ListenerReoccupied);

        assert_eq!(
            runtime.bind_proxy_active(&mut backend),
            Err(ApplyFailure::ProxyConfirmationFailed)
        );
        let status = runtime.status();
        assert_eq!(status.phase, GenerationPhase::Degraded);
        assert!(status.proxy_generation.is_none());
        assert!(!status.proxy_ready);
        assert!(backend.events.contains(&"finalEgressProbe".to_string()));
    }

    #[test]
    fn active_generation_keeps_probe_snapshot_when_new_port_settings_are_pending() {
        let mut runtime = runtime("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
        let mut backend = FakeBackend::default();
        let probe_a = EgressProbeSettings {
            url: "https://a.fixture.invalid/health".to_string(),
            http_port: 18080,
            socks_port: 18081,
            ..EgressProbeSettings::default()
        };
        let probe_b = EgressProbeSettings {
            url: "https://b.fixture.invalid/health".to_string(),
            http_port: 28080,
            socks_port: 28081,
            ..EgressProbeSettings::default()
        };
        select_with_probe(&mut runtime, "A", 1, probe_a.clone());
        let active = runtime
            .execute_latest(&mut backend)
            .unwrap()
            .active
            .unwrap();
        select_with_probe(&mut runtime, "B", 2, probe_b);
        runtime.revalidate_active(&mut backend).unwrap();
        assert_eq!(backend.last_probe, Some(probe_a));
        assert_eq!(
            runtime.status().active.unwrap().generation_id,
            active.generation_id
        );
        assert_eq!(runtime.status().desired.unwrap().node_id, "B");
        assert_eq!(runtime.status().phase, GenerationPhase::PendingApply);
    }

    #[test]
    fn generation_ids_are_epoch_scoped_strings_and_restart_never_infers_active() {
        let mut first = runtime("11111111111111111111111111111111");
        let first_id = select(&mut first, "A", 1);
        let mut restarted = runtime("22222222222222222222222222222222");
        let second_id = restarted
            .restore_desired_after_restart(b"{}", "B".to_string(), "2".to_string(), vec![])
            .unwrap();
        assert_ne!(first_id, second_id);
        assert!(restarted.status().active.is_none());
        assert!(serde_json::to_string(&second_id).unwrap().starts_with('"'));
    }

    #[test]
    fn generation_counter_overflow_fails_closed_without_reusing_an_id() {
        let mut runtime = GenerationRuntime {
            clock: GenerationClock::deterministic(
                "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                u64::MAX,
                None,
            ),
            ..GenerationRuntime::default()
        };
        assert_eq!(
            runtime.select_desired(b"{}", "B".to_string(), "1".to_string(), vec![]),
            Err(ApplyFailure::GenerationCounterOverflow)
        );
        assert!(runtime.status().desired.is_none());
    }

    #[test]
    fn transaction_counter_overflow_fails_closed_before_switching() {
        let mut runtime = runtime("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
        select(&mut runtime, "B", 1);
        runtime.next_transaction_id = u64::MAX;
        assert_eq!(
            runtime.begin_apply().err(),
            Some(ApplyFailure::TransactionCounterOverflow)
        );
        assert_eq!(runtime.status().phase, GenerationPhase::PendingApply);
        assert!(runtime.status().active.is_none());
    }

    #[test]
    fn clock_watermark_is_atomic_private_and_new_boot_uses_a_new_epoch() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("clock.json");
        let mut first = GenerationClock::open(path.clone()).unwrap();
        let first_id = first.next().unwrap();
        let second = GenerationClock::open(path.clone()).unwrap();
        assert_ne!(first.boot_epoch, second.boot_epoch);
        assert!(path.is_file());
        assert!(!path.with_extension("json.tmp").exists());
        assert!(first_id.as_str().ends_with("0000000000000001"));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
    }

    #[test]
    fn validation_failure_keeps_a_and_exact_proxy_binding() {
        let mut runtime = runtime("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
        let mut backend = FakeBackend::default();
        activate(&mut runtime, &mut backend, "A");
        let active = runtime.status().active.unwrap();
        runtime.proxy_generation = Some(ProxyGenerationView {
            generation_id: active.generation_id.clone(),
            pid: active.pid.unwrap(),
        });
        backend.proxy_enabled = true;
        backend.validate_failure = Some(BackendFailure::Failed);
        select(&mut runtime, "B", 2);
        assert_eq!(
            runtime.execute_latest(&mut backend),
            Err(ApplyFailure::ConfigValidationFailed)
        );
        assert!(runtime.status().proxy_ready);
    }

    #[test]
    fn readiness_failure_synchronously_stops_b_before_rolling_back_a() {
        let mut runtime = runtime("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
        let mut backend = FakeBackend::default();
        activate(&mut runtime, &mut backend, "A");
        select(&mut runtime, "B", 2);
        backend.listener_failure = Some(BackendFailure::Failed);
        assert_eq!(
            runtime.execute_latest(&mut backend),
            Err(ApplyFailure::ListenerReadinessFailed)
        );
        assert_eq!(backend.live.len(), 1);
        assert!(backend.live[0].starts_with("active:"));
        let stop = backend
            .events
            .iter()
            .position(|event| event.starts_with("stopCandidate:"))
            .unwrap();
        let exit = backend
            .events
            .iter()
            .rposition(|event| event.starts_with("confirmExit:candidate:"))
            .unwrap();
        let rollback = backend
            .events
            .iter()
            .position(|event| event.starts_with("rollback:"))
            .unwrap();
        assert!(stop < exit && exit < rollback);
    }

    #[test]
    fn cancellation_cleans_candidate_and_rolls_back_without_residue() {
        let mut runtime = runtime("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
        let mut backend = FakeBackend::default();
        activate(&mut runtime, &mut backend, "A");
        select(&mut runtime, "B", 2);
        backend.process_failure = Some(BackendFailure::Cancelled);
        assert_eq!(
            runtime.execute_latest(&mut backend),
            Err(ApplyFailure::Cancelled)
        );
        assert_eq!(backend.live.len(), 1);
        assert!(backend.live[0].starts_with("active:"));
    }

    #[test]
    fn candidate_cleanup_uncertainty_is_degraded_and_never_green() {
        let mut runtime = runtime("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
        let mut backend = FakeBackend::default();
        activate(&mut runtime, &mut backend, "A");
        select(&mut runtime, "B", 2);
        backend.listener_failure = Some(BackendFailure::Failed);
        backend.stop_candidate_fails = true;
        assert_eq!(
            runtime.execute_latest(&mut backend),
            Err(ApplyFailure::CandidateCleanupFailed)
        );
        let status = runtime.status();
        assert_eq!(status.phase, GenerationPhase::Degraded);
        assert_eq!(
            status.active.as_ref().map(|active| active.node_id.as_str()),
            Some("B")
        );
        assert_eq!(
            status
                .active
                .as_ref()
                .map(|active| active.readiness.clone()),
            Some(ReadinessLevel::Degraded)
        );
        assert!(status.proxy_generation.is_none());
        assert!(runtime.active_handle.is_some());
        assert!(backend
            .events
            .iter()
            .any(|event| event.starts_with("confirmExit:candidate:")));

        backend.stop_candidate_fails = false;
        backend.confirm_exit_fails = false;
        runtime.stop_active(&mut backend).unwrap();
        assert!(runtime.status().active.is_none());
        assert!(runtime.active_handle.is_none());
        assert!(backend.live.is_empty());
    }

    #[test]
    fn rollback_readiness_failure_stops_and_confirms_old_process_before_forgetting_it() {
        let mut runtime = runtime("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
        let mut backend = FakeBackend::default();
        activate(&mut runtime, &mut backend, "A");
        select(&mut runtime, "B", 2);
        backend.listener_failure = Some(BackendFailure::Failed);
        backend.rollback_readiness_fails = true;

        assert_eq!(
            runtime.execute_latest(&mut backend),
            Err(ApplyFailure::RollbackFailed)
        );
        assert!(runtime.status().active.is_none());
        assert!(runtime.active_handle.is_none());
        assert!(runtime.status().proxy_generation.is_none());
        assert!(backend.live.is_empty());
        assert!(backend.events.contains(&"rollbackStopped".to_string()));
        assert!(backend
            .events
            .contains(&"rollbackExitConfirmed".to_string()));
    }

    #[test]
    fn failed_rollback_cleanup_retains_handle_until_stop_reclaims_it() {
        let mut runtime = runtime("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
        let mut backend = FakeBackend::default();
        activate(&mut runtime, &mut backend, "A");
        select(&mut runtime, "B", 2);
        backend.listener_failure = Some(BackendFailure::Failed);
        backend.rollback_readiness_fails = true;
        backend.rollback_cleanup_fails = true;

        assert_eq!(
            runtime.execute_latest(&mut backend),
            Err(ApplyFailure::RollbackFailed)
        );
        let status = runtime.status();
        assert_eq!(status.phase, GenerationPhase::Degraded);
        assert_eq!(
            status.active.as_ref().map(|active| active.node_id.as_str()),
            Some("A")
        );
        assert_eq!(
            status
                .active
                .as_ref()
                .map(|active| active.readiness.clone()),
            Some(ReadinessLevel::Degraded)
        );
        assert!(status.proxy_generation.is_none());
        assert!(runtime.active_handle.is_some());
        assert_eq!(backend.live.len(), 1);

        backend.rollback_cleanup_fails = false;
        runtime.stop_active(&mut backend).unwrap();
        assert!(runtime.status().active.is_none());
        assert!(runtime.active_handle.is_none());
        assert!(backend.live.is_empty());
        assert!(generation_files(&runtime.store.root).is_empty());
    }

    #[test]
    fn stop_a_failure_never_restores_stale_proxy_binding() {
        let mut runtime = runtime("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
        let mut backend = FakeBackend::default();
        activate(&mut runtime, &mut backend, "A");
        let active = runtime.status().active.unwrap();
        runtime.proxy_generation = Some(ProxyGenerationView {
            generation_id: active.generation_id.clone(),
            pid: active.pid.unwrap(),
        });
        backend.proxy_enabled = true;
        backend.stop_active_fails = true;
        select(&mut runtime, "B", 2);
        assert_eq!(
            runtime.execute_latest(&mut backend),
            Err(ApplyFailure::ActiveStopFailed)
        );
        let status = runtime.status();
        assert_eq!(status.phase, GenerationPhase::Degraded);
        assert!(status.proxy_generation.is_none());
        assert!(!status.proxy_ready);
        assert!(backend
            .events
            .iter()
            .any(|event| event.starts_with("confirmExit:candidate:")));
    }

    #[test]
    fn proxy_restore_or_apply_readback_uncertainty_clears_binding_and_degrades() {
        let mut runtime = runtime("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
        let mut backend = FakeBackend::default();
        activate(&mut runtime, &mut backend, "A");
        backend.proxy_enabled = true;
        backend.restore_readback = ProxyReadback::Unknown;
        select(&mut runtime, "B", 2);
        assert_eq!(
            runtime.execute_latest(&mut backend),
            Err(ApplyFailure::ProxyRestoreFailed)
        );
        assert_eq!(runtime.status().phase, GenerationPhase::Degraded);
        assert!(runtime.status().proxy_generation.is_none());

        backend.restore_readback = ProxyReadback::Restored;
        backend.bind_readback = Some(ProxyReadback::Unknown);
        assert_eq!(
            runtime.execute_latest(&mut backend),
            Err(ApplyFailure::ProxyConfirmationFailed)
        );
        assert_eq!(runtime.status().phase, GenerationPhase::Degraded);
        assert!(runtime.status().proxy_generation.is_none());
    }

    #[test]
    fn proxy_binding_is_empty_or_exactly_matches_active_generation_and_pid() {
        let mut runtime = runtime("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
        let mut backend = FakeBackend {
            proxy_enabled: true,
            ..FakeBackend::default()
        };
        select(&mut runtime, "B", 2);
        let status = runtime.execute_latest(&mut backend).unwrap();
        let active = status.active.unwrap();
        let proxy = status.proxy_generation.unwrap();
        assert_eq!(proxy.generation_id, active.generation_id);
        assert_eq!(Some(proxy.pid), active.pid);
        assert!(status.proxy_ready);
    }

    #[test]
    fn active_lease_is_exclusive_private_and_dropped_with_replaced_generation() {
        let mut runtime = runtime("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
        let mut backend = FakeBackend::default();
        for index in 0..5 {
            select(&mut runtime, &format!("N{index}"), index);
            runtime.execute_latest(&mut backend).unwrap();
        }
        let files = generation_files(&runtime.store.root);
        assert_eq!(files.len(), 1);
        let generation_path = &files[0];
        #[cfg(windows)]
        {
            let audit = crate::windows_file_dacl_audit(generation_path).unwrap();
            assert!(audit.protected);
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(generation_path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
        let json = serde_json::to_string(&runtime.status()).unwrap();
        assert!(!json.contains("hidden-"));
        assert!(!json.contains("secret"));
    }

    #[test]
    fn stop_releases_active_lease_and_orphan_sweep_cleans_crash_residue() {
        let mut runtime = runtime("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
        let mut backend = FakeBackend::default();
        select(&mut runtime, "A", 1);
        runtime.execute_latest(&mut backend).unwrap();
        let active_path = runtime
            .active_handle
            .as_ref()
            .unwrap()
            .config_path()
            .to_path_buf();
        assert!(active_path.is_file());
        runtime.stop_active(&mut backend).unwrap();
        assert!(!active_path.exists());

        let orphan = runtime.store.root.join("generation-crash.json");
        write_atomic(&orphan, "{\"secret\":true}").unwrap();
        assert!(orphan.exists());
        runtime.store.sweep_orphans().unwrap();
        assert!(!orphan.exists());
    }

    #[test]
    fn orphan_sweep_refuses_a_second_live_instance_and_preserves_files() {
        let root = tempfile::tempdir().unwrap();
        let first = GenerationStore::new(root.path().to_path_buf());
        let orphan = root.path().join("generation-live-owner.json");
        fs::write(&orphan, "{}").unwrap();

        let second = GenerationStore::new(root.path().to_path_buf());
        assert_eq!(
            second.sweep_orphans().unwrap_err(),
            "generation-instance-lease-unavailable"
        );
        assert!(orphan.exists());

        drop(first);
        let third = GenerationStore::new(root.path().to_path_buf());
        third.sweep_orphans().unwrap();
        assert!(!orphan.exists());
    }

    #[test]
    fn failed_lease_delete_writes_private_path_free_journal_and_next_sweep_retries() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("generations");
        fs::create_dir_all(&root).unwrap();
        let generation = root.join("generation-secret-node.json");
        let journal = root.join(ORPHAN_JOURNAL_FILE);
        write_atomic(&generation, "{\"secret\":\"do-not-log\"}").unwrap();

        let recovery_marker = root.join(ORPHAN_RECOVERY_FAILURE_FILE);
        let recovery_failure = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        release_config_lease_path(
            &generation,
            &journal,
            &recovery_marker,
            &recovery_failure,
            None,
            |_| {
                Err(std::io::Error::new(
                    std::io::ErrorKind::PermissionDenied,
                    "injected delete failure",
                ))
            },
        );

        assert!(generation.exists());
        let marker = fs::read_to_string(&journal).unwrap();
        assert_eq!(marker, "{\"version\":1,\"pending\":true}\n");
        assert!(!marker.contains("secret-node"));
        assert!(!marker.contains("do-not-log"));
        #[cfg(windows)]
        {
            let audit = crate::windows_file_dacl_audit(&journal).unwrap();
            assert!(audit.protected);
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(&journal).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }

        let store = GenerationStore::new(root);
        store.sweep_orphans().unwrap();
        assert!(!generation.exists());
        assert!(!journal.exists());
    }

    #[test]
    fn orphan_journal_write_failure_sets_diagnostic_recovery_state_without_secret() {
        let temp = tempfile::tempdir().unwrap();
        let generation = temp.path().join("generation-secret.json");
        let missing_parent = temp.path().join("missing");
        let journal = missing_parent.join(ORPHAN_JOURNAL_FILE);
        let marker = missing_parent.join(ORPHAN_RECOVERY_FAILURE_FILE);
        let recovery_failure = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        write_atomic(&generation, "{\"secret\":\"hidden\"}").unwrap();
        fs::create_dir_all(&missing_parent).unwrap();
        fs::create_dir(&journal).unwrap();
        fs::create_dir(&marker).unwrap();
        release_config_lease_path(
            &generation,
            &journal,
            &marker,
            &recovery_failure,
            None,
            |_| {
                Err(std::io::Error::new(
                    std::io::ErrorKind::PermissionDenied,
                    "injected delete failure",
                ))
            },
        );
        assert!(recovery_failure.load(std::sync::atomic::Ordering::Acquire));
        assert!(journal.is_dir());
        assert!(marker.is_dir());
    }

    #[test]
    fn every_failed_initial_start_releases_its_config_lease() {
        let scenarios = ["validation", "start", "cancel", "readiness"];
        for scenario in scenarios {
            let mut runtime = runtime("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
            let mut backend = FakeBackend::default();
            select(&mut runtime, "A", 1);
            match scenario {
                "validation" => backend.validate_failure = Some(BackendFailure::Failed),
                "start" => backend.start_failure = Some(BackendFailure::Failed),
                "cancel" => backend.process_failure = Some(BackendFailure::Cancelled),
                "readiness" => backend.listener_failure = Some(BackendFailure::Failed),
                _ => unreachable!(),
            }
            assert!(runtime.execute_latest(&mut backend).is_err());
            let files = generation_files(&runtime.store.root);
            assert!(
                files.is_empty(),
                "{scenario} left an orphan generation config"
            );
            assert!(runtime.status().active.is_none());
            assert!(runtime.status().proxy_generation.is_none());
        }
    }
}
