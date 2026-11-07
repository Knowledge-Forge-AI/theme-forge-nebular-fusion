mod contract;
pub(crate) mod storage;

pub(crate) use contract::{
    AppearancePreferenceRecordV1, AppearancePreferencesLoadReply, AppearancePreferencesSaveReply,
    AppearanceSettingsReason,
};

use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};

use tauri::Manager;

const ROOT_DIRECTORY: &str = "appearance-preferences";

pub(crate) struct AppearancePreferencesState {
    inner: Mutex<AppearancePreferencesSession>,
}

impl std::fmt::Debug for AppearancePreferencesState {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("AppearancePreferencesState")
            .finish_non_exhaustive()
    }
}

struct AppearancePreferencesSession {
    root: Option<PathBuf>,
}

pub(crate) fn initialize(
    app: &tauri::AppHandle,
    smoke_directory: Option<&Path>,
) -> AppearancePreferencesState {
    let root = match smoke_directory {
        Some(directory) => Some(directory.join(ROOT_DIRECTORY)),
        None => app
            .path()
            .app_config_dir()
            .ok()
            .map(|directory| directory.join(ROOT_DIRECTORY)),
    };
    let root = root.filter(|root| storage::ensure_root(root).is_ok());
    AppearancePreferencesState {
        inner: Mutex::new(AppearancePreferencesSession { root }),
    }
}

impl AppearancePreferencesState {
    fn lock(
        &self,
    ) -> Result<MutexGuard<'_, AppearancePreferencesSession>, AppearanceSettingsReason> {
        self.inner
            .lock()
            .map_err(|_| AppearanceSettingsReason::StorageUnavailable)
    }

    pub(crate) fn load(&self) -> AppearancePreferencesLoadReply {
        let Ok(session) = self.lock() else {
            return AppearancePreferencesLoadReply::Rejected {
                reason: AppearanceSettingsReason::StorageUnavailable,
            };
        };
        let Some(root) = session.root.as_deref() else {
            return AppearancePreferencesLoadReply::Rejected {
                reason: AppearanceSettingsReason::StorageUnavailable,
            };
        };
        let bytes = match storage::read_bytes(root) {
            Ok(Some(bytes)) => bytes,
            Ok(None) => return AppearancePreferencesLoadReply::Missing,
            Err(error) => {
                return AppearancePreferencesLoadReply::Rejected {
                    reason: storage_reason(error),
                };
            }
        };
        match serde_json::from_slice::<AppearancePreferenceRecordV1>(&bytes) {
            Ok(preferences) if preferences.validate() => {
                AppearancePreferencesLoadReply::Loaded { preferences }
            }
            _ => AppearancePreferencesLoadReply::Rejected {
                reason: AppearanceSettingsReason::InvalidRecord,
            },
        }
    }

    pub(crate) fn save(
        &self,
        preferences: AppearancePreferenceRecordV1,
    ) -> AppearancePreferencesSaveReply {
        if !preferences.validate() {
            return AppearancePreferencesSaveReply::Rejected {
                reason: AppearanceSettingsReason::InvalidRecord,
            };
        }
        let bytes = match serde_json::to_vec(&preferences) {
            Ok(bytes) => bytes,
            Err(_) => {
                return AppearancePreferencesSaveReply::Rejected {
                    reason: AppearanceSettingsReason::InvalidRecord,
                };
            }
        };
        let Ok(session) = self.lock() else {
            return AppearancePreferencesSaveReply::Rejected {
                reason: AppearanceSettingsReason::StorageUnavailable,
            };
        };
        let Some(root) = session.root.as_deref() else {
            return AppearancePreferencesSaveReply::Rejected {
                reason: AppearanceSettingsReason::StorageUnavailable,
            };
        };
        match storage::save_bytes(root, &bytes) {
            Ok(()) => AppearancePreferencesSaveReply::Saved,
            Err(error) => AppearancePreferencesSaveReply::Rejected {
                reason: storage_reason(error),
            },
        }
    }
}

fn storage_reason(error: storage::StorageError) -> AppearanceSettingsReason {
    match error {
        storage::StorageError::Oversize => AppearanceSettingsReason::RecordTooLarge,
        _ => AppearanceSettingsReason::StorageUnavailable,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn with_root(root: Option<PathBuf>) -> AppearancePreferencesState {
        AppearancePreferencesState {
            inner: Mutex::new(AppearancePreferencesSession { root }),
        }
    }

    #[test]
    fn unavailable_state_returns_closed_replies_without_a_filesystem_root()
    -> Result<(), Box<dyn std::error::Error>> {
        let state = with_root(None);
        let preferences: AppearancePreferenceRecordV1 = serde_json::from_str(r#"{"version":1}"#)?;
        assert_eq!(
            state.load(),
            AppearancePreferencesLoadReply::Rejected {
                reason: AppearanceSettingsReason::StorageUnavailable
            }
        );
        assert_eq!(
            state.save(preferences),
            AppearancePreferencesSaveReply::Rejected {
                reason: AppearanceSettingsReason::StorageUnavailable
            }
        );
        Ok(())
    }

    #[test]
    fn native_state_round_trips_only_its_fixed_preference_leaf()
    -> Result<(), Box<dyn std::error::Error>> {
        let base = std::env::temp_dir();
        let mut owned = None;
        for nonce in 0..64 {
            let path = base.join(format!(
                "appearance-native-state-{}-{nonce}",
                std::process::id()
            ));
            match std::fs::create_dir(&path) {
                Ok(()) => {
                    owned = Some(path);
                    break;
                }
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(error) => return Err(error.into()),
            }
        }
        let root = owned.ok_or("fixture directory unavailable")?;
        let state = with_root(Some(root.clone()));
        assert_eq!(state.load(), AppearancePreferencesLoadReply::Missing);
        let preferences: AppearancePreferenceRecordV1 =
            serde_json::from_str(r#"{"version":1,"mode":"dark","light":"nebular"}"#)?;
        assert_eq!(
            state.save(preferences.clone()),
            AppearancePreferencesSaveReply::Saved
        );
        assert_eq!(
            state.load(),
            AppearancePreferencesLoadReply::Loaded { preferences }
        );
        std::fs::remove_file(root.join("appearance.json"))?;
        std::fs::remove_dir(root)?;
        Ok(())
    }
}
