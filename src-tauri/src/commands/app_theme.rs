use tauri::AppHandle;
use tauri_plugin_dialog::DialogExt;

use crate::app_theme::types::{
    AppThemeCompileRequest, AppThemeCompileResponse, AppThemeExportRequest, AppThemeExportResponse,
    AppThemeOpenProfileResponse, AppThemePairedCompileRequest, AppThemePairedCompileResponse,
    AppThemeSaveProfileRequest, AppThemeSaveProfileResponse, AppThemeStatus,
};
use crate::errors::{StudioCommandError, StudioReasonCode, StudioResult};
use crate::state::app_theme::AppThemeState;

#[tauri::command(async)]
pub(crate) fn studio_app_theme_status(
    state: tauri::State<'_, AppThemeState>,
) -> StudioResult<AppThemeStatus> {
    Ok(state.status())
}

#[tauri::command(async)]
pub(crate) fn studio_app_theme_compile(
    request: AppThemeCompileRequest,
    state: tauri::State<'_, AppThemeState>,
) -> StudioResult<AppThemeCompileResponse> {
    state.compile(request)
}

#[tauri::command(async)]
pub(crate) fn studio_app_theme_paired_compile(
    request: AppThemePairedCompileRequest,
    state: tauri::State<'_, AppThemeState>,
) -> StudioResult<AppThemePairedCompileResponse> {
    state.paired_compile(request)
}

#[tauri::command(async)]
pub(crate) fn studio_app_theme_open_profile(
    app: AppHandle,
    state: tauri::State<'_, AppThemeState>,
) -> StudioResult<AppThemeOpenProfileResponse> {
    #[cfg(feature = "native-smoke")]
    if let Some(selected) = crate::theme_lab::smoke_selection::select("open") {
        let Some(path) = selected? else {
            return Ok(AppThemeOpenProfileResponse {
                cancelled: true,
                profile: None,
                display_name: None,
                file_path: None,
                error: None,
            });
        };
        return state.open_profile_path(path);
    }

    let selected = app
        .dialog()
        .file()
        .set_title("Open Application Theme Profile")
        .add_filter("Profile JSON", &["json"])
        .blocking_pick_file()
        .map(|s| {
            s.into_path()
                .map_err(|_| StudioCommandError::new(StudioReasonCode::SelectionRejected))
        })
        .transpose()?;

    let Some(path) = selected else {
        return Ok(AppThemeOpenProfileResponse {
            cancelled: true,
            profile: None,
            display_name: None,
            file_path: None,
            error: None,
        });
    };

    state.open_profile_path(path)
}

#[tauri::command(async)]
pub(crate) fn studio_app_theme_save_profile(
    request: AppThemeSaveProfileRequest,
    app: AppHandle,
    state: tauri::State<'_, AppThemeState>,
) -> StudioResult<AppThemeSaveProfileResponse> {
    #[cfg(feature = "native-smoke")]
    if let Some(selected) = crate::theme_lab::smoke_selection::select("save") {
        let Some(dest) = selected? else {
            return Ok(AppThemeSaveProfileResponse {
                cancelled: true,
                file_path: None,
                error: None,
            });
        };
        return state.save_profile_path(request.profile, dest);
    }

    let active_path = state.active_file_path()?;
    let target_path = if request.save_as.unwrap_or(false) || active_path.is_none() {
        let default_name = format!(
            "{}.profile.json",
            request.profile.name.to_lowercase().replace(' ', "-")
        );
        app.dialog()
            .file()
            .set_title("Save Application Theme Profile")
            .add_filter("Profile JSON", &["json"])
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
        return Ok(AppThemeSaveProfileResponse {
            cancelled: true,
            file_path: None,
            error: None,
        });
    };

    state.save_profile_path(request.profile, dest)
}

#[tauri::command(async)]
pub(crate) fn studio_app_theme_export_package(
    request: AppThemeExportRequest,
    app: AppHandle,
    state: tauri::State<'_, AppThemeState>,
) -> StudioResult<AppThemeExportResponse> {
    #[cfg(feature = "native-smoke")]
    if let Some(selected) = crate::theme_lab::smoke_selection::select("export") {
        let Some(dest) = selected? else {
            return Ok(AppThemeExportResponse {
                cancelled: true,
                destination: None,
                file_count: None,
                error: None,
            });
        };
        return state.export_package_to_path(
            request.specification,
            dest.to_string_lossy().into_owned(),
            request.language,
        );
    }

    let selected = app
        .dialog()
        .file()
        .set_title("Select Package Export Destination Directory")
        .blocking_pick_folder()
        .map(|s| {
            s.into_path()
                .map_err(|_| StudioCommandError::new(StudioReasonCode::SelectionRejected))
        })
        .transpose()?;

    let Some(dest) = selected else {
        return Ok(AppThemeExportResponse {
            cancelled: true,
            destination: None,
            file_count: None,
            error: None,
        });
    };

    state.export_package_to_path(
        request.specification,
        dest.to_string_lossy().into_owned(),
        request.language,
    )
}

#[tauri::command(async)]
pub(crate) fn studio_app_theme_reset(
    state: tauri::State<'_, AppThemeState>,
) -> StudioResult<AppThemeStatus> {
    state.reset()
}
