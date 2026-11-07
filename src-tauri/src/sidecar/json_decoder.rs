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

fn sort_json(value: JsonNode) -> JsonNode {
    match value {
        JsonNode::Array(values) => JsonNode::Array(values.into_iter().map(sort_json).collect()),
        JsonNode::Object(values) => {
            let mut entries: Vec<(String, JsonNode)> = values.into_iter().collect();
            entries.sort_by(|(left, _), (right, _)| left.as_bytes().cmp(right.as_bytes()));
            let mut sorted = serde_json::Map::new();
            for (key, child) in entries {
                sorted.insert(key, sort_json(child));
            }
            JsonNode::Object(sorted)
        }
        other => other,
    }
}

fn encode_sorted(value: JsonNode) -> StudioResult<Vec<u8>> {
    encode(&sort_json(value))
}

/// Serialize a value using the portable paired-v2 canonical object ordering.
///
/// The generic canonical helpers above intentionally retain their historical
/// behavior. Paired-v2 needs a separate recursive ordering pass so its bytes
/// do not depend on the serde_json `preserve_order` feature.
pub(crate) fn canonical_sorted_pretty<T: Serialize>(value: &T) -> StudioResult<Vec<u8>> {
    let node = serde_json::to_value(value)
        .map_err(|_| StudioCommandError::new(StudioReasonCode::ProtocolInvalid))?;
    encode_sorted(node)
}

pub(crate) fn canonical_sorted_projection<T: Serialize>(
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
    encode_sorted(node)
}

#[cfg(test)]
mod tests {
    use super::{canonical_sorted_pretty, canonical_sorted_projection};
    use serde_json::value::Value as JsonNode;

    #[test]
    fn sorted_encoder_is_independent_of_insertion_order_and_recursive() {
        let mut nested = serde_json::Map::new();
        nested.insert("z".to_owned(), JsonNode::String("slash/".to_owned()));
        nested.insert("a".to_owned(), JsonNode::String("Café".to_owned()));

        let mut object = serde_json::Map::new();
        object.insert("z".to_owned(), JsonNode::Object(nested));
        object.insert("a".to_owned(), JsonNode::Array(Vec::new()));
        object.insert(
            "m".to_owned(),
            JsonNode::String("line\n\u{001f}".to_owned()),
        );

        let actual = canonical_sorted_pretty(&JsonNode::Object(object)).expect("canonical bytes");
        let expected = "{\n  \"a\": [],\n  \"m\": \"line\\n\\u001f\",\n  \"z\": {\n    \"a\": \"Café\",\n    \"z\": \"slash/\"\n  }\n}\n"
            .as_bytes();
        assert_eq!(actual, expected);
    }

    #[test]
    fn sorted_projection_removes_only_the_requested_top_level_field() {
        let mut object = serde_json::Map::new();
        object.insert("z".to_owned(), JsonNode::String("z".to_owned()));
        object.insert("digest".to_owned(), JsonNode::String("ignored".to_owned()));
        object.insert("a".to_owned(), JsonNode::String("a".to_owned()));

        let actual = canonical_sorted_projection(&JsonNode::Object(object), "digest")
            .expect("projection bytes");
        assert_eq!(actual, b"{\n  \"a\": \"a\",\n  \"z\": \"z\"\n}\n");
    }
}
