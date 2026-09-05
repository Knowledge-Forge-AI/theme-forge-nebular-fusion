use std::collections::BTreeSet;

use serde::de::{self, DeserializeSeed, MapAccess, SeqAccess, Visitor};

pub(crate) const MAX_FRAME_BYTES: usize = 16_777_216;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum FrameError {
    InvalidUtf8,
    InvalidJson,
    InvalidShape,
    DuplicateKey,
    Nul,
    TooLarge,
    Unterminated,
}

#[derive(Debug, Default)]
pub(crate) struct NdjsonFramer {
    pending: Vec<u8>,
}

impl NdjsonFramer {
    pub(crate) fn push(&mut self, bytes: &[u8]) -> Result<Vec<String>, FrameError> {
        let mut frames = Vec::new();
        for byte in bytes {
            if *byte == 0 {
                return Err(FrameError::Nul);
            }
            self.pending.push(*byte);
            if self.pending.len() > MAX_FRAME_BYTES {
                return Err(FrameError::TooLarge);
            }
            if *byte == b'\n' {
                let frame = &self.pending[..self.pending.len() - 1];
                if frame.is_empty() || frame.len() >= MAX_FRAME_BYTES || frame.contains(&b'\r') {
                    return Err(FrameError::InvalidShape);
                }
                let text = std::str::from_utf8(frame).map_err(|_| FrameError::InvalidUtf8)?;
                validate_strict_object(text)?;
                frames.push(text.to_owned());
                self.pending.clear();
            }
        }
        Ok(frames)
    }

    pub(crate) fn finish(&self) -> Result<(), FrameError> {
        if self.pending.is_empty() {
            Ok(())
        } else {
            Err(FrameError::Unterminated)
        }
    }
}

struct StrictSeed;

impl<'de> DeserializeSeed<'de> for StrictSeed {
    type Value = ();
    fn deserialize<D>(self, deserializer: D) -> Result<Self::Value, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        deserializer.deserialize_any(StrictVisitor)
    }
}

struct StrictVisitor;

impl<'de> Visitor<'de> for StrictVisitor {
    type Value = ();
    fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("bounded JSON")
    }
    fn visit_bool<E>(self, _: bool) -> Result<(), E> {
        Ok(())
    }
    fn visit_i64<E>(self, _: i64) -> Result<(), E> {
        Ok(())
    }
    fn visit_u64<E>(self, _: u64) -> Result<(), E> {
        Ok(())
    }
    fn visit_f64<E>(self, _: f64) -> Result<(), E> {
        Ok(())
    }
    fn visit_str<E>(self, _: &str) -> Result<(), E> {
        Ok(())
    }
    fn visit_string<E>(self, _: String) -> Result<(), E> {
        Ok(())
    }
    fn visit_none<E>(self) -> Result<(), E> {
        Ok(())
    }
    fn visit_unit<E>(self) -> Result<(), E> {
        Ok(())
    }
    fn visit_some<D>(self, deserializer: D) -> Result<(), D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        StrictSeed.deserialize(deserializer)
    }
    fn visit_seq<A>(self, mut sequence: A) -> Result<(), A::Error>
    where
        A: SeqAccess<'de>,
    {
        while sequence.next_element_seed(StrictSeed)?.is_some() {}
        Ok(())
    }
    fn visit_map<A>(self, mut map: A) -> Result<(), A::Error>
    where
        A: MapAccess<'de>,
    {
        let mut keys = BTreeSet::new();
        while let Some(key) = map.next_key::<String>()? {
            if !keys.insert(key) {
                return Err(de::Error::custom("duplicate object key"));
            }
            map.next_value_seed(StrictSeed)?;
        }
        Ok(())
    }
}

pub(crate) fn validate_strict_object(text: &str) -> Result<(), FrameError> {
    if !text.starts_with('{') || !text.ends_with('}') {
        return Err(FrameError::InvalidShape);
    }
    let mut deserializer = serde_json::Deserializer::from_str(text);
    StrictSeed.deserialize(&mut deserializer).map_err(|error| {
        if error.to_string().contains("duplicate object key") {
            FrameError::DuplicateKey
        } else {
            FrameError::InvalidJson
        }
    })?;
    deserializer.end().map_err(|_| FrameError::InvalidJson)
}

#[cfg(test)]
mod tests {
    use super::{FrameError, MAX_FRAME_BYTES, NdjsonFramer, validate_strict_object};

    #[test]
    fn partial_and_multiple_frames_are_bounded() {
        let mut framer = NdjsonFramer::default();
        assert!(framer.push(b"{\"a\":").is_ok());
        let frames_result = framer.push(b"1}\n{\"b\":2}\n");
        assert!(frames_result.is_ok());
        let frames = frames_result.unwrap_or_default();
        assert_eq!(frames, ["{\"a\":1}", "{\"b\":2}"]);
        assert_eq!(framer.finish(), Ok(()));
    }

    #[test]
    fn invalid_inputs_fail_closed() {
        for duplicate in [
            "{\"a\":1,\"a\":2}",
            "{\"outer\":{\"a\":1,\"a\":2}}",
            "{\"array\":[{\"a\":1,\"a\":2}]}",
        ] {
            assert_eq!(
                validate_strict_object(duplicate),
                Err(FrameError::DuplicateKey)
            );
        }
        for bytes in [
            b"{}".as_slice(),
            b"[]\n",
            b"{\"a\":\0}\n",
            b"{\"a\":1}\r\n",
            b"{broken}\n",
            &[0xff, b'\n'],
        ] {
            let mut framer = NdjsonFramer::default();
            let result = framer.push(bytes).and_then(|_| framer.finish());
            assert!(result.is_err());
        }
    }

    #[test]
    fn exact_limit_is_accepted_and_plus_one_is_rejected() {
        let body = " ".repeat(MAX_FRAME_BYTES - 3);
        let exact = format!("{{{body}}}\n");
        assert_eq!(exact.len(), MAX_FRAME_BYTES);
        let mut framer = NdjsonFramer::default();
        let result = framer.push(exact.as_bytes());
        assert!(result.is_ok());
        let frames = result.unwrap_or_default();
        assert_eq!(frames.len(), 1);
        assert_eq!(frames[0].len(), MAX_FRAME_BYTES - 1);

        let mut oversized = NdjsonFramer::default();
        let body_plus_one = " ".repeat(MAX_FRAME_BYTES - 2);
        let plus_one = format!("{{{body_plus_one}}}\n");
        assert_eq!(
            oversized.push(plus_one.as_bytes()),
            Err(FrameError::TooLarge)
        );
    }
}
