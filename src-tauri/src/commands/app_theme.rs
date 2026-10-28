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
    let ticket = state.begin_open()?;

    #[cfg(feature = "native-smoke")]
    if let Some(selected) = crate::theme_lab::smoke_selection::select("open") {
        let Some(path) = selected? else {
            return Ok(AppThemeOpenProfileResponse {
                cancelled: true,
                document: None,
                error: None,
            });
        };
        return state.open_profile_path_with_ticket(path, ticket);
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
            document: None,
            error: None,
        });
    };

    state.open_profile_path_with_ticket(path, ticket)
}

#[tauri::command(async)]
pub(crate) fn studio_app_theme_save_profile(
    request: AppThemeSaveProfileRequest,
    app: AppHandle,
    state: tauri::State<'_, AppThemeState>,
) -> StudioResult<AppThemeSaveProfileResponse> {
    let ticket = state.current_custody_ticket()?;
    let (custodial_path, default_name) = match state.prepare_save_target(&request)? {
        Ok(pair) => pair,
        Err(err_msg) => {
            return Ok(AppThemeSaveProfileResponse {
                cancelled: false,
                saved: false,
                document: None,
                error: Some(err_msg),
            });
        }
    };

    #[cfg(feature = "native-smoke")]
    if let Some(selected) = crate::theme_lab::smoke_selection::select("save") {
        let Some(dest) = selected? else {
            return Ok(AppThemeSaveProfileResponse {
                cancelled: true,
                saved: false,
                document: None,
                error: None,
            });
        };
        return state.save_profile_path_with_ticket(request, dest, Some(ticket));
    }

    let target_path = if let Some(existing_path) = custodial_path {
        Some(existing_path)
    } else {
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
    };

    let Some(dest) = target_path else {
        return Ok(AppThemeSaveProfileResponse {
            cancelled: true,
            saved: false,
            document: None,
            error: None,
        });
    };

    state.save_profile_path_with_ticket(request, dest, Some(ticket))
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app_theme::runner::AppThemeRunner;
    use crate::app_theme::types::{PairedProfileDto, ProfileSaveMode};
    use std::path::PathBuf;
    use std::time::{Duration, SystemTime};

    const SAMPLE_V1_JSON: &[u8] = br##"{"schemaVersion":"tf-paired-profile-v1","name":"Forge Console Test","version":"0.1.0","description":"Test profile description","palette":{"light":{"background":"#ffffff","foreground":"#000000","card":"#ffffff","cardForeground":"#000000","popover":"#ffffff","popoverForeground":"#000000","primary":"#00a896","primaryForeground":"#ffffff","secondary":"#f1f5f9","secondaryForeground":"#0f172a","muted":"#f1f5f9","mutedForeground":"#64748b","accent":"#f1f5f9","accentForeground":"#0f172a","destructive":"#ef4444","destructiveForeground":"#ffffff","border":"#e2e8f0","input":"#e2e8f0","ring":"#00a896"},"dark":{"background":"#09090b","foreground":"#fafafa","card":"#09090b","cardForeground":"#fafafa","popover":"#09090b","popoverForeground":"#fafafa","primary":"#02c39a","primaryForeground":"#09090b","secondary":"#27272a","secondaryForeground":"#fafafa","muted":"#27272a","mutedForeground":"#a1a1aa","accent":"#27272a","accentForeground":"#fafafa","destructive":"#7f1d1d","destructiveForeground":"#fafafa","border":"#27272a","input":"#27272a","ring":"#02c39a"}},"surfaces":{"radius":"0.5rem","borderWidth":"1px","content":704},"typography":{"fontSans":"Inter, sans-serif"},"targetOverrides":{"loom":{"content":680,"defaultAccent":"cyan"},"solarSail":{"surfaces":{"radius":"0.75rem","borderWidth":"2px","content":680}}}}"##;

    fn sample_paired_profile() -> Result<PairedProfileDto, String> {
        PairedProfileDto::from_slice_with_alias_flag(SAMPLE_V1_JSON).map(|(dto, _)| dto)
    }

    fn temp_test_dir(tag: &str) -> Result<(AppThemeState, PathBuf), Box<dyn std::error::Error>> {
        let runner = AppThemeRunner::new(PathBuf::from("/bin/echo"), PathBuf::from("/dev/null"));
        let state = AppThemeState::new(runner);
        let nanos = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)?
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("tfsb-test-{tag}-{nanos}"));
        std::fs::create_dir_all(&dir)?;
        Ok((state, dir))
    }

    #[test]
    fn save_and_open_profile_target_overrides_round_trip() -> Result<(), Box<dyn std::error::Error>>
    {
        let (state, test_dir) = temp_test_dir("roundtrip")?;
        let file_path = test_dir.join("profile.json");
        let profile = sample_paired_profile()?;
        let save_res = state.save_profile_path(
            AppThemeSaveProfileRequest {
                profile: Some(profile.clone()),
                document_id: None,
                save_mode: Some(ProfileSaveMode::NewDocument),
            },
            file_path.clone(),
        )?;
        assert!(save_res.error.is_none() && save_res.saved);

        let doc = state
            .open_profile_path(file_path)?
            .document
            .ok_or("Expected opened document")?;
        assert_eq!(doc.display_name, "profile.json");
        assert!(!doc.document_id.contains("profile.json"));
        let opened_profile = doc.profile.ok_or("Expected opened profile")?;
        assert_eq!(opened_profile.name, profile.name);
        assert_eq!(opened_profile.target_overrides, profile.target_overrides);
        let _ = std::fs::remove_dir_all(&test_dir);
        Ok(())
    }

    #[test]
    fn open_profile_invalid_schema_rejected() -> Result<(), Box<dyn std::error::Error>> {
        let (state, test_dir) = temp_test_dir("schema")?;
        let file_path = test_dir.join("invalid-schema.json");
        let mut invalid_profile = sample_paired_profile()?;
        invalid_profile.schema_version = "tfss.theme-v1".to_string();
        std::fs::write(&file_path, serde_json::to_vec(&invalid_profile)?)?;

        let open_res = state.open_profile_path(file_path)?;
        assert!(open_res.document.is_none());
        assert!(
            open_res
                .error
                .ok_or("Expected error")?
                .contains("Invalid profile schema")
        );
        let _ = std::fs::remove_dir_all(&test_dir);
        Ok(())
    }

    #[test]
    fn save_profile_externally_modified_and_invalid_dest_rejected()
    -> Result<(), Box<dyn std::error::Error>> {
        let (state, test_dir) = temp_test_dir("mtime")?;
        let file_path = test_dir.join("conflict.json");
        let profile = sample_paired_profile()?;
        let save_res = state.save_profile_path(
            AppThemeSaveProfileRequest {
                profile: Some(profile.clone()),
                document_id: None,
                save_mode: Some(ProfileSaveMode::NewDocument),
            },
            file_path.clone(),
        )?;
        let doc_id = save_res.document.ok_or("Expected saved doc")?.document_id;

        std::thread::sleep(Duration::from_millis(50));
        std::fs::write(&file_path, b"{\"external\": true}")?;

        let second_save = state.save_profile_path(
            AppThemeSaveProfileRequest {
                profile: Some(profile.clone()),
                document_id: Some(doc_id),
                save_mode: Some(ProfileSaveMode::Edited),
            },
            file_path,
        )?;
        assert!(
            second_save
                .error
                .ok_or("Expected conflict")?
                .contains("modified externally")
        );

        let invalid_save = state.save_profile_path(
            AppThemeSaveProfileRequest {
                profile: Some(profile),
                document_id: None,
                save_mode: Some(ProfileSaveMode::NewDocument),
            },
            PathBuf::from("/nonexistent_forbidden_dir/sub/profile.json"),
        )?;
        assert!(invalid_save.error.is_some());
        let _ = std::fs::remove_dir_all(&test_dir);
        Ok(())
    }

    #[test]
    fn stale_open_and_save_tickets_are_cancelled_without_overwriting_custody()
    -> Result<(), Box<dyn std::error::Error>> {
        let (state, test_dir) = temp_test_dir("ticket")?;
        let file1 = test_dir.join("first.json");
        let file2 = test_dir.join("second.json");
        let stale_save_file = test_dir.join("stale-save.json");

        let mut p1 = sample_paired_profile()?;
        p1.name = "First Theme".to_string();
        let mut p2 = sample_paired_profile()?;
        p2.name = "Second Theme".to_string();
        std::fs::write(&file1, serde_json::to_vec(&p1)?)?;
        std::fs::write(&file2, serde_json::to_vec(&p2)?)?;

        assert!(
            state
                .prepare_save_target(&AppThemeSaveProfileRequest {
                    profile: None,
                    document_id: None,
                    save_mode: Some(ProfileSaveMode::Original),
                })?
                .is_err()
        );

        let stale_ticket = state.begin_open()?;
        let fresh_res = state.open_profile_path(file2)?;
        assert_eq!(
            fresh_res
                .document
                .as_ref()
                .and_then(|d| d.profile.as_ref())
                .map(|p| p.name.as_str()),
            Some("Second Theme")
        );

        let stale_res = state.open_profile_path_with_ticket(file1, stale_ticket)?;
        assert!(stale_res.cancelled && stale_res.document.is_none());
        assert_eq!(
            state.status().active_display_name.as_deref(),
            Some("second.json")
        );

        // Capture a save ticket before reset, then reset session custody and attempt a stale NewDocument save.
        let save_ticket = state.current_custody_ticket()?;
        state.reset()?;
        let stale_save_res = state.save_profile_path_with_ticket(
            AppThemeSaveProfileRequest {
                profile: Some(p1),
                document_id: None,
                save_mode: Some(ProfileSaveMode::NewDocument),
            },
            stale_save_file.clone(),
            Some(save_ticket),
        )?;
        assert!(stale_save_res.cancelled && !stale_save_res.saved);
        assert!(stale_save_res.document.is_none());
        assert!(!stale_save_file.exists());
        assert!(state.status().active_document_id.is_none());

        let _ = std::fs::remove_dir_all(&test_dir);
        Ok(())
    }
}
