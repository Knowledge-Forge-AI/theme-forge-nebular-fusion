use std::collections::BTreeSet;
use std::io::Write;
use std::path::PathBuf;
use std::sync::mpsc::RecvTimeoutError;
use std::time::{Duration, Instant};

use serde::de::{DeserializeOwned, IgnoredAny};
use tauri::ipc::Channel;

use crate::errors::{StudioCommandError, StudioReasonCode, StudioResult};
use crate::sidecar::artifact::verify_distribution;
use crate::sidecar::brand_protocol::{StudioBrandReadRequest, StudioBrandReadResponse};
use crate::sidecar::coordinator::IncomingId;
use crate::sidecar::framing::MAX_FRAME_BYTES;
use crate::sidecar::process::{
    ProcessSession, ReaderEvent, TerminationOutcome, spawn_process,
    terminate_process as terminate_owned_process,
};
#[cfg(test)]
use crate::sidecar::process::{TerminationFault, spawn_test_process};
use crate::sidecar::protocol::{
    BrandCapabilities, ClientCapabilities, ClientIdentity, EmptyParams, HostLifecycleState,
    InitializeParams, InitializeResult, ProgressNotification, ProjectOpenParams,
    ProjectOpenResponse, ProjectOpenResult, PublicCapabilityLimits, PublicCapabilitySummary,
    PublicPlanCapabilities, PublicSource, RasterCapability, RasterStatus, RpcNotification,
    RpcRequest, RpcResponse, SessionParams, SourceOpenParams, SourceOpenResponse,
    StudioHostStateEvent, StudioHostStatus,
};
use crate::state::plan_coordinator::PlanSessionContext;

mod plan;
pub(crate) use plan::PlanApplyExecution;

const STARTUP_TIMEOUT: Duration = Duration::from_secs(10);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
const SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(3);

pub(crate) struct SidecarSupervisor {
    binary: PathBuf,
    payload: PathBuf,
    temp: PathBuf,
    state: HostLifecycleState,
    sequence: u64,
    next_request_id: u64,
    manifest_digest: Option<String>,
    last_reason_code: Option<&'static str>,
    project_open_count: u32,
    source_open_count: u32,
    session_generation: u64,
    current_project: Option<String>,
    brand_sources: BTreeSet<String>,
    events: Option<Channel<StudioHostStateEvent>>,
    process: Option<ProcessSession>,
    #[cfg(test)]
    test_sidecar: Option<(PathBuf, &'static str)>,
    #[cfg(test)]
    test_timeouts: Option<(Duration, Duration, Duration)>,
    #[cfg(test)]
    test_termination_fault: Option<TerminationFault>,
}

impl SidecarSupervisor {
    pub(crate) fn new(binary: PathBuf, payload: PathBuf, temp: PathBuf) -> Self {
        Self {
            binary,
            payload,
            temp,
            state: HostLifecycleState::NotStarted,
            sequence: 0,
            next_request_id: 1,
            manifest_digest: None,
            last_reason_code: None,
            project_open_count: 0,
            source_open_count: 0,
            session_generation: 0,
            current_project: None,
            brand_sources: BTreeSet::new(),
            events: None,
            process: None,
            #[cfg(test)]
            test_sidecar: None,
            #[cfg(test)]
            test_timeouts: None,
            #[cfg(test)]
            test_termination_fault: None,
        }
    }

    #[cfg(test)]
    fn configure_test_sidecar(
        &mut self,
        executable: PathBuf,
        mode: &'static str,
        timeout: Duration,
    ) {
        self.test_sidecar = Some((executable, mode));
        self.test_timeouts = Some((Duration::from_secs(2), timeout, timeout));
    }

    fn startup_timeout(&self) -> Duration {
        #[cfg(test)]
        if let Some((startup, _, _)) = self.test_timeouts {
            return startup;
        }
        STARTUP_TIMEOUT
    }

    fn request_timeout(&self) -> Duration {
        #[cfg(test)]
        if let Some((_, request, _)) = self.test_timeouts {
            return request;
        }
        REQUEST_TIMEOUT
    }

    fn shutdown_timeout(&self) -> Duration {
        #[cfg(test)]
        if let Some((_, _, shutdown)) = self.test_timeouts {
            return shutdown;
        }
        SHUTDOWN_TIMEOUT
    }

    fn publish(&mut self, state: HostLifecycleState, reason: Option<&'static str>) {
        self.state = state.clone();
        self.last_reason_code = reason;
        self.sequence = self.sequence.saturating_add(1);
        if let Some(channel) = &self.events {
            let _ = channel.send(StudioHostStateEvent {
                schema_version: 1,
                sequence: self.sequence,
                state,
                reason_code: reason,
            });
        }
    }

    fn reason_error(
        &mut self,
        reason: StudioReasonCode,
        public: &'static str,
    ) -> StudioCommandError {
        self.publish(HostLifecycleState::Failed, Some(public));
        StudioCommandError::new(reason)
    }

    pub(crate) fn status(&mut self) -> StudioHostStatus {
        let overflowed = self
            .process
            .as_ref()
            .is_some_and(ProcessSession::transport_overflowed);
        let exited = self
            .process
            .as_mut()
            .is_some_and(|process| process.child.try_wait().ok().flatten().is_some());
        if overflowed {
            let reap = self.force_reap();
            self.publish(
                HostLifecycleState::Failed,
                Some(if reap.is_success() {
                    "sidecar-protocol-invalid"
                } else {
                    "sidecar-shutdown-failed"
                }),
            );
        } else if exited {
            let reap = self.force_reap();
            if reap.is_success() {
                self.publish(HostLifecycleState::Crashed, Some("sidecar-crashed"));
            } else {
                self.publish(HostLifecycleState::Failed, Some("sidecar-shutdown-failed"));
            }
        }
        let (server_version, methods, raster, capabilities) =
            if matches!(self.state, HostLifecycleState::Ready) {
                self.process.as_ref().map_or(
                    (
                        None,
                        Vec::new(),
                        RasterStatus {
                            available: false,
                            qualification_identity: None,
                        },
                        None,
                    ),
                    |process| {
                        (
                            Some(process.server_version.clone()),
                            process.methods.clone(),
                            process.raster.clone(),
                            process.capabilities.clone(),
                        )
                    },
                )
            } else {
                (
                    None,
                    Vec::new(),
                    RasterStatus {
                        available: false,
                        qualification_identity: None,
                    },
                    None,
                )
            };
        StudioHostStatus {
            schema_version: 1,
            studio_version: "0.1.0",
            manifest_digest: self.manifest_digest.clone(),
            state: self.state.clone(),
            selected_protocol_version: matches!(self.state, HostLifecycleState::Ready)
                .then(|| "1.2".to_owned()),
            server_version,
            methods,
            capabilities,
            raster,
            project_open_count: self.project_open_count,
            source_open_count: self.source_open_count,
            last_reason_code: self.last_reason_code,
        }
    }

    pub(crate) fn plan_session_context(&self) -> StudioResult<PlanSessionContext> {
        let process = self
            .process
            .as_ref()
            .filter(|_| matches!(self.state, HostLifecycleState::Ready))
            .ok_or_else(|| StudioCommandError::new(StudioReasonCode::SidecarCrashed))?;
        Ok(PlanSessionContext {
            generation: self.session_generation,
            nonce: process.nonce.clone(),
            project_handle: self.current_project.clone(),
            source_handles: self.brand_sources.clone(),
            raster_plan: process
                .raster
                .available
                .then_some(crate::sidecar::brand_types::QUALIFIED_RASTER_PLAN),
        })
    }

    pub(crate) fn start(
        &mut self,
        events: Channel<StudioHostStateEvent>,
    ) -> StudioResult<StudioHostStatus> {
        self.events = Some(events);
        if matches!(self.state, HostLifecycleState::Ready) {
            let current = self.status();
            if matches!(current.state, HostLifecycleState::Ready) {
                return Ok(current);
            }
        }
        if self.process.is_some() {
            let reap = self.force_reap();
            if !reap.is_success() {
                return Err(self.reason_error(
                    StudioReasonCode::SidecarShutdownFailed,
                    "sidecar-shutdown-failed",
                ));
            }
        }
        self.publish(HostLifecycleState::Verifying, None);
        let verified = verify_distribution(&self.binary, &self.payload).map_err(|error| {
            let unavailable = error.kind() == std::io::ErrorKind::NotFound;
            self.reason_error(
                if unavailable {
                    StudioReasonCode::SidecarArtifactUnavailable
                } else {
                    StudioReasonCode::SidecarArtifactInvalid
                },
                if unavailable {
                    "sidecar-artifact-unavailable"
                } else {
                    "sidecar-artifact-invalid"
                },
            )
        })?;
        self.manifest_digest = Some(verified.manifest_digest.clone());
        self.publish(HostLifecycleState::Starting, None);
        let mut process = self.spawn(&verified).map_err(|error| {
            let unavailable = error.kind() == std::io::ErrorKind::NotFound;
            self.reason_error(
                if unavailable {
                    StudioReasonCode::SidecarArtifactUnavailable
                } else {
                    StudioReasonCode::SidecarArtifactInvalid
                },
                if unavailable {
                    "sidecar-artifact-unavailable"
                } else {
                    "sidecar-artifact-invalid"
                },
            )
        })?;
        self.publish(HostLifecycleState::Initializing, None);
        let initialize = InitializeParams {
            protocol: "tfsb.studio",
            min_version: "1.0",
            max_version: "1.2",
            client: ClientIdentity {
                name: "tfsb-studio",
                version: "0.1.0",
            },
            capabilities: ClientCapabilities {
                progress: true,
                cancellation: true,
            },
        };
        let startup_timeout = self.startup_timeout();
        let result: InitializeResult = match Self::request(
            &mut process,
            self.take_id(),
            "initialize",
            initialize,
            startup_timeout,
        ) {
            Ok(result) => result,
            Err(reason) => {
                let public = match reason {
                    StudioReasonCode::SidecarStartupTimeout => "sidecar-startup-timeout",
                    StudioReasonCode::SidecarProtocolInvalid => "sidecar-protocol-invalid",
                    StudioReasonCode::SidecarCrashed => "sidecar-crashed",
                    _ => "sidecar-initialization-failed",
                };
                let reason = self.terminate_with_reason(process, reason, public);
                return Err(StudioCommandError::new(reason));
            }
        };
        if Self::validate_initialize(&result).is_err() {
            let reason = self.terminate_with_reason(
                process,
                StudioReasonCode::SidecarProtocolInvalid,
                "sidecar-protocol-invalid",
            );
            return Err(StudioCommandError::new(reason));
        }
        let initialized = RpcNotification {
            jsonrpc: "2.0",
            method: "initialized",
            params: SessionParams {
                session_nonce: &result.session_nonce,
            },
        };
        if Self::write_message(&mut process, &initialized).is_err() {
            let reason = self.terminate_with_reason(
                process,
                StudioReasonCode::SidecarProtocolInvalid,
                "sidecar-protocol-invalid",
            );
            return Err(StudioCommandError::new(reason));
        }
        process.nonce = result.session_nonce;
        process.server_version = result.server.version;
        process.methods = result
            .capabilities
            .methods
            .iter()
            .filter_map(|(name, enabled)| enabled.then_some(name.clone()))
            .collect();
        process.methods.sort();
        process.raster = Self::public_raster(&result.capabilities.brand);
        process.capabilities = Some(Self::public_capabilities(&result.capabilities));
        self.process = Some(process);
        self.session_generation = self.session_generation.saturating_add(1).max(1);
        self.current_project = None;
        self.brand_sources.clear();
        self.publish(HostLifecycleState::Ready, None);
        Ok(self.status())
    }

    fn public_raster(brand: &BrandCapabilities) -> RasterStatus {
        match &brand.raster {
            RasterCapability::Unavailable(_) => RasterStatus {
                available: false,
                qualification_identity: None,
            },
            RasterCapability::Available(_) => RasterStatus {
                available: true,
                qualification_identity: Some(
                    "sha256:4bb08e677b87ef1ca74c35c5c22f547cebef4c22a1f98a08a9246fd9397d0f11",
                ),
            },
        }
    }

    fn public_capabilities(
        capabilities: &crate::sidecar::protocol::ServerCapabilities,
    ) -> PublicCapabilitySummary {
        let brand = &capabilities.brand;
        PublicCapabilitySummary {
            base_methods: vec![
                "assetDiff",
                "assetGet",
                "assetList",
                "assetValidate",
                "cancellation",
                "mutationPlans",
                "planApply",
                "previewStatus",
                "progress",
                "projectList",
                "projectOpen",
                "sourceAnalyze",
                "sourceOpen",
                "workspaceOpen",
                "workspaceStatus",
            ],
            brand_reads: vec![
                "consumerLockStatus",
                "consumerProfileList",
                "diff",
                "exportCapability",
                "exportStatus",
                "familyList",
                "qaProfileGet",
                "qaProfileList",
                "qaResultGet",
                "recipeGraph",
                "status",
                "tokenList",
                "visualEvidenceGet",
            ],
            brand_source_purposes: vec!["brandBundle", "npmInstalledPackage"],
            limits: PublicCapabilityLimits {
                asset_page_size_default: 64,
                asset_page_size_max: 128,
                asset_page_size_min: 1,
                brand_page_size_default: 64,
                brand_page_size_max: 128,
                brand_page_size_min: 1,
                max_diff_result_bytes: MAX_FRAME_BYTES as u64,
                max_frame_bytes: MAX_FRAME_BYTES as u64,
                max_qa_result_bytes: MAX_FRAME_BYTES as u64,
            },
            plan_capabilities: PublicPlanCapabilities {
                consumer_install: brand.methods.get("consumerInstallPlan") == Some(&true),
                consumer_sync: brand.methods.get("consumerSyncPlan") == Some(&true),
                derive: brand.methods.get("derivePlan") == Some(&true),
                export: brand.methods.get("exportPlan") == Some(&true),
                qa_baseline: brand.methods.get("qaBaselinePlan") == Some(&true),
            },
        }
    }

    fn validate_initialize(result: &InitializeResult) -> Result<(), ()> {
        const METHODS: &[&str] = &[
            "assetDiff",
            "assetGet",
            "assetList",
            "assetValidate",
            "cancellation",
            "mutationPlans",
            "planApply",
            "previewStatus",
            "progress",
            "projectList",
            "projectOpen",
            "sourceAnalyze",
            "sourceOpen",
            "workspaceOpen",
            "workspaceStatus",
        ];
        if result.protocol != "tfsb.studio"
            || result.selected_version != "1.2"
            || result.server.name != "tfsb-studio-service"
            || result.server.version != "0.1.0"
            || result.session_nonce.len() != 43
            || !result
                .session_nonce
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
            || result.capabilities.methods.len() != METHODS.len()
        {
            return Err(());
        }
        for method in METHODS {
            if result.capabilities.methods.get(*method) != Some(&true) {
                return Err(());
            }
        }
        const BASE_LIMITS: &[(&str, u64)] = &[
            ("assetPageSizeDefault", 64),
            ("assetPageSizeMax", 128),
            ("assetPageSizeMin", 1),
            ("maxActivePlans", 4),
            ("maxConcurrentApplies", 1),
            ("maxConcurrentReads", 4),
            ("maxFrameBytes", MAX_FRAME_BYTES as u64),
            ("maxQueuedReads", 4),
            ("maxRetainedNativeSnapshotPlans", 1),
            ("maxRetainedPlanBytes", 201_326_592),
            ("planTtlMs", 600_000),
            ("sourceDetailPageSizeDefault", 64),
            ("sourceDetailPageSizeMax", 128),
            ("sourceDetailPageSizeMin", 1),
        ];
        const BRAND_READS: &[&str] = &[
            "consumerLockStatus",
            "consumerProfileList",
            "diff",
            "exportCapability",
            "exportStatus",
            "familyList",
            "qaProfileGet",
            "qaProfileList",
            "qaResultGet",
            "recipeGraph",
            "status",
            "tokenList",
        ];
        const BRAND_LIMITS: &[(&str, u64)] = &[
            ("maxDiffResultBytes", MAX_FRAME_BYTES as u64),
            ("maxExportOutputs", 128),
            ("maxQaResultBytes", MAX_FRAME_BYTES as u64),
            ("maxSelectedProfiles", 8),
            ("maxSourcePackages", 8),
            ("pageSizeDefault", 64),
            ("pageSizeMax", 128),
            ("pageSizeMin", 1),
        ];
        let brand = &result.capabilities.brand;
        let raster_available = match &brand.raster {
            RasterCapability::Unavailable(value) => !value.available,
            RasterCapability::Available(value) => {
                crate::sidecar::brand_types::QUALIFIED_RASTER_PLAN.matches_initialize(value)
            }
        };
        let visual_available = match &brand.visual_evidence {
            crate::sidecar::protocol::VisualEvidenceCapability::Unavailable(value) => {
                value.available
            }
            crate::sidecar::protocol::VisualEvidenceCapability::Available(value) => {
                value.available
                    && value.media_types == ["image/png"]
                    && value.encoding == "base64"
                    && value.max_dimension == 1_024
                    && value.max_pixels == 1_048_576
                    && value.max_artifact_bytes == 6_291_456
                    && value.max_aggregate_artifact_bytes == 8_388_608
                    && value.max_result_bytes == 12_582_912
                    && value.max_artifacts == 2
            }
        };
        let brand_plans = [
            "derivePlan",
            "qaBaselinePlan",
            "consumerInstallPlan",
            "consumerSyncPlan",
            "exportPlan",
        ];
        if result.capabilities.limits.len() != BASE_LIMITS.len()
            || BASE_LIMITS
                .iter()
                .any(|(name, value)| result.capabilities.limits.get(*name) != Some(value))
            || brand.schema_version != 1
            || brand.methods.len() != BRAND_READS.len() + brand_plans.len() + 1
            || BRAND_READS
                .iter()
                .any(|name| brand.methods.get(*name) != Some(&true))
            || brand.methods.get("derivePlan") != Some(&true)
            || brand.methods.get("consumerInstallPlan") != Some(&true)
            || brand.methods.get("consumerSyncPlan") != Some(&true)
            || brand.methods.get("qaBaselinePlan")
                != Some(&matches!(&brand.raster, RasterCapability::Available(_)))
            || brand.methods.get("exportPlan")
                != Some(&matches!(&brand.raster, RasterCapability::Available(_)))
            || brand.methods.get("visualEvidenceGet") != Some(&visual_available)
            || brand.source_purposes.len() != 2
            || brand.source_purposes.get("brandBundle") != Some(&true)
            || brand.source_purposes.get("npmInstalledPackage") != Some(&true)
            || brand.limits.len() != BRAND_LIMITS.len()
            || BRAND_LIMITS
                .iter()
                .any(|(name, value)| brand.limits.get(*name) != Some(value))
            || !raster_available
            || visual_available != matches!(&brand.raster, RasterCapability::Available(_))
        {
            return Err(());
        }
        Ok(())
    }

    fn spawn(
        &self,
        verified: &crate::sidecar::artifact::VerifiedDistribution,
    ) -> std::io::Result<ProcessSession> {
        #[cfg(test)]
        if let Some((executable, mode)) = &self.test_sidecar {
            let mut process = spawn_test_process(executable, mode)?;
            process.termination_fault = self.test_termination_fault;
            return Ok(process);
        }
        spawn_process(verified, &self.temp)
    }

    pub(crate) fn take_id(&mut self) -> u64 {
        let id = self.next_request_id;
        self.next_request_id = self.next_request_id.checked_add(1).unwrap_or(1);
        id
    }

    fn write_message<T: serde::Serialize>(
        process: &mut ProcessSession,
        message: &T,
    ) -> Result<(), ()> {
        let mut bytes = serde_json::to_vec(message).map_err(|_| ())?;
        bytes.push(b'\n');
        if bytes.len() > MAX_FRAME_BYTES {
            return Err(());
        }
        let stdin = process.stdin.as_mut().ok_or(())?;
        stdin
            .write_all(&bytes)
            .and_then(|_| stdin.flush())
            .map_err(|_| ())
    }

    fn request<P: serde::Serialize, T: DeserializeOwned>(
        process: &mut ProcessSession,
        id: u64,
        method: &'static str,
        params: P,
        timeout: Duration,
    ) -> Result<T, StudioReasonCode> {
        process
            .coordinator
            .begin(id)
            .map_err(|_| StudioReasonCode::SidecarProtocolInvalid)?;
        if Self::write_message(
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
            return Err(StudioReasonCode::SidecarCrashed);
        }
        let deadline = Instant::now() + timeout;
        loop {
            let now = Instant::now();
            if now >= deadline {
                process
                    .coordinator
                    .retire_timeout(id)
                    .map_err(|_| StudioReasonCode::SidecarProtocolInvalid)?;
                debug_assert!(process.coordinator.is_bounded());
                return Err(if method == "initialize" {
                    StudioReasonCode::SidecarStartupTimeout
                } else {
                    StudioReasonCode::SidecarRequestTimeout
                });
            }
            if process.transport_overflowed() {
                process.coordinator.abandon(id);
                return Err(StudioReasonCode::SidecarProtocolInvalid);
            }
            let remaining = deadline.duration_since(now);
            match process.receiver.recv_timeout(remaining) {
                Ok(ReaderEvent::Frame(frame)) => {
                    if Instant::now() >= deadline {
                        process
                            .coordinator
                            .retire_timeout(id)
                            .map_err(|_| StudioReasonCode::SidecarProtocolInvalid)?;
                        debug_assert!(process.coordinator.is_bounded());
                        return Err(if method == "initialize" {
                            StudioReasonCode::SidecarStartupTimeout
                        } else {
                            StudioReasonCode::SidecarRequestTimeout
                        });
                    }
                    if process.transport_overflowed() {
                        process.coordinator.abandon(id);
                        return Err(StudioReasonCode::SidecarProtocolInvalid);
                    }
                    if let Ok(notification) = serde_json::from_str::<ProgressNotification>(&frame) {
                        match process.coordinator.classify(notification.params.request_id) {
                            IncomingId::Retired => continue,
                            IncomingId::Current => {}
                            IncomingId::Completed | IncomingId::Unknown => {
                                process.coordinator.abandon(id);
                                return Err(StudioReasonCode::SidecarProtocolInvalid);
                            }
                        }
                        const STAGES: &[&str] = &[
                            "started",
                            "scanning",
                            "complete",
                            "validate",
                            "snapshot",
                            "analyze",
                            "plan",
                            "ready",
                            "revalidate",
                            "waiting-lock",
                            "staging",
                            "promoting",
                            "cleanup",
                        ];
                        if notification.jsonrpc != "2.0"
                            || notification.method != "$/progress"
                            || notification.params.request_id != id
                            || !STAGES.contains(&notification.params.stage.as_str())
                            || notification
                                .params
                                .total
                                .is_some_and(|total| notification.params.completed > total)
                        {
                            process.coordinator.abandon(id);
                            return Err(StudioReasonCode::SidecarProtocolInvalid);
                        }
                        continue;
                    }
                    let probe: RpcResponse<IgnoredAny> = serde_json::from_str(&frame)
                        .map_err(|_| StudioReasonCode::SidecarProtocolInvalid)?;
                    let response_id = match &probe {
                        RpcResponse::Success(success) => success.id,
                        RpcResponse::Failure(failure) => failure.id,
                    };
                    match process.coordinator.classify(response_id) {
                        IncomingId::Retired => continue,
                        IncomingId::Current => {}
                        IncomingId::Completed | IncomingId::Unknown => {
                            process.coordinator.abandon(id);
                            return Err(StudioReasonCode::SidecarProtocolInvalid);
                        }
                    }
                    let response: RpcResponse<T> =
                        serde_json::from_str(&frame).map_err(|_error| {
                            #[cfg(test)]
                            eprintln!("typed response validation failed: {_error}");
                            StudioReasonCode::SidecarProtocolInvalid
                        })?;
                    match response {
                        RpcResponse::Success(success) => {
                            if success.jsonrpc != "2.0" || success.id != id {
                                process.coordinator.abandon(id);
                                return Err(StudioReasonCode::SidecarProtocolInvalid);
                            }
                            let transport = process.transport.clone();
                            let state = transport
                                .lock()
                                .map_err(|_| StudioReasonCode::SidecarProtocolInvalid)?;
                            if state.overflowed {
                                process.coordinator.abandon(id);
                                return Err(StudioReasonCode::SidecarProtocolInvalid);
                            }
                            process
                                .coordinator
                                .complete(id)
                                .map_err(|_| StudioReasonCode::SidecarProtocolInvalid)?;
                            return Ok(success.result);
                        }
                        RpcResponse::Failure(failure) => {
                            if failure.jsonrpc != "2.0" || failure.id != id {
                                process.coordinator.abandon(id);
                                return Err(StudioReasonCode::SidecarProtocolInvalid);
                            }
                            let reason = Self::remote_reason(&failure.error)?;
                            let transport = process.transport.clone();
                            let state = transport
                                .lock()
                                .map_err(|_| StudioReasonCode::SidecarProtocolInvalid)?;
                            if state.overflowed {
                                process.coordinator.abandon(id);
                                return Err(StudioReasonCode::SidecarProtocolInvalid);
                            }
                            process
                                .coordinator
                                .complete(id)
                                .map_err(|_| StudioReasonCode::SidecarProtocolInvalid)?;
                            return Err(reason);
                        }
                    }
                }
                Ok(ReaderEvent::Protocol | ReaderEvent::Eof) => {
                    if Instant::now() >= deadline {
                        process
                            .coordinator
                            .retire_timeout(id)
                            .map_err(|_| StudioReasonCode::SidecarProtocolInvalid)?;
                        debug_assert!(process.coordinator.is_bounded());
                        return Err(if method == "initialize" {
                            StudioReasonCode::SidecarStartupTimeout
                        } else {
                            StudioReasonCode::SidecarRequestTimeout
                        });
                    }
                    process.coordinator.abandon(id);
                    return Err(StudioReasonCode::SidecarProtocolInvalid);
                }
                Err(RecvTimeoutError::Timeout) => {
                    process
                        .coordinator
                        .retire_timeout(id)
                        .map_err(|_| StudioReasonCode::SidecarProtocolInvalid)?;
                    debug_assert!(process.coordinator.is_bounded());
                    return Err(if method == "initialize" {
                        StudioReasonCode::SidecarStartupTimeout
                    } else {
                        StudioReasonCode::SidecarRequestTimeout
                    });
                }
                Err(RecvTimeoutError::Disconnected) => {
                    process.coordinator.abandon(id);
                    return Err(StudioReasonCode::SidecarCrashed);
                }
            }
        }
    }

    fn remote_reason(
        error: &crate::sidecar::protocol::RpcError,
    ) -> Result<StudioReasonCode, StudioReasonCode> {
        crate::sidecar::error_registry::remote_reason(error)
    }

    pub(crate) fn open_project(
        &mut self,
        path: &str,
        mode: &'static str,
    ) -> StudioResult<ProjectOpenResult> {
        let id = self.take_id();
        let mut process = self
            .process
            .take()
            .ok_or_else(|| StudioCommandError::new(StudioReasonCode::SidecarCrashed))?;
        let nonce = process.nonce.clone();
        let request_timeout = self.request_timeout();
        let response: Result<ProjectOpenResponse, StudioReasonCode> = Self::request(
            &mut process,
            id,
            "project.open",
            ProjectOpenParams {
                session_nonce: &nonce,
                path,
                mode,
            },
            request_timeout,
        );
        let result = match response.and_then(|value| {
            value
                .into_public()
                .map_err(|_| StudioReasonCode::SidecarProtocolInvalid)
        }) {
            Ok(result) => result,
            Err(reason) if Self::is_remote_reason(reason) => {
                self.process = Some(process);
                return Err(StudioCommandError::new(reason));
            }
            Err(reason) => {
                let reason =
                    self.terminate_with_reason(process, reason, Self::transport_reason(reason));
                return Err(StudioCommandError::new(reason));
            }
        };
        self.process = Some(process);
        self.project_open_count = self.project_open_count.saturating_add(1);
        self.current_project = Some(result.project_handle.clone());
        self.brand_sources.clear();
        Ok(result)
    }

    pub(crate) fn open_source(
        &mut self,
        path: &str,
        purpose: &'static str,
    ) -> StudioResult<PublicSource> {
        let id = self.take_id();
        let mut process = self
            .process
            .take()
            .ok_or_else(|| StudioCommandError::new(StudioReasonCode::SidecarCrashed))?;
        let nonce = process.nonce.clone();
        let request_timeout = self.request_timeout();
        let response: Result<SourceOpenResponse, StudioReasonCode> = Self::request(
            &mut process,
            id,
            "source.open",
            SourceOpenParams {
                session_nonce: &nonce,
                path,
                purpose,
            },
            request_timeout,
        );
        let result = match response.and_then(|value| {
            value
                .into_public()
                .map_err(|_| StudioReasonCode::SidecarProtocolInvalid)
        }) {
            Ok(result) => result,
            Err(reason) if Self::is_remote_reason(reason) => {
                self.process = Some(process);
                return Err(StudioCommandError::new(reason));
            }
            Err(reason) => {
                let reason =
                    self.terminate_with_reason(process, reason, Self::transport_reason(reason));
                return Err(StudioCommandError::new(reason));
            }
        };
        self.process = Some(process);
        self.source_open_count = self.source_open_count.saturating_add(1);
        if matches!(
            result.authority_kind.as_deref(),
            Some("brand-bundle" | "npm-installed-package")
        ) {
            self.brand_sources.insert(result.source_handle.clone());
        }
        Ok(result)
    }

    pub(crate) fn brand_read(
        &mut self,
        request: StudioBrandReadRequest,
    ) -> StudioResult<StudioBrandReadResponse> {
        let id = self.take_id();
        let mut process = self
            .process
            .take()
            .ok_or_else(|| StudioCommandError::new(StudioReasonCode::SidecarCrashed))?;
        let prepared = request.prepare(&process.nonce)?;
        let request_timeout = self.request_timeout();
        let response = Self::request(
            &mut process,
            id,
            prepared.method,
            prepared.params,
            request_timeout,
        );
        let result = match response {
            Ok(value) => request.wrap_response(value),
            Err(reason) if Self::is_remote_reason(reason) => {
                self.process = Some(process);
                return Err(StudioCommandError::new(reason));
            }
            Err(StudioReasonCode::SidecarRequestTimeout) => {
                self.process = Some(process);
                return Err(StudioCommandError::new(StudioReasonCode::RequestTimeout));
            }
            Err(StudioReasonCode::SidecarProtocolInvalid) => {
                let reason = self.terminate_with_reason(
                    process,
                    StudioReasonCode::ProtocolInvalid,
                    "sidecar-protocol-invalid",
                );
                return Err(StudioCommandError::new(reason));
            }
            Err(reason) => {
                let reason =
                    self.terminate_with_reason(process, reason, Self::transport_reason(reason));
                return Err(StudioCommandError::new(reason));
            }
        };
        match result {
            Ok(result) => {
                self.process = Some(process);
                Ok(result)
            }
            Err(_) => {
                let reason = self.terminate_with_reason(
                    process,
                    StudioReasonCode::ProtocolInvalid,
                    "sidecar-protocol-invalid",
                );
                Err(StudioCommandError::new(reason))
            }
        }
    }

    pub(crate) fn shutdown(&mut self) -> StudioResult<()> {
        if self.process.is_none() {
            self.publish(HostLifecycleState::Stopped, None);
            self.events = None;
            return Ok(());
        }
        self.publish(HostLifecycleState::Stopping, None);
        let id = self.take_id();
        let mut process = self
            .process
            .take()
            .ok_or_else(|| StudioCommandError::new(StudioReasonCode::SidecarShutdownFailed))?;
        let nonce = process.nonce.clone();
        let shutdown_timeout = self.shutdown_timeout();
        let graceful = Self::request::<_, ()>(
            &mut process,
            id,
            "shutdown",
            SessionParams {
                session_nonce: &nonce,
            },
            shutdown_timeout,
        )
        .is_ok();
        let _ = Self::write_message(
            &mut process,
            &RpcNotification {
                jsonrpc: "2.0",
                method: "exit",
                params: EmptyParams {},
            },
        );
        let terminated = terminate_owned_process(&mut process);
        let terminal_clean = !process.transport_overflowed()
            && process
                .receiver
                .try_iter()
                .all(|event| matches!(event, ReaderEvent::Eof));
        if graceful && terminated.is_success() && terminal_clean {
            self.publish(HostLifecycleState::Stopped, None);
            self.events = None;
            Ok(())
        } else {
            if terminated.is_unreaped() {
                self.process = Some(process);
            }
            self.publish(HostLifecycleState::Failed, Some("sidecar-shutdown-failed"));
            self.events = None;
            Err(StudioCommandError::new(
                StudioReasonCode::SidecarShutdownFailed,
            ))
        }
    }

    fn force_reap(&mut self) -> TerminationOutcome {
        if let Some(mut process) = self.process.take() {
            let terminated = terminate_owned_process(&mut process);
            if terminated.is_unreaped() {
                self.process = Some(process);
            }
            terminated
        } else {
            TerminationOutcome::Success
        }
    }

    fn terminate_process(&mut self, mut process: ProcessSession) -> TerminationOutcome {
        let terminated = terminate_owned_process(&mut process);
        if terminated.is_unreaped() {
            self.process = Some(process);
        }
        terminated
    }

    fn terminate_with_reason(
        &mut self,
        process: ProcessSession,
        reason: StudioReasonCode,
        public: &'static str,
    ) -> StudioReasonCode {
        let terminated = self.terminate_process(process);
        if terminated.is_success() {
            self.publish(HostLifecycleState::Failed, Some(public));
            reason
        } else {
            self.publish(HostLifecycleState::Failed, Some("sidecar-shutdown-failed"));
            StudioReasonCode::SidecarShutdownFailed
        }
    }

    const fn is_remote_reason(reason: StudioReasonCode) -> bool {
        matches!(
            reason,
            StudioReasonCode::Cancelled
                | StudioReasonCode::CapabilityUnavailable
                | StudioReasonCode::ContextInvalid
                | StudioReasonCode::ContextStale
                | StudioReasonCode::CursorStale
                | StudioReasonCode::DigestMismatch
                | StudioReasonCode::DomainFailed
                | StudioReasonCode::PlanInvalid
                | StudioReasonCode::RequestBusy
                | StudioReasonCode::ResultTooLarge
                | StudioReasonCode::SidecarRemoteRejected
                | StudioReasonCode::Stale
        )
    }

    const fn transport_reason(reason: StudioReasonCode) -> &'static str {
        match reason {
            StudioReasonCode::SidecarRequestTimeout => "sidecar-request-timeout",
            StudioReasonCode::SidecarProtocolInvalid => "sidecar-protocol-invalid",
            StudioReasonCode::SidecarCrashed => "sidecar-crashed",
            _ => "sidecar-request-failed",
        }
    }
}

impl Drop for SidecarSupervisor {
    fn drop(&mut self) {
        let _ = self.force_reap();
    }
}

#[cfg(test)]
mod plan_tests;
#[cfg(test)]
mod tests;
