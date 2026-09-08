use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum StudioReasonCode {
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
pub struct StudioCommandError {
    schema_version: u8,
    reason_code: StudioReasonCode,
    message: &'static str,
}

impl StudioCommandError {
    pub fn new(reason_code: StudioReasonCode) -> Self {
        Self {
            schema_version: 1,
            reason_code,
            message: "The requested Studio host operation could not be completed.",
        }
    }

    pub const fn reason_code(&self) -> StudioReasonCode {
        self.reason_code
    }
}

impl std::fmt::Display for StudioCommandError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {:?}", self.message, self.reason_code)
    }
}

impl std::error::Error for StudioCommandError {}

pub type StudioResult<T> = Result<T, StudioCommandError>;
