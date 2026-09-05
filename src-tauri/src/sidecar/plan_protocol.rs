use serde::{Deserialize, Serialize};
use serde_json::value::Value as JsonNode;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::ipc::Channel;

use crate::errors::{StudioCommandError, StudioReasonCode, StudioResult};
use crate::sidecar::brand_types::{BrandPlanMethod, StudioPlanSummary};
use crate::sidecar::protocol::{bounded_text, valid_digest, valid_handle};

#[derive(Debug, Clone, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub(crate) enum StudioBrandPlanStartRequest {
    CreateDerive {
        project_handle: String,
        selection: DeriveSelection,
    },
    CreateQaBaseline {
        project_handle: String,
        profile_id: String,
        case_id: String,
    },
    CreateConsumerInstall {
        project_handle: String,
        source_handles: Vec<String>,
        profile_ids: Vec<String>,
        parameters: Vec<ConsumerParameterSelection>,
    },
    CreateConsumerSync {
        project_handle: String,
        source_handles: Vec<String>,
        #[serde(default)]
        profile_ids: Option<Vec<String>>,
        #[serde(default)]
        parameters: Option<Vec<ConsumerParameterSelection>>,
    },
    CreateExport {
        project_handle: String,
        profile_id: String,
        #[serde(default)]
        output_ids: Option<Vec<String>>,
    },
    Apply {
        plan_handle: String,
        expected_plan_digest: String,
    },
    Discard {
        plan_handle: String,
    },
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub(crate) enum DeriveSelection {
    All,
    Recipes { recipe_ids: Vec<String> },
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ConsumerParameterSelection {
    pub(crate) profile_id: String,
    pub(crate) values: Vec<ConsumerParameterValue>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ConsumerParameterValue {
    pub(crate) parameter: String,
    pub(crate) value: String,
}

impl StudioBrandPlanStartRequest {
    pub(crate) fn validate(&self) -> StudioResult<()> {
        match self {
            Self::CreateDerive {
                project_handle,
                selection,
            } => {
                project(project_handle)?;
                if let DeriveSelection::Recipes { recipe_ids } = selection {
                    ids(recipe_ids, 1, 128, true)?;
                }
            }
            Self::CreateQaBaseline {
                project_handle,
                profile_id,
                case_id,
            } => {
                project(project_handle)?;
                public_id(profile_id)?;
                public_id(case_id)?;
            }
            Self::CreateConsumerInstall {
                project_handle,
                source_handles,
                profile_ids,
                parameters,
            } => {
                project(project_handle)?;
                handles(source_handles)?;
                ids(profile_ids, 1, 8, false)?;
                validate_parameters(parameters)?;
            }
            Self::CreateConsumerSync {
                project_handle,
                source_handles,
                profile_ids,
                parameters,
            } => {
                project(project_handle)?;
                handles(source_handles)?;
                if let Some(values) = profile_ids {
                    ids(values, 1, 8, false)?;
                }
                if let Some(values) = parameters {
                    validate_parameters(values)?;
                }
            }
            Self::CreateExport {
                project_handle,
                profile_id,
                output_ids,
            } => {
                project(project_handle)?;
                public_id(profile_id)?;
                if let Some(values) = output_ids {
                    ids(values, 1, 128, true)?;
                }
            }
            Self::Apply {
                plan_handle,
                expected_plan_digest,
            } => {
                local_plan_handle(plan_handle)?;
                if !valid_digest(expected_plan_digest) {
                    return invalid();
                }
            }
            Self::Discard { plan_handle } => local_plan_handle(plan_handle)?,
        }
        Ok(())
    }

    pub(crate) const fn is_create(&self) -> bool {
        matches!(
            self,
            Self::CreateDerive { .. }
                | Self::CreateQaBaseline { .. }
                | Self::CreateConsumerInstall { .. }
                | Self::CreateConsumerSync { .. }
                | Self::CreateExport { .. }
        )
    }

    pub(crate) fn public_project(&self) -> Option<&str> {
        match self {
            Self::CreateDerive { project_handle, .. }
            | Self::CreateQaBaseline { project_handle, .. }
            | Self::CreateConsumerInstall { project_handle, .. }
            | Self::CreateConsumerSync { project_handle, .. }
            | Self::CreateExport { project_handle, .. } => Some(project_handle),
            Self::Apply { .. } | Self::Discard { .. } => None,
        }
    }

    pub(crate) fn public_sources(&self) -> &[String] {
        match self {
            Self::CreateConsumerInstall { source_handles, .. }
            | Self::CreateConsumerSync { source_handles, .. } => source_handles,
            _ => &[],
        }
    }

    pub(crate) fn prepare_create(&self, nonce: &str) -> StudioResult<(BrandPlanMethod, JsonNode)> {
        let (method, value) = match self {
            Self::CreateDerive {
                project_handle,
                selection,
            } => (
                BrandPlanMethod::Derive,
                serde_json::to_value(DeriveParams {
                    session_nonce: nonce,
                    project_handle,
                    selection,
                }),
            ),
            Self::CreateQaBaseline {
                project_handle,
                profile_id,
                case_id,
            } => (
                BrandPlanMethod::QaBaseline,
                serde_json::to_value(QaParams {
                    session_nonce: nonce,
                    project_handle,
                    profile_id,
                    case_id,
                }),
            ),
            Self::CreateConsumerInstall {
                project_handle,
                source_handles,
                profile_ids,
                parameters,
            } => (
                BrandPlanMethod::ConsumerInstall,
                serde_json::to_value(ConsumerParams {
                    session_nonce: nonce,
                    project_handle,
                    source_handles,
                    profiles: Some(profile_ids),
                    parameters: Some(parameters),
                }),
            ),
            Self::CreateConsumerSync {
                project_handle,
                source_handles,
                profile_ids,
                parameters,
            } => (
                BrandPlanMethod::ConsumerSync,
                serde_json::to_value(ConsumerParams {
                    session_nonce: nonce,
                    project_handle,
                    source_handles,
                    profiles: profile_ids.as_ref(),
                    parameters: parameters.as_ref(),
                }),
            ),
            Self::CreateExport {
                project_handle,
                profile_id,
                output_ids,
            } => (
                BrandPlanMethod::Export,
                serde_json::to_value(ExportParams {
                    session_nonce: nonce,
                    project_handle,
                    profile_id,
                    output_ids: output_ids.as_ref(),
                }),
            ),
            Self::Apply { .. } | Self::Discard { .. } => return invalid(),
        };
        Ok((
            method,
            value.map_err(|_| StudioCommandError::new(StudioReasonCode::ProtocolInvalid))?,
        ))
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DeriveParams<'a> {
    session_nonce: &'a str,
    project_handle: &'a str,
    selection: &'a DeriveSelection,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct QaParams<'a> {
    session_nonce: &'a str,
    project_handle: &'a str,
    profile_id: &'a str,
    case_id: &'a str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ConsumerParams<'a> {
    session_nonce: &'a str,
    project_handle: &'a str,
    source_handles: &'a [String],
    #[serde(skip_serializing_if = "Option::is_none")]
    profiles: Option<&'a Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    parameters: Option<&'a Vec<ConsumerParameterSelection>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ExportParams<'a> {
    session_nonce: &'a str,
    project_handle: &'a str,
    profile_id: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    output_ids: Option<&'a Vec<String>>,
}

#[derive(Debug, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub(crate) enum StudioBrandPlanStartResult {
    Ready {
        plan_handle: String,
        plan_digest: String,
        method: BrandPlanMethod,
        expires_in_ms: u64,
        summary: Box<StudioPlanSummary>,
        project_handle: String,
        source_handles: Vec<String>,
    },
    Applied {
        method: BrandPlanMethod,
    },
    Discarded,
    Indeterminate {
        method: BrandPlanMethod,
    },
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct StudioBrandPlanCancelRequest {
    pub(crate) operation_handle: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StudioBrandPlanCancelResult {
    pub(crate) accepted: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum StudioPlanProgressStage {
    Validate,
    Snapshot,
    Analyze,
    Plan,
    Ready,
    Revalidate,
    WaitingLock,
    Staging,
    Promoting,
    Cleanup,
    Complete,
}

impl StudioPlanProgressStage {
    pub(crate) fn parse(value: &str) -> Option<Self> {
        match value {
            "validate" => Some(Self::Validate),
            "snapshot" => Some(Self::Snapshot),
            "analyze" => Some(Self::Analyze),
            "plan" => Some(Self::Plan),
            "ready" => Some(Self::Ready),
            "revalidate" => Some(Self::Revalidate),
            "waiting-lock" => Some(Self::WaitingLock),
            "staging" => Some(Self::Staging),
            "promoting" => Some(Self::Promoting),
            "cleanup" => Some(Self::Cleanup),
            "complete" => Some(Self::Complete),
            _ => None,
        }
    }

    pub(crate) const fn order(self) -> u8 {
        match self {
            Self::Validate | Self::Revalidate => 0,
            Self::Snapshot | Self::WaitingLock => 1,
            Self::Analyze | Self::Staging => 2,
            Self::Plan | Self::Promoting => 3,
            Self::Ready | Self::Cleanup => 4,
            Self::Complete => 5,
        }
    }

    pub(crate) const fn is_apply(self) -> bool {
        matches!(
            self,
            Self::Revalidate
                | Self::WaitingLock
                | Self::Staging
                | Self::Promoting
                | Self::Cleanup
                | Self::Complete
        )
    }
}

#[derive(Debug, Serialize)]
#[serde(tag = "state", rename_all = "kebab-case")]
pub(crate) enum StudioPlanOperationState {
    Started,
    Progress { progress: StudioPlanProgress },
    CancellationRequested,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StudioPlanProgress {
    pub(crate) stage: StudioPlanProgressStage,
    pub(crate) completed: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) total: Option<u64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StudioPlanOperationEvent {
    pub(crate) schema_version: u8,
    pub(crate) sequence: u64,
    pub(crate) operation_handle: String,
    #[serde(flatten)]
    pub(crate) state: StudioPlanOperationState,
}

pub(crate) struct PlanEventEmitter {
    channel: Channel<StudioPlanOperationEvent>,
    operation_handle: String,
    sequence: u64,
    last_progress: Option<(StudioPlanProgressStage, u64, Option<u64>)>,
    apply: bool,
    cancellation_emitted: bool,
}

impl PlanEventEmitter {
    pub(crate) fn new(
        channel: Channel<StudioPlanOperationEvent>,
        operation_handle: String,
        apply: bool,
    ) -> Self {
        Self {
            channel,
            operation_handle,
            sequence: 0,
            last_progress: None,
            apply,
            cancellation_emitted: false,
        }
    }

    pub(crate) fn started(&mut self) -> StudioResult<()> {
        self.send(StudioPlanOperationState::Started)
    }

    pub(crate) fn cancellation_requested(&mut self) -> StudioResult<()> {
        if self.cancellation_emitted {
            return Ok(());
        }
        self.cancellation_emitted = true;
        self.send(StudioPlanOperationState::CancellationRequested)
    }

    pub(crate) fn progress(
        &mut self,
        stage: StudioPlanProgressStage,
        completed: u64,
        total: Option<u64>,
    ) -> StudioResult<()> {
        if stage.is_apply() != self.apply
            || total.is_some_and(|value| completed > value)
            || self
                .last_progress
                .is_some_and(|(prior_stage, prior_completed, prior_total)| {
                    stage.order() < prior_stage.order()
                        || stage == prior_stage
                            && (completed <= prior_completed || total != prior_total)
                })
        {
            return invalid();
        }
        self.last_progress = Some((stage, completed, total));
        self.send(StudioPlanOperationState::Progress {
            progress: StudioPlanProgress {
                stage,
                completed,
                total,
            },
        })
    }

    fn send(&mut self, state: StudioPlanOperationState) -> StudioResult<()> {
        self.sequence = self.sequence.saturating_add(1);
        self.channel
            .send(StudioPlanOperationEvent {
                schema_version: 1,
                sequence: self.sequence,
                operation_handle: self.operation_handle.clone(),
                state,
            })
            .map_err(|_| StudioCommandError::new(StudioReasonCode::Cancelled))
    }

    pub(crate) fn channel_closed_requests_cancel(
        result: StudioResult<()>,
        cancel: &Arc<AtomicBool>,
    ) -> StudioResult<()> {
        if result.is_err() {
            cancel.store(true, Ordering::SeqCst);
        }
        result
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RawPlanResult {
    pub(crate) plan_token: String,
    pub(crate) plan_digest: String,
    pub(crate) expires_in_ms: u64,
    pub(crate) method: BrandPlanMethod,
    pub(crate) summary: JsonNode,
}

impl RawPlanResult {
    pub(crate) fn validate(self, expected: BrandPlanMethod) -> StudioResult<DecodedPlanResult> {
        if self.plan_token.len() != 43
            || !self
                .plan_token
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
            || !valid_digest(&self.plan_digest)
            || self.expires_in_ms != 600_000
            || self.method != expected
        {
            return invalid();
        }
        let summary = StudioPlanSummary::decode(expected, self.summary)?;
        Ok(DecodedPlanResult {
            plan_token: self.plan_token,
            plan_digest: self.plan_digest,
            method: expected,
            summary,
        })
    }
}

pub(crate) struct DecodedPlanResult {
    pub(crate) plan_token: String,
    pub(crate) plan_digest: String,
    pub(crate) method: BrandPlanMethod,
    pub(crate) summary: StudioPlanSummary,
}

#[derive(Debug, Deserialize)]
#[serde(untagged)]
pub(crate) enum PlanApplyResult {
    Empty(()),
    Applied(PlanApplied),
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct PlanApplied {
    pub(crate) applied: bool,
    pub(crate) method: BrandPlanMethod,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct PlanDiscardResult {
    pub(crate) discarded: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PlanApplyParams<'a> {
    pub(crate) session_nonce: &'a str,
    pub(crate) plan_token: &'a str,
    pub(crate) expected_plan_digest: &'a str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PlanDiscardParams<'a> {
    pub(crate) session_nonce: &'a str,
    pub(crate) plan_token: &'a str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CancelRequestParams<'a> {
    pub(crate) session_nonce: &'a str,
    pub(crate) id: u64,
}

fn validate_parameters(values: &[ConsumerParameterSelection]) -> StudioResult<()> {
    if values.len() > 8 {
        return invalid();
    }
    let mut prior = None;
    for entry in values {
        if !bounded_text(&entry.profile_id, 1, 512)
            || entry.values.len() > 16
            || prior
                .as_ref()
                .is_some_and(|value| value >= &entry.profile_id)
        {
            return invalid();
        }
        prior = Some(entry.profile_id.clone());
        let mut prior_parameter = None;
        for selected in &entry.values {
            if !public_id(&selected.parameter).is_ok()
                || !bounded_text(&selected.value, 1, 256)
                || prior_parameter
                    .as_ref()
                    .is_some_and(|value| value >= &selected.parameter)
            {
                return invalid();
            }
            prior_parameter = Some(selected.parameter.clone());
        }
    }
    Ok(())
}

fn handles(values: &[String]) -> StudioResult<()> {
    if values.is_empty() || values.len() > 8 {
        return invalid();
    }
    let mut prior = None;
    for value in values {
        if !valid_handle(value, "source_") || prior.as_ref().is_some_and(|entry| entry >= value) {
            return invalid();
        }
        prior = Some(value.clone());
    }
    Ok(())
}

fn ids(values: &[String], minimum: usize, maximum: usize, strict: bool) -> StudioResult<()> {
    if values.len() < minimum || values.len() > maximum {
        return invalid();
    }
    let mut prior = None;
    for value in values {
        if (strict && public_id(value).is_err())
            || (!strict && !bounded_text(value, 1, 512))
            || prior.as_ref().is_some_and(|entry| entry >= value)
        {
            return invalid();
        }
        prior = Some(value.clone());
    }
    Ok(())
}

fn project(value: &str) -> StudioResult<()> {
    if valid_handle(value, "project_") {
        Ok(())
    } else {
        invalid()
    }
}

fn public_id(value: &str) -> StudioResult<()> {
    let valid = !value.is_empty()
        && value.len() <= 256
        && value.is_ascii()
        && value
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
        && value.as_bytes().first().is_some_and(u8::is_ascii_lowercase)
        && !value.ends_with('-')
        && !value.contains("--");
    if valid { Ok(()) } else { invalid() }
}

fn local_plan_handle(value: &str) -> StudioResult<()> {
    if value.len() == 69
        && value.starts_with("plan_")
        && value[5..]
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    {
        Ok(())
    } else {
        invalid()
    }
}

fn invalid<T>() -> StudioResult<T> {
    Err(StudioCommandError::new(StudioReasonCode::ProtocolInvalid))
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::sync::atomic::{AtomicBool, Ordering};

    use serde_json::{Value as JsonNode, json};

    use super::{
        BrandPlanMethod, PlanApplyResult, PlanEventEmitter, RawPlanResult,
        StudioBrandPlanStartRequest, StudioBrandPlanStartResult, StudioPlanProgressStage,
    };
    use crate::errors::{StudioCommandError, StudioReasonCode};

    const DIGEST: &str = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    fn derive_summary() -> JsonNode {
        json!({
            "selectedRecipes": ["recipe-one"], "transitiveRecipes": [], "affectedTargets": [],
            "createdCount": 0, "updatedCount": 0, "unchangedCount": 0,
            "operationSummaries": [], "targetStates": [], "tokenDigest": DIGEST,
            "recipeDigest": DIGEST, "brandSystemDigest": DIGEST, "warnings": [], "dryRun": true
        })
    }

    #[test]
    fn command_requests_are_closed_and_translate_only_to_typed_protocol_params() {
        let raw = json!({ "kind": "create-consumer-install", "projectHandle": "project_safe", "sourceHandles": ["source_safe"], "profileIds": ["package/profile"], "parameters": [{ "profileId": "package/profile", "values": [{ "parameter": "theme", "value": "dark" }] }] });
        let request: Result<StudioBrandPlanStartRequest, _> = serde_json::from_value(raw);
        assert!(request.as_ref().is_ok_and(|value| value.validate().is_ok()));
        let prepared = request
            .ok()
            .and_then(|value| value.prepare_create("private-nonce").ok());
        assert!(prepared.as_ref().is_some_and(|(method, params)| {
            *method == BrandPlanMethod::ConsumerInstall
                && params.get("sessionNonce").and_then(JsonNode::as_str) == Some("private-nonce")
                && params
                    .get("profiles")
                    .and_then(JsonNode::as_array)
                    .is_some_and(|values| values.len() == 1)
        }));
        let with_extra: Result<StudioBrandPlanStartRequest, _> = serde_json::from_value(
            json!({ "kind": "discard", "planHandle": format!("plan_{}", "a".repeat(64)), "planToken": "forbidden" }),
        );
        assert!(with_extra.is_err());
    }

    #[test]
    fn raw_plan_token_is_consumed_only_into_private_decode_and_never_public_serialization() {
        let token = "A".repeat(43);
        let decoded = RawPlanResult {
            plan_token: token.clone(),
            plan_digest: DIGEST.to_owned(),
            expires_in_ms: 600_000,
            method: BrandPlanMethod::Derive,
            summary: derive_summary(),
        }
        .validate(BrandPlanMethod::Derive);
        assert!(decoded.is_ok());
        if let Ok(decoded) = decoded {
            let public = StudioBrandPlanStartResult::Ready {
                plan_handle: format!("plan_{}", "b".repeat(64)),
                plan_digest: decoded.plan_digest,
                method: decoded.method,
                expires_in_ms: 600_000,
                summary: Box::new(decoded.summary),
                project_handle: "project_safe".to_owned(),
                source_handles: Vec::new(),
            };
            let serialized = serde_json::to_string(&public).unwrap_or_default();
            assert!(!serialized.contains(&token));
            assert!(!serialized.contains("planToken"));
            assert!(!serialized.contains("sessionNonce"));
            assert!(!serialized.contains("requestId"));
        }
    }

    #[test]
    fn result_wrappers_and_progress_stages_are_closed() {
        let applied: Result<PlanApplyResult, _> =
            serde_json::from_value(json!({ "applied": true, "method": "brand.export.plan" }));
        let invalid: Result<PlanApplyResult, _> = serde_json::from_value(
            json!({ "applied": true, "method": "brand.export.plan", "extra": true }),
        );
        assert!(matches!(applied, Ok(PlanApplyResult::Applied(_))));
        assert!(invalid.is_err());
        assert!(
            StudioPlanProgressStage::parse("waiting-lock")
                .is_some_and(StudioPlanProgressStage::is_apply)
        );
        assert!(StudioPlanProgressStage::parse("invented").is_none());

        let cancel = Arc::new(AtomicBool::new(false));
        let closed = PlanEventEmitter::channel_closed_requests_cancel(
            Err(StudioCommandError::new(StudioReasonCode::Cancelled)),
            &cancel,
        );
        assert!(closed.is_err());
        assert!(cancel.load(Ordering::SeqCst));
    }
}
