use super::PairedV2ExecutionController;
use crate::errors::StudioCommandError;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

static NEXT_TEST_NONCE: AtomicU64 = AtomicU64::new(1);

fn next_test_nonce() -> u64 {
    NEXT_TEST_NONCE.fetch_add(1, Ordering::Relaxed)
}

#[test]
fn newer_reservation_rejects_older_pending_work() -> Result<(), StudioCommandError> {
    let controller = Arc::new(PairedV2ExecutionController::default());
    let old = controller.reserve(next_test_nonce())?;
    let current = controller.reserve(next_test_nonce())?;

    assert_ne!(old, current);
    assert!(controller.acquire(old).is_err());

    let lease = controller.acquire(current)?;
    assert_eq!(controller.snapshot(), (None, Some(current)));
    controller.finish(lease.operation);
    assert_eq!(controller.snapshot(), (None, None));
    Ok(())
}

#[test]
fn newer_claim_cancels_active_old_phase_before_launch() -> Result<(), StudioCommandError> {
    let controller = Arc::new(PairedV2ExecutionController::default());
    let old = controller.reserve(next_test_nonce())?;
    let old_lease = controller.acquire(old)?;

    // This models an old bind finishing after a newer claim has reserved the
    // composite lane but before the old compile phase is launched.
    let current = controller.reserve(next_test_nonce())?;
    assert!(old_lease.cancel.load(std::sync::atomic::Ordering::SeqCst));
    assert!(controller.begin_phase(&old_lease).is_err());

    controller.finish(old);
    let current_lease = controller.acquire(current)?;
    let launch = controller.begin_phase(&current_lease)?;
    drop(launch);
    controller.finish(current);
    Ok(())
}

#[test]
fn explicit_cancel_invalidates_pending_and_active_v2_work() -> Result<(), StudioCommandError> {
    let controller = Arc::new(PairedV2ExecutionController::default());
    let operation = controller.reserve(next_test_nonce())?;
    let lease = controller.acquire(operation)?;

    controller.cancel();
    assert!(lease.cancel.load(std::sync::atomic::Ordering::SeqCst));
    assert!(controller.begin_phase(&lease).is_err());
    controller.finish(operation);
    assert_eq!(controller.snapshot(), (None, None));
    Ok(())
}

#[test]
fn abort_reserved_operation_releases_preacquire_reservation() -> Result<(), StudioCommandError> {
    let controller = Arc::new(PairedV2ExecutionController::default());
    let operation = controller.reserve(next_test_nonce())?;

    controller.abort(operation);
    assert_eq!(controller.snapshot(), (None, None));
    assert!(controller.acquire(operation).is_err());
    Ok(())
}
