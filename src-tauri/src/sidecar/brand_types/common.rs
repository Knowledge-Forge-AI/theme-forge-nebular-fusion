use std::collections::BTreeMap;

use serde::{Deserialize, Deserializer, Serialize};
use serde_json::{Number, value::Value as JsonNode};

use crate::errors::{StudioCommandError, StudioReasonCode, StudioResult};

pub(super) const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

pub(super) fn invalid<T>() -> StudioResult<T> {
    Err(StudioCommandError::new(StudioReasonCode::ProtocolInvalid))
}

pub(super) trait Validate {
    fn validate(&self) -> StudioResult<()>;
}

pub(super) fn decode<T>(raw: JsonNode) -> StudioResult<T>
where
    T: for<'de> Deserialize<'de> + Validate,
{
    let value: T = serde_json::from_value(raw)
        .map_err(|_| StudioCommandError::new(StudioReasonCode::ProtocolInvalid))?;
    value.validate()?;
    Ok(value)
}

#[derive(Debug, Clone, Serialize)]
#[serde(transparent)]
pub(crate) struct Digest(String);

impl<'de> Deserialize<'de> for Digest {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        let valid = value.len() == 71
            && value.starts_with("sha256:")
            && value[7..]
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte));
        if valid {
            Ok(Self(value))
        } else {
            Err(serde::de::Error::custom("invalid digest"))
        }
    }
}

impl Digest {
    pub(crate) fn as_str(&self) -> &str {
        &self.0
    }
}

pub(super) fn valid_text(value: &str, maximum: usize) -> bool {
    !value.is_empty()
        && value.len() <= maximum
        && !value.contains('\0')
        && !value.starts_with('/')
        && !value.contains("/Users/")
        && !value.contains(".tfsb/brand-baselines/")
}

pub(super) fn valid_id(value: &str) -> bool {
    valid_text(value, 256)
        && value.is_ascii()
        && value.split('-').all(|part| {
            !part.is_empty()
                && part
                    .bytes()
                    .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit())
        })
        && value.as_bytes().first().is_some_and(u8::is_ascii_lowercase)
}

pub(super) fn valid_role(value: &str) -> bool {
    valid_id(value)
        || value
            .strip_prefix("x.")
            .is_some_and(|rest| rest.split('.').count() == 2 && rest.split('.').all(valid_id))
}

pub(super) fn ordered_unique(values: impl IntoIterator<Item = String>) -> StudioResult<()> {
    let mut prior: Option<String> = None;
    for value in values {
        if prior.as_ref().is_some_and(|entry| entry >= &value) {
            return invalid();
        }
        prior = Some(value);
    }
    Ok(())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Page<T> {
    pub(crate) page: PageBody<T>,
    pub(crate) view_digest: Digest,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct PageBody<T> {
    pub(crate) size: u16,
    pub(crate) count: u16,
    pub(crate) items: Vec<T>,
    pub(crate) next_cursor: Option<String>,
}

pub(super) fn validate_page<T>(page: &Page<T>, key: impl Fn(&T) -> String) -> StudioResult<()> {
    if !(1..=128).contains(&page.page.size)
        || usize::from(page.page.count) != page.page.items.len()
        || page.page.count > page.page.size
        || (page.page.count < page.page.size && page.page.next_cursor.is_some())
        || page
            .page
            .next_cursor
            .as_ref()
            .is_some_and(|cursor| !valid_text(cursor, 16_384) || !cursor.is_ascii())
    {
        return invalid();
    }
    ordered_unique(page.page.items.iter().map(key))
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub(crate) enum DomainValue {
    Null(()),
    Boolean(bool),
    Number(Number),
    Text(String),
    Array(Vec<DomainValue>),
    Object(BTreeMap<String, DomainValue>),
}

impl DomainValue {
    pub(super) fn validate(&self, depth: u8) -> StudioResult<()> {
        if depth > 20 {
            return invalid();
        }
        match self {
            Self::Null(()) | Self::Boolean(_) => Ok(()),
            Self::Number(number) => {
                let valid = number
                    .as_u64()
                    .is_some_and(|value| value <= MAX_SAFE_INTEGER)
                    || number
                        .as_i64()
                        .is_some_and(|value| value.unsigned_abs() <= MAX_SAFE_INTEGER);
                if valid { Ok(()) } else { invalid() }
            }
            Self::Text(value) => {
                if valid_text(value, 16_384) {
                    Ok(())
                } else {
                    invalid()
                }
            }
            Self::Array(values) if values.len() <= 4_096 => values
                .iter()
                .try_for_each(|value| value.validate(depth + 1)),
            Self::Object(values) if values.len() <= 512 => {
                const FORBIDDEN: &[&str] = &[
                    "sessionNonce",
                    "requestId",
                    "canonicalSvg",
                    "svgBytes",
                    "baselinePath",
                    "companionText",
                    "receiptJson",
                    "rendererPath",
                    "modulePath",
                    "packagePath",
                ];
                if values.keys().any(|key| FORBIDDEN.contains(&key.as_str())) {
                    return invalid();
                }
                values
                    .values()
                    .try_for_each(|value| value.validate(depth + 1))
            }
            Self::Array(_) | Self::Object(_) => invalid(),
        }
    }
}

pub(super) fn validate_count(value: u64, maximum: u64) -> StudioResult<()> {
    if value <= maximum { Ok(()) } else { invalid() }
}
