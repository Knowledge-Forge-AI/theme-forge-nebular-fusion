use tauri::AppHandle;
use tauri_plugin_dialog::DialogExt;

use crate::errors::{StudioCommandError, StudioReasonCode, StudioResult};
use crate::scene::protocol_dto::{
    SceneApplyRequest, SceneCompileRequest, SceneCompileResponse, SceneDisposeRequest,
    SceneDisposeResponse, SceneDraftResponse, SceneEditRequest, SceneExportPlanRequest,
    SceneImportResponse, SceneImportSvgRequest, SceneNewRequest, SceneOpenRequest,
    ScenePlanResponse, ScenePublicationResponse, SceneSavePlanRequest, SceneSelectionResponse,
    SceneStatusRequest, SceneStatusResponse, SceneTokenBindRequest,
};
use crate::state::scene::SceneState;

#[tauri::command(async)]
pub(crate) fn studio_scene_new(
    request: SceneNewRequest,
    state: tauri::State<'_, SceneState>,
) -> StudioResult<SceneDraftResponse> {
    crate::scene::protocol_dto::validate_request_size(&request, 64 * 1024)?;
    state.new_draft(request)
}

#[tauri::command(async)]
pub(crate) fn studio_scene_status(
    request: SceneStatusRequest,
    host: tauri::State<'_, crate::state::host::HostState>,
    state: tauri::State<'_, SceneState>,
) -> StudioResult<SceneStatusResponse> {
    crate::scene::protocol_dto::validate_request_size(&request, 64 * 1024)?;
    state.status_with_host(request, host.scene_generation())
}

#[tauri::command(async)]
pub(crate) fn studio_scene_dispose(
    request: SceneDisposeRequest,
    state: tauri::State<'_, SceneState>,
) -> StudioResult<SceneDisposeResponse> {
    crate::scene::protocol_dto::validate_request_size(&request, 64 * 1024)?;
    state.dispose(request)
}

#[tauri::command(async)]
pub(crate) fn studio_scene_open(
    request: SceneOpenRequest,
    app: AppHandle,
    state: tauri::State<'_, SceneState>,
) -> StudioResult<SceneSelectionResponse> {
    crate::scene::protocol_dto::validate_request_size(&request, 64 * 1024)?;
    // 1. Capture native replacement intent and validate expected BEFORE picker
    let reservation = state.begin_replacement(
        request.expected.as_ref(),
        request.replacement_intent_id.as_deref(),
    )?;

    // 2. Open native picker
    let selected = app
        .dialog()
        .file()
        .set_title("Open Vector Scene")
        .add_filter("Vector Scene JSON", &["json"])
        .blocking_pick_file();

    let selected = selected
        .map(|s| {
            s.into_path()
                .map_err(|_| StudioCommandError::new(StudioReasonCode::SelectionRejected))
        })
        .transpose()?;

    let Some(path) = selected else {
        state.cancel_replacement(&reservation);
        return Ok(SceneSelectionResponse {
            cancelled: true,
            draft: None,
        });
    };

    // 3. Open file, compile canonical scene, validate reservation at completion
    let draft = state.open_file(path, reservation)?;
    Ok(SceneSelectionResponse {
        cancelled: false,
        draft: Some(draft),
    })
}

#[tauri::command(async)]
pub(crate) fn studio_scene_import_svg(
    request: SceneImportSvgRequest,
    app: AppHandle,
    state: tauri::State<'_, SceneState>,
) -> StudioResult<SceneImportResponse> {
    crate::scene::protocol_dto::validate_request_size(&request, 64 * 1024)?;
    // 1. Capture native replacement intent and validate expected BEFORE picker
    let reservation = state.begin_replacement(
        request.expected.as_ref(),
        request.replacement_intent_id.as_deref(),
    )?;

    // 2. Open native picker
    let selected = app
        .dialog()
        .file()
        .set_title("Import SVG as Scene")
        .add_filter("Scalable Vector Graphics", &["svg"])
        .blocking_pick_file();

    let selected = selected
        .map(|s| {
            s.into_path()
                .map_err(|_| StudioCommandError::new(StudioReasonCode::SelectionRejected))
        })
        .transpose()?;

    let Some(path) = selected else {
        state.cancel_replacement(&reservation);
        return Ok(SceneImportResponse {
            cancelled: true,
            classification: None,
            reason_codes: Vec::new(),
            draft: None,
            normalizations: Vec::new(),
            diagnostics: Vec::new(),
        });
    };

    // 3. Import SVG, compile canonical scene, validate reservation at completion
    state.import_svg_file(path, reservation)
}

#[tauri::command(async)]
pub(crate) fn studio_scene_edit(
    request: SceneEditRequest,
    state: tauri::State<'_, SceneState>,
) -> StudioResult<SceneDraftResponse> {
    crate::scene::protocol_dto::validate_request_size(&request, 1024 * 1024)?;
    state.edit(request)
}

#[tauri::command(async)]
pub(crate) fn studio_scene_compile(
    request: SceneCompileRequest,
    state: tauri::State<'_, SceneState>,
) -> StudioResult<SceneCompileResponse> {
    crate::scene::protocol_dto::validate_request_size(&request, 64 * 1024)?;
    state.compile(request)
}

#[tauri::command(async)]
pub(crate) fn studio_scene_save_plan(
    request: SceneSavePlanRequest,
    app: AppHandle,
    state: tauri::State<'_, SceneState>,
) -> StudioResult<ScenePlanResponse> {
    crate::scene::protocol_dto::validate_request_size(&request, 64 * 1024)?;
    state.validate_save_plan_preconditions(&request.expected)?;

    let default_name = request
        .default_name
        .clone()
        .unwrap_or_else(|| "scene.tfsb-scene.json".to_owned());
    crate::scene::io::validate_suggested_name(&default_name)?;
    let selected = app
        .dialog()
        .file()
        .set_title("Save Vector Scene As")
        .add_filter("Vector Scene JSON", &["json"])
        .set_file_name(&default_name)
        .blocking_save_file();

    let selected = selected
        .map(|s| {
            s.into_path()
                .map_err(|_| StudioCommandError::new(StudioReasonCode::SelectionRejected))
        })
        .transpose()?;

    state.save_plan(request, selected)
}

#[tauri::command(async)]
pub(crate) fn studio_scene_save_apply(
    request: SceneApplyRequest,
    state: tauri::State<'_, SceneState>,
) -> StudioResult<ScenePublicationResponse> {
    crate::scene::protocol_dto::validate_request_size(&request, 64 * 1024)?;
    state.save_apply(request)
}

#[tauri::command(async)]
pub(crate) fn studio_scene_export_plan(
    request: SceneExportPlanRequest,
    app: AppHandle,
    state: tauri::State<'_, SceneState>,
) -> StudioResult<ScenePlanResponse> {
    crate::scene::protocol_dto::validate_request_size(&request, 64 * 1024)?;
    state.validate_export_plan_preconditions(&request.expected)?;

    let default_name = request
        .default_name
        .clone()
        .unwrap_or_else(|| "scene.svg".to_owned());
    crate::scene::io::validate_suggested_name(&default_name)?;
    let selected = app
        .dialog()
        .file()
        .set_title("Export Scene as SVG")
        .add_filter("Scalable Vector Graphics", &["svg"])
        .set_file_name(&default_name)
        .blocking_save_file();

    let selected = selected
        .map(|s| {
            s.into_path()
                .map_err(|_| StudioCommandError::new(StudioReasonCode::SelectionRejected))
        })
        .transpose()?;

    state.export_plan(request, selected)
}

#[tauri::command(async)]
pub(crate) fn studio_scene_export_apply(
    request: SceneApplyRequest,
    state: tauri::State<'_, SceneState>,
) -> StudioResult<ScenePublicationResponse> {
    crate::scene::protocol_dto::validate_request_size(&request, 64 * 1024)?;
    state.export_apply(request)
}

#[tauri::command(async)]
pub(crate) fn studio_scene_bind_tokens(
    request: SceneTokenBindRequest,
    host: tauri::State<'_, crate::state::host::HostState>,
    state: tauri::State<'_, SceneState>,
) -> StudioResult<SceneDraftResponse> {
    crate::scene::protocol_dto::validate_request_size(&request, 64 * 1024)?;
    state.bind_tokens(request, &host)
}
