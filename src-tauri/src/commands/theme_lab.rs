use std::path::PathBuf;
use tauri::AppHandle;
use tauri_plugin_dialog::DialogExt;

use crate::errors::{StudioCommandError, StudioReasonCode, StudioResult};
use crate::state::theme_lab::ThemeLabState;
use crate::theme_lab::types::{
    ThemeLabCompileRequest, ThemeLabCompileResponse, ThemeLabExampleResponse, ThemeLabOpenResponse,
    ThemeLabSaveRequest, ThemeLabSaveResponse, ThemeLabStatus, ThemeSpecification,
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
            diagnostics: vec![],
            error: None,
        });
    };

    state.open_file(path)
}

#[tauri::command(async)]
pub(crate) fn studio_theme_lab_open(
    app: AppHandle,
    state: tauri::State<'_, ThemeLabState>,
) -> StudioResult<ThemeLabOpenResponse> {
    #[cfg(feature = "native-smoke")]
    if let Some(selected) = crate::theme_lab::smoke_selection::select("open") {
        return open_selected_path(selected?, &state);
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

    open_selected_path(selected, &state)
}

pub fn save_to_selected_path(
    selected: Option<PathBuf>,
    spec: ThemeSpecification,
    state: &ThemeLabState,
) -> StudioResult<ThemeLabSaveResponse> {
    let Some(dest) = selected else {
        return Ok(ThemeLabSaveResponse {
            cancelled: true,
            display_name: None,
        });
    };

    let display_name = state.save_file(spec, &dest)?;
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
        return save_to_selected_path(selected?, request.specification, &state);
    }
    let active_path = state.active_file_path()?;
    let target_path = if request.save_as || active_path.is_none() {
        let default_name = format!("{}.theme.json", request.specification.name);
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

    save_to_selected_path(target_path, request.specification, &state)
}

#[tauri::command(async)]
pub(crate) fn studio_theme_lab_dispose(state: tauri::State<'_, ThemeLabState>) -> StudioResult<()> {
    state.cancel_active();
    Ok(())
}
