use tauri::AppHandle;
use tauri_plugin_dialog::DialogExt;

use crate::errors::{StudioCommandError, StudioReasonCode, StudioResult};
use crate::scene::protocol_dto::{
    SceneAdoptRequest, SceneBriefRequest, SceneDraftResponse, ScenePacketExportRequest,
    ScenePacketImportRequest, ScenePacketResponse, ScenePublicationResponse, SceneReviewRequest,
    SceneVerificationResponse, SceneVerifyRequest,
};
use crate::state::scene::SceneState;

#[tauri::command(async)]
pub(crate) fn studio_scene_brief_create(
    request: SceneBriefRequest,
    state: tauri::State<'_, SceneState>,
) -> StudioResult<ScenePacketResponse> {
    crate::scene::protocol_dto::validate_request_size(&request, 64 * 1024)?;
    state.brief_create(request)
}

#[tauri::command(async)]
pub(crate) fn studio_scene_packet_import(
    request: ScenePacketImportRequest,
    app: AppHandle,
    state: tauri::State<'_, SceneState>,
) -> StudioResult<ScenePacketResponse> {
    crate::scene::protocol_dto::validate_request_size(&request, 64 * 1024)?;
    if let Some(ref expected) = request.expected {
        let _ = state.status(crate::scene::protocol_dto::SceneStatusRequest {
            expected: Some(expected.clone()),
        })?;
    }

    let selected = app
        .dialog()
        .file()
        .set_title("Import Scene Exchange Packet")
        .add_filter("Scene packet JSON", &["json"])
        .blocking_pick_file();

    let selected = selected
        .map(|s| {
            s.into_path()
                .map_err(|_| StudioCommandError::new(StudioReasonCode::SelectionRejected))
        })
        .transpose()?;

    state.packet_import(request, selected)
}

#[tauri::command(async)]
pub(crate) fn studio_scene_packet_export(
    request: ScenePacketExportRequest,
    app: AppHandle,
    state: tauri::State<'_, SceneState>,
) -> StudioResult<ScenePublicationResponse> {
    crate::scene::protocol_dto::validate_request_size(&request, 64 * 1024)?;
    let _ = state.status(crate::scene::protocol_dto::SceneStatusRequest {
        expected: Some(request.expected.clone()),
    })?;

    let default_name = "scene-packet.json";
    let selected = app
        .dialog()
        .file()
        .set_title("Export Scene Exchange Packet")
        .add_filter("Scene packet JSON", &["json"])
        .set_file_name(default_name)
        .blocking_save_file();

    let selected = selected
        .map(|s| {
            s.into_path()
                .map_err(|_| StudioCommandError::new(StudioReasonCode::SelectionRejected))
        })
        .transpose()?;

    state.packet_export(request, selected)
}

#[tauri::command(async)]
pub(crate) fn studio_scene_review_create(
    request: SceneReviewRequest,
    state: tauri::State<'_, SceneState>,
) -> StudioResult<ScenePacketResponse> {
    crate::scene::protocol_dto::validate_request_size(&request, 64 * 1024)?;
    state.review_create(request)
}

#[tauri::command(async)]
pub(crate) fn studio_scene_candidate_verify(
    request: SceneVerifyRequest,
    state: tauri::State<'_, SceneState>,
) -> StudioResult<SceneVerificationResponse> {
    crate::scene::protocol_dto::validate_request_size(&request, 64 * 1024)?;
    state.candidate_verify(request)
}

#[tauri::command(async)]
pub(crate) fn studio_scene_candidate_adopt(
    request: SceneAdoptRequest,
    state: tauri::State<'_, SceneState>,
) -> StudioResult<SceneDraftResponse> {
    crate::scene::protocol_dto::validate_request_size(&request, 64 * 1024)?;
    state.candidate_adopt(request)
}
