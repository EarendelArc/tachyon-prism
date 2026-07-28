use serde::Serialize;
use sha2::{Digest, Sha256};

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
    pub generation_id: u64,
    pub config_sha256: String,
    pub node_id: String,
    pub routing_revision: u64,
    pub pid: Option<u32>,
    pub managed_listener_addresses: Vec<String>,
    pub readiness: ReadinessLevel,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProxyGenerationView {
    pub generation_id: u64,
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

struct DesiredRecord {
    view: GenerationView,
    config: Vec<u8>,
}

pub struct ApplyPlan {
    transaction_id: u64,
    desired: GenerationView,
    config: Vec<u8>,
    previous_active: Option<GenerationView>,
    previous_proxy: Option<ProxyGenerationView>,
    proxy_was_enabled: bool,
}

impl ApplyPlan {
    pub fn generation_id(&self) -> u64 {
        self.desired.generation_id
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

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ApplyFailure {
    Busy,
    NoDesired,
    StaleTransaction,
    ConfigValidationFailed,
    GenerationPersistFailed,
    ProxyRestoreFailed,
    CandidateStartFailed,
    ProcessReadinessFailed,
    ListenerReadinessFailed,
    RollbackFailed,
    ProxyConfirmationFailed,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BackendFailure {
    Failed,
}

pub trait ApplyBackend {
    fn validate_config(&mut self, plan: &ApplyPlan) -> Result<(), BackendFailure>;
    fn persist_generation(&mut self, plan: &ApplyPlan) -> Result<(), BackendFailure>;
    fn proxy_enabled(&self) -> bool;
    fn restore_proxy_snapshot(&mut self) -> Result<(), BackendFailure>;
    fn stop_active(&mut self, active: &GenerationView) -> Result<(), BackendFailure>;
    fn start_candidate(&mut self, plan: &ApplyPlan) -> Result<u32, BackendFailure>;
    fn confirm_process_identity(
        &mut self,
        generation_id: u64,
        pid: u32,
    ) -> Result<(), BackendFailure>;
    fn confirm_listener_readiness(
        &mut self,
        generation_id: u64,
        pid: u32,
        listeners: &[String],
    ) -> Result<(), BackendFailure>;
    fn rollback(&mut self, active: &GenerationView) -> Result<u32, BackendFailure>;
    fn bind_proxy(&mut self, generation_id: u64, pid: u32) -> Result<(), BackendFailure>;
}

#[derive(Default)]
pub struct GenerationRuntime {
    next_generation_id: u64,
    next_transaction_id: u64,
    desired: Option<DesiredRecord>,
    active: Option<GenerationView>,
    proxy_generation: Option<ProxyGenerationView>,
    phase: Option<GenerationPhase>,
    in_flight_transaction: Option<u64>,
    last_error_code: Option<String>,
}

impl GenerationRuntime {
    pub fn select_desired(
        &mut self,
        config: &[u8],
        node_id: String,
        routing_revision: u64,
        managed_listener_addresses: Vec<String>,
    ) -> u64 {
        self.next_generation_id = self.next_generation_id.saturating_add(1).max(1);
        let generation_id = self.next_generation_id;
        self.desired = Some(DesiredRecord {
            view: GenerationView {
                generation_id,
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
            self.phase = Some(GenerationPhase::PendingApply);
        }
        generation_id
    }

    pub fn restore_desired_after_restart(
        &mut self,
        config: &[u8],
        node_id: String,
        routing_revision: u64,
        managed_listener_addresses: Vec<String>,
    ) -> u64 {
        self.active = None;
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
        let proxy_ready = match (&active, &self.proxy_generation) {
            (Some(active), Some(proxy)) => {
                active.readiness == ReadinessLevel::ListenerReady
                    && active.generation_id == proxy.generation_id
                    && active.pid == Some(proxy.pid)
            }
            _ => false,
        };
        GenerationStatus {
            desired: self.desired.as_ref().map(|desired| desired.view.clone()),
            active,
            proxy_generation: self.proxy_generation.clone(),
            phase: self.phase.clone().unwrap_or(GenerationPhase::Idle),
            proxy_ready,
            last_error_code: self.last_error_code.clone(),
        }
    }

    pub fn begin_apply(&mut self, proxy_was_enabled: bool) -> Result<ApplyPlan, ApplyFailure> {
        if self.in_flight_transaction.is_some() {
            return Err(ApplyFailure::Busy);
        }
        let desired = self.desired.as_ref().ok_or(ApplyFailure::NoDesired)?;
        self.next_transaction_id = self.next_transaction_id.saturating_add(1).max(1);
        let transaction_id = self.next_transaction_id;
        self.in_flight_transaction = Some(transaction_id);
        self.phase = Some(GenerationPhase::Switching);
        self.last_error_code = None;
        Ok(ApplyPlan {
            transaction_id,
            desired: desired.view.clone(),
            config: desired.config.clone(),
            previous_active: self.active.clone(),
            previous_proxy: self.proxy_generation.clone(),
            proxy_was_enabled,
        })
    }

    pub fn execute_latest<B: ApplyBackend>(
        &mut self,
        backend: &mut B,
    ) -> Result<GenerationStatus, ApplyFailure> {
        let plan = self.begin_apply(backend.proxy_enabled())?;
        if backend.validate_config(&plan).is_err() {
            return self.finish_before_switch_failure(&plan, ApplyFailure::ConfigValidationFailed);
        }
        if backend.persist_generation(&plan).is_err() {
            return self.finish_before_switch_failure(&plan, ApplyFailure::GenerationPersistFailed);
        }
        if plan.proxy_was_enabled && backend.restore_proxy_snapshot().is_err() {
            return self.finish_before_switch_failure(&plan, ApplyFailure::ProxyRestoreFailed);
        }
        if let Some(active) = &plan.previous_active {
            if backend.stop_active(active).is_err() {
                return self
                    .finish_before_switch_failure(&plan, ApplyFailure::CandidateStartFailed);
            }
        }
        let pid = match backend.start_candidate(&plan) {
            Ok(pid) => pid,
            Err(_) => {
                return self.finish_after_switch_failure(
                    &plan,
                    backend,
                    ApplyFailure::CandidateStartFailed,
                )
            }
        };
        if backend
            .confirm_process_identity(plan.generation_id(), pid)
            .is_err()
        {
            return self.finish_after_switch_failure(
                &plan,
                backend,
                ApplyFailure::ProcessReadinessFailed,
            );
        }
        if backend
            .confirm_listener_readiness(
                plan.generation_id(),
                pid,
                plan.managed_listener_addresses(),
            )
            .is_err()
        {
            return self.finish_after_switch_failure(
                &plan,
                backend,
                ApplyFailure::ListenerReadinessFailed,
            );
        }
        let proxy_binding = if plan.proxy_was_enabled {
            if backend
                .confirm_process_identity(plan.generation_id(), pid)
                .is_err()
                || backend.bind_proxy(plan.generation_id(), pid).is_err()
            {
                None
            } else {
                Some(ProxyGenerationView {
                    generation_id: plan.generation_id(),
                    pid,
                })
            }
        } else {
            None
        };
        self.finish_success(&plan, pid, proxy_binding)
    }

    pub fn finish_success(
        &mut self,
        plan: &ApplyPlan,
        pid: u32,
        proxy_binding: Option<ProxyGenerationView>,
    ) -> Result<GenerationStatus, ApplyFailure> {
        self.require_current(plan)?;
        let mut active = plan.desired.clone();
        active.pid = Some(pid);
        active.readiness = ReadinessLevel::ListenerReady;
        self.active = Some(active);
        self.in_flight_transaction = None;
        self.proxy_generation = proxy_binding;
        if plan.proxy_was_enabled && !self.status().proxy_ready {
            self.phase = Some(GenerationPhase::Degraded);
            self.last_error_code = Some("proxyConfirmationFailed".to_string());
            return Err(ApplyFailure::ProxyConfirmationFailed);
        }
        self.phase = Some(
            if self.desired_generation_id() == Some(plan.generation_id()) {
                GenerationPhase::Idle
            } else {
                GenerationPhase::PendingApply
            },
        );
        self.last_error_code = None;
        Ok(self.status())
    }

    fn finish_before_switch_failure(
        &mut self,
        plan: &ApplyPlan,
        failure: ApplyFailure,
    ) -> Result<GenerationStatus, ApplyFailure> {
        self.require_current(plan)?;
        self.in_flight_transaction = None;
        self.active = plan.previous_active.clone();
        self.proxy_generation = plan.previous_proxy.clone();
        self.phase = Some(GenerationPhase::PendingApply);
        self.last_error_code = Some(failure_code(failure).to_string());
        Err(failure)
    }

    fn finish_after_switch_failure<B: ApplyBackend>(
        &mut self,
        plan: &ApplyPlan,
        backend: &mut B,
        failure: ApplyFailure,
    ) -> Result<GenerationStatus, ApplyFailure> {
        if self.require_current(plan).is_err() {
            return Err(ApplyFailure::StaleTransaction);
        }
        self.phase = Some(GenerationPhase::RollingBack);
        self.proxy_generation = None;
        if let Some(previous) = &plan.previous_active {
            match backend.rollback(previous) {
                Ok(pid) => {
                    let mut active = previous.clone();
                    active.pid = Some(pid);
                    active.readiness = ReadinessLevel::ListenerReady;
                    self.active = Some(active);
                    self.in_flight_transaction = None;
                    self.phase = Some(GenerationPhase::PendingApply);
                    self.last_error_code = Some(failure_code(failure).to_string());
                    Err(failure)
                }
                Err(_) => {
                    self.active = None;
                    self.in_flight_transaction = None;
                    self.phase = Some(GenerationPhase::Degraded);
                    self.last_error_code = Some("rollbackFailed".to_string());
                    Err(ApplyFailure::RollbackFailed)
                }
            }
        } else {
            self.active = None;
            self.in_flight_transaction = None;
            self.phase = Some(GenerationPhase::Degraded);
            self.last_error_code = Some(failure_code(failure).to_string());
            Err(failure)
        }
    }

    fn require_current(&self, plan: &ApplyPlan) -> Result<(), ApplyFailure> {
        if self.in_flight_transaction == Some(plan.transaction_id) {
            Ok(())
        } else {
            Err(ApplyFailure::StaleTransaction)
        }
    }

    fn desired_generation_id(&self) -> Option<u64> {
        self.desired
            .as_ref()
            .map(|desired| desired.view.generation_id)
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
        ApplyFailure::StaleTransaction => "staleTransaction",
        ApplyFailure::ConfigValidationFailed => "configValidationFailed",
        ApplyFailure::GenerationPersistFailed => "generationPersistFailed",
        ApplyFailure::ProxyRestoreFailed => "proxyRestoreFailed",
        ApplyFailure::CandidateStartFailed => "candidateStartFailed",
        ApplyFailure::ProcessReadinessFailed => "processReadinessFailed",
        ApplyFailure::ListenerReadinessFailed => "listenerReadinessFailed",
        ApplyFailure::RollbackFailed => "rollbackFailed",
        ApplyFailure::ProxyConfirmationFailed => "proxyConfirmationFailed",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    struct FakeBackend {
        root: TempDir,
        events: Vec<String>,
        proxy_enabled: bool,
        validate_fails: bool,
        persist_fails: bool,
        start_fails: bool,
        process_fails: bool,
        listener_fails: bool,
        rollback_fails: bool,
        bind_fails: bool,
        next_pid: u32,
    }

    impl Default for FakeBackend {
        fn default() -> Self {
            Self {
                root: tempfile::tempdir().unwrap(),
                events: Vec::new(),
                proxy_enabled: false,
                validate_fails: false,
                persist_fails: false,
                start_fails: false,
                process_fails: false,
                listener_fails: false,
                rollback_fails: false,
                bind_fails: false,
                next_pid: 4000,
            }
        }
    }

    impl ApplyBackend for FakeBackend {
        fn validate_config(&mut self, plan: &ApplyPlan) -> Result<(), BackendFailure> {
            self.events
                .push(format!("validate:{}", plan.generation_id()));
            if self.validate_fails {
                Err(BackendFailure::Failed)
            } else {
                Ok(())
            }
        }

        fn persist_generation(&mut self, plan: &ApplyPlan) -> Result<(), BackendFailure> {
            self.events
                .push(format!("persist:{}", plan.generation_id()));
            if self.persist_fails {
                return Err(BackendFailure::Failed);
            }
            fs::write(
                self.root
                    .path()
                    .join(format!("generation-{}.json", plan.generation_id())),
                plan.config(),
            )
            .map_err(|_| BackendFailure::Failed)
        }

        fn proxy_enabled(&self) -> bool {
            self.proxy_enabled
        }
        fn restore_proxy_snapshot(&mut self) -> Result<(), BackendFailure> {
            self.events.push("restoreProxy".to_string());
            Ok(())
        }
        fn stop_active(&mut self, active: &GenerationView) -> Result<(), BackendFailure> {
            self.events.push(format!("stop:{}", active.generation_id));
            Ok(())
        }
        fn start_candidate(&mut self, plan: &ApplyPlan) -> Result<u32, BackendFailure> {
            self.events.push(format!("start:{}", plan.generation_id()));
            if self.start_fails {
                Err(BackendFailure::Failed)
            } else {
                self.next_pid += 1;
                Ok(self.next_pid)
            }
        }
        fn confirm_process_identity(
            &mut self,
            generation_id: u64,
            pid: u32,
        ) -> Result<(), BackendFailure> {
            self.events.push(format!("process:{generation_id}:{pid}"));
            if self.process_fails {
                Err(BackendFailure::Failed)
            } else {
                Ok(())
            }
        }
        fn confirm_listener_readiness(
            &mut self,
            generation_id: u64,
            pid: u32,
            _listeners: &[String],
        ) -> Result<(), BackendFailure> {
            self.events.push(format!("listeners:{generation_id}:{pid}"));
            if self.listener_fails {
                Err(BackendFailure::Failed)
            } else {
                Ok(())
            }
        }
        fn rollback(&mut self, active: &GenerationView) -> Result<u32, BackendFailure> {
            self.events
                .push(format!("rollback:{}", active.generation_id));
            if self.rollback_fails {
                Err(BackendFailure::Failed)
            } else {
                self.next_pid += 1;
                Ok(self.next_pid)
            }
        }
        fn bind_proxy(&mut self, generation_id: u64, pid: u32) -> Result<(), BackendFailure> {
            self.events.push(format!("bindProxy:{generation_id}:{pid}"));
            if self.bind_fails {
                Err(BackendFailure::Failed)
            } else {
                Ok(())
            }
        }
    }

    fn select(runtime: &mut GenerationRuntime, node: &str, revision: u64) -> u64 {
        runtime.select_desired(
            format!(r#"{{"node":"{node}","secret":"hidden-{node}"}}"#).as_bytes(),
            node.to_string(),
            revision,
            vec!["127.0.0.1:10808".to_string(), "127.0.0.1:10809".to_string()],
        )
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
    fn stopped_selection_updates_desired_without_inventing_active() {
        let mut runtime = GenerationRuntime::default();
        let id = select(&mut runtime, "B", 7);
        let status = runtime.status();
        assert_eq!(status.desired.unwrap().generation_id, id);
        assert!(status.active.is_none());
        assert_eq!(status.phase, GenerationPhase::PendingApply);
    }

    #[test]
    fn running_a_to_b_applies_atomically_and_rebinds_proxy_after_confirmation() {
        let mut runtime = GenerationRuntime::default();
        let mut backend = FakeBackend::default();
        let a = activate(&mut runtime, &mut backend, "A");
        let a_id = a.active.unwrap().generation_id;
        backend.proxy_enabled = true;
        select(&mut runtime, "B", 2);
        let status = runtime.execute_latest(&mut backend).unwrap();
        let active = status.active.unwrap();
        assert_ne!(active.generation_id, a_id);
        assert_eq!(active.node_id, "B");
        assert_eq!(active.readiness, ReadinessLevel::ListenerReady);
        assert!(status.proxy_ready);
        let restore = backend
            .events
            .iter()
            .rposition(|event| event == "restoreProxy")
            .unwrap();
        let stop = backend
            .events
            .iter()
            .rposition(|event| event == &format!("stop:{a_id}"))
            .unwrap();
        let bind = backend
            .events
            .iter()
            .rposition(|event| event.starts_with("bindProxy:"))
            .unwrap();
        assert!(restore < stop && stop < bind);
    }

    #[test]
    fn validation_failure_does_not_stop_active_a() {
        let mut runtime = GenerationRuntime::default();
        let mut backend = FakeBackend::default();
        let a_id = activate(&mut runtime, &mut backend, "A")
            .active
            .unwrap()
            .generation_id;
        select(&mut runtime, "B", 2);
        backend.validate_fails = true;
        assert_eq!(
            runtime.execute_latest(&mut backend),
            Err(ApplyFailure::ConfigValidationFailed)
        );
        let status = runtime.status();
        assert_eq!(status.active.unwrap().generation_id, a_id);
        assert!(!backend
            .events
            .iter()
            .any(|event| event == &format!("stop:{a_id}")));
    }

    #[test]
    fn start_failure_rolls_back_a_and_keeps_proxy_restored() {
        let mut runtime = GenerationRuntime::default();
        let mut backend = FakeBackend::default();
        let a_id = activate(&mut runtime, &mut backend, "A")
            .active
            .unwrap()
            .generation_id;
        select(&mut runtime, "B", 2);
        backend.proxy_enabled = true;
        backend.start_fails = true;
        assert_eq!(
            runtime.execute_latest(&mut backend),
            Err(ApplyFailure::CandidateStartFailed)
        );
        let status = runtime.status();
        assert_eq!(status.active.unwrap().generation_id, a_id);
        assert!(status.proxy_generation.is_none());
        assert!(!status.proxy_ready);
        assert_eq!(status.phase, GenerationPhase::PendingApply);
    }

    #[test]
    fn rollback_failure_enters_degraded_without_green_state() {
        let mut runtime = GenerationRuntime::default();
        let mut backend = FakeBackend::default();
        activate(&mut runtime, &mut backend, "A");
        select(&mut runtime, "B", 2);
        backend.start_fails = true;
        backend.rollback_fails = true;
        assert_eq!(
            runtime.execute_latest(&mut backend),
            Err(ApplyFailure::RollbackFailed)
        );
        let status = runtime.status();
        assert_eq!(status.phase, GenerationPhase::Degraded);
        assert!(status.active.is_none());
        assert!(!status.proxy_ready);
    }

    #[test]
    fn late_b_completion_cannot_replace_newer_desired_c() {
        let mut runtime = GenerationRuntime::default();
        select(&mut runtime, "B", 2);
        let plan_b = runtime.begin_apply(false).unwrap();
        select(&mut runtime, "C", 3);
        let status = runtime.finish_success(&plan_b, 5001, None).unwrap();
        assert_eq!(status.active.unwrap().node_id, "B");
        assert_eq!(status.desired.unwrap().node_id, "C");
        assert_eq!(status.phase, GenerationPhase::PendingApply);
        assert_eq!(
            runtime.finish_success(&plan_b, 5001, None),
            Err(ApplyFailure::StaleTransaction)
        );
    }

    #[test]
    fn restart_never_promotes_desired_to_active() {
        let mut runtime = GenerationRuntime::default();
        runtime.restore_desired_after_restart(b"{\"node\":\"B\"}", "B".to_string(), 4, vec![]);
        let status = runtime.status();
        assert_eq!(status.desired.unwrap().node_id, "B");
        assert!(status.active.is_none());
        assert!(!status.proxy_ready);
    }

    #[test]
    fn proxy_generation_mismatch_is_degraded_and_never_ready() {
        let mut runtime = GenerationRuntime::default();
        select(&mut runtime, "B", 2);
        let plan = runtime.begin_apply(true).unwrap();
        let wrong = ProxyGenerationView {
            generation_id: plan.generation_id() + 1,
            pid: 5002,
        };
        assert_eq!(
            runtime.finish_success(&plan, 5001, Some(wrong)),
            Err(ApplyFailure::ProxyConfirmationFailed)
        );
        let status = runtime.status();
        assert_eq!(status.phase, GenerationPhase::Degraded);
        assert!(!status.proxy_ready);
    }

    #[test]
    fn serialized_status_never_contains_config_or_secret() {
        let mut runtime = GenerationRuntime::default();
        select(&mut runtime, "node-safe-id", 9);
        let json = serde_json::to_string(&runtime.status()).unwrap();
        assert!(json.contains("node-safe-id"));
        assert!(json.contains("configSha256"));
        assert!(!json.contains("hidden-node-safe-id"));
        assert!(!json.contains("secret"));
        assert!(!json.contains("outbounds"));
    }
}
