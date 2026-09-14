use std::collections::BTreeMap;
use std::path::PathBuf;
use std::time::{Duration, Instant, SystemTime};

use sha2::{Digest, Sha256};

use super::io::{display_name, get_parent_identity};
use super::protocol_dto::{
    SceneCompiledPreview, SceneDiagnosticDto, SceneDraftResponse, SceneExpected, SceneMetricsDto,
    ScenePlanResponse, SceneReceiptDto, SceneStatusResponse,
};
use super::types::{
    SCENE_COMPATIBILITY, SCENE_COMPILER_LEVEL, SCENE_SCHEMA, SceneEditOperation, SceneElement,
    VectorScene,
};
use crate::errors::{StudioCommandError, StudioReasonCode, StudioResult};

pub const PLAN_TTL: Duration = Duration::from_secs(300); // 5 minutes
pub const MAX_RETAINED_PACKETS: usize = 4;
pub const MAX_PACKETS_AGGREGATE_BYTES: usize = 32 * 1024 * 1024; // 32 MiB
pub const MAX_PACKET_BYTES: usize = 16 * 1024 * 1024; // 16 MiB

pub fn compute_sha256(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReplacementReservation {
    pub intent_id: String,
    pub session_id: String,
    pub revision: u64,
    pub draft_input_digest: String,
}

#[derive(Debug, Clone)]
pub struct RetainedPlan {
    pub plan_id: String,
    pub kind: PlanKind,
    pub target_path: PathBuf,
    pub target_display_name: String,
    pub target_parent_identity: (u64, u64),
    pub bytes: Vec<u8>,
    pub canonical_digest: String,
    pub session_id: String,
    pub revision: u64,
    pub created_at: Instant,
    pub expires_at: Instant,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PlanKind {
    SaveJson,
    ExportSvg,
}

impl RetainedPlan {
    pub fn is_expired(&self) -> bool {
        Instant::now() >= self.expires_at
    }
}

#[derive(Debug, Clone)]
pub struct RetainedPacket {
    pub packet_id: String,
    pub kind: String,
    pub canonical_json: String,
    pub packet_digest: String,
    pub sender_claims: Vec<String>,
    pub created_at: Instant,
}

#[derive(Debug, Clone)]
pub struct RetainedVerification {
    pub handle: String,
    pub candidate_packet_id: String,
    pub candidate_digest: String,
    pub compiled_svg_digest: Option<String>,
    pub verified_scene: VectorScene,
    pub metrics: Option<SceneMetricsDto>,
    pub diagnostics: Vec<SceneDiagnosticDto>,
    pub created_at: Instant,
}

#[derive(Debug)]
pub struct SceneSession {
    pub session_id: String,
    pub revision: u64,
    pub source_id: Option<String>,
    pub source_path: Option<PathBuf>,
    pub source_display_name: Option<String>,
    pub source_digest: Option<String>,
    pub token_snapshot_id: Option<String>,
    pub last_host_generation: u64,
    pub active_replacement_intent: Option<ReplacementReservation>,
    pub current_scene: VectorScene,
    pub canonical_json: String,
    pub draft_input_digest: String,
    pub dirty: bool,
    pub disposed: bool,
    pub validated_json: Option<String>,
    pub compiled_svg: Option<String>,
    pub compiled_svg_digest: Option<String>,
    pub receipt: Option<SceneReceiptDto>,
    pub metrics: Option<SceneMetricsDto>,
    pub diagnostics: Vec<SceneDiagnosticDto>,
    pub retained_save_plan: Option<RetainedPlan>,
    pub retained_export_plan: Option<RetainedPlan>,
    pub retained_packets: Vec<RetainedPacket>,
    pub retained_verifications: Vec<RetainedVerification>,
}

fn element_id(element: &SceneElement) -> Option<&str> {
    match element {
        SceneElement::Path { id, .. }
        | SceneElement::Rect { id, .. }
        | SceneElement::Circle { id, .. }
        | SceneElement::Ellipse { id, .. }
        | SceneElement::Line { id, .. }
        | SceneElement::Polyline { id, .. }
        | SceneElement::Polygon { id, .. }
        | SceneElement::Group { id, .. }
        | SceneElement::Use { id, .. }
        | SceneElement::Connector { id, .. }
        | SceneElement::Label { id, .. } => id.as_deref(),
        SceneElement::DiagramNode { id, .. } => Some(id.as_str()),
    }
}

impl Default for SceneSession {
    fn default() -> Self {
        Self::new()
    }
}

impl SceneSession {
    pub fn new() -> Self {
        let nanos = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let session_id = format!("tfsb-scene-session-{nanos}");
        let default_scene = VectorScene::default();
        let canonical_json = serde_json::to_string(&default_scene).unwrap_or_default();
        let draft_input_digest = compute_sha256(canonical_json.as_bytes());

        Self {
            session_id,
            revision: 0,
            source_id: None,
            source_path: None,
            source_display_name: None,
            source_digest: None,
            token_snapshot_id: None,
            last_host_generation: 0,
            active_replacement_intent: None,
            current_scene: default_scene,
            canonical_json,
            draft_input_digest,
            dirty: false,
            disposed: false,
            validated_json: None,
            compiled_svg: None,
            compiled_svg_digest: None,
            receipt: None,
            metrics: None,
            diagnostics: Vec::new(),
            retained_save_plan: None,
            retained_export_plan: None,
            retained_packets: Vec::new(),
            retained_verifications: Vec::new(),
        }
    }

    pub fn is_initial_untouched(&self) -> bool {
        self.revision == 0 && !self.dirty && self.source_id.is_none() && !self.disposed
    }

    pub fn next_revision(&mut self) -> StudioResult<u64> {
        if self.disposed {
            return Err(StudioCommandError::new(StudioReasonCode::ContextStale));
        }
        self.revision = self
            .revision
            .checked_add(1)
            .ok_or_else(|| StudioCommandError::new(StudioReasonCode::ContextStale))?;
        Ok(self.revision)
    }

    pub fn check_expected(&self, expected: &SceneExpected) -> StudioResult<()> {
        if self.disposed {
            return Err(StudioCommandError::new(StudioReasonCode::ContextStale));
        }
        if self.session_id != expected.session_id {
            return Err(StudioCommandError::new(StudioReasonCode::ContextInvalid));
        }
        if self.revision != expected.revision {
            return Err(StudioCommandError::new(StudioReasonCode::Stale));
        }
        if let Some(ref expected_digest) = expected.draft_input_digest
            && expected_digest != &self.draft_input_digest
        {
            return Err(StudioCommandError::new(StudioReasonCode::DigestMismatch));
        }
        if expected.source_id != self.source_id
            || expected.token_snapshot_id != self.token_snapshot_id
        {
            return Err(StudioCommandError::new(StudioReasonCode::ContextStale));
        }
        if expected
            .engine_identity
            .as_deref()
            .is_some_and(|id| id != "tfsb.vector-scene-v1:1:1")
        {
            return Err(StudioCommandError::new(StudioReasonCode::ContextStale));
        }
        Ok(())
    }

    pub fn begin_replacement_intent(
        &mut self,
        expected: Option<&SceneExpected>,
        client_intent_id: Option<&str>,
    ) -> StudioResult<ReplacementReservation> {
        if self.disposed {
            return Err(StudioCommandError::new(StudioReasonCode::ContextStale));
        }
        if !self.is_initial_untouched() {
            let exp = expected
                .ok_or_else(|| StudioCommandError::new(StudioReasonCode::ContextInvalid))?;
            self.check_expected(exp)?;
        } else if let Some(exp) = expected {
            self.check_expected(exp)?;
        }

        if let Some(client_id) = client_intent_id
            && let Some(ref active) = self.active_replacement_intent
            && active.intent_id != client_id
        {
            return Err(StudioCommandError::new(StudioReasonCode::Stale));
        }

        let nanos = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let intent_id = format!("native-intent-{}-{}", self.revision, nanos);

        let reservation = ReplacementReservation {
            intent_id,
            session_id: self.session_id.clone(),
            revision: self.revision,
            draft_input_digest: self.draft_input_digest.clone(),
        };
        self.active_replacement_intent = Some(reservation.clone());
        Ok(reservation)
    }

    pub fn cancel_replacement_intent(&mut self, reservation: &ReplacementReservation) {
        if self.active_replacement_intent.as_ref() == Some(reservation) {
            self.active_replacement_intent = None;
        }
    }

    pub fn validate_replacement_intent(
        &self,
        reservation: &ReplacementReservation,
    ) -> StudioResult<()> {
        if self.disposed {
            return Err(StudioCommandError::new(StudioReasonCode::ContextStale));
        }
        if self.session_id != reservation.session_id {
            return Err(StudioCommandError::new(StudioReasonCode::ContextInvalid));
        }
        if self.revision != reservation.revision {
            return Err(StudioCommandError::new(StudioReasonCode::Stale));
        }
        if self.draft_input_digest != reservation.draft_input_digest {
            return Err(StudioCommandError::new(StudioReasonCode::DigestMismatch));
        }
        if self.active_replacement_intent.as_ref() != Some(reservation) {
            return Err(StudioCommandError::new(StudioReasonCode::Stale));
        }
        Ok(())
    }

    pub fn invalidate_evidence(&mut self) {
        self.retained_verifications.clear();
        self.retained_save_plan = None;
        self.retained_export_plan = None;
        self.validated_json = None;
        self.compiled_svg = None;
        self.compiled_svg_digest = None;
        self.receipt = None;
        self.metrics = None;
        self.diagnostics.clear();
    }

    pub fn update_canonical(&mut self) -> StudioResult<()> {
        let json = serde_json::to_string(&self.current_scene)
            .map_err(|_| StudioCommandError::new(StudioReasonCode::DomainFailed))?;
        self.draft_input_digest = compute_sha256(json.as_bytes());
        self.canonical_json = json;
        Ok(())
    }

    pub fn dispose(&mut self) {
        self.disposed = true;
        self.active_replacement_intent = None;
        self.retained_save_plan = None;
        self.retained_export_plan = None;
        self.retained_packets.clear();
        self.retained_verifications.clear();
    }

    pub fn status(&self) -> SceneStatusResponse {
        SceneStatusResponse {
            scene: (self.revision > 0).then(|| self.current_scene.clone()),
            session_id: self.session_id.clone(),
            revision: self.revision,
            source_id: self.source_id.clone(),
            source_display_name: self.source_display_name.clone(),
            dirty: self.dirty,
            disposed: self.disposed,
            draft_input_digest: self.draft_input_digest.clone(),
            token_snapshot_id: self.token_snapshot_id.clone(),
            has_compiled_svg: self.compiled_svg.is_some(),
            compiled_svg_digest: self.compiled_svg_digest.clone(),
            retained_save_plan: self
                .retained_save_plan
                .as_ref()
                .is_some_and(|p| !p.is_expired()),
            retained_export_plan: self
                .retained_export_plan
                .as_ref()
                .is_some_and(|p| !p.is_expired()),
            retained_packets_count: self.retained_packets.len(),
            diagnostics: self.diagnostics.clone(),
        }
    }

    pub fn draft_response(&self) -> SceneDraftResponse {
        let compiled = if let (Some(svg), Some(svg_digest), Some(receipt), Some(metrics)) = (
            &self.compiled_svg,
            &self.compiled_svg_digest,
            &self.receipt,
            &self.metrics,
        ) {
            Some(SceneCompiledPreview {
                svg: svg.clone(),
                svg_digest: svg_digest.clone(),
                receipt: receipt.clone(),
                metrics: metrics.clone(),
            })
        } else {
            None
        };

        SceneDraftResponse {
            session_id: self.session_id.clone(),
            revision: self.revision,
            source_id: self.source_id.clone(),
            dirty: self.dirty,
            scene: self.current_scene.clone(),
            canonical_json: self.canonical_json.clone(),
            draft_input_digest: self.draft_input_digest.clone(),
            token_snapshot_id: self.token_snapshot_id.clone(),
            compiled,
            diagnostics: self.diagnostics.clone(),
        }
    }

    pub fn apply_edits(&mut self, operations: Vec<SceneEditOperation>) -> StudioResult<()> {
        if self.disposed {
            return Err(StudioCommandError::new(StudioReasonCode::ContextStale));
        }
        if operations.is_empty() {
            return Ok(());
        }
        if operations.len() > 64
            || serde_json::to_vec(&operations)
                .map_err(|_| StudioCommandError::new(StudioReasonCode::ProtocolInvalid))?
                .len()
                > 1024 * 1024
        {
            return Err(StudioCommandError::new(StudioReasonCode::ResultTooLarge));
        }

        // Transactional execution: mutate a clone, only swap on complete success
        let mut tentative = self.current_scene.clone();

        for op in operations {
            match op {
                SceneEditOperation::SetArtboard { artboard } => {
                    tentative.artboard = artboard;
                }
                SceneEditOperation::SetProfile { profile } => {
                    tentative.profile = profile;
                }
                SceneEditOperation::SetAccessibility { accessibility } => {
                    tentative.accessibility = accessibility;
                }
                SceneEditOperation::InsertElement { index, element } => {
                    if tentative.elements.len() >= 2000 {
                        return Err(StudioCommandError::new(StudioReasonCode::ResultTooLarge));
                    }
                    match index {
                        Some(i) if i <= tentative.elements.len() => {
                            tentative.elements.insert(i, element);
                        }
                        _ => tentative.elements.push(element),
                    }
                }
                SceneEditOperation::UpdateElement { id, element } => {
                    let mut found = false;
                    for el in &mut tentative.elements {
                        if element_id(el) == Some(&id) {
                            *el = element.clone();
                            found = true;
                            break;
                        }
                    }
                    if !found {
                        return Err(StudioCommandError::new(StudioReasonCode::SelectionRejected));
                    }
                }
                SceneEditOperation::RemoveElement { id } => {
                    tentative.elements.retain(|el| element_id(el) != Some(&id));
                }
                SceneEditOperation::MoveElement { id, new_index } => {
                    let pos = tentative
                        .elements
                        .iter()
                        .position(|el| element_id(el) == Some(&id));
                    if let Some(p) = pos {
                        let el = tentative.elements.remove(p);
                        let target = new_index.min(tentative.elements.len());
                        tentative.elements.insert(target, el);
                    } else {
                        return Err(StudioCommandError::new(StudioReasonCode::SelectionRejected));
                    }
                }
                SceneEditOperation::SetDefinitions { definitions } => {
                    tentative.definitions = definitions;
                }
                SceneEditOperation::SetTokenBindings { token_bindings } => {
                    tentative.token_bindings = token_bindings;
                }
                SceneEditOperation::SetLayout { layout } => {
                    tentative.layout = layout;
                }
                SceneEditOperation::SetProvenance { provenance } => {
                    tentative.provenance = provenance;
                }
                SceneEditOperation::ReplaceScene { scene } => {
                    if scene.schema != SCENE_SCHEMA
                        || scene.compatibility != SCENE_COMPATIBILITY
                        || scene.compiler_level > SCENE_COMPILER_LEVEL
                    {
                        return Err(StudioCommandError::new(StudioReasonCode::ProtocolInvalid));
                    }
                    tentative = scene;
                }
            }
        }

        let bytes = serde_json::to_vec(&tentative)
            .map_err(|_| StudioCommandError::new(StudioReasonCode::ProtocolInvalid))?;
        if bytes.len() > 8 * 1024 * 1024 {
            return Err(StudioCommandError::new(StudioReasonCode::ResultTooLarge));
        }
        self.next_revision()?;
        self.current_scene = tentative;
        self.dirty = true;
        self.invalidate_evidence();
        self.update_canonical()?;
        Ok(())
    }

    pub fn bind_tokens(
        &mut self,
        host_generation: u64,
        bindings: BTreeMap<String, String>,
    ) -> StudioResult<()> {
        if self.disposed {
            return Err(StudioCommandError::new(StudioReasonCode::ContextStale));
        }
        if host_generation < self.last_host_generation {
            return Err(StudioCommandError::new(StudioReasonCode::ContextStale));
        }

        let mut validated_bindings = BTreeMap::new();
        for (name, color_str) in bindings {
            let trimmed = color_str.trim();
            let hex_clean = trimmed.strip_prefix('#').unwrap_or(trimmed);
            if hex_clean.len() == 8 {
                let alpha = &hex_clean[6..8];
                if !alpha.eq_ignore_ascii_case("ff") {
                    return Err(StudioCommandError::new(StudioReasonCode::DomainFailed));
                }
                validated_bindings.insert(name, format!("#{}", &hex_clean[0..6]));
            } else if hex_clean.len() == 6 {
                if !hex_clean.chars().all(|c| c.is_ascii_hexdigit()) {
                    return Err(StudioCommandError::new(StudioReasonCode::DomainFailed));
                }
                validated_bindings.insert(name, format!("#{hex_clean}"));
            } else {
                return Err(StudioCommandError::new(StudioReasonCode::DomainFailed));
            }
        }

        if validated_bindings.len() > 1000 {
            return Err(StudioCommandError::new(StudioReasonCode::ResultTooLarge));
        }
        self.next_revision()?;
        self.last_host_generation = host_generation;
        let binding_bytes = serde_json::to_vec(&validated_bindings)
            .map_err(|_| StudioCommandError::new(StudioReasonCode::DomainFailed))?;
        self.token_snapshot_id = Some(format!(
            "token-snapshot-{}-{}",
            host_generation,
            compute_sha256(&binding_bytes)
        ));
        self.current_scene.token_bindings = Some(validated_bindings);
        self.dirty = true;

        self.invalidate_evidence();
        self.update_canonical()?;
        Ok(())
    }

    pub fn retain_save_plan(&mut self, target_path: PathBuf) -> StudioResult<ScenePlanResponse> {
        if self.disposed {
            return Err(StudioCommandError::new(StudioReasonCode::ContextStale));
        }
        // Save must be disabled for uncompiled or invalid drafts
        let Some(ref _svg) = self.compiled_svg else {
            return Err(StudioCommandError::new(StudioReasonCode::PlanInvalid));
        };
        let Some(ref receipt) = self.receipt else {
            return Err(StudioCommandError::new(StudioReasonCode::PlanInvalid));
        };
        let canonical = self
            .validated_json
            .as_ref()
            .ok_or_else(|| StudioCommandError::new(StudioReasonCode::PlanInvalid))?;
        if receipt.source_digest != format!("sha256:{}", compute_sha256(canonical.as_bytes())) {
            return Err(StudioCommandError::new(StudioReasonCode::DigestMismatch));
        }

        let parent_identity = get_parent_identity(&target_path)?;

        let now = Instant::now();
        let plan_id = format!(
            "scene-save-plan-{:x}",
            SystemTime::now()
                .duration_since(SystemTime::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        );
        let display = display_name(&target_path)
            .ok_or_else(|| StudioCommandError::new(StudioReasonCode::SelectionRejected))?;
        let bytes = canonical.as_bytes().to_vec();
        let byte_count = bytes.len();
        let digest = compute_sha256(&bytes);
        let expires_at = now + PLAN_TTL;
        let expires_at_unix_ms = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64 + 300_000)
            .unwrap_or(0);

        self.retained_save_plan = Some(RetainedPlan {
            plan_id: plan_id.clone(),
            kind: PlanKind::SaveJson,
            target_path,
            target_display_name: display.clone(),
            target_parent_identity: parent_identity,
            bytes,
            canonical_digest: digest.clone(),
            session_id: self.session_id.clone(),
            revision: self.revision,
            created_at: now,
            expires_at,
        });

        Ok(ScenePlanResponse {
            cancelled: false,
            plan_id: Some(plan_id),
            target_display_name: Some(display),
            target_kind: Some("json".to_owned()),
            byte_count: Some(byte_count),
            canonical_digest: Some(digest),
            expires_at_unix_ms: Some(expires_at_unix_ms),
        })
    }

    pub fn retain_export_plan(&mut self, target_path: PathBuf) -> StudioResult<ScenePlanResponse> {
        if self.disposed {
            return Err(StudioCommandError::new(StudioReasonCode::ContextStale));
        }
        let Some(ref svg) = self.compiled_svg else {
            return Err(StudioCommandError::new(StudioReasonCode::PlanInvalid));
        };
        let Some(ref receipt) = self.receipt else {
            return Err(StudioCommandError::new(StudioReasonCode::PlanInvalid));
        };
        if self
            .validated_json
            .as_ref()
            .map(|v| format!("sha256:{}", compute_sha256(v.as_bytes())))
            .as_ref()
            != Some(&receipt.source_digest)
        {
            return Err(StudioCommandError::new(StudioReasonCode::PlanInvalid));
        }

        let parent_identity = get_parent_identity(&target_path)?;

        let now = Instant::now();
        let plan_id = format!(
            "scene-export-plan-{:x}",
            SystemTime::now()
                .duration_since(SystemTime::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        );
        let display = display_name(&target_path)
            .ok_or_else(|| StudioCommandError::new(StudioReasonCode::SelectionRejected))?;
        let bytes = svg.as_bytes().to_vec();
        let byte_count = bytes.len();
        let digest = self
            .compiled_svg_digest
            .clone()
            .unwrap_or_else(|| compute_sha256(&bytes));
        let expires_at = now + PLAN_TTL;
        let expires_at_unix_ms = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64 + 300_000)
            .unwrap_or(0);

        self.retained_export_plan = Some(RetainedPlan {
            plan_id: plan_id.clone(),
            kind: PlanKind::ExportSvg,
            target_path,
            target_display_name: display.clone(),
            target_parent_identity: parent_identity,
            bytes,
            canonical_digest: digest.clone(),
            session_id: self.session_id.clone(),
            revision: self.revision,
            created_at: now,
            expires_at,
        });

        Ok(ScenePlanResponse {
            cancelled: false,
            plan_id: Some(plan_id),
            target_display_name: Some(display),
            target_kind: Some("svg".to_owned()),
            byte_count: Some(byte_count),
            canonical_digest: Some(digest),
            expires_at_unix_ms: Some(expires_at_unix_ms),
        })
    }

    pub fn take_save_plan(&mut self, plan_id: &str) -> StudioResult<RetainedPlan> {
        if self.disposed {
            return Err(StudioCommandError::new(StudioReasonCode::ContextStale));
        }
        let plan = self
            .retained_save_plan
            .take()
            .ok_or_else(|| StudioCommandError::new(StudioReasonCode::PlanInvalid))?;
        if plan.plan_id != plan_id {
            return Err(StudioCommandError::new(StudioReasonCode::PlanInvalid));
        }
        if plan.is_expired() {
            return Err(StudioCommandError::new(StudioReasonCode::PlanExpired));
        }
        if plan.session_id != self.session_id || plan.revision != self.revision {
            return Err(StudioCommandError::new(StudioReasonCode::Stale));
        }
        Ok(plan)
    }

    pub fn take_export_plan(&mut self, plan_id: &str) -> StudioResult<RetainedPlan> {
        if self.disposed {
            return Err(StudioCommandError::new(StudioReasonCode::ContextStale));
        }
        let plan = self
            .retained_export_plan
            .take()
            .ok_or_else(|| StudioCommandError::new(StudioReasonCode::PlanInvalid))?;
        if plan.plan_id != plan_id {
            return Err(StudioCommandError::new(StudioReasonCode::PlanInvalid));
        }
        if plan.is_expired() {
            return Err(StudioCommandError::new(StudioReasonCode::PlanExpired));
        }
        if plan.session_id != self.session_id || plan.revision != self.revision {
            return Err(StudioCommandError::new(StudioReasonCode::Stale));
        }
        Ok(plan)
    }

    pub fn retain_packet(
        &mut self,
        packet_id: String,
        kind: String,
        canonical_json: String,
        sender_claims: Vec<String>,
    ) -> StudioResult<RetainedPacket> {
        if self.disposed {
            return Err(StudioCommandError::new(StudioReasonCode::ContextStale));
        }
        if canonical_json.len() > MAX_PACKET_BYTES {
            return Err(StudioCommandError::new(StudioReasonCode::ResultTooLarge));
        }
        let packet_digest = compute_sha256(canonical_json.as_bytes());

        while self.retained_packets.len() >= MAX_RETAINED_PACKETS {
            self.retained_packets.remove(0);
        }
        let mut aggregate: usize = self
            .retained_packets
            .iter()
            .map(|p| p.canonical_json.len())
            .sum();
        while aggregate + canonical_json.len() > MAX_PACKETS_AGGREGATE_BYTES
            && !self.retained_packets.is_empty()
        {
            let removed = self.retained_packets.remove(0);
            aggregate = aggregate.saturating_sub(removed.canonical_json.len());
        }

        let packet = RetainedPacket {
            packet_id,
            kind,
            canonical_json,
            packet_digest,
            sender_claims,
            created_at: Instant::now(),
        };
        self.retained_packets.push(packet.clone());
        Ok(packet)
    }

    pub fn get_packet(&self, packet_id: &str) -> StudioResult<&RetainedPacket> {
        self.retained_packets
            .iter()
            .find(|p| p.packet_id == packet_id)
            .ok_or_else(|| StudioCommandError::new(StudioReasonCode::SelectionRejected))
    }

    pub fn retain_verification(
        &mut self,
        candidate_packet_id: String,
        candidate_digest: String,
        compiled_svg_digest: Option<String>,
        verified_scene: VectorScene,
        metrics: Option<SceneMetricsDto>,
        diagnostics: Vec<SceneDiagnosticDto>,
    ) -> String {
        let handle = format!(
            "scene-verify-{}",
            compute_sha256(candidate_digest.as_bytes())
        );
        self.retained_verifications.retain(|v| v.handle != handle);
        while self.retained_verifications.len() >= 4 {
            self.retained_verifications.remove(0);
        }
        self.retained_verifications.push(RetainedVerification {
            handle: handle.clone(),
            candidate_packet_id,
            candidate_digest,
            compiled_svg_digest,
            verified_scene,
            metrics,
            diagnostics,
            created_at: Instant::now(),
        });
        handle
    }

    pub fn take_verification(&mut self, handle: &str) -> StudioResult<RetainedVerification> {
        let pos = self
            .retained_verifications
            .iter()
            .position(|v| v.handle == handle)
            .ok_or_else(|| StudioCommandError::new(StudioReasonCode::PlanInvalid))?;
        let verification = self.retained_verifications.remove(pos);
        if verification.created_at.elapsed() > PLAN_TTL {
            return Err(StudioCommandError::new(StudioReasonCode::PlanExpired));
        }
        Ok(verification)
    }
}
