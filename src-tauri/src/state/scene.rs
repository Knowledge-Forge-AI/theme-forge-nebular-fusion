use std::path::PathBuf;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::SystemTime;

use crate::errors::{StudioCommandError, StudioReasonCode, StudioResult};
use crate::scene::exchange::{
    BRIEF_SCHEMA, BriefPacketEnvelope, EXCHANGE_SCHEMA_VERSION, MAX_CANDIDATE_IDS_COUNT,
    REVIEW_SCHEMA, ReviewPacketEnvelope, SceneExchangePacket, parse_exchange_packet,
};
use crate::scene::io::{
    MAX_PACKET_FILE_BYTES, MAX_SCENE_FILE_BYTES, MAX_SVG_FILE_BYTES, display_name,
    publish_absent_only_bytes, read_selected_bytes,
};
use crate::scene::protocol_dto::{
    SceneAdoptRequest, SceneApplyRequest, SceneBriefRequest, SceneCompileRequest,
    SceneCompileResponse, SceneDiagnosticDto, SceneDisposeRequest, SceneDisposeResponse,
    SceneDraftResponse, SceneEditRequest, SceneExpected, SceneExportPlanRequest,
    SceneImportResponse, SceneNewRequest, ScenePacketExportRequest, ScenePacketImportRequest,
    ScenePacketResponse, ScenePlanResponse, ScenePublicationResponse, SceneReviewRequest,
    SceneSavePlanRequest, SceneStatusRequest, SceneStatusResponse, SceneTokenBindRequest,
    SceneVerificationResponse, SceneVerifyRequest,
};
use crate::scene::runner::SceneRunner;
use crate::scene::session::{ReplacementReservation, SceneSession, compute_sha256};
use crate::scene::types::{
    SCENE_COMPATIBILITY, SCENE_COMPILER_LEVEL, SCENE_SCHEMA, SceneAccessibility, VectorScene,
};

pub struct SceneState {
    shared: Arc<SceneShared>,
}

impl Clone for SceneState {
    fn clone(&self) -> Self {
        Self {
            shared: Arc::clone(&self.shared),
        }
    }
}

impl std::fmt::Debug for SceneState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SceneState").finish_non_exhaustive()
    }
}

struct SceneShared {
    runner: SceneRunner,
    session: Mutex<SceneSession>,
}

impl SceneState {
    pub fn new(runner: SceneRunner) -> Self {
        Self {
            shared: Arc::new(SceneShared {
                runner,
                session: Mutex::new(SceneSession::new()),
            }),
        }
    }

    fn lock(&self) -> StudioResult<MutexGuard<'_, SceneSession>> {
        self.shared
            .session
            .lock()
            .map_err(|_| StudioCommandError::new(StudioReasonCode::SidecarCrashed))
    }

    pub fn runner(&self) -> &SceneRunner {
        &self.shared.runner
    }

    pub fn shutdown(&self) {
        self.shared.runner.close();
        if let Ok(mut session) = self.lock() {
            session.dispose();
        }
    }

    pub fn begin_replacement(
        &self,
        expected: Option<&SceneExpected>,
        client_intent_id: Option<&str>,
    ) -> StudioResult<ReplacementReservation> {
        let mut session = self.lock()?;
        session.begin_replacement_intent(expected, client_intent_id)
    }

    pub fn cancel_replacement(&self, reservation: &ReplacementReservation) {
        if let Ok(mut session) = self.lock() {
            session.cancel_replacement_intent(reservation);
        }
    }

    pub fn validate_save_plan_preconditions(&self, expected: &SceneExpected) -> StudioResult<()> {
        let session = self.lock()?;
        session.check_expected(expected)?;
        if session.compiled_svg.is_none() || session.receipt.is_none() {
            return Err(StudioCommandError::new(StudioReasonCode::PlanInvalid));
        }
        Ok(())
    }

    pub fn validate_export_plan_preconditions(&self, expected: &SceneExpected) -> StudioResult<()> {
        let session = self.lock()?;
        session.check_expected(expected)?;
        if session.compiled_svg.is_none() || session.receipt.is_none() {
            return Err(StudioCommandError::new(StudioReasonCode::PlanInvalid));
        }
        Ok(())
    }

    pub fn status(&self, request: SceneStatusRequest) -> StudioResult<SceneStatusResponse> {
        let session = self.lock()?;
        if let Some(ref expected) = request.expected {
            session.check_expected(expected)?;
        }
        Ok(session.status())
    }

    pub(crate) fn status_with_host(
        &self,
        request: SceneStatusRequest,
        generation: u64,
    ) -> StudioResult<SceneStatusResponse> {
        let mut response = self.status(request)?;
        let session = self.lock()?;
        if session.token_snapshot_id.is_some() && session.last_host_generation != generation {
            response.diagnostics.push(SceneDiagnosticDto { code: "TOKEN_SOURCE_CHANGED".to_owned(), message: "Brand source changed; explicit token refresh required. The scene snapshot is unchanged.".to_owned(), severity: Some("warning".to_owned()), path: None });
        }
        Ok(response)
    }

    pub fn new_draft(&self, request: SceneNewRequest) -> StudioResult<SceneDraftResponse> {
        let reservation = self.begin_replacement(
            request.expected.as_ref(),
            request.replacement_intent_id.as_deref(),
        )?;
        let mut scene = VectorScene::default();
        if let Some(profile) = request.profile {
            scene.profile = profile;
        }
        if let Some(artboard) = request.artboard {
            scene.artboard = artboard;
        }
        if let Some(ref title) = request.title {
            scene.accessibility = SceneAccessibility::Labelled {
                title: title.clone(),
                desc: None,
                focusable: None,
            };
        }

        // New compiles through the authenticated engine before committing its intent.
        let compile_output = self.shared.runner.compile(&scene, false)?;
        if !compile_output.valid {
            return Err(StudioCommandError::new(StudioReasonCode::ProtocolInvalid));
        }

        let mut session = self.lock()?;
        session.validate_replacement_intent(&reservation)?;
        session.next_revision()?;
        session.invalidate_evidence();
        session.token_snapshot_id = None;
        session.current_scene = scene;
        session.source_id = None;
        session.source_path = None;
        session.source_display_name = None;
        session.source_digest = None;
        session.validated_json = compile_output.canonical_json.clone();
        session.compiled_svg = compile_output.svg.clone();
        session.compiled_svg_digest = compile_output
            .svg
            .as_ref()
            .map(|s| compute_sha256(s.as_bytes()));
        session.receipt = compile_output.receipt;
        session.metrics = compile_output.metrics;
        session.diagnostics = compile_output.diagnostics;
        session.dirty = true;

        session.update_canonical()?;
        session.active_replacement_intent = None;

        Ok(session.draft_response())
    }

    pub fn dispose(&self, request: SceneDisposeRequest) -> StudioResult<SceneDisposeResponse> {
        let mut session = self.lock()?;
        session.check_expected(&request.expected)?;
        session.dispose();
        if !self.shared.runner.close() {
            return Err(StudioCommandError::new(StudioReasonCode::RequestTimeout));
        }
        Ok(SceneDisposeResponse {
            session_id: session.session_id.clone(),
            disposed: true,
        })
    }

    pub fn open_file(
        &self,
        path: PathBuf,
        reservation: ReplacementReservation,
    ) -> StudioResult<SceneDraftResponse> {
        self.lock()?.validate_replacement_intent(&reservation)?;
        let bytes = read_selected_bytes(&path, MAX_SCENE_FILE_BYTES)?;
        let source_id = crate::scene::io::selected_source_id(&path)?;
        let scene: VectorScene = serde_json::from_slice(&bytes)
            .map_err(|_| StudioCommandError::new(StudioReasonCode::SelectionRejected))?;

        if scene.schema != SCENE_SCHEMA
            || scene.compatibility != SCENE_COMPATIBILITY
            || scene.compiler_level > SCENE_COMPILER_LEVEL
        {
            return Err(StudioCommandError::new(StudioReasonCode::SelectionRejected));
        }

        // Open MUST compile canonical scene before adoption!
        let compile_output = self.shared.runner.compile(&scene, false)?;
        if !compile_output.valid {
            return Err(StudioCommandError::new(StudioReasonCode::ProtocolInvalid));
        }

        let mut session = self.lock()?;
        session.validate_replacement_intent(&reservation)?;

        let display = display_name(&path);
        let digest = compute_sha256(&bytes);
        if source_id != crate::scene::io::selected_source_id(&path)? {
            return Err(StudioCommandError::new(StudioReasonCode::ContextStale));
        }

        session.next_revision()?;
        session.invalidate_evidence();
        session.token_snapshot_id = None;
        session.current_scene = scene;
        session.source_id = Some(source_id);
        session.source_path = Some(path);
        session.source_display_name = display;
        session.source_digest = Some(digest);
        session.validated_json = compile_output.canonical_json.clone();
        session.compiled_svg = compile_output.svg.clone();
        session.compiled_svg_digest = compile_output
            .svg
            .as_ref()
            .map(|s| compute_sha256(s.as_bytes()));
        session.receipt = compile_output.receipt;
        session.metrics = compile_output.metrics;
        session.diagnostics = compile_output.diagnostics;
        session.dirty = false;

        session.update_canonical()?;
        session.active_replacement_intent = None;

        Ok(session.draft_response())
    }

    pub fn import_svg_file(
        &self,
        path: PathBuf,
        reservation: ReplacementReservation,
    ) -> StudioResult<SceneImportResponse> {
        self.lock()?.validate_replacement_intent(&reservation)?;
        let bytes = read_selected_bytes(&path, MAX_SVG_FILE_BYTES)?;
        let source_id = crate::scene::io::selected_source_id(&path)?;
        let source_digest = compute_sha256(&bytes);
        let svg_text = String::from_utf8(bytes)
            .map_err(|_| StudioCommandError::new(StudioReasonCode::ProtocolInvalid))?;

        let import_result = self.shared.runner.import_svg(&svg_text)?;

        if import_result.classification.as_deref() == Some("SUPPORTED_IMPORT")
            && let Some(imported_scene) = import_result.imported_scene
        {
            let compile_output = self.shared.runner.compile(&imported_scene, false)?;
            if !compile_output.valid {
                let mut session = self.lock()?;
                session.cancel_replacement_intent(&reservation);
                return Err(StudioCommandError::new(StudioReasonCode::ProtocolInvalid));
            }

            let mut session = self.lock()?;
            session.validate_replacement_intent(&reservation)?;

            if source_id != crate::scene::io::selected_source_id(&path)? {
                return Err(StudioCommandError::new(StudioReasonCode::ContextStale));
            }
            session.next_revision()?;
            session.invalidate_evidence();
            session.token_snapshot_id = None;
            session.current_scene = imported_scene;
            session.source_id = Some(source_id);
            session.source_display_name = display_name(&path);
            session.source_path = Some(path);
            session.source_digest = Some(source_digest);
            session.validated_json = compile_output.canonical_json.clone();
            session.compiled_svg = compile_output.svg.clone();
            session.compiled_svg_digest = compile_output
                .svg
                .as_ref()
                .map(|s| compute_sha256(s.as_bytes()));
            session.receipt = compile_output.receipt;
            session.metrics = compile_output.metrics;
            session.diagnostics = compile_output.diagnostics;
            session.dirty = true;

            session.update_canonical()?;
            session.active_replacement_intent = None;

            Ok(SceneImportResponse {
                cancelled: false,
                classification: import_result.classification,
                reason_codes: import_result.reason_codes,
                draft: Some(session.draft_response()),
                normalizations: import_result.normalizations,
                diagnostics: import_result.diagnostics,
            })
        } else {
            let mut session = self.lock()?;
            session.cancel_replacement_intent(&reservation);

            Ok(SceneImportResponse {
                cancelled: false,
                classification: import_result.classification,
                reason_codes: import_result.reason_codes,
                draft: None,
                normalizations: import_result.normalizations,
                diagnostics: import_result.diagnostics,
            })
        }
    }

    pub fn edit(&self, request: SceneEditRequest) -> StudioResult<SceneDraftResponse> {
        let mut session = self.lock()?;
        session.check_expected(&request.expected)?;
        session.apply_edits(request.operations)?;
        Ok(session.draft_response())
    }

    pub fn compile(&self, request: SceneCompileRequest) -> StudioResult<SceneCompileResponse> {
        let (scene, session_id, revision, draft_input_digest) = {
            let session = self.lock()?;
            session.check_expected(&request.expected)?;
            (
                session.current_scene.clone(),
                session.session_id.clone(),
                session.revision,
                session.draft_input_digest.clone(),
            )
        };

        let compile_output = self
            .shared
            .runner
            .compile(&scene, request.dry_run.unwrap_or(false))?;

        let mut session = self.lock()?;
        if session.disposed {
            return Err(StudioCommandError::new(StudioReasonCode::ContextStale));
        }
        session.check_expected(&request.expected)?;
        if session.session_id == session_id && session.revision == revision {
            session.validated_json = compile_output.canonical_json.clone();
            session.compiled_svg = compile_output.svg.clone();
            if let Some(ref svg) = compile_output.svg {
                session.compiled_svg_digest = Some(compute_sha256(svg.as_bytes()));
            }
            session.receipt = compile_output.receipt.clone();
            session.metrics = compile_output.metrics.clone();
            session.diagnostics = compile_output.diagnostics.clone();
        }

        Ok(SceneCompileResponse {
            session_id,
            revision,
            draft_input_digest,
            svg: compile_output.svg,
            receipt: compile_output.receipt,
            metrics: compile_output.metrics,
            diagnostics: compile_output.diagnostics,
        })
    }

    pub fn save_plan(
        &self,
        request: SceneSavePlanRequest,
        target_path: Option<PathBuf>,
    ) -> StudioResult<ScenePlanResponse> {
        let Some(target) = target_path else {
            return Ok(ScenePlanResponse {
                cancelled: true,
                plan_id: None,
                target_display_name: None,
                target_kind: None,
                byte_count: None,
                canonical_digest: None,
                expires_at_unix_ms: None,
            });
        };
        let mut session = self.lock()?;
        session.check_expected(&request.expected)?;
        session.retain_save_plan(target)
    }

    pub fn save_apply(&self, request: SceneApplyRequest) -> StudioResult<ScenePublicationResponse> {
        let mut session = self.lock()?;
        session.check_expected(&request.expected)?;
        let plan = session.take_save_plan(&request.plan_id)?;

        crate::scene::io::validate_parent_identity(&plan.target_path, plan.target_parent_identity)?;

        if session.compiled_svg.is_none() || session.receipt.is_none() {
            return Err(StudioCommandError::new(StudioReasonCode::PlanInvalid));
        }
        if Some(plan.canonical_digest.clone())
            != session
                .validated_json
                .as_ref()
                .map(|v| compute_sha256(v.as_bytes()))
        {
            return Err(StudioCommandError::new(StudioReasonCode::DigestMismatch));
        }

        let bytes_written = publish_absent_only_bytes(&plan.target_path, &plan.bytes)?;

        let source_id = crate::scene::io::selected_source_id(&plan.target_path)?;
        session.source_path = Some(plan.target_path);
        session.source_display_name = Some(plan.target_display_name.clone());
        session.source_digest = Some(plan.canonical_digest.clone());
        session.source_id = Some(source_id.clone());
        session.dirty = false;
        session.retained_save_plan = None;
        session.retained_export_plan = None;
        session.retained_verifications.clear();

        Ok(ScenePublicationResponse {
            published: true,
            target_display_name: Some(plan.target_display_name),
            source_id: Some(source_id),
            digest: Some(plan.canonical_digest),
            byte_count: Some(bytes_written),
        })
    }

    pub fn export_plan(
        &self,
        request: SceneExportPlanRequest,
        target_path: Option<PathBuf>,
    ) -> StudioResult<ScenePlanResponse> {
        let Some(target) = target_path else {
            return Ok(ScenePlanResponse {
                cancelled: true,
                plan_id: None,
                target_display_name: None,
                target_kind: None,
                byte_count: None,
                canonical_digest: None,
                expires_at_unix_ms: None,
            });
        };
        let mut session = self.lock()?;
        session.check_expected(&request.expected)?;
        session.retain_export_plan(target)
    }

    pub fn export_apply(
        &self,
        request: SceneApplyRequest,
    ) -> StudioResult<ScenePublicationResponse> {
        let mut session = self.lock()?;
        session.check_expected(&request.expected)?;
        let plan = session.take_export_plan(&request.plan_id)?;

        crate::scene::io::validate_parent_identity(&plan.target_path, plan.target_parent_identity)?;

        if session.compiled_svg.is_none() || session.receipt.is_none() {
            return Err(StudioCommandError::new(StudioReasonCode::PlanInvalid));
        }
        if Some(&plan.canonical_digest) != session.compiled_svg_digest.as_ref()
            || Some(plan.canonical_digest.clone())
                != session
                    .compiled_svg
                    .as_ref()
                    .map(|svg| compute_sha256(svg.as_bytes()))
        {
            return Err(StudioCommandError::new(StudioReasonCode::DigestMismatch));
        }

        let bytes_written = publish_absent_only_bytes(&plan.target_path, &plan.bytes)?;

        Ok(ScenePublicationResponse {
            published: true,
            target_display_name: Some(plan.target_display_name),
            source_id: None,
            digest: Some(plan.canonical_digest),
            byte_count: Some(bytes_written),
        })
    }

    pub(crate) fn bind_tokens(
        &self,
        request: SceneTokenBindRequest,
        host: &crate::state::host::HostState,
    ) -> StudioResult<SceneDraftResponse> {
        self.lock()?.check_expected(&request.expected)?;
        let snapshot = crate::state::scene_tokens::read(host, &request.project_handle)?;
        let mut session = self.lock()?;
        session.check_expected(&request.expected)?;
        if snapshot.generation != host.scene_generation() {
            return Err(StudioCommandError::new(StudioReasonCode::ContextStale));
        }
        session.bind_tokens(snapshot.generation, snapshot.bindings)?;
        session.token_snapshot_id = Some(snapshot.identity);
        if snapshot.excluded > 0 {
            session.diagnostics.push(SceneDiagnosticDto {
                code: "TOKEN_VALUES_EXCLUDED".to_owned(),
                message: format!(
                    "{} nonopaque or unsupported tokens excluded",
                    snapshot.excluded
                ),
                severity: Some("warning".to_owned()),
                path: None,
            });
        }
        Ok(session.draft_response())
    }

    pub fn brief_create(&self, request: SceneBriefRequest) -> StudioResult<ScenePacketResponse> {
        let mut session = self.lock()?;
        session.check_expected(&request.expected)?;

        let packet_id = format!(
            "scene-brief-{:x}",
            SystemTime::now()
                .duration_since(SystemTime::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        );
        let envelope = BriefPacketEnvelope {
            source_id: session.source_id.clone(),
            token_snapshot_id: session.token_snapshot_id.clone(),
            schema: BRIEF_SCHEMA.to_owned(),
            schema_version: EXCHANGE_SCHEMA_VERSION,
            brief_id: packet_id.clone(),
            title: request.title,
            objective: request.objective,
            acceptance_criteria: request.acceptance_criteria,
            prohibited_changes: request.prohibited_changes,
            scene: session.current_scene.clone(),
            canonical_digest: session.draft_input_digest.clone(),
        };
        envelope.validate_bounds()?;

        let canonical_text = serde_json::to_string(&envelope)
            .map_err(|_| StudioCommandError::new(StudioReasonCode::DomainFailed))?;

        let retained =
            session.retain_packet(packet_id, "brief".to_owned(), canonical_text, Vec::new())?;

        Ok(ScenePacketResponse {
            cancelled: false,
            packet_id: Some(retained.packet_id),
            packet_kind: Some(retained.kind),
            canonical_json: Some(retained.canonical_json),
            packet_digest: Some(retained.packet_digest),
            sender_claims: Vec::new(),
            diagnostics: Vec::new(),
        })
    }

    pub fn packet_import(
        &self,
        request: ScenePacketImportRequest,
        selected_path: Option<PathBuf>,
    ) -> StudioResult<ScenePacketResponse> {
        let Some(path) = selected_path else {
            return Ok(ScenePacketResponse {
                cancelled: true,
                packet_id: None,
                packet_kind: None,
                canonical_json: None,
                packet_digest: None,
                sender_claims: Vec::new(),
                diagnostics: Vec::new(),
            });
        };

        let bytes = read_selected_bytes(&path, MAX_PACKET_FILE_BYTES)?;
        let packet_str = String::from_utf8(bytes)
            .map_err(|_| StudioCommandError::new(StudioReasonCode::ProtocolInvalid))?;

        let packet = parse_exchange_packet(&packet_str, request.expected_kind.as_deref())?;
        let packet_id = packet.packet_id().to_owned();
        let kind = packet.kind().to_owned();
        let canonical_json = packet.to_canonical_json()?;

        let mut session = self.lock()?;
        if let Some(ref expected) = request.expected {
            session.check_expected(expected)?;
        }

        let retained = session.retain_packet(packet_id, kind, canonical_json, Vec::new())?;

        Ok(ScenePacketResponse {
            cancelled: false,
            packet_id: Some(retained.packet_id),
            packet_kind: Some(retained.kind),
            canonical_json: Some(retained.canonical_json),
            packet_digest: Some(retained.packet_digest),
            sender_claims: Vec::new(),
            diagnostics: Vec::new(),
        })
    }

    pub fn packet_export(
        &self,
        request: ScenePacketExportRequest,
        target_path: Option<PathBuf>,
    ) -> StudioResult<ScenePublicationResponse> {
        let Some(path) = target_path else {
            return Ok(ScenePublicationResponse {
                published: false,
                target_display_name: None,
                source_id: None,
                digest: None,
                byte_count: None,
            });
        };

        let packet = {
            let session = self.lock()?;
            session.check_expected(&request.expected)?;
            session.get_packet(&request.packet_id)?.clone()
        };

        let bytes_written = publish_absent_only_bytes(&path, packet.canonical_json.as_bytes())?;
        let display = display_name(&path);

        Ok(ScenePublicationResponse {
            published: true,
            target_display_name: display,
            source_id: None,
            digest: Some(packet.packet_digest),
            byte_count: Some(bytes_written),
        })
    }

    pub fn review_create(&self, request: SceneReviewRequest) -> StudioResult<ScenePacketResponse> {
        let mut session = self.lock()?;
        session.check_expected(&request.expected)?;

        // Review validates packet references
        let brief_packet = session.get_packet(&request.brief_packet_id)?;
        let parsed_brief = parse_exchange_packet(&brief_packet.canonical_json, Some("brief"))?;
        let brief_envelope = match parsed_brief {
            SceneExchangePacket::Brief(b) => b,
            _ => return Err(StudioCommandError::new(StudioReasonCode::ProtocolInvalid)),
        };

        if request.candidate_packet_ids.is_empty()
            || request.candidate_packet_ids.len() > MAX_CANDIDATE_IDS_COUNT
        {
            return Err(StudioCommandError::new(StudioReasonCode::ProtocolInvalid));
        }

        for cand_id in &request.candidate_packet_ids {
            let cand_packet = session.get_packet(cand_id)?;
            let parsed_cand =
                parse_exchange_packet(&cand_packet.canonical_json, Some("candidate"))?;
            let cand_envelope = match parsed_cand {
                SceneExchangePacket::Candidate(c) => c,
                _ => return Err(StudioCommandError::new(StudioReasonCode::ProtocolInvalid)),
            };
            if cand_envelope.brief_id != brief_envelope.brief_id {
                return Err(StudioCommandError::new(StudioReasonCode::SelectionRejected));
            }
        }

        let packet_id = format!(
            "scene-review-{:x}",
            SystemTime::now()
                .duration_since(SystemTime::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        );

        let envelope = ReviewPacketEnvelope {
            schema: REVIEW_SCHEMA.to_owned(),
            schema_version: EXCHANGE_SCHEMA_VERSION,
            review_id: packet_id.clone(),
            brief_packet_id: request.brief_packet_id,
            candidate_packet_ids: request.candidate_packet_ids,
            overall_disposition: request.overall_disposition,
            summary: request.summary,
            annotations: request.annotations,
        };
        envelope.validate_bounds()?;

        let canonical_text = serde_json::to_string(&envelope)
            .map_err(|_| StudioCommandError::new(StudioReasonCode::DomainFailed))?;

        let retained =
            session.retain_packet(packet_id, "review".to_owned(), canonical_text, Vec::new())?;

        Ok(ScenePacketResponse {
            cancelled: false,
            packet_id: Some(retained.packet_id),
            packet_kind: Some(retained.kind),
            canonical_json: Some(retained.canonical_json),
            packet_digest: Some(retained.packet_digest),
            sender_claims: Vec::new(),
            diagnostics: Vec::new(),
        })
    }

    pub fn candidate_verify(
        &self,
        request: SceneVerifyRequest,
    ) -> StudioResult<SceneVerificationResponse> {
        let (candidate_envelope, cand_raw_digest) = {
            let session = self.lock()?;
            session.check_expected(&request.expected)?;

            let cand_packet = session.get_packet(&request.candidate_packet_id)?;
            let parsed_cand =
                parse_exchange_packet(&cand_packet.canonical_json, Some("candidate"))?;
            let cand_envelope = match parsed_cand {
                SceneExchangePacket::Candidate(c) => c,
                _ => return Err(StudioCommandError::new(StudioReasonCode::ProtocolInvalid)),
            };

            if cand_envelope.source_id != session.source_id
                || cand_envelope.token_snapshot_id != session.token_snapshot_id
            {
                return Err(StudioCommandError::new(StudioReasonCode::ContextStale));
            }
            // Require current brief linkage:
            let brief_id = request
                .brief_packet_id
                .as_deref()
                .unwrap_or(&cand_envelope.brief_id);
            let brief_packet = session.get_packet(brief_id)?;
            let parsed_brief = parse_exchange_packet(&brief_packet.canonical_json, Some("brief"))?;
            let brief_envelope = match parsed_brief {
                SceneExchangePacket::Brief(b) => b,
                _ => return Err(StudioCommandError::new(StudioReasonCode::ProtocolInvalid)),
            };

            if cand_envelope.brief_id != brief_envelope.brief_id {
                return Ok(SceneVerificationResponse {
                    valid: false,
                    candidate_packet_id: request.candidate_packet_id,
                    candidate_digest: cand_packet.packet_digest.clone(),
                    compiled_svg_digest: None,
                    metrics: None,
                    diagnostics: vec![SceneDiagnosticDto {
                        code: "BRIEF_LINKAGE_MISMATCH".to_owned(),
                        message: "Candidate does not link to target brief".to_owned(),
                        severity: Some("error".to_owned()),
                        path: None,
                    }],
                    verification_handle: String::new(),
                });
            }

            let cand_brief_clean = cand_envelope
                .brief_digest
                .strip_prefix("sha256:")
                .unwrap_or(&cand_envelope.brief_digest);
            let brief_digest_clean = brief_envelope
                .canonical_digest
                .strip_prefix("sha256:")
                .unwrap_or(&brief_envelope.canonical_digest);
            let brief_packet_clean = brief_packet
                .packet_digest
                .strip_prefix("sha256:")
                .unwrap_or(&brief_packet.packet_digest);

            if cand_brief_clean != brief_digest_clean && cand_brief_clean != brief_packet_clean {
                return Ok(SceneVerificationResponse {
                    valid: false,
                    candidate_packet_id: request.candidate_packet_id,
                    candidate_digest: cand_packet.packet_digest.clone(),
                    compiled_svg_digest: None,
                    metrics: None,
                    diagnostics: vec![SceneDiagnosticDto {
                        code: "BRIEF_DIGEST_MISMATCH".to_owned(),
                        message: "Candidate brief digest does not match brief evidence".to_owned(),
                        severity: Some("error".to_owned()),
                        path: None,
                    }],
                    verification_handle: String::new(),
                });
            }

            (cand_envelope, cand_packet.packet_digest.clone())
        };

        if candidate_envelope.scene_schema != SCENE_SCHEMA
            || candidate_envelope.scene_compatibility != SCENE_COMPATIBILITY
            || candidate_envelope.scene_compiler_level != SCENE_COMPILER_LEVEL
            || candidate_envelope.profile != candidate_envelope.scene.profile
            || candidate_envelope.artboard != candidate_envelope.scene.artboard
        {
            return Ok(SceneVerificationResponse {
                valid: false,
                candidate_packet_id: request.candidate_packet_id,
                candidate_digest: cand_raw_digest,
                compiled_svg_digest: None,
                metrics: None,
                diagnostics: vec![SceneDiagnosticDto {
                    code: "CANDIDATE_SCHEMA_MISMATCH".to_owned(),
                    message: "Candidate metadata does not match scene or compiler level".to_owned(),
                    severity: Some("error".to_owned()),
                    path: None,
                }],
                verification_handle: String::new(),
            });
        }

        // Verify uses runner.compile(candidate.scene, false)
        let compile_output = match self.shared.runner.compile(&candidate_envelope.scene, false) {
            Ok(output) => output,
            Err(err) => {
                return Ok(SceneVerificationResponse {
                    valid: false,
                    candidate_packet_id: request.candidate_packet_id,
                    candidate_digest: cand_raw_digest,
                    compiled_svg_digest: None,
                    metrics: None,
                    diagnostics: vec![SceneDiagnosticDto {
                        code: "COMPILE_FAILED".to_owned(),
                        message: format!("Compilation failed: {:?}", err.reason_code()),
                        severity: Some("error".to_owned()),
                        path: None,
                    }],
                    verification_handle: String::new(),
                });
            }
        };

        if !compile_output.valid || compile_output.receipt.is_none() {
            return Ok(SceneVerificationResponse {
                valid: false,
                candidate_packet_id: request.candidate_packet_id,
                candidate_digest: cand_raw_digest,
                compiled_svg_digest: None,
                metrics: compile_output.metrics,
                diagnostics: compile_output.diagnostics,
                verification_handle: String::new(),
            });
        }

        let receipt = compile_output
            .receipt
            .as_ref()
            .ok_or_else(|| StudioCommandError::new(StudioReasonCode::SidecarProtocolInvalid))?;
        let receipt_svg_clean = receipt
            .svg_digest
            .strip_prefix("sha256:")
            .unwrap_or(&receipt.svg_digest);
        let cand_svg_clean = candidate_envelope
            .svg_digest
            .strip_prefix("sha256:")
            .unwrap_or(&candidate_envelope.svg_digest);
        let receipt_glyph_clean = receipt
            .glyph_catalog_digest
            .strip_prefix("sha256:")
            .unwrap_or(&receipt.glyph_catalog_digest);
        let cand_glyph_clean = candidate_envelope
            .glyph_catalog_digest
            .strip_prefix("sha256:")
            .unwrap_or(&candidate_envelope.glyph_catalog_digest);
        let receipt_token_clean = receipt
            .token_digest
            .strip_prefix("sha256:")
            .unwrap_or(&receipt.token_digest);
        let cand_token_clean = candidate_envelope
            .token_digest
            .strip_prefix("sha256:")
            .unwrap_or(&candidate_envelope.token_digest);

        if receipt
            .source_digest
            .strip_prefix("sha256:")
            .unwrap_or(&receipt.source_digest)
            != candidate_envelope
                .canonical_scene_digest
                .strip_prefix("sha256:")
                .unwrap_or(&candidate_envelope.canonical_scene_digest)
            || receipt_svg_clean != cand_svg_clean
            || receipt_glyph_clean != cand_glyph_clean
            || receipt_token_clean != cand_token_clean
            || receipt.profile != candidate_envelope.profile
            || receipt.artboard != candidate_envelope.artboard
        {
            return Ok(SceneVerificationResponse {
                valid: false,
                candidate_packet_id: request.candidate_packet_id,
                candidate_digest: cand_raw_digest,
                compiled_svg_digest: None,
                metrics: compile_output.metrics,
                diagnostics: vec![SceneDiagnosticDto {
                    code: "RECEIPT_BINDING_MISMATCH".to_owned(),
                    message: "Engine compilation receipt bindings do not match candidate claims"
                        .to_owned(),
                    severity: Some("error".to_owned()),
                    path: None,
                }],
                verification_handle: String::new(),
            });
        }

        let svg_digest = compile_output
            .svg
            .as_ref()
            .map(|s| compute_sha256(s.as_bytes()));

        // ONLY retain verification handle if valid matching evidence!
        let mut session = self.lock()?;
        session.check_expected(&request.expected)?;

        let handle = session.retain_verification(
            request.candidate_packet_id.clone(),
            cand_raw_digest.clone(),
            svg_digest.clone(),
            candidate_envelope.scene,
            compile_output.metrics.clone(),
            compile_output.diagnostics.clone(),
        );

        Ok(SceneVerificationResponse {
            valid: true,
            candidate_packet_id: request.candidate_packet_id,
            candidate_digest: cand_raw_digest,
            compiled_svg_digest: svg_digest,
            metrics: compile_output.metrics,
            diagnostics: compile_output.diagnostics,
            verification_handle: handle,
        })
    }

    pub fn candidate_adopt(&self, request: SceneAdoptRequest) -> StudioResult<SceneDraftResponse> {
        let mut session = self.lock()?;
        session.check_expected(&request.expected)?;
        let verification = session.take_verification(&request.verification_handle)?;

        session.next_revision()?;
        session.current_scene = verification.verified_scene;
        session.dirty = true;
        session.source_id = None;
        session.source_path = None;
        session.source_display_name = None;
        session.source_digest = None;

        session.invalidate_evidence();
        session.update_canonical()?;

        Ok(session.draft_response())
    }
}

#[cfg(test)]
mod real_boundary_tests {
    use super::*;
    use crate::scene::protocol_dto::*;
    use crate::scene::types::*;
    use std::fs;
    fn expected(d: &SceneDraftResponse) -> SceneExpected {
        SceneExpected {
            session_id: d.session_id.clone(),
            revision: d.revision,
            draft_input_digest: Some(d.draft_input_digest.clone()),
            source_id: d.source_id.clone(),
            token_snapshot_id: d.token_snapshot_id.clone(),
            engine_identity: None,
        }
    }
    #[test]
    fn real_engine_save_export_stale_plan_and_selected_open()
    -> Result<(), Box<dyn std::error::Error>> {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
        let state = SceneState::new(SceneRunner::new(
            root.join("binaries/tfsb-studio-service-aarch64-apple-darwin"),
            root.join("scene-payload/bin/scene-batch.js"),
        ));
        let d = state.new_draft(SceneNewRequest {
            expected: None,
            replacement_intent_id: None,
            profile: Some(SceneProfile::Diagram),
            preset: None,
            artboard: None,
            title: Some("Native round trip".to_owned()),
        })?;
        let dir = std::env::temp_dir().join(format!(
            "scene-real-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(SystemTime::UNIX_EPOCH)?
                .as_nanos()
        ));
        fs::create_dir(&dir)?;
        let result = (|| -> Result<(), Box<dyn std::error::Error>> {
            let exp = expected(&d);
            let stale = state.save_plan(
                SceneSavePlanRequest {
                    expected: exp.clone(),
                    default_name: None,
                },
                Some(dir.join("stale.json")),
            )?;
            let edited = state.edit(SceneEditRequest {
                expected: exp.clone(),
                operations: vec![SceneEditOperation::SetProfile {
                    profile: SceneProfile::Editorial,
                }],
            })?;
            assert!(
                state
                    .save_apply(SceneApplyRequest {
                        expected: exp,
                        plan_id: stale.plan_id.ok_or("no plan")?
                    })
                    .is_err()
            );
            assert!(!dir.join("stale.json").exists());
            let exp = expected(&edited);
            let output = state.compile(SceneCompileRequest {
                expected: exp.clone(),
                dry_run: None,
            })?;
            let receipt = output.receipt.ok_or("no receipt")?;
            let plan = state.save_plan(
                SceneSavePlanRequest {
                    expected: exp.clone(),
                    default_name: None,
                },
                Some(dir.join("scene.json")),
            )?;
            let saved = state.save_apply(SceneApplyRequest {
                expected: exp.clone(),
                plan_id: plan.plan_id.ok_or("no plan")?,
            })?;
            let bytes = fs::read(dir.join("scene.json"))?;
            assert_eq!(
                format!("sha256:{}", compute_sha256(&bytes)),
                receipt.source_digest
            );
            assert!(saved.source_id.is_some());
            let now = state.lock()?.draft_response();
            let exp = expected(&now);
            let export = state.export_plan(
                SceneExportPlanRequest {
                    expected: exp.clone(),
                    default_name: None,
                },
                Some(dir.join("scene.svg")),
            )?;
            // A same-revision evidence mismatch must never publish the retained bytes.
            let original_digest = state.lock()?.compiled_svg_digest.clone();
            state.lock()?.compiled_svg_digest = Some(compute_sha256(b"different SVG"));
            let mismatch = state.export_apply(SceneApplyRequest {
                expected: exp.clone(),
                plan_id: export.plan_id.ok_or("no export")?,
            });
            assert_eq!(
                mismatch
                    .err()
                    .ok_or("expected digest rejection")?
                    .reason_code(),
                StudioReasonCode::DigestMismatch
            );
            assert!(!dir.join("scene.svg").exists());
            state.lock()?.compiled_svg_digest = original_digest;
            let export = state.export_plan(
                SceneExportPlanRequest {
                    expected: exp.clone(),
                    default_name: None,
                },
                Some(dir.join("scene.svg")),
            )?;
            state.export_apply(SceneApplyRequest {
                expected: exp.clone(),
                plan_id: export.plan_id.ok_or("no export")?,
            })?;
            assert_eq!(
                format!(
                    "sha256:{}",
                    compute_sha256(&fs::read(dir.join("scene.svg"))?)
                ),
                receipt.svg_digest
            );
            assert!(
                state
                    .save_plan(
                        SceneSavePlanRequest {
                            expected: exp.clone(),
                            default_name: None
                        },
                        Some(dir.join("scene.json"))
                    )
                    .and_then(|p| state.save_apply(SceneApplyRequest {
                        expected: exp.clone(),
                        plan_id: p.plan_id.unwrap_or_default()
                    }))
                    .is_err()
            );
            let reservation = state.begin_replacement(Some(&exp), None)?;
            let opened = state.open_file(dir.join("scene.json"), reservation)?;
            assert!(!opened.dirty);
            let exp = expected(&opened);
            let brief = state.brief_create(SceneBriefRequest {
                expected: exp.clone(),
                title: "Iteration".to_owned(),
                objective: "Keep the diagram".to_owned(),
                acceptance_criteria: vec![],
                prohibited_changes: vec![],
            })?;
            let scene_receipt = opened
                .compiled
                .as_ref()
                .ok_or("compiled missing")?
                .receipt
                .clone();
            let candidate = crate::scene::exchange::CandidatePacketEnvelope {
                source_id: opened.source_id.clone(),
                token_snapshot_id: opened.token_snapshot_id.clone(),
                schema: crate::scene::exchange::CANDIDATE_SCHEMA.to_owned(),
                schema_version: 1,
                candidate_id: "candidate-real".to_owned(),
                brief_id: brief.packet_id.clone().ok_or("brief id")?,
                brief_digest: brief.packet_digest.ok_or("brief digest")?,
                canonical_scene_digest: scene_receipt.source_digest,
                svg_digest: scene_receipt.svg_digest,
                profile: opened.scene.profile,
                artboard: opened.scene.artboard.clone(),
                scene_schema: SCENE_SCHEMA.to_owned(),
                scene_compatibility: 1,
                scene_compiler_level: 1,
                glyph_catalog_digest: scene_receipt.glyph_catalog_digest,
                token_digest: scene_receipt.token_digest,
                sender_provenance: None,
                scene: opened.scene.clone(),
            };
            let candidate_path = dir.join("candidate.json");
            fs::write(&candidate_path, serde_json::to_vec(&candidate)?)?;
            state.packet_import(
                ScenePacketImportRequest {
                    expected: Some(exp.clone()),
                    expected_kind: Some("candidate".to_owned()),
                },
                Some(candidate_path),
            )?;
            let verification = state.candidate_verify(SceneVerifyRequest {
                expected: exp.clone(),
                candidate_packet_id: "candidate-real".to_owned(),
                brief_packet_id: brief.packet_id.clone(),
            })?;
            assert!(verification.valid, "{:?}", verification.diagnostics);
            let edited = state.edit(SceneEditRequest {
                expected: exp,
                operations: vec![SceneEditOperation::SetProfile {
                    profile: SceneProfile::Diagram,
                }],
            })?;
            let exp = expected(&edited);
            let stale_adoption = state.candidate_adopt(SceneAdoptRequest {
                expected: exp.clone(),
                verification_handle: verification.verification_handle,
            });
            assert_eq!(
                stale_adoption
                    .err()
                    .ok_or("expected stale handle rejection")?
                    .reason_code(),
                StudioReasonCode::PlanInvalid
            );
            let unchanged = state.lock()?.draft_response();
            assert_eq!(unchanged.revision, edited.revision);
            assert_eq!(unchanged.scene, edited.scene);
            // Explicit fresh verification at the new revision restores adoption authority.
            let verification = state.candidate_verify(SceneVerifyRequest {
                expected: exp.clone(),
                candidate_packet_id: "candidate-real".to_owned(),
                brief_packet_id: brief.packet_id,
            })?;
            assert!(verification.valid, "{:?}", verification.diagnostics);
            let adopted = state.candidate_adopt(SceneAdoptRequest {
                expected: exp,
                verification_handle: verification.verification_handle,
            })?;
            assert!(adopted.dirty);
            assert!(adopted.revision > opened.revision);
            assert!(adopted.source_id.is_none());
            let opened = adopted;
            let reservation = state.begin_replacement(Some(&expected(&opened)), None)?;
            state.dispose(SceneDisposeRequest {
                expected: expected(&opened),
            })?;
            assert!(
                state
                    .open_file(dir.join("scene.json"), reservation)
                    .is_err()
            );
            Ok(())
        })();
        fs::remove_dir_all(&dir)?;
        result
    }

    #[test]
    fn real_engine_open_file_omitted_source_rejection_and_full_binding_success()
    -> Result<(), Box<dyn std::error::Error>> {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
        let state = SceneState::new(SceneRunner::new(
            root.join("binaries/tfsb-studio-service-aarch64-apple-darwin"),
            root.join("scene-payload/bin/scene-batch.js"),
        ));
        let dir = std::env::temp_dir().join(format!(
            "scene-open-binding-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(SystemTime::UNIX_EPOCH)?
                .as_nanos()
        ));
        fs::create_dir(&dir)?;
        struct DirGuard(PathBuf);
        impl Drop for DirGuard {
            fn drop(&mut self) {
                let _ = fs::remove_dir_all(&self.0);
            }
        }
        let _guard = DirGuard(dir.clone());

        // 1. Establish valid seed scene on disk from an initial draft (revision 1)
        let initial = state.new_draft(SceneNewRequest {
            expected: None,
            replacement_intent_id: None,
            profile: Some(SceneProfile::Diagram),
            preset: None,
            artboard: None,
            title: Some("Regression test seed".to_owned()),
        })?;
        assert_eq!(initial.revision, 1);
        assert!(initial.source_id.is_none());

        let scene_path = dir.join("seed.json");
        fs::write(&scene_path, &initial.canonical_json)?;
        let reservation = state.begin_replacement(Some(&expected(&initial)), None)?;
        let opened = state.open_file(scene_path, reservation)?;
        assert_eq!(opened.revision, 2);
        assert!(!opened.dirty);
        let adopted_source_id = opened
            .source_id
            .clone()
            .ok_or("open_file must adopt source_id")?;
        assert!(opened.token_snapshot_id.is_none());

        // 3. Compile with otherwise correct expected lacking source_id rejects ContextStale
        let mut expected_lacking_source = expected(&opened);
        expected_lacking_source.source_id = None;
        let compile_err = state.compile(SceneCompileRequest {
            expected: expected_lacking_source.clone(),
            dry_run: None,
        });
        assert_eq!(
            compile_err
                .err()
                .ok_or("expected compile rejection when source_id is omitted")?
                .reason_code(),
            StudioReasonCode::ContextStale
        );
        // 4. Compile with full expected succeeds and produces compiled preview/receipt
        let expected_full = expected(&opened);
        assert_eq!(expected_full.source_id.as_ref(), Some(&adopted_source_id));
        let compile_ok = state.compile(SceneCompileRequest {
            expected: expected_full.clone(),
            dry_run: None,
        })?;
        assert!(compile_ok.svg.is_some());
        assert!(compile_ok.receipt.is_some());
        assert!(
            state
                .validate_save_plan_preconditions(&expected_full)
                .is_ok()
        );

        // 5. Token absence mismatch: bind tokens so session expects token_snapshot_id
        let mut tokens = std::collections::BTreeMap::new();
        tokens.insert("brand-primary".to_owned(), "#112233".to_owned());
        state.lock()?.bind_tokens(1, tokens)?;
        let bound = state.lock()?.draft_response();
        assert_eq!(bound.revision, 3);
        assert!(bound.token_snapshot_id.is_some());

        // Compile with expected omitting token_snapshot_id rejects ContextStale
        let mut expected_omitted_token = expected(&bound);
        expected_omitted_token.token_snapshot_id = None;
        let token_err = state.compile(SceneCompileRequest {
            expected: expected_omitted_token,
            dry_run: None,
        });
        assert_eq!(
            token_err
                .err()
                .ok_or("expected compile rejection when token_snapshot_id is omitted")?
                .reason_code(),
            StudioReasonCode::ContextStale
        );

        // Full binding with both source_id and token_snapshot_id succeeds
        let expected_bound_full = expected(&bound);
        let compile_bound_ok = state.compile(SceneCompileRequest {
            expected: expected_bound_full.clone(),
            dry_run: None,
        })?;
        assert!(compile_bound_ok.svg.is_some());
        assert!(compile_bound_ok.receipt.is_some());
        assert!(
            state
                .validate_save_plan_preconditions(&expected_bound_full)
                .is_ok()
        );

        state.shutdown();
        Ok(())
    }

    #[test]
    fn real_engine_open_file_rejection_classification_and_state_preservation()
    -> Result<(), Box<dyn std::error::Error>> {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
        let state = SceneState::new(SceneRunner::new(
            root.join("binaries/tfsb-studio-service-aarch64-apple-darwin"),
            root.join("scene-payload/bin/scene-batch.js"),
        ));
        let dir = std::env::temp_dir().join(format!(
            "scene-open-rejections-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(SystemTime::UNIX_EPOCH)?
                .as_nanos()
        ));
        fs::create_dir(&dir)?;
        struct DirGuard(PathBuf);
        impl Drop for DirGuard {
            fn drop(&mut self) {
                let _ = fs::remove_dir_all(&self.0);
            }
        }
        let _guard = DirGuard(dir.clone());

        // Local schema rejection must complete even when no engine can run.
        // An attempted invocation would return an engine-availability error.
        let unavailable = SceneState::new(SceneRunner::new(
            dir.join("absent-node"),
            dir.join("absent-engine.js"),
        ));
        let local_only_path = dir.join("local-only.json");
        fs::write(&local_only_path, br#"{"ordinary":"json"}"#)?;
        let reservation = unavailable.begin_replacement(None, None)?;
        let local_error = unavailable
            .open_file(local_only_path, reservation)
            .err()
            .ok_or("expected local rejection before engine invocation")?;
        assert_eq!(
            local_error.reason_code(),
            StudioReasonCode::SelectionRejected
        );
        assert_eq!(
            unavailable
                .status(SceneStatusRequest { expected: None })?
                .revision,
            0
        );
        unavailable.shutdown();

        // 1. Establish valid seed scene (revision 1)
        let initial = state.new_draft(SceneNewRequest {
            expected: None,
            replacement_intent_id: None,
            profile: Some(SceneProfile::Diagram),
            preset: None,
            artboard: None,
            title: Some("Seed for error classification".to_owned()),
        })?;
        assert_eq!(initial.revision, 1);
        let exp_initial = expected(&initial);
        let initial_digest = initial.draft_input_digest.clone();

        // Regression 1: Malformed JSON -> SelectionRejected
        let malformed_path = dir.join("malformed.json");
        fs::write(&malformed_path, b"{ not-json: [ unclosed")?;
        let res_malformed = state.begin_replacement(Some(&exp_initial), None)?;
        let err_malformed = state
            .open_file(malformed_path, res_malformed)
            .err()
            .ok_or("expected malformed JSON rejection")?;
        assert_eq!(
            err_malformed.reason_code(),
            StudioReasonCode::SelectionRejected
        );

        // Verify session state is completely unchanged (no engine invocation / state mutation)
        let status1 = state.status(SceneStatusRequest { expected: None })?;
        assert_eq!(status1.revision, 1);
        assert_eq!(status1.draft_input_digest, initial_digest);
        assert_eq!(state.lock()?.source_id, None);

        // Regression 2: Valid non-Scene JSON -> SelectionRejected
        let non_scene_path = dir.join("non_scene.json");
        fs::write(
            &non_scene_path,
            br#"{"name": "arbitrary", "count": 100, "active": true}"#,
        )?;
        let res_non_scene = state.begin_replacement(Some(&exp_initial), None)?;
        let err_non_scene = state
            .open_file(non_scene_path, res_non_scene)
            .err()
            .ok_or("expected non-Scene JSON rejection")?;
        assert_eq!(
            err_non_scene.reason_code(),
            StudioReasonCode::SelectionRejected
        );

        // Verify state remains unchanged
        let status2 = state.status(SceneStatusRequest { expected: None })?;
        assert_eq!(status2.revision, 1);
        assert_eq!(status2.draft_input_digest, initial_digest);

        // Regression 3: Incompatible schema / compatibility / compiler_level -> SelectionRejected
        // 3a. Incompatible schema string
        let mut scene_incompat = initial.scene.clone();
        scene_incompat.schema = "tfsb.vector-scene-v999".to_owned();
        let incompat_schema_path = dir.join("incompat_schema.json");
        fs::write(&incompat_schema_path, serde_json::to_vec(&scene_incompat)?)?;
        let res_incompat_schema = state.begin_replacement(Some(&exp_initial), None)?;
        let err_schema = state
            .open_file(incompat_schema_path, res_incompat_schema)
            .err()
            .ok_or("expected incompatible schema rejection")?;
        assert_eq!(
            err_schema.reason_code(),
            StudioReasonCode::SelectionRejected
        );

        // 3b. Incompatible compatibility level
        let mut scene_incompat_compat = initial.scene.clone();
        scene_incompat_compat.compatibility = 999;
        let incompat_compat_path = dir.join("incompat_compat.json");
        fs::write(
            &incompat_compat_path,
            serde_json::to_vec(&scene_incompat_compat)?,
        )?;
        let res_incompat_compat = state.begin_replacement(Some(&exp_initial), None)?;
        let err_compat = state
            .open_file(incompat_compat_path, res_incompat_compat)
            .err()
            .ok_or("expected incompatible compatibility rejection")?;
        assert_eq!(
            err_compat.reason_code(),
            StudioReasonCode::SelectionRejected
        );

        // 3c. Incompatible compiler level
        let mut scene_incompat_level = initial.scene.clone();
        scene_incompat_level.compiler_level = 999;
        let incompat_level_path = dir.join("incompat_level.json");
        fs::write(
            &incompat_level_path,
            serde_json::to_vec(&scene_incompat_level)?,
        )?;
        let res_incompat_level = state.begin_replacement(Some(&exp_initial), None)?;
        let err_level = state
            .open_file(incompat_level_path, res_incompat_level)
            .err()
            .ok_or("expected incompatible compiler level rejection")?;
        assert_eq!(err_level.reason_code(), StudioReasonCode::SelectionRejected);

        // Verify state is STILL unchanged at revision 1
        let status3 = state.status(SceneStatusRequest { expected: None })?;
        assert_eq!(status3.revision, 1);
        assert_eq!(status3.draft_input_digest, initial_digest);

        // Regression 4: Valid Scene -> succeeds, advances revision to 2, adopts source_id
        let valid_scene_path = dir.join("valid_scene.json");
        fs::write(&valid_scene_path, &initial.canonical_json)?;
        let res_valid = state.begin_replacement(Some(&exp_initial), None)?;
        let opened = state.open_file(valid_scene_path, res_valid)?;
        assert_eq!(opened.revision, 2);
        assert!(!opened.dirty);
        assert!(opened.source_id.is_some());
        assert!(opened.compiled.is_some());

        // Regression 5: Engine invalid result -> ProtocolInvalid
        // Valid JSON & deserializable VectorScene, but fails engine compilation validation (negative artboard width)
        let mut invalid_engine_scene = opened.scene.clone();
        invalid_engine_scene.artboard.width = -500.0;
        let invalid_engine_path = dir.join("engine_invalid.json");
        fs::write(
            &invalid_engine_path,
            serde_json::to_vec(&invalid_engine_scene)?,
        )?;
        let exp_opened = expected(&opened);
        let res_engine = state.begin_replacement(Some(&exp_opened), None)?;
        let err_engine = state
            .open_file(invalid_engine_path, res_engine)
            .err()
            .ok_or("expected engine validation rejection")?;
        assert_eq!(err_engine.reason_code(), StudioReasonCode::ProtocolInvalid);

        // Verify state remained at revision 2
        let status4 = state.status(SceneStatusRequest { expected: None })?;
        assert_eq!(status4.revision, 2);

        state.shutdown();
        Ok(())
    }
}
