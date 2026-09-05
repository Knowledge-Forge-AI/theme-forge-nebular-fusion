use crate::errors::StudioReasonCode;
use crate::sidecar::protocol::{RpcError, bounded_text};

#[derive(Clone, Copy)]
pub(crate) struct RemoteErrorSpec {
    pub(crate) symbolic: &'static str,
    pub(crate) numeric: i64,
    pub(crate) retryable: bool,
    pub(crate) public: StudioReasonCode,
}

use StudioReasonCode::{
    Cancelled, CapabilityUnavailable, ContextInvalid, ContextStale, CursorStale, DigestMismatch,
    DomainFailed, PlanInvalid, RequestBusy, ResultTooLarge, SidecarRemoteRejected, Stale,
};

pub(crate) const REMOTE_ERROR_REGISTRY: &[RemoteErrorSpec] = &[
    RemoteErrorSpec {
        symbolic: "PARSE_ERROR",
        numeric: -32700,
        retryable: false,
        public: SidecarRemoteRejected,
    },
    RemoteErrorSpec {
        symbolic: "INVALID_REQUEST",
        numeric: -32600,
        retryable: false,
        public: SidecarRemoteRejected,
    },
    RemoteErrorSpec {
        symbolic: "METHOD_NOT_FOUND",
        numeric: -32601,
        retryable: false,
        public: SidecarRemoteRejected,
    },
    RemoteErrorSpec {
        symbolic: "INVALID_PARAMS",
        numeric: -32602,
        retryable: false,
        public: SidecarRemoteRejected,
    },
    RemoteErrorSpec {
        symbolic: "INTERNAL_ERROR",
        numeric: -32603,
        retryable: false,
        public: SidecarRemoteRejected,
    },
    RemoteErrorSpec {
        symbolic: "INVALID_REQUEST_ID",
        numeric: -32000,
        retryable: false,
        public: SidecarRemoteRejected,
    },
    RemoteErrorSpec {
        symbolic: "PROTOCOL_VERSION_UNSUPPORTED",
        numeric: -32001,
        retryable: false,
        public: SidecarRemoteRejected,
    },
    RemoteErrorSpec {
        symbolic: "SESSION_NOT_INITIALIZED",
        numeric: -32002,
        retryable: true,
        public: SidecarRemoteRejected,
    },
    RemoteErrorSpec {
        symbolic: "SESSION_NONCE_INVALID",
        numeric: -32003,
        retryable: false,
        public: SidecarRemoteRejected,
    },
    RemoteErrorSpec {
        symbolic: "ROOT_INVALID",
        numeric: -32010,
        retryable: false,
        public: ContextStale,
    },
    RemoteErrorSpec {
        symbolic: "ROOT_HANDLE_INVALID",
        numeric: -32011,
        retryable: false,
        public: ContextInvalid,
    },
    RemoteErrorSpec {
        symbolic: "METHOD_CAPABILITY_UNAVAILABLE",
        numeric: -32020,
        retryable: false,
        public: CapabilityUnavailable,
    },
    RemoteErrorSpec {
        symbolic: "REQUEST_BUSY",
        numeric: -32030,
        retryable: true,
        public: RequestBusy,
    },
    RemoteErrorSpec {
        symbolic: "REQUEST_CANCELLED",
        numeric: -32031,
        retryable: true,
        public: Cancelled,
    },
    RemoteErrorSpec {
        symbolic: "PLAN_TOKEN_INVALID",
        numeric: -32040,
        retryable: false,
        public: PlanInvalid,
    },
    RemoteErrorSpec {
        symbolic: "PLAN_STALE",
        numeric: -32041,
        retryable: false,
        public: Stale,
    },
    RemoteErrorSpec {
        symbolic: "PLAN_DIGEST_MISMATCH",
        numeric: -32042,
        retryable: false,
        public: DigestMismatch,
    },
    RemoteErrorSpec {
        symbolic: "CURSOR_INVALID",
        numeric: -32050,
        retryable: false,
        public: SidecarRemoteRejected,
    },
    RemoteErrorSpec {
        symbolic: "CURSOR_STALE",
        numeric: -32051,
        retryable: true,
        public: CursorStale,
    },
    RemoteErrorSpec {
        symbolic: "DOMAIN_OPERATION_FAILED",
        numeric: -32060,
        retryable: false,
        public: DomainFailed,
    },
    RemoteErrorSpec {
        symbolic: "MESSAGE_TOO_LARGE",
        numeric: -32061,
        retryable: false,
        public: ResultTooLarge,
    },
];

pub(crate) fn remote_reason(error: &RpcError) -> Result<StudioReasonCode, StudioReasonCode> {
    if !bounded_text(&error.message, 1, 512)
        || !bounded_text(&error.data.message, 1, 512)
        || error.data.location.as_ref().is_some_and(|value| {
            !bounded_text(value, 1, 512)
                || value.starts_with('/')
                || value.starts_with("../")
                || value.contains('\\')
        })
    {
        return Err(StudioReasonCode::SidecarProtocolInvalid);
    }
    let Some(spec) = REMOTE_ERROR_REGISTRY
        .iter()
        .find(|spec| spec.symbolic == error.data.code)
    else {
        return Err(StudioReasonCode::SidecarProtocolInvalid);
    };
    if error.code != spec.numeric || error.data.retryable != spec.retryable {
        return Err(StudioReasonCode::SidecarProtocolInvalid);
    }
    Ok(spec.public)
}
