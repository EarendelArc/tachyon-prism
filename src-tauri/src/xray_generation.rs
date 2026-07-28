use crate::write_atomic;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs;
use std::path::{Path, PathBuf};

const CLOCK_VERSION: u32 = 1;
const RETAINED_GENERATIONS: usize = 3;

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
    Degraded,
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
pub struct CandidateHandle {
    pub pid: u32,
    pub runner_token: String,
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

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BackendFailure {
    Failed,
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
    CandidateCleanupFailed,
    RollbackFailed,
    ProxyConfirmationFailed,
    Cancelled,
}

pub trait ApplyBackend {
    fn validate_config(&mut self, plan: &ApplyPlan) -> Result<(), BackendFailure>;
    fn persist_generation(&mut self, plan: &ApplyPlan) -> Result<(), BackendFailure>;
    fn capture_proxy_snapshot(&mut self) -> Result<Option<ProxySnapshotHandle>, BackendFailure>;
    fn restore_proxy_snapshot(
        &mut self,
        snapshot: &ProxySnapshotHandle,
    ) -> Result<ProxyReadback, BackendFailure>;
    fn stop_active(&mut self, active: &CandidateHandle) -> Result<(), BackendFailure>;
    fn confirm_exit(&mut self, handle: &CandidateHandle) -> Result<(), BackendFailure>;
    fn start_candidate(&mut self, plan: &ApplyPlan) -> Result<CandidateHandle, BackendFailure>;
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
    fn rollback(
        &mut self,
        active: &GenerationView,
        previous_handle: &CandidateHandle,
    ) -> Result<CandidateHandle, BackendFailure>;
    fn bind_proxy(
        &mut self,
        generation_id: &GenerationId,
        handle: &CandidateHandle,
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

    pub fn config_sha256(&self) -> &str {
        &self.desired.config_sha256
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
    pub fn with_persistent_clock(path: PathBuf) -> Result<Self, String> {
        Ok(Self {
            clock: GenerationClock::open(path)?,
            ..Self::default()
        })
    }

    pub fn select_desired(
        &mut self,
        config: &[u8],
        node_id: String,
        routing_revision: String,
        managed_listener_addresses: Vec<String>,
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
                readiness: ReadinessLevel::Desired,
            },
            config: config.to_vec(),
        });
        if self.in_flight_transaction.is_none() {
            self.phase = GenerationPhase::PendingApply;
        }
        Ok(generation_id)
    }

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
        let active = self.active.clone();
        let proxy_ready = matches!(
            (&active, &self.active_handle, &self.proxy_generation),
            (Some(active), Some(handle), Some(proxy))
                if active.readiness == ReadinessLevel::ListenerReady
                    && active.generation_id == proxy.generation_id
                    && active.pid == Some(proxy.pid)
                    && handle.pid == proxy.pid
        );
        GenerationStatus {
            desired: self.desired.as_ref().map(|desired| desired.view.clone()),
            active,
            proxy_generation: self.proxy_generation.clone(),
            phase: self.phase.clone(),
            proxy_ready,
            last_error_code: self.last_error_code.clone(),
        }
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
            previous_active: self.active.clone(),
            previous_handle: self.active_handle.clone(),
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
            Err(_) => return self.finish_proxy_uncertain(&plan, ApplyFailure::ProxyRestoreFailed),
        };
        if backend.validate_config(&plan).is_err() {
            return self.finish_before_proxy_change(&plan, ApplyFailure::ConfigValidationFailed);
        }
        self.set_desired_readiness(&plan, ReadinessLevel::ConfigValidated)?;
        if backend.persist_generation(&plan).is_err() {
            return self.finish_before_proxy_change(&plan, ApplyFailure::GenerationPersistFailed);
        }
        if let Some(snapshot) = &plan.proxy_snapshot {
            match backend.restore_proxy_snapshot(snapshot) {
                Ok(ProxyReadback::Restored) => self.proxy_generation = None,
                _ => return self.finish_proxy_uncertain(&plan, ApplyFailure::ProxyRestoreFailed),
            }
        }
        if let Some(active_handle) = &plan.previous_handle {
            let stop_result = backend.stop_active(active_handle);
            let exit_result = backend.confirm_exit(active_handle);
            if stop_result.is_err() || exit_result.is_err() {
                return self.finish_proxy_uncertain(&plan, ApplyFailure::ActiveStopFailed);
            }
        }
        self.active = None;
        self.active_handle = None;
        let candidate = match backend.start_candidate(&plan) {
            Ok(candidate) => candidate,
            Err(BackendFailure::Cancelled) => {
                return self.rollback_previous(&plan, backend, ApplyFailure::Cancelled, false)
            }
            Err(BackendFailure::Failed) => {
                return self.rollback_previous(
                    &plan,
                    backend,
                    ApplyFailure::CandidateStartFailed,
                    false,
                )
            }
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
            return self.cleanup_candidate_and_rollback(&plan, backend, &candidate, failure, false);
        }
        let proxy_binding = if plan.proxy_snapshot.is_some() {
            match backend.bind_proxy(plan.generation_id(), &candidate) {
                Ok(ProxyReadback::Bound(binding))
                    if binding.generation_id == *plan.generation_id()
                        && binding.pid == candidate.pid =>
                {
                    Some(binding)
                }
                _ => {
                    return self.cleanup_candidate_and_rollback(
                        &plan,
                        backend,
                        &candidate,
                        ApplyFailure::ProxyConfirmationFailed,
                        true,
                    )
                }
            }
        } else {
            None
        };
        self.finish_success(&plan, candidate, proxy_binding)
    }

    fn cleanup_candidate_and_rollback<B: ApplyBackend>(
        &mut self,
        plan: &ApplyPlan,
        backend: &mut B,
        candidate: &CandidateHandle,
        failure: ApplyFailure,
        proxy_uncertain: bool,
    ) -> Result<GenerationStatus, ApplyFailure> {
        let stop_result = backend.stop_candidate(candidate);
        let exit_result = backend.confirm_exit(candidate);
        if stop_result.is_err() || exit_result.is_err() {
            return self.finish_degraded(plan, ApplyFailure::CandidateCleanupFailed);
        }
        self.rollback_previous(plan, backend, failure, proxy_uncertain)
    }

    fn rollback_previous<B: ApplyBackend>(
        &mut self,
        plan: &ApplyPlan,
        backend: &mut B,
        failure: ApplyFailure,
        proxy_uncertain: bool,
    ) -> Result<GenerationStatus, ApplyFailure> {
        self.require_current(plan)?;
        self.phase = GenerationPhase::RollingBack;
        self.proxy_generation = None;
        match (&plan.previous_active, &plan.previous_handle) {
            (Some(previous), Some(previous_handle)) => {
                match backend.rollback(previous, previous_handle) {
                    Ok(handle) => {
                        let mut active = previous.clone();
                        active.pid = Some(handle.pid);
                        active.readiness = if proxy_uncertain {
                            ReadinessLevel::Degraded
                        } else {
                            ReadinessLevel::ListenerReady
                        };
                        self.active = Some(active);
                        self.active_handle = Some(handle);
                        self.in_flight_transaction = None;
                        self.phase = if proxy_uncertain {
                            GenerationPhase::Degraded
                        } else {
                            GenerationPhase::PendingApply
                        };
                        self.last_error_code = Some(failure_code(failure).to_string());
                        Err(failure)
                    }
                    Err(_) => self.finish_degraded(plan, ApplyFailure::RollbackFailed),
                }
            }
            _ => self.finish_degraded(plan, failure),
        }
    }

    fn finish_success(
        &mut self,
        plan: &ApplyPlan,
        candidate: CandidateHandle,
        proxy_binding: Option<ProxyGenerationView>,
    ) -> Result<GenerationStatus, ApplyFailure> {
        self.require_current(plan)?;
        let mut active = plan.desired.clone();
        active.pid = Some(candidate.pid);
        active.readiness = ReadinessLevel::ListenerReady;
        let active_pid = active.pid;
        self.active = Some(active);
        self.active_handle = Some(candidate);
        self.proxy_generation = proxy_binding;
        if let Some(desired) = self.desired.as_mut() {
            if desired.view.generation_id == *plan.generation_id() {
                desired.view.pid = active_pid;
                desired.view.readiness = ReadinessLevel::ListenerReady;
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
        plan: &ApplyPlan,
        failure: ApplyFailure,
    ) -> Result<GenerationStatus, ApplyFailure> {
        self.require_current(plan)?;
        self.in_flight_transaction = None;
        self.active = plan.previous_active.clone();
        self.active_handle = plan.previous_handle.clone();
        self.proxy_generation = plan.previous_proxy.clone();
        self.phase = GenerationPhase::PendingApply;
        self.last_error_code = Some(failure_code(failure).to_string());
        Err(failure)
    }

    fn finish_proxy_uncertain(
        &mut self,
        plan: &ApplyPlan,
        failure: ApplyFailure,
    ) -> Result<GenerationStatus, ApplyFailure> {
        self.require_current(plan)?;
        self.proxy_generation = None;
        self.in_flight_transaction = None;
        self.active = plan.previous_active.clone().map(|mut active| {
            active.readiness = ReadinessLevel::Degraded;
            active
        });
        self.active_handle = plan.previous_handle.clone();
        self.phase = GenerationPhase::Degraded;
        self.last_error_code = Some(failure_code(failure).to_string());
        Err(failure)
    }

    fn finish_degraded(
        &mut self,
        plan: &ApplyPlan,
        failure: ApplyFailure,
    ) -> Result<GenerationStatus, ApplyFailure> {
        self.require_current(plan)?;
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
}

impl GenerationStore {
    pub fn new(root: PathBuf) -> Self {
        Self {
            root,
            retained: RETAINED_GENERATIONS,
        }
    }

    pub fn persist(&self, plan: &ApplyPlan) -> Result<PathBuf, String> {
        fs::create_dir_all(&self.root).map_err(|_| "generation-dir-create-failed".to_string())?;
        let path = self
            .root
            .join(format!("generation-{}.json", plan.generation_id().as_str()));
        let config = std::str::from_utf8(plan.config())
            .map_err(|_| "generation-config-not-utf8".to_string())?;
        write_atomic(&path, config).map_err(|_| "generation-config-write-failed".to_string())?;
        self.cleanup_stale(&path)?;
        Ok(path)
    }

    fn cleanup_stale(&self, current: &Path) -> Result<(), String> {
        let mut files = fs::read_dir(&self.root)
            .map_err(|_| "generation-dir-read-failed".to_string())?
            .filter_map(Result::ok)
            .map(|entry| entry.path())
            .filter(|path| {
                path.extension().and_then(|value| value.to_str()) == Some("json")
                    && path
                        .file_name()
                        .and_then(|value| value.to_str())
                        .is_some_and(|name| name.starts_with("generation-"))
            })
            .collect::<Vec<_>>();
        files.retain(|path| path != current);
        files.sort_by_key(|path| {
            (
                fs::metadata(path)
                    .and_then(|metadata| metadata.modified())
                    .ok(),
                path.clone(),
            )
        });
        let keep = self.retained.max(1);
        let remove_count = files.len().saturating_sub(keep - 1);
        for path in files.into_iter().take(remove_count) {
            fs::remove_file(path).map_err(|_| "generation-stale-cleanup-failed".to_string())?;
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
        ApplyFailure::CandidateCleanupFailed => "candidateCleanupFailed",
        ApplyFailure::RollbackFailed => "rollbackFailed",
        ApplyFailure::ProxyConfirmationFailed => "proxyConfirmationFailed",
        ApplyFailure::Cancelled => "applyCancelled",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    struct FakeBackend {
        root: TempDir,
        events: Vec<String>,
        live: Vec<String>,
        proxy_enabled: bool,
        restore_readback: ProxyReadback,
        bind_readback: Option<ProxyReadback>,
        validate_failure: Option<BackendFailure>,
        start_failure: Option<BackendFailure>,
        process_failure: Option<BackendFailure>,
        listener_failure: Option<BackendFailure>,
        stop_active_fails: bool,
        stop_candidate_fails: bool,
        confirm_exit_fails: bool,
        rollback_fails: bool,
        next_pid: u32,
    }

    impl Default for FakeBackend {
        fn default() -> Self {
            Self {
                root: tempfile::tempdir().unwrap(),
                events: vec![],
                live: vec![],
                proxy_enabled: false,
                restore_readback: ProxyReadback::Restored,
                bind_readback: None,
                validate_failure: None,
                start_failure: None,
                process_failure: None,
                listener_failure: None,
                stop_active_fails: false,
                stop_candidate_fails: false,
                confirm_exit_fails: false,
                rollback_fails: false,
                next_pid: 4000,
            }
        }
    }

    impl FakeBackend {
        fn handle(&mut self, token: String) -> CandidateHandle {
            self.next_pid += 1;
            self.live.push(token.clone());
            CandidateHandle {
                pid: self.next_pid,
                runner_token: token,
            }
        }
    }

    impl ApplyBackend for FakeBackend {
        fn validate_config(&mut self, plan: &ApplyPlan) -> Result<(), BackendFailure> {
            self.events
                .push(format!("validate:{}", plan.generation_id().as_str()));
            self.validate_failure.take().map_or(Ok(()), Err)
        }

        fn persist_generation(&mut self, plan: &ApplyPlan) -> Result<(), BackendFailure> {
            self.events
                .push(format!("persist:{}", plan.config_sha256()));
            GenerationStore::new(self.root.path().join("generations"))
                .persist(plan)
                .map(|_| ())
                .map_err(|_| BackendFailure::Failed)
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
                .push(format!("stopActive:{}", active.runner_token));
            if self.stop_active_fails {
                Err(BackendFailure::Failed)
            } else {
                self.live.retain(|token| token != &active.runner_token);
                Ok(())
            }
        }

        fn confirm_exit(&mut self, handle: &CandidateHandle) -> Result<(), BackendFailure> {
            self.events
                .push(format!("confirmExit:{}", handle.runner_token));
            if self.confirm_exit_fails || self.live.contains(&handle.runner_token) {
                Err(BackendFailure::Failed)
            } else {
                Ok(())
            }
        }

        fn start_candidate(&mut self, plan: &ApplyPlan) -> Result<CandidateHandle, BackendFailure> {
            self.events
                .push(format!("start:{}", plan.generation_id().as_str()));
            if let Some(failure) = self.start_failure.take() {
                Err(failure)
            } else {
                Ok(self.handle(format!("candidate:{}", plan.generation_id().as_str())))
            }
        }

        fn stop_candidate(&mut self, handle: &CandidateHandle) -> Result<(), BackendFailure> {
            self.events
                .push(format!("stopCandidate:{}", handle.runner_token));
            if self.stop_candidate_fails {
                Err(BackendFailure::Failed)
            } else {
                self.live.retain(|token| token != &handle.runner_token);
                Ok(())
            }
        }

        fn confirm_process_identity(
            &mut self,
            _generation_id: &GenerationId,
            _handle: &CandidateHandle,
        ) -> Result<(), BackendFailure> {
            self.events.push("processReady".to_string());
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

        fn rollback(
            &mut self,
            active: &GenerationView,
            _previous_handle: &CandidateHandle,
        ) -> Result<CandidateHandle, BackendFailure> {
            self.events
                .push(format!("rollback:{}", active.generation_id.as_str()));
            if self.rollback_fails {
                Err(BackendFailure::Failed)
            } else {
                Ok(self.handle(format!("active:{}", active.generation_id.as_str())))
            }
        }

        fn bind_proxy(
            &mut self,
            generation_id: &GenerationId,
            handle: &CandidateHandle,
        ) -> Result<ProxyReadback, BackendFailure> {
            self.events.push("bindProxy".to_string());
            Ok(self.bind_readback.clone().unwrap_or_else(|| {
                ProxyReadback::Bound(ProxyGenerationView {
                    generation_id: generation_id.clone(),
                    pid: handle.pid,
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

    fn select(runtime: &mut GenerationRuntime, node: &str, revision: u64) -> GenerationId {
        runtime
            .select_desired(
                format!(r#"{{"node":"{node}","secret":"hidden-{node}"}}"#).as_bytes(),
                node.to_string(),
                revision.to_string(),
                vec!["127.0.0.1:10808".to_string()],
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
        assert!(status.active.is_none());
        assert!(status.proxy_generation.is_none());
        assert!(backend
            .events
            .iter()
            .any(|event| event.starts_with("confirmExit:candidate:")));
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
        let mut backend = FakeBackend::default();
        backend.proxy_enabled = true;
        select(&mut runtime, "B", 2);
        let status = runtime.execute_latest(&mut backend).unwrap();
        let active = status.active.unwrap();
        let proxy = status.proxy_generation.unwrap();
        assert_eq!(proxy.generation_id, active.generation_id);
        assert_eq!(Some(proxy.pid), active.pid);
        assert!(status.proxy_ready);
    }

    #[test]
    fn generation_store_keeps_only_recent_atomic_files_without_secret_status() {
        let mut runtime = runtime("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
        let mut backend = FakeBackend::default();
        for index in 0..5 {
            select(&mut runtime, &format!("N{index}"), index);
            runtime.execute_latest(&mut backend).unwrap();
        }
        let count = fs::read_dir(backend.root.path().join("generations"))
            .unwrap()
            .count();
        assert_eq!(count, RETAINED_GENERATIONS);
        let generation_path = fs::read_dir(backend.root.path().join("generations"))
            .unwrap()
            .next()
            .unwrap()
            .unwrap()
            .path();
        #[cfg(windows)]
        {
            let audit = crate::windows_file_dacl_audit(&generation_path).unwrap();
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
}
