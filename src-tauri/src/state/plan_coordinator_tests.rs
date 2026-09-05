use std::collections::BTreeSet;
use std::sync::{Arc, Barrier, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use serde_json::json;

use super::{
    MonotonicClock, PlanCoordinator, PlanSessionContext, constant_time_equal, opaque_handle,
};
use crate::errors::StudioReasonCode;
use crate::sidecar::brand_types::{BrandPlanMethod, StudioPlanSummary};
use crate::sidecar::plan_protocol::{
    DecodedPlanResult, DeriveSelection, StudioBrandPlanStartRequest, StudioBrandPlanStartResult,
};

const DIGEST: &str = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

struct TestClock(Mutex<Instant>);

impl MonotonicClock for TestClock {
    fn now(&self) -> Instant {
        self.0
            .lock()
            .map_or_else(|error| *error.into_inner(), |now| *now)
    }
}

impl TestClock {
    fn advance(&self, duration: Duration) {
        if let Ok(mut now) = self.0.lock() {
            *now += duration;
        }
    }
}

fn context(generation: u64) -> PlanSessionContext {
    PlanSessionContext {
        generation,
        nonce: format!("nonce-{generation}"),
        project_handle: Some("project_safe".to_owned()),
        source_handles: BTreeSet::new(),
        raster_plan: Some(crate::sidecar::brand_types::QUALIFIED_RASTER_PLAN),
    }
}

fn create() -> StudioBrandPlanStartRequest {
    StudioBrandPlanStartRequest::CreateDerive {
        project_handle: "project_safe".to_owned(),
        selection: DeriveSelection::All,
    }
}

fn decoded() -> DecodedPlanResult {
    let summary = StudioPlanSummary::decode(
        BrandPlanMethod::Derive,
        json!({ "selectedRecipes": ["recipe-one"], "transitiveRecipes": [], "affectedTargets": [], "createdCount": 0, "updatedCount": 0, "unchangedCount": 0, "operationSummaries": [], "targetStates": [], "tokenDigest": DIGEST, "recipeDigest": DIGEST, "brandSystemDigest": DIGEST, "warnings": [], "dryRun": true }),
    );
    DecodedPlanResult {
        plan_token: "A".repeat(43),
        plan_digest: DIGEST.to_owned(),
        method: BrandPlanMethod::Derive,
        summary: summary.unwrap_or_else(|_| unreachable!()),
    }
}

fn retain(coordinator: &PlanCoordinator, session: &PlanSessionContext) -> Option<String> {
    let begun = coordinator.begin(create(), session).ok()?;
    let operation_handle = begun.control.handle.clone();
    let result = coordinator
        .retain_created(
            &operation_handle,
            decoded(),
            session,
            "project_safe".to_owned(),
            Vec::new(),
        )
        .ok()?;
    coordinator.finish(&operation_handle);
    if let StudioBrandPlanStartResult::Ready { plan_handle, .. } = result {
        Some(plan_handle)
    } else {
        None
    }
}

#[test]
fn local_handles_are_domain_separated_and_digest_comparison_is_bounded() {
    let plan = opaque_handle("plan_", "nonce", "token", "digest");
    let operation = opaque_handle("operation_", "nonce", "token", "digest");
    assert_eq!(plan.len(), 69);
    assert_eq!(operation.len(), 74);
    assert_ne!(plan, operation);
    assert!(constant_time_equal("same", "same"));
    assert!(!constant_time_equal("same", "different"));
    let coordinator = PlanCoordinator::new();
    assert!(coordinator.is_ok());
    assert!(coordinator.is_ok_and(|value| !value.has_retained()));
}

#[test]
fn one_pending_plan_digest_mismatch_and_session_binding_fail_closed() -> Result<(), String> {
    let coordinator = PlanCoordinator::new().map_err(|_| "coordinator unavailable".to_owned())?;
    let session = context(1);
    let handle =
        retain(&coordinator, &session).ok_or_else(|| "plan was not retained".to_owned())?;
    assert!(coordinator.begin(create(), &session).is_err());
    assert!(
        coordinator
            .begin(
                StudioBrandPlanStartRequest::Apply {
                    plan_handle: handle.clone(),
                    expected_plan_digest:
                        "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
                            .to_owned()
                },
                &session
            )
            .is_err()
    );
    assert!(coordinator.has_retained());
    assert!(
        coordinator
            .begin(
                StudioBrandPlanStartRequest::Discard {
                    plan_handle: handle
                },
                &context(2)
            )
            .is_err()
    );
    assert!(!coordinator.has_retained());

    let handle =
        retain(&coordinator, &session).ok_or_else(|| "plan was not retained".to_owned())?;
    let mut changed_capability = session.clone();
    changed_capability.raster_plan = None;
    assert!(
        coordinator
            .begin(
                StudioBrandPlanStartRequest::Discard {
                    plan_handle: handle
                },
                &changed_capability
            )
            .is_err_and(|error| error.reason_code() == StudioReasonCode::ContextStale)
    );
    assert!(!coordinator.has_retained());
    Ok(())
}

#[test]
fn exact_ten_minute_monotonic_boundary_expires_and_retires_authority() -> Result<(), String> {
    let start = Instant::now();
    let clock = Arc::new(TestClock(Mutex::new(start)));
    let coordinator = PlanCoordinator::with_clock(clock.clone())
        .map_err(|_| "coordinator unavailable".to_owned())?;
    let session = context(1);
    let handle =
        retain(&coordinator, &session).ok_or_else(|| "plan was not retained".to_owned())?;
    clock.advance(Duration::from_millis(599_999));
    assert!(coordinator.has_retained());
    clock.advance(Duration::from_millis(1));
    assert!(
        coordinator
            .begin(
                StudioBrandPlanStartRequest::Discard {
                    plan_handle: handle
                },
                &session
            )
            .is_err()
    );
    assert!(!coordinator.has_retained());
    Ok(())
}

#[test]
fn identity_change_reservation_atomically_excludes_plan_admission() -> Result<(), String> {
    let coordinator =
        Arc::new(PlanCoordinator::new().map_err(|_| "coordinator unavailable".to_owned())?);
    let reservation = coordinator
        .begin_identity_change()
        .map_err(|_| "identity change reservation unavailable".to_owned())?;
    let barrier = Arc::new(Barrier::new(2));
    let worker_coordinator = coordinator.clone();
    let worker_barrier = barrier.clone();
    let worker = thread::spawn(move || {
        worker_barrier.wait();
        worker_coordinator.begin(create(), &context(1))
    });
    barrier.wait();
    let attempt = worker.join();
    assert!(attempt.is_ok_and(|result| {
        result.is_err_and(|error| error.reason_code() == StudioReasonCode::RequestBusy)
    }));
    drop(reservation);
    assert!(coordinator.begin(create(), &context(1)).is_ok());
    Ok(())
}

#[test]
fn admitted_plan_and_retained_plan_exclude_identity_change_reservation() -> Result<(), String> {
    let coordinator =
        Arc::new(PlanCoordinator::new().map_err(|_| "coordinator unavailable".to_owned())?);
    let active = coordinator
        .begin(create(), &context(1))
        .map_err(|_| "plan admission unavailable".to_owned())?;
    let barrier = Arc::new(Barrier::new(2));
    let worker_coordinator = coordinator.clone();
    let worker_barrier = barrier.clone();
    let worker = thread::spawn(move || {
        worker_barrier.wait();
        worker_coordinator.begin_identity_change()
    });
    barrier.wait();
    let attempt = worker.join();
    assert!(attempt.is_ok_and(|result| {
        result.is_err_and(|error| error.reason_code() == StudioReasonCode::RequestBusy)
    }));
    coordinator.finish(&active.control.handle);

    assert!(retain(&coordinator, &context(1)).is_some());
    assert!(
        coordinator
            .begin_identity_change()
            .is_err_and(|error| { error.reason_code() == StudioReasonCode::PlanActive })
    );
    Ok(())
}

#[test]
fn applying_discarding_cancellation_stop_and_restart_keep_reservation_closed() -> Result<(), String>
{
    let coordinator = PlanCoordinator::new().map_err(|_| "coordinator unavailable".to_owned())?;
    let session = context(1);
    let apply_handle =
        retain(&coordinator, &session).ok_or_else(|| "apply plan was not retained".to_owned())?;
    let apply = coordinator
        .begin(
            StudioBrandPlanStartRequest::Apply {
                plan_handle: apply_handle,
                expected_plan_digest: DIGEST.to_owned(),
            },
            &session,
        )
        .map_err(|_| "apply admission unavailable".to_owned())?;
    assert!(coordinator.begin_identity_change().is_err());
    assert!(
        coordinator
            .cancel(&apply.control.handle)
            .is_ok_and(|accepted| accepted)
    );
    assert!(coordinator.begin_identity_change().is_err());
    coordinator.finish(&apply.control.handle);

    let discard_handle =
        retain(&coordinator, &session).ok_or_else(|| "discard plan was not retained".to_owned())?;
    let discard = coordinator
        .begin(
            StudioBrandPlanStartRequest::Discard {
                plan_handle: discard_handle,
            },
            &session,
        )
        .map_err(|_| "discard admission unavailable".to_owned())?;
    assert!(coordinator.begin_identity_change().is_err());
    coordinator.finish(&discard.control.handle);

    let reservation = coordinator
        .begin_identity_change()
        .map_err(|_| "identity change reservation unavailable".to_owned())?;
    coordinator.invalidate_all();
    assert!(coordinator.begin(create(), &session).is_err());
    drop(reservation);
    assert!(coordinator.begin(create(), &session).is_ok());
    Ok(())
}
