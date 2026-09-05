use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum StudioReasonCode {
    CapabilityUnavailable,
    CursorStale,
    DomainFailed,
    DigestMismatch,
    ContextInvalid,
    ContextStale,
    PlanActive,
    PlanExpired,
    PlanInvalid,
    ResultTooLarge,
    Stale,
    Cancelled,
    ProtocolInvalid,
    RequestBusy,
    RequestTimeout,
    SidecarArtifactUnavailable,
    SidecarArtifactInvalid,
    SidecarBusy,
    SidecarCrashed,
    SidecarProtocolInvalid,
    SidecarStartupTimeout,
    SidecarRequestTimeout,
    SidecarShutdownFailed,
    SidecarRemoteRejected,
    DialogUnavailable,
    SelectionRejected,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StudioCommandError {
    schema_version: u8,
    reason_code: StudioReasonCode,
    message: &'static str,
}

impl StudioCommandError {
    pub(crate) fn new(reason_code: StudioReasonCode) -> Self {
        Self {
            schema_version: 1,
            reason_code,
            message: "The requested Studio host operation could not be completed.",
        }
    }

    pub(crate) const fn reason_code(&self) -> StudioReasonCode {
        self.reason_code
    }
}

pub(crate) type StudioResult<T> = Result<T, StudioCommandError>;
