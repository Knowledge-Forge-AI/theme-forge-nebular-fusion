use crate::errors::{StudioCommandError, StudioReasonCode, StudioResult};
use crate::sidecar::brand_types::BrandPlanMethod;
use crate::sidecar::plan_protocol::{
    DecodedPlanResult, PlanApplyParams, PlanApplyResult, PlanDiscardParams, PlanDiscardResult,
    PlanEventEmitter, RawPlanResult, StudioBrandPlanStartRequest,
};
use crate::sidecar::plan_transport::{self, PlanTransportError};
use crate::sidecar::process::{ProcessSession, TerminationOutcome};
use crate::sidecar::protocol::HostLifecycleState;
use crate::state::plan_coordinator::{OperationControl, RetainedPlan};

use super::SidecarSupervisor;

pub(crate) enum PlanApplyExecution {
    Applied(BrandPlanMethod),
    Indeterminate(BrandPlanMethod),
    Failed {
        reason: StudioReasonCode,
        written: bool,
    },
}

pub(crate) struct PlanDiscardExecution {
    pub(crate) result: StudioResult<()>,
}

impl SidecarSupervisor {
    pub(crate) fn plan_create(
        &mut self,
        request: &StudioBrandPlanStartRequest,
        control: &OperationControl,
        events: &mut PlanEventEmitter,
    ) -> StudioResult<DecodedPlanResult> {
        let id = self.take_id();
        let mut process = self
            .process
            .take()
            .ok_or_else(|| StudioCommandError::new(StudioReasonCode::SidecarCrashed))?;
        let nonce = process.nonce.clone();
        let (method, params) = request.prepare_create(&nonce)?;
        let response = plan_transport::request::<_, RawPlanResult>(
            &mut process,
            id,
            method.as_str(),
            params,
            self.request_timeout(),
            &control.cancel,
            events,
        );
        match response {
            Ok(success) => {
                let decoded = match success.result.validate(method) {
                    Ok(decoded) => decoded,
                    Err(_) => {
                        let reason = self.terminate_with_reason(
                            process,
                            StudioReasonCode::SidecarProtocolInvalid,
                            "sidecar-protocol-invalid",
                        );
                        return Err(StudioCommandError::new(reason));
                    }
                };
                if success.cancellation_observed {
                    let cleanup_id = self.take_id();
                    let cleanup_nonce = process.nonce.clone();
                    let cleanup: Result<PlanDiscardResult, StudioReasonCode> = Self::request(
                        &mut process,
                        cleanup_id,
                        "plan.discard",
                        PlanDiscardParams {
                            session_nonce: &cleanup_nonce,
                            plan_token: &decoded.plan_token,
                        },
                        self.request_timeout(),
                    );
                    if !matches!(cleanup, Ok(PlanDiscardResult { discarded: true })) {
                        let reason = self.terminate_with_reason(
                            process,
                            StudioReasonCode::Cancelled,
                            "sidecar-request-failed",
                        );
                        return Err(StudioCommandError::new(reason));
                    } else {
                        self.process = Some(process);
                    }
                    return Err(StudioCommandError::new(StudioReasonCode::Cancelled));
                }
                self.process = Some(process);
                Ok(decoded)
            }
            Err(failure) => self.plan_transport_failure(process, failure),
        }
    }

    pub(crate) fn plan_apply(
        &mut self,
        plan: &RetainedPlan,
        control: &OperationControl,
        events: &mut PlanEventEmitter,
    ) -> PlanApplyExecution {
        let id = self.take_id();
        let Some(mut process) = self.process.take() else {
            return PlanApplyExecution::Failed {
                reason: StudioReasonCode::SidecarCrashed,
                written: false,
            };
        };
        let nonce = process.nonce.clone();
        let response = plan_transport::request::<_, PlanApplyResult>(
            &mut process,
            id,
            "plan.apply",
            PlanApplyParams {
                session_nonce: &nonce,
                plan_token: plan.token(),
                expected_plan_digest: &plan.digest,
            },
            self.request_timeout(),
            &control.cancel,
            events,
        );
        match response {
            Ok(success) => match success.result {
                PlanApplyResult::Applied(applied)
                    if applied.applied && applied.method == plan.method =>
                {
                    self.process = Some(process);
                    PlanApplyExecution::Applied(plan.method)
                }
                PlanApplyResult::Empty(()) | PlanApplyResult::Applied(_) => {
                    let reason = self.terminate_with_reason(
                        process,
                        StudioReasonCode::SidecarProtocolInvalid,
                        "sidecar-protocol-invalid",
                    );
                    if reason == StudioReasonCode::SidecarShutdownFailed {
                        PlanApplyExecution::Failed {
                            reason,
                            written: true,
                        }
                    } else {
                        PlanApplyExecution::Indeterminate(plan.method)
                    }
                }
            },
            Err(failure) if Self::is_remote_reason(failure.reason) => {
                self.process = Some(process);
                PlanApplyExecution::Failed {
                    reason: failure.reason,
                    written: failure.written,
                }
            }
            Err(failure) if failure.written => {
                let reason = self.terminate_with_reason(
                    process,
                    failure.reason,
                    Self::transport_reason(failure.reason),
                );
                if reason == StudioReasonCode::SidecarShutdownFailed {
                    PlanApplyExecution::Failed {
                        reason,
                        written: true,
                    }
                } else {
                    PlanApplyExecution::Indeterminate(plan.method)
                }
            }
            Err(failure) => {
                let reason = self.terminate_with_reason(
                    process,
                    failure.reason,
                    Self::transport_reason(failure.reason),
                );
                PlanApplyExecution::Failed {
                    reason,
                    written: false,
                }
            }
        }
    }

    pub(crate) fn plan_discard(
        &mut self,
        plan: &RetainedPlan,
        control: &OperationControl,
        events: &mut PlanEventEmitter,
    ) -> PlanDiscardExecution {
        let id = self.take_id();
        let Some(mut process) = self.process.take() else {
            return PlanDiscardExecution {
                result: Err(StudioCommandError::new(StudioReasonCode::SidecarCrashed)),
            };
        };
        let nonce = process.nonce.clone();
        let response = plan_transport::request::<_, PlanDiscardResult>(
            &mut process,
            id,
            "plan.discard",
            PlanDiscardParams {
                session_nonce: &nonce,
                plan_token: plan.token(),
            },
            self.request_timeout(),
            &control.cancel,
            events,
        );
        match response {
            Ok(success) if success.result.discarded => {
                self.process = Some(process);
                PlanDiscardExecution { result: Ok(()) }
            }
            Ok(_) => {
                let reason = self.terminate_with_reason(
                    process,
                    StudioReasonCode::ProtocolInvalid,
                    "sidecar-protocol-invalid",
                );
                PlanDiscardExecution {
                    result: Err(StudioCommandError::new(reason)),
                }
            }
            Err(failure) if Self::is_remote_reason(failure.reason) => {
                self.process = Some(process);
                PlanDiscardExecution {
                    result: Err(StudioCommandError::new(failure.reason)),
                }
            }
            Err(failure) => {
                let reason = self.terminate_with_reason(
                    process,
                    failure.reason,
                    Self::transport_reason(failure.reason),
                );
                PlanDiscardExecution {
                    result: Err(StudioCommandError::new(reason)),
                }
            }
        }
    }

    pub(crate) fn discard_unretained(&mut self, token: &str) {
        let id = self.take_id();
        let Some(mut process) = self.process.take() else {
            return;
        };
        let nonce = process.nonce.clone();
        let response: Result<PlanDiscardResult, StudioReasonCode> = Self::request(
            &mut process,
            id,
            "plan.discard",
            PlanDiscardParams {
                session_nonce: &nonce,
                plan_token: token,
            },
            self.request_timeout(),
        );
        if matches!(&response, Ok(PlanDiscardResult { discarded: true })) {
            self.process = Some(process);
        } else {
            match self.terminate_process(process) {
                TerminationOutcome::Success => {
                    self.publish(HostLifecycleState::Failed, Some("sidecar-request-failed"));
                }
                TerminationOutcome::ReapedWorkerJoinFailure | TerminationOutcome::Unreaped => {
                    self.publish(HostLifecycleState::Failed, Some("sidecar-shutdown-failed"));
                }
            }
        }
    }

    fn plan_transport_failure<T>(
        &mut self,
        process: ProcessSession,
        failure: PlanTransportError,
    ) -> StudioResult<T> {
        if failure.reason == StudioReasonCode::SidecarRequestTimeout && failure.written {
            let reason = self.terminate_with_reason(
                process,
                StudioReasonCode::RequestTimeout,
                "sidecar-request-timeout",
            );
            Err(StudioCommandError::new(reason))
        } else if Self::is_remote_reason(failure.reason) {
            self.process = Some(process);
            Err(StudioCommandError::new(failure.reason))
        } else {
            let reason = self.terminate_with_reason(
                process,
                failure.reason,
                Self::transport_reason(failure.reason),
            );
            Err(StudioCommandError::new(reason))
        }
    }
}
