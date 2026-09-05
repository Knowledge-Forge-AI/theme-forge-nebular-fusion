use serde::Serialize;
use serde_json::value::Value as JsonNode;

use crate::errors::{StudioCommandError, StudioReasonCode, StudioResult};

fn invalid<T>() -> StudioResult<T> {
    Err(StudioCommandError::new(StudioReasonCode::ProtocolInvalid))
}

fn encode(value: &JsonNode) -> StudioResult<Vec<u8>> {
    let mut bytes = serde_json::to_string_pretty(value)
        .map_err(|_| StudioCommandError::new(StudioReasonCode::ProtocolInvalid))?
        .into_bytes();
    bytes.push(b'\n');
    Ok(bytes)
}

pub(crate) fn canonical_pretty<T: Serialize>(value: &T) -> StudioResult<Vec<u8>> {
    let node = serde_json::to_value(value)
        .map_err(|_| StudioCommandError::new(StudioReasonCode::ProtocolInvalid))?;
    encode(&node)
}

pub(crate) fn canonical_projection<T: Serialize>(
    value: &T,
    excluded_field: &str,
) -> StudioResult<Vec<u8>> {
    let mut node = serde_json::to_value(value)
        .map_err(|_| StudioCommandError::new(StudioReasonCode::ProtocolInvalid))?;
    let Some(fields) = node.as_object_mut() else {
        return invalid();
    };
    if fields.remove(excluded_field).is_none() {
        return invalid();
    }
    encode(&node)
}
