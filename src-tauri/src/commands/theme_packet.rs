use crate::app_theme::paired_v2_packets::{
    PAIRED_PROFILE_SCHEMA_PREFIX, PAIRED_V2_PACKET_MAX_BYTES, PAIRED_V2_PACKET_PROBE_MAX_BYTES,
    PairedV2PacketClassification, PairedV2PacketCreateRequest, PairedV2PacketEnvelope,
    PairedV2PacketKind, classify_packet, create_packet, parse_packet,
};
use crate::design_evidence::{publish_selected_bytes, read_selected_bytes};
use crate::errors::{StudioCommandError, StudioReasonCode, StudioResult};
use crate::state::app_theme::AppThemeState;
use crate::state::theme_lab::ThemeLabState;
use crate::theme_lab::types::*;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::DialogExt;

const MAX_PACKET_BYTES: usize = PAIRED_V2_PACKET_PROBE_MAX_BYTES;
const PAIRED_CANDIDATE_KIND: &str = "tf-paired-profile-v2-candidate";
const PAIRED_REVIEW_KIND: &str = "tf-paired-profile-v2-review";

fn paired_active(app: &AppHandle) -> bool {
    app.try_state::<crate::release_smoke::ScriptedSelections>()
        .is_some_and(|selection| selection.is_paired_v2())
}

fn paired_path(app: &AppHandle, key: &str) -> StudioResult<Option<PathBuf>> {
    let Some(selection) = app.try_state::<crate::release_smoke::ScriptedSelections>() else {
        return Ok(None);
    };
    if !selection.is_paired_v2() {
        return Ok(None);
    }
    selection.paired_file(key).map(Some)
}

fn paired_import_selection_key(expected_kind: Option<&str>) -> StudioResult<&'static str> {
    match expected_kind {
        Some(PAIRED_CANDIDATE_KIND) => Ok("import"),
        Some(PAIRED_REVIEW_KIND) => Ok("review-import"),
        _ => Err(StudioCommandError::new(StudioReasonCode::SelectionRejected)),
    }
}

fn paired_export_selection_key(kind: PairedV2PacketKind) -> StudioResult<&'static str> {
    match kind {
        PairedV2PacketKind::Candidate => Ok(PAIRED_CANDIDATE_KIND),
        PairedV2PacketKind::Review => Ok(PAIRED_REVIEW_KIND),
        PairedV2PacketKind::Brief => {
            Err(StudioCommandError::new(StudioReasonCode::SelectionRejected))
        }
    }
}

fn reject_nonpaired_path(app: &AppHandle) -> StudioResult<()> {
    if paired_active(app) {
        return Err(StudioCommandError::new(StudioReasonCode::SelectionRejected));
    }
    Ok(())
}

fn invalid() -> StudioCommandError {
    StudioCommandError::new(StudioReasonCode::SidecarProtocolInvalid)
}
fn display_name(path: &std::path::Path) -> Option<String> {
    path.file_name()
        .and_then(|name| name.to_str())
        .filter(|name| name.len() <= 255 && !name.chars().any(char::is_control))
        .map(str::to_owned)
}

fn expected_kind_is_paired(expected_kind: Option<&str>) -> bool {
    expected_kind.is_some_and(|kind| kind.starts_with(PAIRED_PROFILE_SCHEMA_PREFIX))
}

fn paired_packet_kind(schema: &str) -> StudioResult<PairedV2PacketKind> {
    PairedV2PacketKind::from_schema(schema)
        .ok_or_else(|| StudioCommandError::new(StudioReasonCode::ProtocolInvalid))
}

fn reject_paired_packet_text(packet_json: &str) -> StudioResult<()> {
    if matches!(
        classify_packet(packet_json.as_bytes()),
        PairedV2PacketClassification::Paired { .. }
    ) {
        return Err(StudioCommandError::new(StudioReasonCode::ProtocolInvalid));
    }
    Ok(())
}

fn validate_paired_export_canonical(
    packet_json: &str,
    envelope: &PairedV2PacketEnvelope,
) -> StudioResult<()> {
    if envelope.canonical_json != packet_json {
        return Err(StudioCommandError::new(StudioReasonCode::ProtocolInvalid));
    }
    Ok(())
}

fn paired_import_response(
    path: &std::path::Path,
    envelope: PairedV2PacketEnvelope,
) -> ThemePacketImportResponse {
    ThemePacketImportResponse {
        cancelled: false,
        display_name: display_name(path),
        canonical_json: Some(envelope.canonical_json.clone()),
        kind: Some(envelope.kind.clone()),
        digest: Some(envelope.digest.clone()),
        paired_v2: Some(envelope),
        error: None,
    }
}

fn paired_default_name(kind: PairedV2PacketKind) -> String {
    let suffix = match kind {
        PairedV2PacketKind::Brief => "brief",
        PairedV2PacketKind::Candidate => "candidate",
        PairedV2PacketKind::Review => "review",
    };
    format!("theme.paired-v2-{suffix}.json")
}

fn classify_paired_packet(
    packet_json: &str,
    expected_kind: Option<&str>,
) -> StudioResult<Option<PairedV2PacketEnvelope>> {
    let classification = classify_packet(packet_json.as_bytes());
    let expected_paired = expected_kind_is_paired(expected_kind);
    match classification {
        PairedV2PacketClassification::Paired { schema } => {
            let Some(expected_kind) = expected_kind else {
                return Err(StudioCommandError::new(StudioReasonCode::ProtocolInvalid));
            };
            if expected_kind != schema {
                return Err(StudioCommandError::new(StudioReasonCode::ProtocolInvalid));
            }
            Ok(Some(parse_packet(
                packet_json.as_bytes(),
                Some(expected_kind),
            )?))
        }
        PairedV2PacketClassification::NonPaired | PairedV2PacketClassification::Indeterminate => {
            if expected_paired {
                Err(StudioCommandError::new(StudioReasonCode::ProtocolInvalid))
            } else {
                Ok(None)
            }
        }
    }
}

#[tauri::command(async)]
pub(crate) fn studio_theme_brief_create(
    request: ThemeBriefCreateRequest,
    app: AppHandle,
    state: tauri::State<'_, ThemeLabState>,
) -> StudioResult<ThemeBriefCreateResponse> {
    reject_nonpaired_path(&app)?;
    reject_paired_packet_text(&request.brief_input)?;
    let result = state.runner()?.create_brief(request.brief_input)?;
    Ok(ThemeBriefCreateResponse {
        canonical_json: result.canonical_json.unwrap_or_default(),
        digest: result.digest.unwrap_or_default(),
        error: result.error,
    })
}

pub fn import_theme_packet_from_path(
    selected_path: Option<PathBuf>,
    expected_kind: Option<String>,
    state: &ThemeLabState,
) -> StudioResult<ThemePacketImportResponse> {
    let Some(path) = selected_path else {
        return Ok(ThemePacketImportResponse {
            cancelled: true,
            display_name: None,
            canonical_json: None,
            kind: None,
            digest: None,
            paired_v2: None,
            error: None,
        });
    };
    let bytes = read_selected_bytes(&path, MAX_PACKET_BYTES)?;
    if let Some(envelope) = classify_paired_packet(
        std::str::from_utf8(&bytes).map_err(|_| invalid())?,
        expected_kind.as_deref(),
    )? {
        return Ok(paired_import_response(&path, envelope));
    }
    let text = String::from_utf8(bytes).map_err(|_| invalid())?;
    let result = state.runner()?.parse_packet(text, expected_kind)?;
    Ok(ThemePacketImportResponse {
        cancelled: false,
        display_name: display_name(&path),
        canonical_json: result.canonical_json,
        kind: result.kind,
        digest: result.digest,
        paired_v2: None,
        error: result.error,
    })
}

#[tauri::command(async)]
pub(crate) fn studio_theme_packet_import(
    request: ThemePacketImportRequest,
    app: AppHandle,
    state: tauri::State<'_, ThemeLabState>,
) -> StudioResult<ThemePacketImportResponse> {
    if paired_active(&app) {
        if request.expected_kind.as_deref() != Some("tf-paired-profile-v2-candidate")
            && request.expected_kind.as_deref() != Some(PAIRED_REVIEW_KIND)
        {
            return Err(StudioCommandError::new(StudioReasonCode::SelectionRejected));
        }
        let selection_key = paired_import_selection_key(request.expected_kind.as_deref())?;
        if let Some(path) = paired_path(&app, selection_key)? {
            return import_theme_packet_from_path(Some(path), request.expected_kind, &state);
        }
    } else {
        reject_nonpaired_path(&app)?;
    }
    #[cfg(feature = "native-smoke")]
    if let Some(selected) = crate::theme_lab::smoke_selection::select("import") {
        return import_theme_packet_from_path(selected?, request.expected_kind, &state);
    }
    let selected = app
        .dialog()
        .file()
        .set_title("Import Theme Exchange Packet")
        .add_filter("Theme packet JSON", &["json"])
        .blocking_pick_file()
        .map(|selected| {
            selected
                .into_path()
                .map_err(|_| StudioCommandError::new(StudioReasonCode::SelectionRejected))
        })
        .transpose()?;
    import_theme_packet_from_path(selected, request.expected_kind, &state)
}

pub fn export_theme_packet_to_path(
    selected_path: Option<PathBuf>,
    packet_json: String,
    state: &ThemeLabState,
) -> StudioResult<ThemePacketExportResponse> {
    let Some(path) = selected_path else {
        return Ok(ThemePacketExportResponse {
            cancelled: true,
            saved: false,
            display_name: None,
            digest: None,
            paired_v2: None,
            error: None,
        });
    };
    if path.extension().and_then(|extension| extension.to_str()) != Some("json") {
        return Err(StudioCommandError::new(StudioReasonCode::SelectionRejected));
    }
    reject_paired_packet_text(&packet_json)?;
    let result = state.runner()?.parse_packet(packet_json, None)?;
    if !result.valid {
        return Ok(ThemePacketExportResponse {
            cancelled: false,
            saved: false,
            display_name: display_name(&path),
            digest: None,
            paired_v2: None,
            error: result.error,
        });
    }
    let canonical = result.canonical_json.ok_or_else(invalid)?;
    if canonical.len() > MAX_PACKET_BYTES {
        return Err(StudioCommandError::new(StudioReasonCode::ResultTooLarge));
    }
    publish_selected_bytes(&path, canonical.as_bytes())?;
    Ok(ThemePacketExportResponse {
        cancelled: false,
        saved: true,
        display_name: display_name(&path),
        digest: result.digest,
        paired_v2: None,
        error: None,
    })
}

pub fn export_paired_theme_packet_to_path(
    selected_path: Option<PathBuf>,
    envelope: PairedV2PacketEnvelope,
    state: &AppThemeState,
) -> StudioResult<ThemePacketExportResponse> {
    let Some(path) = selected_path else {
        return Ok(ThemePacketExportResponse {
            cancelled: true,
            saved: false,
            display_name: None,
            digest: None,
            paired_v2: None,
            error: None,
        });
    };
    if path.extension().and_then(|extension| extension.to_str()) != Some("json") {
        return Err(StudioCommandError::new(StudioReasonCode::SelectionRejected));
    }
    let kind = paired_packet_kind(&envelope.kind)?;
    if envelope.canonical_json.len() > PAIRED_V2_PACKET_MAX_BYTES {
        return Err(StudioCommandError::new(StudioReasonCode::ResultTooLarge));
    }
    state.publish_paired_packet_to_path(&path, kind, &envelope)?;
    Ok(ThemePacketExportResponse {
        cancelled: false,
        saved: true,
        display_name: display_name(&path),
        digest: Some(envelope.digest.clone()),
        paired_v2: Some(envelope),
        error: None,
    })
}

#[tauri::command(async)]
pub(crate) fn studio_theme_packet_export(
    request: ThemePacketExportRequest,
    app: AppHandle,
    state: tauri::State<'_, ThemeLabState>,
    app_theme_state: tauri::State<'_, AppThemeState>,
) -> StudioResult<ThemePacketExportResponse> {
    // Classify before touching the generic runner. Paired packets have their
    // own strict parser and custody-aware publisher.
    if let Some(envelope) =
        classify_paired_packet(&request.packet_json, request.expected_kind.as_deref())?
    {
        validate_paired_export_canonical(&request.packet_json, &envelope)?;
        let kind = paired_packet_kind(&envelope.kind)?;
        if paired_active(&app) {
            let selection_key = paired_export_selection_key(kind)?;
            if let Some(selected) = paired_path(&app, selection_key)? {
                return export_paired_theme_packet_to_path(
                    Some(selected),
                    envelope,
                    &app_theme_state,
                );
            }
        }
        #[cfg(feature = "native-smoke")]
        if let Some(selected) = crate::theme_lab::smoke_selection::select(kind.schema()) {
            return export_paired_theme_packet_to_path(selected?, envelope, &app_theme_state);
        }
        let selected = app
            .dialog()
            .file()
            .set_title("Export Paired Profile v2 Packet")
            .add_filter("Paired Profile v2 packet JSON", &["json"])
            .set_file_name(paired_default_name(kind))
            .blocking_save_file()
            .map(|selected| {
                selected
                    .into_path()
                    .map_err(|_| StudioCommandError::new(StudioReasonCode::SelectionRejected))
            })
            .transpose()?;
        return export_paired_theme_packet_to_path(selected, envelope, &app_theme_state);
    }

    if expected_kind_is_paired(request.expected_kind.as_deref()) {
        return Err(StudioCommandError::new(StudioReasonCode::ProtocolInvalid));
    }
    reject_nonpaired_path(&app)?;

    // Validate and derive the kind before presenting a destination or publishing.
    let result = state
        .runner()?
        .parse_packet(request.packet_json, request.expected_kind.clone())?;
    if !result.valid {
        return Ok(ThemePacketExportResponse {
            cancelled: false,
            saved: false,
            display_name: None,
            digest: None,
            paired_v2: None,
            error: result.error,
        });
    }
    let kind = result.kind.as_deref().ok_or_else(invalid)?;
    let canonical = result.canonical_json.ok_or_else(invalid)?;
    #[cfg(feature = "native-smoke")]
    if let Some(selected) = crate::theme_lab::smoke_selection::select(kind) {
        return export_theme_packet_to_path(selected?, canonical, &state);
    }
    let default_name = format!("theme.tfsl-{kind}.json");
    let selected = app
        .dialog()
        .file()
        .set_title("Export Theme Exchange Packet")
        .add_filter("Theme packet JSON", &["json"])
        .set_file_name(default_name)
        .blocking_save_file()
        .map(|selected| {
            selected
                .into_path()
                .map_err(|_| StudioCommandError::new(StudioReasonCode::SelectionRejected))
        })
        .transpose()?;
    export_theme_packet_to_path(selected, canonical, &state)
}

#[tauri::command(async)]
pub(crate) fn studio_app_theme_paired_packet_create_v2(
    request: PairedV2PacketCreateRequest,
) -> StudioResult<PairedV2PacketEnvelope> {
    create_packet(request)
}

#[tauri::command(async)]
pub(crate) fn studio_theme_review_create(
    request: ThemeReviewCreateRequest,
    app: AppHandle,
    state: tauri::State<'_, ThemeLabState>,
) -> StudioResult<ThemeReviewCreateResponse> {
    reject_nonpaired_path(&app)?;
    reject_paired_packet_text(&request.review_input)?;
    let result = state.runner()?.create_review(request.review_input)?;
    Ok(ThemeReviewCreateResponse {
        canonical_json: result.canonical_json.unwrap_or_default(),
        digest: result.digest.unwrap_or_default(),
        error: result.error,
    })
}
#[tauri::command(async)]
pub(crate) fn studio_theme_candidate_verify(
    request: ThemeCandidateVerifyRequest,
    state: tauri::State<'_, ThemeLabState>,
) -> StudioResult<BatchSubprocessResponse> {
    reject_paired_packet_text(&request.candidate)?;
    reject_paired_packet_text(&request.brief)?;
    state
        .runner()?
        .verify_candidate(request.candidate, request.brief, request.options)
}
#[tauri::command(async)]
pub(crate) fn studio_theme_review_validate(
    request: ThemeReviewValidateRequest,
    state: tauri::State<'_, ThemeLabState>,
) -> StudioResult<BatchSubprocessResponse> {
    reject_paired_packet_text(&request.review)?;
    reject_paired_packet_text(&request.brief)?;
    for candidate in &request.candidates {
        reject_paired_packet_text(candidate)?;
    }
    state.runner()?.validate_review(request)
}
#[tauri::command(async)]
pub(crate) fn studio_theme_candidate_adopt(
    request: ThemeCandidateAdoptRequest,
    state: tauri::State<'_, ThemeLabState>,
) -> StudioResult<ThemeCandidateAdoptResponse> {
    reject_paired_packet_text(&request.candidate)?;
    reject_paired_packet_text(&request.brief)?;
    state.adopt_candidate(request)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app_theme::paired_v2_packets::{
        PairedV2BriefCreateInput, PairedV2CandidateCreateInput, PairedV2PacketCreateRequest,
        PairedV2ReviewCreateInput, PairedV2ReviewDisposition, PairedV2ReviewDispositionKind,
    };
    use crate::app_theme::runner::AppThemeRunner;
    use crate::state::app_theme::AppThemeState;
    use crate::theme_lab::runner::ThemeLabRunner;
    use base64::Engine as _;
    use sha2::Digest;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn digest(ch: char) -> String {
        std::iter::repeat_n(ch, 64).collect()
    }

    fn owned_directory(tag: &str) -> Option<PathBuf> {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |duration| duration.as_nanos());
        let directory = std::env::temp_dir().join(format!(
            "tfsb-paired-packet-command-{tag}-{}-{nanos}",
            std::process::id()
        ));
        std::fs::create_dir(&directory).ok().map(|_| directory)
    }

    fn theme_state() -> ThemeLabState {
        ThemeLabState::new(ThemeLabRunner::new(
            PathBuf::from("/nonexistent/node"),
            PathBuf::from("/nonexistent/batch"),
        ))
    }

    fn app_theme_state() -> AppThemeState {
        AppThemeState::new(AppThemeRunner::new(
            PathBuf::from("/nonexistent/node"),
            PathBuf::from("/nonexistent/adapter"),
        ))
    }

    fn brief_input() -> PairedV2BriefCreateInput {
        PairedV2BriefCreateInput {
            schema: "tf-paired-profile-v2-brief".to_owned(),
            schema_version: 1,
            brief_id: "brief-1".to_owned(),
            title: "Packet brief".to_owned(),
            goal: "Exercise portable exchange".to_owned(),
            profile_name: "Profile".to_owned(),
            profile_version: "1.0.0".to_owned(),
            source_profile_sha256: digest('a'),
            source_canonical_digest: digest('b'),
            editable_paths: vec!["color.*".to_owned()],
            allowed_modes: vec!["light".to_owned()],
            acceptance_criteria: vec!["Retain identity".to_owned()],
            prohibited_changes: vec!["No overwrite".to_owned()],
        }
    }

    fn candidate_input() -> PairedV2CandidateCreateInput {
        let source = b"source";
        PairedV2CandidateCreateInput {
            schema: "tf-paired-profile-v2-candidate".to_owned(),
            schema_version: 1,
            candidate_id: "candidate-1".to_owned(),
            brief_digest: digest('a'),
            source_bytes_base64: base64::engine::general_purpose::STANDARD.encode(source),
            source_profile_sha256: format!("{:x}", sha2::Sha256::digest(source)),
            source_canonical_digest: digest('b'),
            rationale: "Candidate rationale".to_owned(),
        }
    }

    fn review_input() -> PairedV2ReviewCreateInput {
        PairedV2ReviewCreateInput {
            schema: "tf-paired-profile-v2-review".to_owned(),
            schema_version: 1,
            review_id: "review-1".to_owned(),
            brief_digest: digest('a'),
            candidate_digests: vec![digest('c')],
            dispositions: vec![PairedV2ReviewDisposition {
                candidate_digest: digest('c'),
                disposition: PairedV2ReviewDispositionKind::Approve,
                comment: None,
            }],
            overall_disposition: PairedV2ReviewDispositionKind::Approve,
            summary: "Review summary".to_owned(),
        }
    }

    fn create_envelope(kind: PairedV2PacketKind) -> Option<PairedV2PacketEnvelope> {
        let request = match kind {
            PairedV2PacketKind::Brief => PairedV2PacketCreateRequest::Brief(brief_input()),
            PairedV2PacketKind::Candidate => {
                PairedV2PacketCreateRequest::Candidate(candidate_input())
            }
            PairedV2PacketKind::Review => PairedV2PacketCreateRequest::Review(review_input()),
        };
        create_packet(request).ok()
    }

    #[test]
    fn paired_review_kind_uses_only_the_closed_import_export_keys() {
        assert_eq!(
            paired_import_selection_key(Some(PAIRED_CANDIDATE_KIND)).ok(),
            Some("import")
        );
        assert_eq!(
            paired_import_selection_key(Some(PAIRED_REVIEW_KIND)).ok(),
            Some("review-import")
        );
        assert!(paired_import_selection_key(Some("tf-paired-profile-v2-brief")).is_err());
        assert!(paired_import_selection_key(Some("tf-paired-profile-v1-review")).is_err());
        assert!(paired_import_selection_key(None).is_err());

        assert_eq!(
            paired_export_selection_key(PairedV2PacketKind::Candidate).ok(),
            Some(PAIRED_CANDIDATE_KIND)
        );
        assert_eq!(
            paired_export_selection_key(PairedV2PacketKind::Review).ok(),
            Some(PAIRED_REVIEW_KIND)
        );
        assert!(paired_export_selection_key(PairedV2PacketKind::Brief).is_err());
    }

    fn oversized_paired_packet_text() -> String {
        let mut bytes = Vec::with_capacity(PAIRED_V2_PACKET_MAX_BYTES + 64);
        bytes.extend_from_slice(br#"{"schema":"tf-paired-profile-v2-brief","padding":""#);
        bytes.extend(std::iter::repeat_n(b'x', PAIRED_V2_PACKET_MAX_BYTES));
        bytes.extend_from_slice(br#""}"#);
        String::from_utf8(bytes).unwrap_or_default()
    }

    #[test]
    fn paired_create_import_export_uses_pure_paths_without_loom_runner() -> Result<(), &'static str>
    {
        let Some(directory) = owned_directory("round-trip") else {
            return Err("could not create exclusive test directory");
        };
        let Some(envelope) = studio_app_theme_paired_packet_create_v2(
            PairedV2PacketCreateRequest::Brief(brief_input()),
        )
        .ok() else {
            return Err("paired create was rejected");
        };
        let source = directory.join("brief.json");
        assert!(std::fs::write(&source, envelope.canonical_json.as_bytes()).is_ok());

        let imported = import_theme_packet_from_path(
            Some(source),
            Some(envelope.kind.clone()),
            &theme_state(),
        );
        assert!(imported.is_ok());
        if let Ok(imported) = imported {
            assert!(imported.paired_v2.is_some());
            assert_eq!(imported.kind.as_deref(), Some(envelope.kind.as_str()));
        }

        let destination = directory.join("exported.json");
        let exported = export_paired_theme_packet_to_path(
            Some(destination.clone()),
            envelope.clone(),
            &app_theme_state(),
        );
        assert!(exported.is_ok());
        if let Ok(exported) = exported {
            assert!(exported.saved);
            assert!(exported.paired_v2.is_some());
        }
        assert!(std::fs::remove_dir_all(directory).is_ok());
        Ok(())
    }

    #[test]
    fn all_paired_kinds_round_trip_and_use_fixed_names() -> Result<(), &'static str> {
        let Some(directory) = owned_directory("kinds") else {
            return Err("could not create exclusive test directory");
        };
        for (index, kind) in [
            PairedV2PacketKind::Brief,
            PairedV2PacketKind::Candidate,
            PairedV2PacketKind::Review,
        ]
        .into_iter()
        .enumerate()
        {
            let Some(envelope) = create_envelope(kind) else {
                return Err("paired packet creation failed");
            };
            assert_eq!(
                paired_default_name(kind),
                format!(
                    "theme.paired-v2-{}.json",
                    match kind {
                        PairedV2PacketKind::Brief => "brief",
                        PairedV2PacketKind::Candidate => "candidate",
                        PairedV2PacketKind::Review => "review",
                    }
                )
            );
            let path = directory.join(format!("packet-{index}.json"));
            assert!(std::fs::write(&path, envelope.canonical_json.as_bytes()).is_ok());
            let imported = import_theme_packet_from_path(
                Some(path),
                Some(kind.schema().to_owned()),
                &theme_state(),
            );
            assert!(imported.is_ok());
            if let Ok(imported) = imported {
                assert_eq!(imported.kind.as_deref(), Some(kind.schema()));
                assert!(imported.paired_v2.is_some());
            }
        }
        assert!(std::fs::remove_dir_all(directory).is_ok());
        Ok(())
    }

    #[test]
    fn paired_wrong_kind_never_falls_through_generic_and_refusals_omit_envelope()
    -> Result<(), &'static str> {
        let Some(directory) = owned_directory("refusal") else {
            return Err("could not create exclusive test directory");
        };
        let Some(envelope) = create_envelope(PairedV2PacketKind::Brief) else {
            return Err("paired packet creation failed");
        };
        let path = directory.join("brief.json");
        assert!(std::fs::write(&path, envelope.canonical_json.as_bytes()).is_ok());
        let wrong_kind = import_theme_packet_from_path(
            Some(path),
            Some(PairedV2PacketKind::Candidate.schema().to_owned()),
            &theme_state(),
        );
        assert!(matches!(
            wrong_kind,
            Err(error) if error.reason_code() == StudioReasonCode::ProtocolInvalid
        ));

        let no_expected_kind =
            import_theme_packet_from_path(Some(directory.join("brief.json")), None, &theme_state());
        assert!(matches!(
            no_expected_kind,
            Err(error) if error.reason_code() == StudioReasonCode::ProtocolInvalid
        ));

        let generic_fallback = export_theme_packet_to_path(
            Some(directory.join("fallback.json")),
            envelope.canonical_json.clone(),
            &theme_state(),
        );
        assert!(matches!(
            generic_fallback,
            Err(error) if error.reason_code() == StudioReasonCode::ProtocolInvalid
        ));

        let cancelled_import = import_theme_packet_from_path(None, None, &theme_state());
        assert!(cancelled_import.is_ok());
        if let Ok(cancelled_import) = cancelled_import {
            assert!(cancelled_import.paired_v2.is_none());
        }
        let cancelled_export =
            export_paired_theme_packet_to_path(None, envelope, &app_theme_state());
        assert!(cancelled_export.is_ok());
        if let Ok(cancelled_export) = cancelled_export {
            assert!(cancelled_export.paired_v2.is_none());
        }
        assert!(std::fs::remove_dir_all(directory).is_ok());
        Ok(())
    }

    #[test]
    fn legacy_cancelled_wire_omits_optional_paired_envelope() {
        let response = import_theme_packet_from_path(None, None, &theme_state());
        assert!(response.is_ok());
        if let Ok(response) = response {
            let serialized = serde_json::to_string(&response);
            assert!(serialized.is_ok());
            if let Ok(serialized) = serialized {
                assert!(!serialized.contains("pairedV2"));
            }
        }
    }

    #[test]
    fn oversized_paired_packets_are_fenced_before_generic_import_or_export()
    -> Result<(), &'static str> {
        let Some(directory) = owned_directory("oversized") else {
            return Err("could not create exclusive test directory");
        };
        let packet = oversized_paired_packet_text();
        assert!(matches!(
            classify_paired_packet(&packet, None),
            Err(error) if error.reason_code() == StudioReasonCode::ProtocolInvalid
        ));
        assert!(matches!(
            classify_paired_packet(&packet, Some("tf-paired-profile-v2-brief")),
            Err(error) if error.reason_code() == StudioReasonCode::ResultTooLarge
        ));

        let source = directory.join("oversized.json");
        assert!(std::fs::write(&source, packet.as_bytes()).is_ok());
        let import_without_expected =
            import_theme_packet_from_path(Some(source.clone()), None, &theme_state());
        assert!(matches!(
            import_without_expected,
            Err(error) if error.reason_code() == StudioReasonCode::ProtocolInvalid
        ));
        let import_with_expected = import_theme_packet_from_path(
            Some(source),
            Some("tf-paired-profile-v2-brief".to_owned()),
            &theme_state(),
        );
        assert!(matches!(
            import_with_expected,
            Err(error) if error.reason_code() == StudioReasonCode::ResultTooLarge
        ));
        let export_without_expected = export_theme_packet_to_path(
            Some(directory.join("export.json")),
            packet,
            &theme_state(),
        );
        assert!(matches!(
            export_without_expected,
            Err(error) if error.reason_code() == StudioReasonCode::ProtocolInvalid
        ));
        assert!(std::fs::remove_dir_all(directory).is_ok());
        Ok(())
    }

    #[test]
    fn paired_export_requires_native_canonical_request_bytes() -> Result<(), &'static str> {
        let Some(envelope) = create_envelope(PairedV2PacketKind::Brief) else {
            return Err("paired packet creation failed");
        };
        assert!(validate_paired_export_canonical(&envelope.canonical_json, &envelope).is_ok());
        let noncanonical = format!(" {} ", envelope.canonical_json);
        assert!(matches!(
            validate_paired_export_canonical(&noncanonical, &envelope),
            Err(error) if error.reason_code() == StudioReasonCode::ProtocolInvalid
        ));
        Ok(())
    }

    #[test]
    fn generic_packet_authority_fences_known_paired_family_only() -> Result<(), &'static str> {
        let Some(envelope) = create_envelope(PairedV2PacketKind::Brief) else {
            return Err("paired packet creation failed");
        };
        assert!(reject_paired_packet_text(&envelope.canonical_json).is_err());
        assert!(
            reject_paired_packet_text(r#"{"schema":"tfsl.theme-brief","schemaVersion":1}"#).is_ok()
        );
        Ok(())
    }
}
