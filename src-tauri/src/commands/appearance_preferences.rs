use crate::appearance_preferences::{
    AppearancePreferenceRecordV1, AppearancePreferencesLoadReply, AppearancePreferencesSaveReply,
    AppearancePreferencesState,
};

#[tauri::command(async)]
pub(crate) fn studio_appearance_preferences_load(
    state: tauri::State<'_, AppearancePreferencesState>,
) -> AppearancePreferencesLoadReply {
    state.load()
}

#[tauri::command(async)]
pub(crate) fn studio_appearance_preferences_save(
    preferences: AppearancePreferenceRecordV1,
    state: tauri::State<'_, AppearancePreferencesState>,
) -> AppearancePreferencesSaveReply {
    state.save(preferences)
}
