use crate::design_evidence::{publish_selected_bytes, read_selected_bytes};
use crate::errors::{StudioCommandError, StudioReasonCode, StudioResult};
use crate::state::theme_lab::ThemeLabState;
use crate::theme_lab::types::*;
use std::path::PathBuf;
use tauri::AppHandle;
use tauri_plugin_dialog::DialogExt;

const MAX_PACKET_BYTES: usize = 16 * 1024 * 1024;
fn invalid() -> StudioCommandError {
    StudioCommandError::new(StudioReasonCode::SidecarProtocolInvalid)
}
fn display_name(path: &std::path::Path) -> Option<String> {
    path.file_name()
        .and_then(|name| name.to_str())
        .filter(|name| name.len() <= 255 && !name.chars().any(char::is_control))
        .map(str::to_owned)
}

#[tauri::command(async)]
pub(crate) fn studio_theme_brief_create(
    request: ThemeBriefCreateRequest,
    state: tauri::State<'_, ThemeLabState>,
) -> StudioResult<ThemeBriefCreateResponse> {
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
            error: None,
        });
    };
    let bytes = read_selected_bytes(&path, MAX_PACKET_BYTES)?;
    let text = String::from_utf8(bytes).map_err(|_| invalid())?;
    let result = state.runner()?.parse_packet(text, expected_kind)?;
    Ok(ThemePacketImportResponse {
        cancelled: false,
        display_name: display_name(&path),
        canonical_json: result.canonical_json,
        kind: result.kind,
        digest: result.digest,
        error: result.error,
    })
}

#[tauri::command(async)]
pub(crate) fn studio_theme_packet_import(
    request: ThemePacketImportRequest,
    app: AppHandle,
    state: tauri::State<'_, ThemeLabState>,
) -> StudioResult<ThemePacketImportResponse> {
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
            error: None,
        });
    };
    if path.extension().and_then(|extension| extension.to_str()) != Some("json") {
        return Err(StudioCommandError::new(StudioReasonCode::SelectionRejected));
    }
    let result = state.runner()?.parse_packet(packet_json, None)?;
    if !result.valid {
        return Ok(ThemePacketExportResponse {
            cancelled: false,
            saved: false,
            display_name: display_name(&path),
            digest: None,
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
        error: None,
    })
}

#[tauri::command(async)]
pub(crate) fn studio_theme_packet_export(
    request: ThemePacketExportRequest,
    app: AppHandle,
    state: tauri::State<'_, ThemeLabState>,
) -> StudioResult<ThemePacketExportResponse> {
    // Validate and derive the kind before presenting a destination or publishing.
    let result = state.runner()?.parse_packet(request.packet_json, None)?;
    if !result.valid {
        return Ok(ThemePacketExportResponse {
            cancelled: false,
            saved: false,
            display_name: None,
            digest: None,
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
pub(crate) fn studio_theme_review_create(
    request: ThemeReviewCreateRequest,
    state: tauri::State<'_, ThemeLabState>,
) -> StudioResult<ThemeReviewCreateResponse> {
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
    state
        .runner()?
        .verify_candidate(request.candidate, request.brief, request.options)
}
#[tauri::command(async)]
pub(crate) fn studio_theme_review_validate(
    request: ThemeReviewValidateRequest,
    state: tauri::State<'_, ThemeLabState>,
) -> StudioResult<BatchSubprocessResponse> {
    state.runner()?.validate_review(request)
}
#[tauri::command(async)]
pub(crate) fn studio_theme_candidate_adopt(
    request: ThemeCandidateAdoptRequest,
    state: tauri::State<'_, ThemeLabState>,
) -> StudioResult<ThemeCandidateAdoptResponse> {
    state.adopt_candidate(request)
}
