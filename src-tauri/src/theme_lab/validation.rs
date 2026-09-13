//! Validate compiler identity and complete ordered output before accepting results.
use crate::errors::{StudioCommandError, StudioReasonCode, StudioResult};
use sha2::{Digest, Sha256};
pub(crate) const EXPECTED_DESCRIPTOR_SCHEMA: &str = "tfsl.theme-descriptor-v1";
pub(crate) const EXPECTED_DESCRIPTOR_SCHEMA_VERSION: u32 = 1;
pub(crate) const EXPECTED_DESCRIPTOR_SCHEMA_V2: &str = "tfsl.theme-descriptor-v2";
pub(crate) const EXPECTED_DESCRIPTOR_SCHEMA_VERSION_V2: u32 = 2;
pub(crate) const EXPECTED_DESCRIPTOR_ADAPTER: &str = "starlight-v0.42";
pub(crate) const EXPECTED_THEME_SCHEMA_VERSION_V2: &str = "tfsl.theme-v2";

pub(super) fn validate_descriptor_and_digest(
    css: &str,
    descriptor: &crate::theme_lab::types::ThemeDescriptor,
    styles: Option<&[crate::theme_lab::types::ThemeStyleFile]>,
) -> StudioResult<()> {
    match descriptor {
        crate::theme_lab::types::ThemeDescriptor::V1(desc) => {
            if desc.schema != EXPECTED_DESCRIPTOR_SCHEMA
                || desc.schema_version != EXPECTED_DESCRIPTOR_SCHEMA_VERSION
                || desc.adapter != EXPECTED_DESCRIPTOR_ADAPTER
            {
                return Err(StudioCommandError::new(
                    StudioReasonCode::SidecarProtocolInvalid,
                ));
            }

            let mut hasher = Sha256::new();
            hasher.update(css.as_bytes());
            let computed_digest = format!("{:x}", hasher.finalize());
            if computed_digest != desc.output_digest {
                return Err(StudioCommandError::new(StudioReasonCode::DigestMismatch));
            }

            Ok(())
        }
        crate::theme_lab::types::ThemeDescriptor::V2(desc) => {
            if desc.schema != EXPECTED_DESCRIPTOR_SCHEMA_V2
                || desc.schema_version != EXPECTED_DESCRIPTOR_SCHEMA_VERSION_V2
                || desc.theme_schema_version != EXPECTED_THEME_SCHEMA_VERSION_V2
                || desc.adapter != EXPECTED_DESCRIPTOR_ADAPTER
            {
                return Err(StudioCommandError::new(
                    StudioReasonCode::SidecarProtocolInvalid,
                ));
            }

            if desc.selected_accent.trim().is_empty() {
                return Err(StudioCommandError::new(
                    StudioReasonCode::SidecarProtocolInvalid,
                ));
            }

            if desc.catalog.identity != desc.catalog_identity
                || desc.catalog.digest != desc.catalog_digest
            {
                return Err(StudioCommandError::new(
                    StudioReasonCode::SidecarProtocolInvalid,
                ));
            }

            if desc.provenance.semantic != desc.compiler_semantic {
                return Err(StudioCommandError::new(
                    StudioReasonCode::SidecarProtocolInvalid,
                ));
            }

            let valid_tuple = match desc.compiler_semantic.as_str() {
                "tfsl.theme-compiler-v2-core-1" => {
                    desc.catalog_identity == "tfsl.starlight-core-catalog-v1"
                        && desc.catalog_digest
                            == "d45f945d3323244c5b6d2908799c968d5d1d223e945b8aed0a0ce96b76f32953"
                }
                "tfsl.theme-compiler-v2-code-1" => {
                    desc.catalog_identity == "tfsl.starlight-code-catalog-v1"
                        && desc.catalog_digest
                            == "a56cd99c26ce6e015854338eee63fd850121cf2c86af7cbe992cf39b4b58f34b"
                }
                "tfsl.theme-compiler-v2-catalog-1" => {
                    desc.catalog_identity == "tfsl.starlight-component-catalog-v1"
                        && desc.catalog_digest
                            == "34b1b7c6359a3eb996043d5ce688e1d3740bfeafa462a1b912a08d162638fc73"
                }
                _ => false,
            };

            if !valid_tuple {
                return Err(StudioCommandError::new(
                    StudioReasonCode::SidecarProtocolInvalid,
                ));
            }

            let mut hasher = Sha256::new();
            hasher.update(css.as_bytes());
            let computed_digest = format!("{:x}", hasher.finalize());
            if computed_digest != desc.output_digest {
                return Err(StudioCommandError::new(StudioReasonCode::DigestMismatch));
            }

            let styles = styles
                .ok_or_else(|| StudioCommandError::new(StudioReasonCode::SidecarProtocolInvalid))?;
            {
                if styles.is_empty() {
                    return Err(StudioCommandError::new(
                        StudioReasonCode::SidecarProtocolInvalid,
                    ));
                }

                const CORE_STYLE_PATHS: &[&str] = &[
                    "styles/layers.css",
                    "styles/tokens.css",
                    "styles/base.css",
                    "styles/accent.css",
                    "styles/overrides.css",
                ];
                const CODE_STYLE_PATHS: &[&str] = &[
                    "styles/layers.css",
                    "styles/tokens.css",
                    "styles/base.css",
                    "styles/accent.css",
                    "styles/overrides.css",
                    "styles/code.css",
                ];
                const CATALOG_STYLE_PATHS_NO_CODE: &[&str] = &[
                    "styles/layers.css",
                    "styles/tokens.css",
                    "styles/base.css",
                    "styles/accent.css",
                    "styles/overrides.css",
                    "styles/compat.css",
                ];
                const CATALOG_STYLE_PATHS_CODE: &[&str] = &[
                    "styles/layers.css",
                    "styles/tokens.css",
                    "styles/base.css",
                    "styles/accent.css",
                    "styles/overrides.css",
                    "styles/code.css",
                    "styles/compat.css",
                ];

                let style_paths: Vec<&str> = styles.iter().map(|s| s.path.as_str()).collect();
                let paths_valid = match desc.compiler_semantic.as_str() {
                    "tfsl.theme-compiler-v2-core-1" => style_paths == CORE_STYLE_PATHS,
                    "tfsl.theme-compiler-v2-code-1" => style_paths == CODE_STYLE_PATHS,
                    "tfsl.theme-compiler-v2-catalog-1" => {
                        style_paths == CATALOG_STYLE_PATHS_NO_CODE
                            || style_paths == CATALOG_STYLE_PATHS_CODE
                    }
                    _ => false,
                };
                if !paths_valid {
                    return Err(StudioCommandError::new(
                        StudioReasonCode::SidecarProtocolInvalid,
                    ));
                }

                let joined = styles
                    .iter()
                    .map(|s| s.css.as_str())
                    .collect::<Vec<&str>>()
                    .join("\n\n")
                    + "\n";
                if joined != css {
                    return Err(StudioCommandError::new(
                        StudioReasonCode::SidecarProtocolInvalid,
                    ));
                }

                #[derive(serde::Serialize)]
                struct InventoryEntry<'a> {
                    path: &'a str,
                    sha256: String,
                    size: usize,
                }
                let entries: Vec<InventoryEntry> = styles
                    .iter()
                    .map(|s| {
                        let mut h = Sha256::new();
                        h.update(s.css.as_bytes());
                        InventoryEntry {
                            path: &s.path,
                            sha256: format!("{:x}", h.finalize()),
                            size: s.css.len(),
                        }
                    })
                    .collect();
                let entries_json = serde_json::to_string(&entries).map_err(|_| {
                    StudioCommandError::new(StudioReasonCode::SidecarProtocolInvalid)
                })?;
                let mut inv_hasher = Sha256::new();
                inv_hasher.update(b"tfsl.styles-inventory-v2\n");
                inv_hasher.update(entries_json.as_bytes());
                let computed_inv_digest = format!("{:x}", inv_hasher.finalize());
                if computed_inv_digest != desc.inventory_digest {
                    return Err(StudioCommandError::new(StudioReasonCode::DigestMismatch));
                }
            }

            Ok(())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::validate_descriptor_and_digest;
    use crate::errors::StudioReasonCode;
    use crate::theme_lab::runner::ThemeLabRunner;
    use crate::theme_lab::types::{ThemeDescriptor, ThemeDocument, ThemeLabCompileRequest};
    use std::path::Path;

    #[test]
    fn catalog_rebuild_fails_closed_with_unchanged_package_and_semantics()
    -> Result<(), Box<dyn std::error::Error>> {
        let root = Path::new(env!("CARGO_MANIFEST_DIR"));
        let packet: serde_json::Value = serde_json::from_slice(&std::fs::read(root.join(
            "loom-payload/protocol/tfsl-theme-evidence-v2/examples/candidate-a.tfsl-candidate-v2.json",
        ))?)?;
        let document: ThemeDocument = serde_json::from_value(packet["theme"].clone())?;
        let runner = ThemeLabRunner::new(
            root.join("binaries/tfsb-studio-service-aarch64-apple-darwin"),
            root.join("loom-payload/bin/tfsl-batch.js"),
        );
        let compiled = runner.compile(ThemeLabCompileRequest {
            specification: document,
            options: None,
            ui_revision: Some(1),
            session_id: None,
        })?;
        assert!(compiled.valid);
        let css = compiled.compiled_css.ok_or("missing compiled CSS")?;
        let descriptor = compiled.descriptor.ok_or("missing descriptor")?;
        validate_descriptor_and_digest(&css, &descriptor, compiled.styles.as_deref())?;
        for change_identity in [false, true] {
            let ThemeDescriptor::V2(mut altered) = descriptor.clone() else {
                return Err("expected v2 descriptor".into());
            };
            // Keep both catalog declarations internally consistent. Package and
            // compiler semantics stay unchanged: only an exact pin can reject this.
            if change_identity {
                altered.catalog_identity.push_str("-rebuilt");
                altered
                    .catalog
                    .identity
                    .clone_from(&altered.catalog_identity);
            } else {
                altered.catalog_digest = "0".repeat(64);
                altered.catalog.digest.clone_from(&altered.catalog_digest);
            }
            let result = validate_descriptor_and_digest(
                &css,
                &ThemeDescriptor::V2(altered),
                compiled.styles.as_deref(),
            );
            assert_eq!(
                result.err().map(|error| error.reason_code()),
                Some(StudioReasonCode::SidecarProtocolInvalid)
            );
        }
        Ok(())
    }
}
