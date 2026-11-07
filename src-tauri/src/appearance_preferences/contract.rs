use serde::{Deserialize, Deserializer, Serialize};

pub(crate) const CURRENT_VERSION: u8 = 1;
pub(crate) const MAX_FAMILY_ID_CHARS: usize = 128;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum AppearanceModePreference {
    System,
    Light,
    Dark,
}

fn deserialize_present<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    match Option::<T>::deserialize(deserializer)? {
        Some(value) => Ok(Some(value)),
        None => Err(serde::de::Error::custom("null is not allowed")),
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AppearancePreferenceRecordV1 {
    pub(crate) version: u8,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "deserialize_present"
    )]
    pub(crate) mode: Option<AppearanceModePreference>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "deserialize_present"
    )]
    pub(crate) light: Option<String>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "deserialize_present"
    )]
    pub(crate) dark: Option<String>,
}

impl AppearancePreferenceRecordV1 {
    pub(crate) fn validate(&self) -> bool {
        self.version == CURRENT_VERSION
            && self.light.as_deref().is_none_or(valid_family_id)
            && self.dark.as_deref().is_none_or(valid_family_id)
    }
}

fn valid_family_id(value: &str) -> bool {
    !value.is_empty() && value.encode_utf16().count() <= MAX_FAMILY_ID_CHARS
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum AppearanceSettingsReason {
    InvalidRecord,
    StorageUnavailable,
    RecordTooLarge,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "status")]
pub(crate) enum AppearancePreferencesLoadReply {
    #[serde(rename = "loaded")]
    Loaded {
        preferences: AppearancePreferenceRecordV1,
    },
    #[serde(rename = "missing")]
    Missing,
    #[serde(rename = "rejected")]
    Rejected { reason: AppearanceSettingsReason },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "status")]
pub(crate) enum AppearancePreferencesSaveReply {
    #[serde(rename = "saved")]
    Saved,
    #[serde(rename = "rejected")]
    Rejected { reason: AppearanceSettingsReason },
}

#[cfg(test)]
mod tests {
    use super::{
        AppearanceModePreference, AppearancePreferenceRecordV1, AppearancePreferencesLoadReply,
        AppearancePreferencesSaveReply, AppearanceSettingsReason, CURRENT_VERSION,
        MAX_FAMILY_ID_CHARS,
    };

    fn valid_record_json() -> &'static str {
        r#"{"version":1,"mode":"dark","light":"nebular","dark":"terminal-nova"}"#
    }

    #[test]
    fn record_accepts_valid_optional_fields_and_omission() -> Result<(), Box<dyn std::error::Error>>
    {
        let record: AppearancePreferenceRecordV1 = serde_json::from_str(valid_record_json())?;
        assert!(record.validate());
        assert_eq!(record.mode, Some(AppearanceModePreference::Dark));

        let omitted: AppearancePreferenceRecordV1 = serde_json::from_str(r#"{"version":1}"#)?;
        assert!(omitted.validate());
        assert_eq!(omitted.mode, None);
        Ok(())
    }

    #[test]
    fn explicit_null_is_rejected_but_unknown_fields_are_also_closed() {
        for field in ["mode", "light", "dark"] {
            let json = format!(r#"{{"version":1,"{field}":null}}"#);
            assert!(serde_json::from_str::<AppearancePreferenceRecordV1>(&json).is_err());
        }
        assert!(
            serde_json::from_str::<AppearancePreferenceRecordV1>(r#"{"version":1,"extra":true}"#)
                .is_err()
        );
    }

    #[test]
    fn version_and_family_id_validation_are_bounded() -> Result<(), Box<dyn std::error::Error>> {
        let mut record: AppearancePreferenceRecordV1 = serde_json::from_str(r#"{"version":1}"#)?;
        assert!(record.validate());
        record.version = CURRENT_VERSION.saturating_add(1);
        assert!(!record.validate());

        record.version = CURRENT_VERSION;
        record.light = Some("x".repeat(MAX_FAMILY_ID_CHARS));
        assert!(record.validate());
        record.dark = Some("x".repeat(MAX_FAMILY_ID_CHARS + 1));
        assert!(!record.validate());
        record.dark = Some(String::new());
        assert!(!record.validate());
        Ok(())
    }

    #[test]
    fn family_id_bound_matches_javascript_utf16_length() -> Result<(), Box<dyn std::error::Error>> {
        let mut record: AppearancePreferenceRecordV1 = serde_json::from_str(r#"{"version":1}"#)?;
        record.light = Some("😀".repeat(MAX_FAMILY_ID_CHARS / 2));
        assert!(record.validate());
        record.light = Some("😀".repeat((MAX_FAMILY_ID_CHARS / 2) + 1));
        assert!(!record.validate());
        Ok(())
    }

    #[test]
    fn replies_are_closed_tagged_records() -> Result<(), Box<dyn std::error::Error>> {
        let record: AppearancePreferenceRecordV1 = serde_json::from_str(r#"{"version":1}"#)?;
        assert_eq!(
            serde_json::to_string(&AppearancePreferencesLoadReply::Loaded {
                preferences: record,
            })?,
            r#"{"status":"loaded","preferences":{"version":1}}"#
        );
        assert_eq!(
            serde_json::to_string(&AppearancePreferencesLoadReply::Rejected {
                reason: AppearanceSettingsReason::RecordTooLarge,
            })?,
            r#"{"status":"rejected","reason":"record-too-large"}"#
        );
        assert_eq!(
            serde_json::to_string(&AppearancePreferencesSaveReply::Saved)?,
            r#"{"status":"saved"}"#
        );
        Ok(())
    }
}
