use std::io::Write;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::RecvTimeoutError;
use std::time::{Duration, Instant};

use serde::Serialize;
use serde::de::{DeserializeOwned, IgnoredAny};

use crate::errors::StudioReasonCode;
use crate::sidecar::coordinator::IncomingId;
use crate::sidecar::framing::MAX_FRAME_BYTES;
use crate::sidecar::plan_protocol::{
    CancelRequestParams, PlanEventEmitter, StudioPlanProgressStage,
};
use crate::sidecar::process::{ProcessSession, ReaderEvent};
use crate::sidecar::protocol::{ProgressNotification, RpcNotification, RpcRequest, RpcResponse};

const CANCEL_POLL: Duration = Duration::from_millis(25);

pub(crate) struct PlanTransportSuccess<T> {
    pub(crate) result: T,
    pub(crate) cancellation_observed: bool,
}

pub(crate) struct PlanTransportError {
    pub(crate) reason: StudioReasonCode,
    pub(crate) written: bool,
}

pub(crate) fn request<P: Serialize, T: DeserializeOwned>(
    process: &mut ProcessSession,
    id: u64,
    method: &'static str,
    params: P,
    timeout: Duration,
    cancel: &Arc<AtomicBool>,
    events: &mut PlanEventEmitter,
) -> Result<PlanTransportSuccess<T>, PlanTransportError> {
    process
        .coordinator
        .begin(id)
        .map_err(|_| error(StudioReasonCode::SidecarProtocolInvalid, false))?;
    if write_message(
        process,
        &RpcRequest {
            jsonrpc: "2.0",
            id,
            method,
            params,
        },
    )
    .is_err()
    {
        process.coordinator.abandon(id);
        return Err(error(StudioReasonCode::SidecarCrashed, false));
    }
    let deadline = Instant::now() + timeout;
    let mut cancellation_sent = false;
    loop {
        if Instant::now() >= deadline {
            process
                .coordinator
                .retire_timeout(id)
                .map_err(|_| error(StudioReasonCode::SidecarProtocolInvalid, true))?;
            return Err(error(StudioReasonCode::SidecarRequestTimeout, true));
        }
        if process.transport_overflowed() {
            process.coordinator.abandon(id);
            return Err(error(StudioReasonCode::SidecarProtocolInvalid, true));
        }
        if cancel.load(Ordering::SeqCst) && !cancellation_sent {
            let nonce = process.nonce.clone();
            if write_message(
                process,
                &RpcNotification {
                    jsonrpc: "2.0",
                    method: "$/cancelRequest",
                    params: CancelRequestParams {
                        session_nonce: &nonce,
                        id,
                    },
                },
            )
            .is_err()
            {
                process.coordinator.abandon(id);
                return Err(error(StudioReasonCode::SidecarCrashed, true));
            }
            cancellation_sent = true;
            let emitted = events.cancellation_requested();
            let _ = PlanEventEmitter::channel_closed_requests_cancel(emitted, cancel);
        }
        let wait = CANCEL_POLL.min(deadline.saturating_duration_since(Instant::now()));
        match process.receiver.recv_timeout(wait) {
            Ok(ReaderEvent::Frame(frame)) => {
                if let Some(result) = handle_frame(process, id, &frame, events, cancel)? {
                    return Ok(result);
                }
            }
            Ok(ReaderEvent::Protocol | ReaderEvent::Eof) => {
                process.coordinator.abandon(id);
                return Err(error(StudioReasonCode::SidecarProtocolInvalid, true));
            }
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => {
                process.coordinator.abandon(id);
                return Err(error(StudioReasonCode::SidecarCrashed, true));
            }
        }
    }
}

fn handle_frame<T: DeserializeOwned>(
    process: &mut ProcessSession,
    id: u64,
    frame: &str,
    events: &mut PlanEventEmitter,
    cancel: &Arc<AtomicBool>,
) -> Result<Option<PlanTransportSuccess<T>>, PlanTransportError> {
    if let Ok(notification) = serde_json::from_str::<ProgressNotification>(frame) {
        validate_progress(process, id, &notification, events, cancel)?;
        return Ok(None);
    }
    let probe: RpcResponse<IgnoredAny> = serde_json::from_str(frame)
        .map_err(|_| error(StudioReasonCode::SidecarProtocolInvalid, true))?;
    let response_id = match &probe {
        RpcResponse::Success(success) => success.id,
        RpcResponse::Failure(failure) => failure.id,
    };
    match process.coordinator.classify(response_id) {
        IncomingId::Current => {}
        IncomingId::Retired => return Ok(None),
        IncomingId::Completed | IncomingId::Unknown => {
            process.coordinator.abandon(id);
            return Err(error(StudioReasonCode::SidecarProtocolInvalid, true));
        }
    }
    let response: RpcResponse<T> = serde_json::from_str(frame)
        .map_err(|_| error(StudioReasonCode::SidecarProtocolInvalid, true))?;
    match response {
        RpcResponse::Success(success) => {
            if success.jsonrpc != "2.0" || success.id != id {
                process.coordinator.abandon(id);
                return Err(error(StudioReasonCode::SidecarProtocolInvalid, true));
            }
            process
                .coordinator
                .complete(id)
                .map_err(|_| error(StudioReasonCode::SidecarProtocolInvalid, true))?;
            Ok(Some(PlanTransportSuccess {
                result: success.result,
                cancellation_observed: cancel.load(Ordering::SeqCst),
            }))
        }
        RpcResponse::Failure(failure) => {
            if failure.jsonrpc != "2.0" || failure.id != id {
                process.coordinator.abandon(id);
                return Err(error(StudioReasonCode::SidecarProtocolInvalid, true));
            }
            let reason = crate::sidecar::error_registry::remote_reason(&failure.error)
                .map_err(|reason| error(reason, true))?;
            process
                .coordinator
                .complete(id)
                .map_err(|_| error(StudioReasonCode::SidecarProtocolInvalid, true))?;
            Err(error(reason, true))
        }
    }
}

fn validate_progress(
    process: &mut ProcessSession,
    id: u64,
    notification: &ProgressNotification,
    events: &mut PlanEventEmitter,
    cancel: &Arc<AtomicBool>,
) -> Result<(), PlanTransportError> {
    if notification.jsonrpc != "2.0"
        || notification.method != "$/progress"
        || notification.params.request_id != id
        || process.coordinator.classify(id) != IncomingId::Current
    {
        process.coordinator.abandon(id);
        return Err(error(StudioReasonCode::SidecarProtocolInvalid, true));
    }
    let stage = StudioPlanProgressStage::parse(&notification.params.stage).ok_or_else(|| {
        process.coordinator.abandon(id);
        error(StudioReasonCode::SidecarProtocolInvalid, true)
    })?;
    let emitted = events.progress(
        stage,
        notification.params.completed,
        notification.params.total,
    );
    match emitted {
        Ok(()) => Ok(()),
        Err(err) if err.reason_code() == StudioReasonCode::Cancelled => {
            cancel.store(true, Ordering::SeqCst);
            Ok(())
        }
        Err(err) => {
            process.coordinator.abandon(id);
            Err(error(err.reason_code(), true))
        }
    }
}

fn write_message<T: Serialize>(process: &mut ProcessSession, message: &T) -> Result<(), ()> {
    let mut bytes = serde_json::to_vec(message).map_err(|_| ())?;
    bytes.push(b'\n');
    if bytes.len() > MAX_FRAME_BYTES {
        bytes.fill(0);
        return Err(());
    }
    let stdin = match process.stdin.as_mut() {
        Some(stdin) => stdin,
        None => {
            bytes.fill(0);
            return Err(());
        }
    };
    let outcome = stdin
        .write_all(&bytes)
        .and_then(|_| stdin.flush())
        .map_err(|_| ());
    bytes.fill(0);
    outcome
}

const fn error(reason: StudioReasonCode, written: bool) -> PlanTransportError {
    PlanTransportError { reason, written }
}
