use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::AtomicBool;
use std::time::{Duration, Instant};

use tauri::ipc::Channel;

use super::SidecarSupervisor;
use crate::errors::StudioReasonCode;
use crate::sidecar::artifact::{DISTRIBUTION_TEST_LOCK, verify_distribution};
use crate::sidecar::plan_protocol::{
    DeriveSelection, PlanEventEmitter, StudioBrandPlanStartRequest,
};
use crate::sidecar::process::TerminationFault;
use crate::sidecar::protocol::HostLifecycleState;
use crate::state::plan_coordinator::OperationControl;

fn fake_binary() -> Result<PathBuf, String> {
    let current = std::env::current_exe().map_err(|error| error.to_string())?;
    let debug = current
        .parent()
        .and_then(|directory| directory.parent())
        .ok_or_else(|| "test executable has no target/debug ancestor".to_owned())?;
    let binary = debug.join("tfsb-studio-fake-sidecar");
    if !binary.is_file() {
        return Err(format!("fake sidecar is unavailable: {}", binary.display()));
    }
    Ok(binary)
}

fn lifecycle_supervisor(mode: &'static str) -> Result<SidecarSupervisor, String> {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let binary = root.join("binaries/tfsb-studio-service-aarch64-apple-darwin");
    let payload = root.join("sidecar-payload");
    verify_distribution(&binary, &payload)
        .map_err(|error| format!("artifact verification failed: {error}"))?;
    let temp = root
        .join("target")
        .join(format!("tfsb-plan-lifecycle-{}-{mode}", std::process::id()));
    let mut supervisor = SidecarSupervisor::new(binary, payload, temp);
    supervisor.configure_test_sidecar(fake_binary()?, mode, Duration::from_millis(80));
    Ok(supervisor)
}

fn fake_plan_create(
    supervisor: &mut SidecarSupervisor,
    cancelled: bool,
) -> Result<crate::sidecar::plan_protocol::DecodedPlanResult, crate::errors::StudioCommandError> {
    let control = OperationControl {
        handle: format!("operation_{}", "a".repeat(64)),
        cancel: Arc::new(AtomicBool::new(cancelled)),
    };
    let mut events = PlanEventEmitter::new(Channel::new(|_| Ok(())), control.handle.clone(), false);
    events.started()?;
    supervisor.plan_create(
        &StudioBrandPlanStartRequest::CreateDerive {
            project_handle: "project_safe".to_owned(),
            selection: DeriveSelection::All,
        },
        &control,
        &mut events,
    )
}

fn reap_test_supervisor(supervisor: &mut SidecarSupervisor) {
    supervisor.test_termination_fault = None;
    if let Some(process) = supervisor.process.as_mut() {
        process.termination_fault = None;
    }
    let _ = supervisor.force_reap();
}

#[test]
fn plan_create_timeout_is_session_fatal_and_late_ready_cannot_survive() -> Result<(), String> {
    let _distribution = DISTRIBUTION_TEST_LOCK
        .lock()
        .map_err(|_| "distribution test lock".to_owned())?;
    for mode in ["lifecycle-plan-timeout-ready", "lifecycle-plan-never"] {
        let mut supervisor = lifecycle_supervisor(mode)?;
        supervisor
            .start(Channel::new(|_| Ok(())))
            .map_err(|error| {
                format!(
                    "{mode} did not initialize: {}",
                    serde_json::to_string(&error).unwrap_or_default()
                )
            })?;
        let started = Instant::now();
        let error = fake_plan_create(&mut supervisor, false)
            .err()
            .ok_or_else(|| format!("{mode} unexpectedly created a plan"))?;
        let public = serde_json::to_string(&error).map_err(|error| error.to_string())?;
        if error.reason_code() != StudioReasonCode::RequestTimeout
            || supervisor.process.is_some()
            || !matches!(supervisor.status().state, HostLifecycleState::Failed)
            || supervisor.status().last_reason_code != Some("sidecar-request-timeout")
            || public.contains("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")
            || public.contains("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
            || started.elapsed() > Duration::from_secs(3)
        {
            return Err(format!(
                "{mode} did not fail, reap, bound, and redact exactly"
            ));
        }
        let second = fake_plan_create(&mut supervisor, false)
            .err()
            .ok_or_else(|| "uncertain session admitted a second plan".to_owned())?;
        if second.reason_code() != StudioReasonCode::SidecarCrashed {
            return Err("uncertain session did not remain closed pending restart".to_owned());
        }

        supervisor.configure_test_sidecar(fake_binary()?, mode, Duration::from_millis(80));
        supervisor
            .start(Channel::new(|_| Ok(())))
            .map_err(|_| "explicit timeout-session restart failed".to_owned())?;
        let repeated = fake_plan_create(&mut supervisor, false)
            .err()
            .ok_or_else(|| "repeated create timeout unexpectedly succeeded".to_owned())?;
        if repeated.reason_code() != StudioReasonCode::RequestTimeout
            || supervisor.process.is_some()
        {
            return Err(
                "repeated create timeout was not independently killed and reaped".to_owned(),
            );
        }
    }
    Ok(())
}

#[test]
fn plan_termination_failure_retains_session_and_blocks_restart() -> Result<(), String> {
    let _distribution = DISTRIBUTION_TEST_LOCK
        .lock()
        .map_err(|_| "distribution test lock".to_owned())?;
    let mut supervisor = lifecycle_supervisor("lifecycle-plan-never")?;
    supervisor
        .start(Channel::new(|_| Ok(())))
        .map_err(|_| "plan sidecar did not initialize".to_owned())?;
    let Some(old_id) = supervisor
        .process
        .as_ref()
        .map(|process| process.child.id())
    else {
        return Err("plan setup did not retain its process".to_owned());
    };
    if let Some(process) = supervisor.process.as_mut() {
        process.termination_fault = Some(TerminationFault::UnreapedKillFailure);
    }
    let error = match fake_plan_create(&mut supervisor, false) {
        Ok(_) => {
            reap_test_supervisor(&mut supervisor);
            return Err("plan unexpectedly completed".to_owned());
        }
        Err(error) => error,
    };
    let status = supervisor.status();
    if error.reason_code() != StudioReasonCode::SidecarShutdownFailed
        || supervisor
            .process
            .as_ref()
            .map(|process| process.child.id())
            != Some(old_id)
        || !matches!(status.state, HostLifecycleState::Failed)
        || status.last_reason_code != Some("sidecar-shutdown-failed")
    {
        reap_test_supervisor(&mut supervisor);
        return Err("plan termination failure was not retained and published".to_owned());
    }
    let blocked = supervisor.start(Channel::new(|_| Ok(())));
    if !blocked
        .as_ref()
        .is_err_and(|error| error.reason_code() == StudioReasonCode::SidecarShutdownFailed)
        || supervisor
            .process
            .as_ref()
            .map(|process| process.child.id())
            != Some(old_id)
    {
        reap_test_supervisor(&mut supervisor);
        return Err("plan restart was admitted before bounded reap".to_owned());
    }
    supervisor.test_termination_fault = None;
    if let Some(process) = supervisor.process.as_mut() {
        process.termination_fault = None;
    } else {
        reap_test_supervisor(&mut supervisor);
        return Err("plan restart lost the old process owner".to_owned());
    }
    supervisor.configure_test_sidecar(
        fake_binary()?,
        "lifecycle-success",
        Duration::from_millis(80),
    );
    if supervisor.start(Channel::new(|_| Ok(()))).is_err() {
        reap_test_supervisor(&mut supervisor);
        return Err("plan restart after the bounded reap did not start".to_owned());
    }
    if supervisor.shutdown().is_err() {
        reap_test_supervisor(&mut supervisor);
        return Err("restarted plan session did not shut down".to_owned());
    }
    Ok(())
}

#[test]
fn cancellation_ready_race_discards_exact_plan_and_preserves_clean_session() -> Result<(), String> {
    let _distribution = DISTRIBUTION_TEST_LOCK
        .lock()
        .map_err(|_| "distribution test lock".to_owned())?;
    let mut supervisor = lifecycle_supervisor("lifecycle-plan-cancel-ready")?;
    supervisor
        .start(Channel::new(|_| Ok(())))
        .map_err(|_| "cancel-ready sidecar did not initialize".to_owned())?;
    let error = fake_plan_create(&mut supervisor, true)
        .err()
        .ok_or_else(|| "cancel-ready race exposed a ready plan".to_owned())?;
    let public = serde_json::to_string(&error).map_err(|error| error.to_string())?;
    if error.reason_code() != StudioReasonCode::Cancelled
        || supervisor.process.is_none()
        || !matches!(supervisor.status().state, HostLifecycleState::Ready)
        || public.contains("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")
        || public.contains("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
    {
        return Err(
            "cancel-ready race did not discard, redact, and preserve the clean session".to_owned(),
        );
    }
    supervisor
        .shutdown()
        .map_err(|_| "cancel-ready session did not shut down cleanly".to_owned())?;
    if supervisor.process.is_some() {
        return Err("cancel-ready shutdown retained a process or worker".to_owned());
    }
    Ok(())
}

#[test]
fn invalid_plan_progress_fails_through_transport_and_never_returns_ready() -> Result<(), String> {
    let _distribution = DISTRIBUTION_TEST_LOCK
        .lock()
        .map_err(|_| "distribution test lock".to_owned())?;
    for mode in [
        "lifecycle-plan-progress-unknown",
        "lifecycle-plan-progress-repeated-stage",
        "lifecycle-plan-progress-regressing-stage",
        "lifecycle-plan-progress-repeated-completed",
        "lifecycle-plan-progress-changed-total",
    ] {
        let mut supervisor = lifecycle_supervisor(mode)?;
        supervisor
            .start(Channel::new(|_| Ok(())))
            .map_err(|_| format!("{mode} did not initialize"))?;
        let error = fake_plan_create(&mut supervisor, false)
            .err()
            .ok_or_else(|| format!("{mode} returned a ready plan"))?;
        if !matches!(
            error.reason_code(),
            StudioReasonCode::ProtocolInvalid | StudioReasonCode::SidecarProtocolInvalid
        ) || supervisor.process.is_some()
            || !matches!(supervisor.status().state, HostLifecycleState::Failed)
        {
            return Err(format!(
                "{mode} did not fail and reap through plan transport"
            ));
        }
    }
    Ok(())
}
