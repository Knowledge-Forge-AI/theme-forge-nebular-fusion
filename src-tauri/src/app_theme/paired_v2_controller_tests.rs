use super::PairedV2ExecutionController;
use std::sync::Arc;

#[test]
fn newer_reservation_rejects_older_pending_work() {
    let controller = Arc::new(PairedV2ExecutionController::default());
    let Some(old) = controller.reserve(11).ok() else {
        assert!(false, "old reservation failed");
        return;
    };
    let Some(current) = controller.reserve(12).ok() else {
        assert!(false, "current reservation failed");
        return;
    };

    assert_ne!(old, current);
    assert!(controller.acquire(old).is_err());

    let Some(lease) = controller.acquire(current).ok() else {
        assert!(false, "current lease failed");
        return;
    };
    assert_eq!(controller.snapshot(), (None, Some(current)));
    controller.finish(lease.operation);
    assert_eq!(controller.snapshot(), (None, None));
}

#[test]
fn newer_claim_cancels_active_old_phase_before_launch() {
    let controller = Arc::new(PairedV2ExecutionController::default());
    let Some(old) = controller.reserve(21).ok() else {
        assert!(false, "old reservation failed");
        return;
    };
    let Some(old_lease) = controller.acquire(old).ok() else {
        assert!(false, "old lease failed");
        return;
    };

    // This models an old bind finishing after a newer claim has reserved the
    // composite lane but before the old compile phase is launched.
    let Some(current) = controller.reserve(22).ok() else {
        assert!(false, "current reservation failed");
        return;
    };
    assert!(old_lease.cancel.load(std::sync::atomic::Ordering::SeqCst));
    assert!(controller.begin_phase(&old_lease).is_err());

    controller.finish(old);
    let Some(current_lease) = controller.acquire(current).ok() else {
        assert!(false, "current lease failed");
        return;
    };
    let Some(_launch) = controller.begin_phase(&current_lease).ok() else {
        assert!(false, "current launch fence failed");
        return;
    };
    drop(_launch);
    controller.finish(current);
}

#[test]
fn explicit_cancel_invalidates_pending_and_active_v2_work() {
    let controller = Arc::new(PairedV2ExecutionController::default());
    let Some(operation) = controller.reserve(31).ok() else {
        assert!(false, "reservation failed");
        return;
    };
    let Some(lease) = controller.acquire(operation).ok() else {
        assert!(false, "lease failed");
        return;
    };

    controller.cancel();
    assert!(lease.cancel.load(std::sync::atomic::Ordering::SeqCst));
    assert!(controller.begin_phase(&lease).is_err());
    controller.finish(operation);
    assert_eq!(controller.snapshot(), (None, None));
}

#[test]
fn abort_reserved_operation_releases_preacquire_reservation() {
    let controller = Arc::new(PairedV2ExecutionController::default());
    let Some(operation) = controller.reserve(41).ok() else {
        assert!(false, "reservation failed");
        return;
    };

    controller.abort(operation);
    assert_eq!(controller.snapshot(), (None, None));
    assert!(controller.acquire(operation).is_err());
}
