use std::ops::{Deref, DerefMut};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, TryLockError};

use crate::errors::{StudioCommandError, StudioReasonCode, StudioResult};
use crate::sidecar::plan_protocol::{
    PlanEventEmitter, StudioBrandPlanStartRequest, StudioBrandPlanStartResult,
    StudioPlanOperationEvent,
};
use crate::sidecar::protocol::{HostLifecycleState, StudioHostStateEvent, StudioHostStatus};
use crate::sidecar::supervisor::PlanApplyExecution;
use crate::sidecar::supervisor::SidecarSupervisor;
use crate::state::plan_coordinator::{IdentityChangeGuard, PlanCoordinator, PlanOperationAction};
use tauri::ipc::Channel;

#[derive(Clone)]
pub(crate) struct HostState {
    shared: Arc<HostShared>,
    plans: Arc<PlanCoordinator>,
}

struct HostShared {
    scene_generation: AtomicU64,
    supervisor: Mutex<SidecarSupervisor>,
    operation: Mutex<()>,
    /// Last completed status publication.  A status request that overlaps an
    /// in-flight mutation reads this snapshot instead of queueing behind the
    /// supervisor.  The cache is written only while the supervisor is held;
    /// no code acquires it and then waits for the supervisor.  While a
    /// lifecycle mutation is in flight, callers see the last completed
    /// lifecycle state; guard Drop publishes the mutation's resulting fields
    /// before either production lock is released.
    published: Mutex<StudioHostStatus>,
    #[cfg(test)]
    teardown_operation_hook: Mutex<Option<std::sync::mpsc::Sender<()>>>,
}

/// The operation gate serializes mutating host operations while the supervisor
/// guard protects the supervisor itself.  Keep `supervisor` declared first so
/// Rust drops it before `operation`; a mutation must release the supervisor
/// mutex before allowing the next mutation through the operation gate.
pub(crate) struct HostSupervisorGuard<'a> {
    supervisor: MutexGuard<'a, SidecarSupervisor>,
    _operation: MutexGuard<'a, ()>,
    published: &'a Mutex<StudioHostStatus>,
}

impl Deref for HostSupervisorGuard<'_> {
    type Target = SidecarSupervisor;

    fn deref(&self) -> &Self::Target {
        &self.supervisor
    }
}

impl DerefMut for HostSupervisorGuard<'_> {
    fn deref_mut(&mut self) -> &mut Self::Target {
        &mut self.supervisor
    }
}

impl Drop for HostSupervisorGuard<'_> {
    fn drop(&mut self) {
        // Publish before releasing either production lock.  Drop cannot
        // report an error, so a poisoned cache is left poisoned and makes the
        // next status request fail closed as SidecarCrashed.  Never reap here:
        // child inspection belongs to explicit supervisor operations.
        let snapshot = self.supervisor.status_snapshot();
        if let Ok(mut published) = self.published.lock() {
            *published = snapshot;
        }
    }
}

impl HostState {
    pub(crate) fn new(supervisor: SidecarSupervisor) -> StudioResult<Self> {
        let published = supervisor.status_snapshot();
        Ok(Self {
            shared: Arc::new(HostShared {
                supervisor: Mutex::new(supervisor),
                operation: Mutex::new(()),
                scene_generation: AtomicU64::new(0),
                published: Mutex::new(published),
                #[cfg(test)]
                teardown_operation_hook: Mutex::new(None),
            }),
            plans: Arc::new(PlanCoordinator::new()?),
        })
    }

    pub(crate) fn lock(&self) -> StudioResult<HostSupervisorGuard<'_>> {
        let operation = match self.shared.operation.try_lock() {
            Ok(operation) => operation,
            Err(TryLockError::WouldBlock) => {
                return Err(StudioCommandError::new(StudioReasonCode::SidecarBusy));
            }
            Err(TryLockError::Poisoned(_)) => {
                return Err(StudioCommandError::new(StudioReasonCode::SidecarCrashed));
            }
        };
        let supervisor = self
            .shared
            .supervisor
            .lock()
            .map_err(|_| StudioCommandError::new(StudioReasonCode::SidecarCrashed))?;
        Ok(HostSupervisorGuard {
            supervisor,
            _operation: operation,
            published: &self.shared.published,
        })
    }

    fn lock_for_teardown(&self) -> StudioResult<HostSupervisorGuard<'_>> {
        let operation = self
            .shared
            .operation
            .lock()
            .map_err(|_| StudioCommandError::new(StudioReasonCode::SidecarCrashed))?;
        #[cfg(test)]
        if let Ok(mut hook) = self.shared.teardown_operation_hook.lock()
            && let Some(signal) = hook.take()
        {
            let _ = signal.send(());
        }
        let supervisor = self
            .shared
            .supervisor
            .lock()
            .map_err(|_| StudioCommandError::new(StudioReasonCode::SidecarCrashed))?;
        Ok(HostSupervisorGuard {
            supervisor,
            _operation: operation,
            published: &self.shared.published,
        })
    }

    pub(crate) fn start_host(
        &self,
        events: Channel<StudioHostStateEvent>,
    ) -> StudioResult<StudioHostStatus> {
        self.advance_scene_generation()?;
        self.invalidate_plans();
        self.lock_for_teardown()?.start(events)
    }

    pub(crate) fn status(&self) -> StudioResult<StudioHostStatus> {
        let status = match self.shared.supervisor.try_lock() {
            Ok(mut supervisor) => {
                let status = supervisor.status();
                self.publish_status(&status)?;
                status
            }
            Err(TryLockError::WouldBlock) => self.cached_status()?,
            Err(TryLockError::Poisoned(_)) => {
                return Err(StudioCommandError::new(StudioReasonCode::SidecarCrashed));
            }
        };
        if !matches!(status.state, HostLifecycleState::Ready) {
            self.invalidate_plans();
        }
        Ok(status)
    }

    fn publish_status(&self, status: &StudioHostStatus) -> StudioResult<()> {
        self.shared
            .published
            .lock()
            .map(|mut published| *published = status.clone())
            .map_err(|_| StudioCommandError::new(StudioReasonCode::SidecarCrashed))
    }

    fn cached_status(&self) -> StudioResult<StudioHostStatus> {
        self.shared
            .published
            .lock()
            .map(|published| published.clone())
            .map_err(|_| StudioCommandError::new(StudioReasonCode::SidecarCrashed))
    }

    pub(crate) fn shutdown_host(&self) -> StudioResult<()> {
        self.advance_scene_generation()?;
        self.invalidate_plans();
        self.lock_for_teardown()?.shutdown()
    }

    pub(crate) fn start_plan(
        &self,
        request: StudioBrandPlanStartRequest,
        progress: Channel<StudioPlanOperationEvent>,
    ) -> StudioResult<StudioBrandPlanStartResult> {
        let context = self.lock()?.plan_session_context()?;
        let operation = self.plans.begin(request, &context)?;
        let operation_handle = operation.control.handle.clone();
        let apply = matches!(operation.action, PlanOperationAction::Apply { .. });
        if apply {
            self.advance_scene_generation()?;
        }
        let mut events = PlanEventEmitter::new(progress, operation_handle.clone(), apply);
        let result = (|| -> StudioResult<StudioBrandPlanStartResult> {
            if events.started().is_err() {
                operation
                    .control
                    .cancel
                    .store(true, std::sync::atomic::Ordering::SeqCst);
                Err(StudioCommandError::new(StudioReasonCode::Cancelled))
            } else {
                let mut supervisor = self.lock()?;
                match operation.action {
                    PlanOperationAction::Create {
                        request,
                        project_handle,
                        source_handles,
                        ..
                    } => match supervisor.plan_create(&request, &operation.control, &mut events) {
                        Ok(created) => {
                            let current = supervisor.plan_session_context()?;
                            let mut token = created.plan_token.clone();
                            let retained = self.plans.retain_created(
                                &operation_handle,
                                created,
                                &current,
                                project_handle,
                                source_handles,
                            );
                            if retained.is_err() {
                                supervisor.discard_unretained(&token);
                            }
                            let token_length = token.len();
                            token.replace_range(.., &"0".repeat(token_length));
                            token.clear();
                            retained
                        }
                        Err(error) => Err(error),
                    },
                    PlanOperationAction::Apply { plan } => {
                        let method = plan.method;
                        match supervisor.plan_apply(&plan, &operation.control, &mut events) {
                            PlanApplyExecution::Applied(method) => {
                                Ok(StudioBrandPlanStartResult::Applied { method })
                            }
                            PlanApplyExecution::Indeterminate(method) => {
                                Ok(StudioBrandPlanStartResult::Indeterminate { method })
                            }
                            PlanApplyExecution::Failed { reason, written } => {
                                if !written && let Ok(current) = supervisor.plan_session_context() {
                                    self.plans.restore_unwritten_apply(
                                        &operation_handle,
                                        plan,
                                        &current,
                                    );
                                }
                                let _ = method;
                                Err(StudioCommandError::new(reason))
                            }
                        }
                    }
                    PlanOperationAction::Discard { plan } => {
                        supervisor
                            .plan_discard(&plan, &operation.control, &mut events)
                            .result?;
                        Ok(StudioBrandPlanStartResult::Discarded)
                    }
                }
            }
        })();
        self.plans.finish(&operation_handle);
        if result.is_err() {
            let host_non_ready = self
                .lock()
                .map(|mut supervisor| {
                    !matches!(supervisor.status().state, HostLifecycleState::Ready)
                })
                .unwrap_or(true);
            if host_non_ready {
                self.invalidate_plans();
            }
        }
        result
    }

    pub(crate) fn cancel_plan(&self, operation_handle: &str) -> StudioResult<bool> {
        self.plans.cancel(operation_handle)
    }

    pub(crate) fn invalidate_plans(&self) {
        self.plans.invalidate_all();
    }

    pub(crate) fn begin_identity_change(&self) -> StudioResult<IdentityChangeGuard> {
        self.advance_scene_generation()?;
        self.plans.begin_identity_change()
    }
    pub(crate) fn scene_generation(&self) -> u64 {
        self.shared.scene_generation.load(Ordering::SeqCst)
    }

    fn advance_scene_generation(&self) -> StudioResult<()> {
        self.shared
            .scene_generation
            .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |n| n.checked_add(1))
            .map(|_| ())
            .map_err(|_| StudioCommandError::new(StudioReasonCode::ContextStale))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::error::Error;
    use std::path::PathBuf;
    use std::sync::mpsc;
    use std::thread;
    use std::time::Duration;

    const WAIT: Duration = Duration::from_secs(1);
    type WorkerResult = Result<(), &'static str>;

    fn host() -> StudioResult<HostState> {
        HostState::new(SidecarSupervisor::new(
            PathBuf::from("test-sidecar"),
            PathBuf::from("test-payload"),
            PathBuf::from("test-temp"),
        ))
    }

    fn join_worker(worker: thread::JoinHandle<WorkerResult>) -> Result<(), Box<dyn Error>> {
        let result = worker
            .join()
            .map_err(|_| std::io::Error::other("worker thread panicked"))?;
        result.map_err(std::io::Error::other)?;
        Ok(())
    }

    #[test]
    fn status_returns_last_completed_snapshot_while_mutation_owns_supervisor()
    -> Result<(), Box<dyn Error>> {
        let host = host()?;
        let _mutation = host.lock()?;

        let status = host.status()?;
        assert!(matches!(status.state, HostLifecycleState::NotStarted));
        assert_eq!(status.project_open_count, 0);
        Ok(())
    }

    #[test]
    fn status_returns_last_completed_snapshot_while_status_reader_owns_supervisor()
    -> Result<(), Box<dyn Error>> {
        let host = host()?;
        let initial = host.status()?;
        assert!(matches!(initial.state, HostLifecycleState::NotStarted));
        let _status_reader = host
            .shared
            .supervisor
            .lock()
            .map_err(|_| "status lock poisoned")?;

        let status = host.status()?;
        assert!(matches!(status.state, HostLifecycleState::NotStarted));
        Ok(())
    }

    #[test]
    fn status_does_not_acquire_operation_gate() -> Result<(), Box<dyn Error>> {
        let host = host()?;
        let _operation = host
            .shared
            .operation
            .lock()
            .map_err(|_| "operation gate poisoned")?;

        let status = host.status()?;
        assert!(matches!(status.state, HostLifecycleState::NotStarted));
        Ok(())
    }

    #[test]
    fn completed_mutation_publishes_fresh_project_count_before_next_status()
    -> Result<(), Box<dyn Error>> {
        let host = host()?;
        {
            let mut mutation = host.lock()?;
            mutation.test_set_status_fixture(HostLifecycleState::Ready, 3);
        }

        let _status_reader = host
            .shared
            .supervisor
            .lock()
            .map_err(|_| "status lock poisoned")?;
        let status = host.status()?;
        assert!(matches!(status.state, HostLifecycleState::Ready));
        assert_eq!(status.project_open_count, 3);
        Ok(())
    }

    #[test]
    fn mutation_waits_for_status_reader_then_acquires_operation_gate() -> Result<(), Box<dyn Error>>
    {
        let host = host()?;
        let status_reader = host
            .shared
            .supervisor
            .lock()
            .map_err(|_| "status lock poisoned")?;
        let (attempting_tx, attempting_rx) = mpsc::channel();
        let (result_tx, result_rx): (mpsc::Sender<StudioResult<()>>, _) = mpsc::channel();
        let worker_host = host.clone();

        let worker = thread::spawn(move || -> WorkerResult {
            attempting_tx.send(()).map_err(|_| "attempt signal")?;
            let result = worker_host.lock().map(drop);
            result_tx.send(result).map_err(|_| "mutation result")?;
            Ok(())
        });

        attempting_rx.recv_timeout(WAIT)?;
        if result_rx.recv_timeout(WAIT).is_ok() {
            drop(status_reader);
            let _ = join_worker(worker);
            return Err("mutation completed while status reader held supervisor".into());
        }
        drop(status_reader);
        let result = result_rx.recv_timeout(WAIT)?;
        if result.is_err() {
            return Err("mutation rejected after status reader release".into());
        }
        join_worker(worker)?;
        Ok(())
    }

    #[test]
    fn concurrent_mutations_remain_busy() -> Result<(), Box<dyn Error>> {
        let host = host()?;
        let first = host.lock()?;
        let (result_tx, result_rx) = mpsc::channel();
        let worker_host = host.clone();

        let worker = thread::spawn(move || -> WorkerResult {
            let error = match worker_host.lock() {
                Ok(_) => return Err("second mutation must not queue"),
                Err(error) => error,
            };
            result_tx
                .send(error.reason_code())
                .map_err(|_| "result signal")?;
            Ok(())
        });

        assert_eq!(result_rx.recv_timeout(WAIT)?, StudioReasonCode::SidecarBusy);
        join_worker(worker)?;
        drop(first);
        Ok(())
    }

    #[test]
    fn teardown_waits_for_status_reader_before_acquiring_both_locks() -> Result<(), Box<dyn Error>>
    {
        let host = host()?;
        let status_reader = host
            .shared
            .supervisor
            .lock()
            .map_err(|_| "status lock poisoned")?;
        let (operation_tx, operation_rx) = mpsc::channel();
        *host
            .shared
            .teardown_operation_hook
            .lock()
            .map_err(|_| "teardown hook poisoned")? = Some(operation_tx);
        let (attempting_tx, attempting_rx) = mpsc::channel();
        let (result_tx, result_rx): (mpsc::Sender<StudioResult<()>>, _) = mpsc::channel();
        let worker_host = host.clone();

        let worker = thread::spawn(move || -> WorkerResult {
            attempting_tx
                .send(())
                .map_err(|_| "teardown attempt signal")?;
            let result = worker_host.lock_for_teardown().map(drop);
            result_tx.send(result).map_err(|_| "teardown result")?;
            Ok(())
        });

        attempting_rx.recv_timeout(WAIT)?;
        operation_rx.recv_timeout(WAIT)?;
        let (mutation_tx, mutation_rx) = mpsc::channel();
        let mutation_host = host.clone();
        let mutation_worker = thread::spawn(move || -> WorkerResult {
            let error = match mutation_host.lock() {
                Ok(_) => return Err("mutation queued behind teardown"),
                Err(error) => error,
            };
            mutation_tx
                .send(error.reason_code())
                .map_err(|_| "teardown busy result")?;
            Ok(())
        });
        if result_rx.recv_timeout(WAIT).is_ok() {
            drop(status_reader);
            let _ = join_worker(worker);
            let _ = join_worker(mutation_worker);
            return Err("teardown acquired while status reader held supervisor".into());
        }
        assert_eq!(
            mutation_rx.recv_timeout(WAIT)?,
            StudioReasonCode::SidecarBusy
        );
        join_worker(mutation_worker)?;
        drop(status_reader);
        let result = result_rx.recv_timeout(WAIT)?;
        if result.is_err() {
            return Err("teardown rejected after status reader release".into());
        }
        join_worker(worker)?;
        Ok(())
    }

    #[test]
    fn poisoned_operation_gate_maps_to_sidecar_crashed() -> Result<(), Box<dyn Error>> {
        let host = host()?;
        let shared = Arc::clone(&host.shared);
        thread::spawn(move || {
            let result = std::panic::catch_unwind(|| {
                if let Ok(_operation) = shared.operation.lock() {
                    std::panic::resume_unwind(Box::new("poison operation gate"));
                }
            });
            assert!(result.is_err());
        })
        .join()
        .map_err(|_| "poison worker panicked")?;

        let error = match host.lock() {
            Ok(_) => return Err("poisoned operation gate must reject mutation".into()),
            Err(error) => error,
        };
        assert_eq!(error.reason_code(), StudioReasonCode::SidecarCrashed);
        Ok(())
    }

    #[test]
    fn poisoned_supervisor_maps_to_sidecar_crashed() -> Result<(), Box<dyn Error>> {
        let host = host()?;
        let shared = Arc::clone(&host.shared);
        thread::spawn(move || {
            let result = std::panic::catch_unwind(|| {
                if let Ok(_supervisor) = shared.supervisor.lock() {
                    std::panic::resume_unwind(Box::new("poison supervisor"));
                }
            });
            assert!(result.is_err());
        })
        .join()
        .map_err(|_| "poison worker panicked")?;

        let lock_error = match host.lock() {
            Ok(_) => return Err("poisoned supervisor must reject mutation".into()),
            Err(error) => error,
        };
        assert_eq!(lock_error.reason_code(), StudioReasonCode::SidecarCrashed);
        let status_error = match host.status() {
            Ok(_) => return Err("poisoned supervisor must reject status".into()),
            Err(error) => error,
        };
        assert_eq!(status_error.reason_code(), StudioReasonCode::SidecarCrashed);
        Ok(())
    }

    #[test]
    fn poisoned_published_cache_fails_closed_without_drop_panic() -> Result<(), Box<dyn Error>> {
        let host = host()?;
        let shared = Arc::clone(&host.shared);
        thread::spawn(move || {
            let result = std::panic::catch_unwind(|| {
                if let Ok(_published) = shared.published.lock() {
                    std::panic::resume_unwind(Box::new("poison published cache"));
                }
            });
            assert!(result.is_err());
        })
        .join()
        .map_err(|_| "cache poison worker panicked")?;

        // Guard Drop must tolerate the poisoned cache; a fallback status must
        // still fail closed rather than returning an untrusted snapshot.
        let mutation = host.lock()?;
        drop(mutation);
        let _status_reader = host
            .shared
            .supervisor
            .lock()
            .map_err(|_| "status lock poisoned")?;
        let error = match host.status() {
            Ok(_) => return Err("poisoned published cache must reject status".into()),
            Err(error) => error,
        };
        assert_eq!(error.reason_code(), StudioReasonCode::SidecarCrashed);
        Ok(())
    }
}
