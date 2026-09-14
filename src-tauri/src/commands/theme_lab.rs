use std::path::PathBuf;
use tauri::AppHandle;
use tauri_plugin_dialog::DialogExt;

use crate::errors::{StudioCommandError, StudioReasonCode, StudioResult};
use crate::state::theme_lab::ThemeLabState;
use crate::theme_lab::types::{
    ThemeDocument, ThemeDraftUpdateRequest, ThemeDraftUpdateResponse, ThemeLabCompileRequest,
    ThemeLabCompileResponse, ThemeLabExampleResponse, ThemeLabOpenRequest, ThemeLabOpenResponse,
    ThemeLabSaveRequest, ThemeLabSaveResponse, ThemeLabStatus,
};

#[tauri::command(async)]
pub(crate) fn studio_theme_lab_status(
    state: tauri::State<'_, ThemeLabState>,
) -> StudioResult<ThemeLabStatus> {
    Ok(state.status())
}

#[tauri::command(async)]
pub(crate) fn studio_theme_lab_compile(
    request: ThemeLabCompileRequest,
    state: tauri::State<'_, ThemeLabState>,
) -> StudioResult<ThemeLabCompileResponse> {
    state.compile(request)
}

#[tauri::command(async)]
pub(crate) fn studio_theme_lab_example(
    example_name: String,
    ui_revision: Option<u64>,
    session_id: Option<String>,
    state: tauri::State<'_, ThemeLabState>,
) -> StudioResult<ThemeLabExampleResponse> {
    state.example(example_name, ui_revision, session_id)
}

pub fn open_selected_path(
    selected: Option<PathBuf>,
    state: &ThemeLabState,
) -> StudioResult<ThemeLabOpenResponse> {
    let Some(path) = selected else {
        return Ok(ThemeLabOpenResponse {
            cancelled: true,
            specification: None,
            display_name: None,
            compiled_css: None,
            descriptor: None,
            styles: None,
            diagnostics: vec![],
            error: None,
        });
    };

    state.open_file(path)
}

#[tauri::command(async)]
pub(crate) fn studio_theme_lab_open(
    request: Option<ThemeLabOpenRequest>,
    app: AppHandle,
    state: tauri::State<'_, ThemeLabState>,
) -> StudioResult<ThemeLabOpenResponse> {
    let session_id = request.as_ref().and_then(|r| r.session_id.clone());
    let ui_revision = request.as_ref().and_then(|r| r.ui_revision);

    #[cfg(feature = "native-smoke")]
    if let Some(selected) = crate::theme_lab::smoke_selection::select("open") {
        let Some(path) = selected? else {
            return Ok(ThemeLabOpenResponse {
                cancelled: true,
                specification: None,
                display_name: None,
                compiled_css: None,
                descriptor: None,
                styles: None,
                diagnostics: vec![],
                error: None,
            });
        };
        return state.open_file_with_binding(path, session_id, ui_revision);
    }
    let selected = app
        .dialog()
        .file()
        .set_title("Open Theme Specification")
        .add_filter("Theme JSON", &["json"])
        .blocking_pick_file();

    let selected = selected
        .map(|s| {
            s.into_path()
                .map_err(|_| StudioCommandError::new(StudioReasonCode::SelectionRejected))
        })
        .transpose()?;

    let Some(path) = selected else {
        return Ok(ThemeLabOpenResponse {
            cancelled: true,
            specification: None,
            display_name: None,
            compiled_css: None,
            descriptor: None,
            styles: None,
            diagnostics: vec![],
            error: None,
        });
    };

    state.open_file_with_binding(path, session_id, ui_revision)
}

pub fn save_to_selected_path(
    selected: Option<PathBuf>,
    spec: impl Into<ThemeDocument>,
    state: &ThemeLabState,
) -> StudioResult<ThemeLabSaveResponse> {
    let Some(dest) = selected else {
        return Ok(ThemeLabSaveResponse {
            cancelled: true,
            display_name: None,
        });
    };

    let display_name = state.save_file(spec.into(), &dest)?;
    Ok(ThemeLabSaveResponse {
        cancelled: false,
        display_name: Some(display_name),
    })
}

#[tauri::command(async)]
pub(crate) fn studio_theme_lab_save(
    request: ThemeLabSaveRequest,
    app: AppHandle,
    state: tauri::State<'_, ThemeLabState>,
) -> StudioResult<ThemeLabSaveResponse> {
    #[cfg(feature = "native-smoke")]
    if let Some(selected) = crate::theme_lab::smoke_selection::select("save") {
        let Some(dest) = selected? else {
            return Ok(ThemeLabSaveResponse {
                cancelled: true,
                display_name: None,
            });
        };
        let display_name = state.save_file_with_binding(
            request.specification,
            &dest,
            request.session_id,
            request.ui_revision,
        )?;
        return Ok(ThemeLabSaveResponse {
            cancelled: false,
            display_name: Some(display_name),
        });
    }
    let active_path = state.active_file_path()?;
    let target_path = if request.save_as || active_path.is_none() {
        let default_name = format!("{}.theme.json", request.specification.name());
        app.dialog()
            .file()
            .set_title("Save Theme Specification")
            .add_filter("Theme JSON", &["json"])
            .set_file_name(&default_name)
            .blocking_save_file()
            .map(|s| {
                s.into_path()
                    .map_err(|_| StudioCommandError::new(StudioReasonCode::SelectionRejected))
            })
            .transpose()?
    } else {
        active_path
    };

    let Some(dest) = target_path else {
        return Ok(ThemeLabSaveResponse {
            cancelled: true,
            display_name: None,
        });
    };

    let display_name = state.save_file_with_binding(
        request.specification,
        &dest,
        request.session_id,
        request.ui_revision,
    )?;
    Ok(ThemeLabSaveResponse {
        cancelled: false,
        display_name: Some(display_name),
    })
}

#[tauri::command(async)]
pub(crate) fn studio_theme_lab_dispose(state: tauri::State<'_, ThemeLabState>) -> StudioResult<()> {
    state.cancel_active();
    Ok(())
}

#[tauri::command(async)]
pub(crate) fn studio_theme_lab_draft_update(
    request: ThemeDraftUpdateRequest,
    state: tauri::State<'_, ThemeLabState>,
) -> StudioResult<ThemeDraftUpdateResponse> {
    state.draft_update(request)
}
