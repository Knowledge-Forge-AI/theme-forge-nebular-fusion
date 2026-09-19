use std::fs;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::SystemTime;

use sha2::{Digest, Sha256};

use crate::app_theme::runner::{AppThemeRunner, COMPILER_VERSION};
use crate::app_theme::types::{
    AppThemeCompileRequest, AppThemeCompileResponse, AppThemeExportResponse,
    AppThemeOpenProfileResponse, AppThemePairedCompileRequest, AppThemePairedCompileResponse,
    AppThemeSaveProfileResponse, AppThemeStatus, PairedProfileDto, ThemeSpecificationDto,
};
use crate::errors::{StudioCommandError, StudioReasonCode, StudioResult};

#[derive(Clone)]
pub struct AppThemeState {
    shared: Arc<AppThemeShared>,
}

impl std::fmt::Debug for AppThemeState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AppThemeState").finish_non_exhaustive()
    }
}

struct AppThemeShared {
    inner: Mutex<AppThemeSession>,
}

struct AppThemeSession {
    runner: AppThemeRunner,
    session_id: String,
    active_file_path: Option<PathBuf>,
    active_display_name: Option<String>,
    active_file_mtime: Option<SystemTime>,
    latest_revision: u64,
    dirty: bool,
    adopted_theme_digest: Option<String>,
}

impl AppThemeState {
    pub fn new(runner: AppThemeRunner) -> Self {
        let nanos = match SystemTime::now().duration_since(SystemTime::UNIX_EPOCH) {
            Ok(d) => d.as_nanos(),
            Err(_) => 0,
        };
        let session_id = format!("tfsb-app-theme-session-{nanos}");
        Self {
            shared: Arc::new(AppThemeShared {
                inner: Mutex::new(AppThemeSession {
                    runner,
                    session_id,
                    active_file_path: None,
                    active_display_name: None,
                    active_file_mtime: None,
                    latest_revision: 0,
                    dirty: false,
                    adopted_theme_digest: None,
                }),
            }),
        }
    }

    fn lock(&self) -> StudioResult<MutexGuard<'_, AppThemeSession>> {
        self.shared
            .inner
            .lock()
            .map_err(|_| StudioCommandError::new(StudioReasonCode::SidecarCrashed))
    }

    pub fn shutdown(&self) {
        if let Ok(session) = self.lock() {
            session.runner.cancel_active();
        }
    }

    pub fn cancel_active(&self) {
        if let Ok(mut session) = self.lock() {
            session.latest_revision = session.latest_revision.saturating_add(1);
            session.session_id = format!(
                "tfsb-app-theme-session-{:x}",
                Sha256::digest(format!(
                    "{}:{}",
                    session.session_id, session.latest_revision
                ))
            );
            session.runner.cancel_active();
        }
    }

    pub fn status(&self) -> AppThemeStatus {
        let Ok(session) = self.lock() else {
            return AppThemeStatus {
                available: false,
                compiler_version: COMPILER_VERSION.to_owned(),
                session_id: "unavailable".to_owned(),
                latest_revision: 0,
                message: Some("Application Theme session lock failed".to_owned()),
                dirty: None,
                active_file_path: None,
            };
        };

        let available = session.runner.is_available();
        let message = if available {
            None
        } else {
            Some("Solar Sail compiler adapter is not available. Check that solar-sail-payload is built.".to_owned())
        };

        AppThemeStatus {
            available,
            compiler_version: COMPILER_VERSION.to_owned(),
            session_id: session.session_id.clone(),
            latest_revision: session.latest_revision,
            message,
            dirty: Some(session.dirty),
            active_file_path: session
                .active_file_path
                .as_ref()
                .map(|p| p.to_string_lossy().into_owned()),
        }
    }

    pub fn compile(
        &self,
        request: AppThemeCompileRequest,
    ) -> StudioResult<AppThemeCompileResponse> {
        let (runner, req_rev) = {
            let mut session = self.lock()?;
            let req_rev = request
                .ui_revision
                .unwrap_or_else(|| session.latest_revision.saturating_add(1));
            if req_rev < session.latest_revision {
                return Ok(AppThemeCompileResponse {
                    status: "stale".to_owned(),
                    valid: false,
                    ui_revision: req_rev,
                    compiled_css: None,
                    descriptor: None,
                    diagnostics: vec![],
                    error: Some("Stale revision rejected".to_owned()),
                });
            }
            session.latest_revision = req_rev;
            (session.runner.clone(), req_rev)
        };

        runner.compile(request.specification, Some(req_rev))
    }

    pub fn paired_compile(
        &self,
        request: AppThemePairedCompileRequest,
    ) -> StudioResult<AppThemePairedCompileResponse> {
        let (runner, req_rev) = {
            let mut session = self.lock()?;
            let req_rev = request
                .ui_revision
                .unwrap_or_else(|| session.latest_revision.saturating_add(1));
            if req_rev < session.latest_revision {
                return Ok(AppThemePairedCompileResponse {
                    status: "stale".to_owned(),
                    valid: false,
                    ui_revision: req_rev,
                    solar_sail: AppThemeCompileResponse {
                        status: "stale".to_owned(),
                        valid: false,
                        ui_revision: req_rev,
                        compiled_css: None,
                        descriptor: None,
                        diagnostics: vec![],
                        error: Some("Stale revision rejected".to_owned()),
                    },
                    stellar_loom: None,
                    shared_tokens: vec![],
                    error: Some("Stale revision rejected".to_owned()),
                });
            }
            session.latest_revision = req_rev;
            (session.runner.clone(), req_rev)
        };

        runner.paired_compile(request.profile, Some(req_rev))
    }

    pub fn active_file_path(&self) -> StudioResult<Option<PathBuf>> {
        let session = self.lock()?;
        Ok(session.active_file_path.clone())
    }

    pub fn open_profile_path(&self, path: PathBuf) -> StudioResult<AppThemeOpenProfileResponse> {
        let content = match fs::read_to_string(&path) {
            Ok(c) => c,
            Err(e) => {
                return Ok(AppThemeOpenProfileResponse {
                    cancelled: false,
                    profile: None,
                    display_name: None,
                    file_path: Some(path.to_string_lossy().into_owned()),
                    error: Some(format!("Failed to read profile: {e}")),
                });
            }
        };

        let profile = match serde_json::from_str::<PairedProfileDto>(&content) {
            Ok(p) => p,
            Err(e) => {
                return Ok(AppThemeOpenProfileResponse {
                    cancelled: false,
                    profile: None,
                    display_name: None,
                    file_path: Some(path.to_string_lossy().into_owned()),
                    error: Some(format!("Invalid profile format: {e}")),
                });
            }
        };

        if profile.schema_version != "tf-paired-profile-v1" {
            return Ok(AppThemeOpenProfileResponse {
                cancelled: false,
                profile: None,
                display_name: None,
                file_path: Some(path.to_string_lossy().into_owned()),
                error: Some(format!(
                    "Invalid profile schema: expected 'tf-paired-profile-v1', got '{}'",
                    profile.schema_version
                )),
            });
        }

        let display_name = path.file_name().and_then(|n| n.to_str()).map(str::to_owned);
        let mtime = fs::metadata(&path).ok().and_then(|m| m.modified().ok());

        {
            let mut session = self.lock()?;
            session.active_file_path = Some(path.clone());
            session.active_display_name = display_name.clone();
            session.active_file_mtime = mtime;
            session.dirty = false;
        }

        Ok(AppThemeOpenProfileResponse {
            cancelled: false,
            profile: Some(profile),
            display_name,
            file_path: Some(path.to_string_lossy().into_owned()),
            error: None,
        })
    }

    pub fn save_profile_path(
        &self,
        profile: PairedProfileDto,
        path: PathBuf,
    ) -> StudioResult<AppThemeSaveProfileResponse> {
        if path.is_file() {
            let session = self.lock()?;
            let is_active_file = session.active_file_path.as_deref() == Some(&path);
            let modified = is_active_file
                && match (
                    session.active_file_mtime,
                    fs::metadata(&path).and_then(|m| m.modified()),
                ) {
                    (Some(saved), Ok(current)) => current != saved,
                    _ => false,
                };
            if modified {
                return Ok(AppThemeSaveProfileResponse {
                    cancelled: false,
                    file_path: None,
                    error: Some("File was modified externally; save rejected to prevent overwriting changes".to_owned()),
                });
            }
        }

        let serialized = match serde_json::to_string_pretty(&profile) {
            Ok(s) => s,
            Err(e) => {
                return Ok(AppThemeSaveProfileResponse {
                    cancelled: false,
                    file_path: None,
                    error: Some(format!("Serialization failed: {e}")),
                });
            }
        };

        let parent = match path.parent() {
            Some(p) => p,
            None => {
                return Ok(AppThemeSaveProfileResponse {
                    cancelled: false,
                    file_path: None,
                    error: Some("Invalid destination path (no parent directory)".to_owned()),
                });
            }
        };

        if let Err(e) = fs::create_dir_all(parent) {
            return Ok(AppThemeSaveProfileResponse {
                cancelled: false,
                file_path: None,
                error: Some(format!("Failed to create parent directory: {e}")),
            });
        }

        let nanos = match SystemTime::now().duration_since(SystemTime::UNIX_EPOCH) {
            Ok(d) => d.as_nanos(),
            Err(_) => 0,
        };
        let temp_path = parent.join(format!(".tfsb-tmp-save-{nanos}.json"));

        if let Err(e) = fs::write(&temp_path, serialized.as_bytes()) {
            let _ = fs::remove_file(&temp_path);
            return Ok(AppThemeSaveProfileResponse {
                cancelled: false,
                file_path: None,
                error: Some(format!("Failed to write temporary file: {e}")),
            });
        }

        if let Err(e) = fs::rename(&temp_path, &path) {
            let _ = fs::remove_file(&temp_path);
            return Ok(AppThemeSaveProfileResponse {
                cancelled: false,
                file_path: None,
                error: Some(format!("Failed to save profile: {e}")),
            });
        }

        let mtime = fs::metadata(&path).ok().and_then(|m| m.modified().ok());
        {
            let mut session = self.lock()?;
            session.active_file_path = Some(path.clone());
            session.active_display_name =
                path.file_name().and_then(|n| n.to_str()).map(str::to_owned);
            session.active_file_mtime = mtime;
            session.dirty = false;
        }

        Ok(AppThemeSaveProfileResponse {
            cancelled: false,
            file_path: Some(path.to_string_lossy().into_owned()),
            error: None,
        })
    }

    pub fn export_package_to_path(
        &self,
        specification: ThemeSpecificationDto,
        destination: String,
        language: Option<String>,
    ) -> StudioResult<AppThemeExportResponse> {
        let runner = {
            let session = self.lock()?;
            session.runner.clone()
        };

        runner.export_package(specification, destination, language)
    }

    pub fn reset(&self) -> StudioResult<AppThemeStatus> {
        let mut session = self.lock()?;
        session.runner.cancel_active();
        session.latest_revision = session.latest_revision.saturating_add(1);
        session.active_file_path = None;
        session.active_display_name = None;
        session.active_file_mtime = None;
        session.dirty = false;
        session.adopted_theme_digest = None;

        Ok(AppThemeStatus {
            available: session.runner.is_available(),
            compiler_version: COMPILER_VERSION.to_owned(),
            session_id: session.session_id.clone(),
            latest_revision: session.latest_revision,
            message: None,
            dirty: Some(false),
            active_file_path: None,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app_theme::types::{
        ColorTokensDto, LoomTargetOverridesDto, PaletteDto, SolarSailSurfacesOverrideDto,
        SolarSailTargetOverridesDto, SurfacesDto, TargetOverridesDto, TypographyDto,
    };
    use std::time::Duration;

    fn sample_paired_profile() -> PairedProfileDto {
        PairedProfileDto {
            schema_version: "tf-paired-profile-v1".to_string(),
            name: "Forge Console Test".to_string(),
            version: "0.1.0".to_string(),
            description: Some("Test profile description".to_string()),
            palette: PaletteDto {
                light: ColorTokensDto {
                    background: "#ffffff".to_string(),
                    foreground: "#000000".to_string(),
                    card: "#ffffff".to_string(),
                    card_foreground: "#000000".to_string(),
                    popover: "#ffffff".to_string(),
                    popover_foreground: "#000000".to_string(),
                    primary: "#00a896".to_string(),
                    primary_foreground: "#ffffff".to_string(),
                    secondary: "#f1f5f9".to_string(),
                    secondary_foreground: "#0f172a".to_string(),
                    muted: "#f1f5f9".to_string(),
                    muted_foreground: "#64748b".to_string(),
                    accent: "#f1f5f9".to_string(),
                    accent_foreground: "#0f172a".to_string(),
                    destructive: "#ef4444".to_string(),
                    destructive_foreground: "#ffffff".to_string(),
                    border: "#e2e8f0".to_string(),
                    input: "#e2e8f0".to_string(),
                    ring: "#00a896".to_string(),
                    chart1: None,
                    chart2: None,
                    chart3: None,
                    chart4: None,
                    chart5: None,
                },
                dark: ColorTokensDto {
                    background: "#09090b".to_string(),
                    foreground: "#fafafa".to_string(),
                    card: "#09090b".to_string(),
                    card_foreground: "#fafafa".to_string(),
                    popover: "#09090b".to_string(),
                    popover_foreground: "#fafafa".to_string(),
                    primary: "#02c39a".to_string(),
                    primary_foreground: "#09090b".to_string(),
                    secondary: "#27272a".to_string(),
                    secondary_foreground: "#fafafa".to_string(),
                    muted: "#27272a".to_string(),
                    muted_foreground: "#a1a1aa".to_string(),
                    accent: "#27272a".to_string(),
                    accent_foreground: "#fafafa".to_string(),
                    destructive: "#7f1d1d".to_string(),
                    destructive_foreground: "#fafafa".to_string(),
                    border: "#27272a".to_string(),
                    input: "#27272a".to_string(),
                    ring: "#02c39a".to_string(),
                    chart1: None,
                    chart2: None,
                    chart3: None,
                    chart4: None,
                    chart5: None,
                },
            },
            surfaces: SurfacesDto {
                radius: "0.5rem".to_string(),
                border_width: Some("1px".to_string()),
                content: Some(704),
            },
            typography: TypographyDto {
                font_sans: "Inter, sans-serif".to_string(),
                font_heading: None,
                font_mono: None,
            },
            target_overrides: Some(TargetOverridesDto {
                loom: Some(LoomTargetOverridesDto {
                    content: Some(680),
                    default_accent: Some("cyan".to_string()),
                }),
                solar_sail: Some(SolarSailTargetOverridesDto {
                    surfaces: Some(SolarSailSurfacesOverrideDto {
                        radius: Some("0.75rem".to_string()),
                        border_width: Some("2px".to_string()),
                        content: Some(680),
                    }),
                }),
            }),
        }
    }

    #[test]
    fn save_and_open_profile_target_overrides_round_trip() -> Result<(), Box<dyn std::error::Error>>
    {
        let runner = AppThemeRunner::new(PathBuf::from("/bin/echo"), PathBuf::from("/dev/null"));
        let state = AppThemeState::new(runner);
        let nanos = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)?
            .as_nanos();
        let test_dir = std::env::temp_dir().join(format!("tfsb-test-roundtrip-{nanos}"));
        fs::create_dir_all(&test_dir)?;
        let file_path = test_dir.join("profile.json");

        let profile = sample_paired_profile();
        let save_res = state.save_profile_path(profile.clone(), file_path.clone())?;
        assert!(save_res.error.is_none());
        assert_eq!(
            save_res.file_path,
            Some(file_path.to_string_lossy().into_owned())
        );

        let open_res = state.open_profile_path(file_path.clone())?;
        assert!(open_res.error.is_none());
        let opened_profile = open_res
            .profile
            .ok_or("Expected opened profile to be Some")?;
        assert_eq!(opened_profile.name, profile.name);
        assert_eq!(opened_profile.target_overrides, profile.target_overrides);

        let _ = fs::remove_dir_all(&test_dir);
        Ok(())
    }

    #[test]
    fn open_profile_invalid_schema_rejected() -> Result<(), Box<dyn std::error::Error>> {
        let runner = AppThemeRunner::new(PathBuf::from("/bin/echo"), PathBuf::from("/dev/null"));
        let state = AppThemeState::new(runner);
        let nanos = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)?
            .as_nanos();
        let test_dir = std::env::temp_dir().join(format!("tfsb-test-schema-{nanos}"));
        fs::create_dir_all(&test_dir)?;
        let file_path = test_dir.join("invalid-schema.json");

        let mut invalid_profile = sample_paired_profile();
        invalid_profile.schema_version = "tfss.theme-v1".to_string();
        let invalid_json = serde_json::to_string(&invalid_profile)?;
        fs::write(&file_path, invalid_json.as_bytes())?;

        let open_res = state.open_profile_path(file_path)?;
        assert!(open_res.profile.is_none());
        let err = open_res.error.ok_or("Expected error for invalid schema")?;
        assert!(err.contains("Invalid profile schema"));

        let _ = fs::remove_dir_all(&test_dir);
        Ok(())
    }

    #[test]
    fn save_profile_externally_modified_file_rejected() -> Result<(), Box<dyn std::error::Error>> {
        let runner = AppThemeRunner::new(PathBuf::from("/bin/echo"), PathBuf::from("/dev/null"));
        let state = AppThemeState::new(runner);
        let nanos = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)?
            .as_nanos();
        let test_dir = std::env::temp_dir().join(format!("tfsb-test-mtime-{nanos}"));
        fs::create_dir_all(&test_dir)?;
        let file_path = test_dir.join("conflict.json");

        let profile = sample_paired_profile();
        let save_res = state.save_profile_path(profile.clone(), file_path.clone())?;
        assert!(save_res.error.is_none());

        // Wait slightly to ensure different modification timestamp, then overwrite externally
        std::thread::sleep(Duration::from_millis(50));
        fs::write(&file_path, b"{\"external\": true}")?;

        let second_save = state.save_profile_path(profile, file_path)?;
        let err = second_save
            .error
            .ok_or("Expected conflict error on externally modified file")?;
        assert!(err.contains("modified externally"));

        let _ = fs::remove_dir_all(&test_dir);
        Ok(())
    }

    #[test]
    fn save_profile_invalid_destination_fails_gracefully() -> Result<(), Box<dyn std::error::Error>>
    {
        let runner = AppThemeRunner::new(PathBuf::from("/bin/echo"), PathBuf::from("/dev/null"));
        let state = AppThemeState::new(runner);
        let profile = sample_paired_profile();
        let invalid_path = PathBuf::from("/nonexistent_forbidden_dir/sub/profile.json");
        let save_res = state.save_profile_path(profile, invalid_path)?;
        assert!(save_res.error.is_some());

        Ok(())
    }
}
