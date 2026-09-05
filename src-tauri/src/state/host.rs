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
    supervisor: Mutex<SidecarSupervisor>,
}

impl HostState {
    pub(crate) fn new(supervisor: SidecarSupervisor) -> StudioResult<Self> {
        Ok(Self {
            shared: Arc::new(HostShared {
                supervisor: Mutex::new(supervisor),
            }),
            plans: Arc::new(PlanCoordinator::new()?),
        })
    }

    pub(crate) fn lock(&self) -> StudioResult<MutexGuard<'_, SidecarSupervisor>> {
        match self.shared.supervisor.try_lock() {
            Ok(supervisor) => Ok(supervisor),
            Err(TryLockError::WouldBlock) => {
                Err(StudioCommandError::new(StudioReasonCode::SidecarBusy))
            }
            Err(TryLockError::Poisoned(_)) => {
                Err(StudioCommandError::new(StudioReasonCode::SidecarCrashed))
            }
        }
    }

    fn lock_for_teardown(&self) -> StudioResult<MutexGuard<'_, SidecarSupervisor>> {
        self.shared
            .supervisor
            .lock()
            .map_err(|_| StudioCommandError::new(StudioReasonCode::SidecarCrashed))
    }

    pub(crate) fn start_host(
        &self,
        events: Channel<StudioHostStateEvent>,
    ) -> StudioResult<StudioHostStatus> {
        self.invalidate_plans();
        self.lock_for_teardown()?.start(events)
    }

    pub(crate) fn status(&self) -> StudioResult<StudioHostStatus> {
        let status = self.lock()?.status();
        if !matches!(status.state, HostLifecycleState::Ready) {
            self.invalidate_plans();
        }
        Ok(status)
    }

    pub(crate) fn shutdown_host(&self) -> StudioResult<()> {
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
        self.plans.begin_identity_change()
    }
}
