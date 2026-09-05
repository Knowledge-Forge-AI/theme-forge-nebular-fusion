use std::collections::BTreeSet;

use serde::{Deserialize, Serialize};
use serde_json::{json, value::Value as JsonNode};

use crate::errors::{StudioCommandError, StudioReasonCode, StudioResult};
use crate::sidecar::brand_types::{
    self, BrandStatus, ConsumerLockStatus, ConsumerProfilePage, ExportCapability, ExportStatusPage,
    FamilyPage, QaProfile, QaProfilePage, QaResult, RecipeGraph, SemanticDiff, TokenPage,
};
use crate::sidecar::visual_evidence::{VisualEvidenceResult, validate_visual_evidence};

const MAX_HANDLE_BYTES: usize = 256;
const MAX_CURSOR_BYTES: usize = 16_384;

#[derive(Debug, Clone, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub(crate) enum StudioBrandReadRequest {
    AssetIdentity {
        project_handle: String,
        asset_id: String,
    },
    Status {
        project_handle: String,
    },
    FamilyPage(PageRequest),
    TokenPage(PageRequest),
    RecipeGraph {
        project_handle: String,
    },
    QaProfilePage(PageRequest),
    QaProfile(ProfileRequest),
    QaResult(ProfileRequest),
    SemanticDiff(SourceReadRequest),
    ConsumerProfilePage(SourcePageRequest),
    ConsumerLockStatus {
        project_handle: String,
    },
    ExportCapability {
        project_handle: String,
    },
    ExportStatusPage(PageRequest),
    VisualEvidence {
        request: VisualEvidenceReadRequest,
    },
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct PageRequest {
    pub(crate) project_handle: String,
    pub(crate) page_size: u16,
    pub(crate) cursor: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ProfileRequest {
    pub(crate) project_handle: String,
    pub(crate) profile_id: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SourceReadRequest {
    pub(crate) project_handle: String,
    pub(crate) source_handle: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SourcePageRequest {
    pub(crate) project_handle: String,
    pub(crate) source_handles: Vec<String>,
    pub(crate) page_size: u16,
    pub(crate) cursor: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub(crate) enum VisualTarget {
    Asset {
        asset_id: String,
    },
    Binding {
        family: String,
        role: String,
        variant: String,
    },
}

#[derive(Debug, Clone, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub(crate) enum VisualEvidenceReadRequest {
    ProjectRender {
        project_handle: String,
        target: VisualTarget,
        width: u16,
        height: u16,
        background: String,
    },
    QaBaseline {
        project_handle: String,
        profile_id: String,
        case_id: String,
    },
    BrandDiff {
        project_handle: String,
        source_handle: String,
        target: VisualTarget,
        width: u16,
        height: u16,
        background: String,
    },
}

#[derive(Debug, Serialize)]
#[serde(tag = "kind", content = "data", rename_all = "kebab-case")]
pub(crate) enum StudioBrandReadResponse {
    AssetIdentity(AssetIdentity),
    Status(BrandStatus),
    FamilyPage(FamilyPage),
    TokenPage(TokenPage),
    RecipeGraph(RecipeGraph),
    QaProfilePage(QaProfilePage),
    QaProfile(QaProfile),
    QaResult(QaResult),
    SemanticDiff(Box<SemanticDiff>),
    ConsumerProfilePage(ConsumerProfilePage),
    ConsumerLockStatus(ConsumerLockStatus),
    ExportCapability(ExportCapability),
    ExportStatusPage(ExportStatusPage),
    VisualEvidence(Box<VisualEvidenceResult>),
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AssetIdentity {
    asset_id: String,
    canonical_asset_digest: String,
    svg_digest: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AssetGetPrivate {
    asset_id: String,
    canonical_toml: String,
    model: JsonNode,
    canonical_svg: String,
    digests: AssetGetDigestsPrivate,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AssetGetDigestsPrivate {
    raw_toml: String,
    semantic: String,
    svg: String,
}

pub(crate) struct PreparedBrandRead {
    pub(crate) method: &'static str,
    pub(crate) params: JsonNode,
}

fn valid_public_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_HANDLE_BYTES
        && value.is_ascii()
        && !value.contains(['\0', '/', '\\'])
}

fn require_id(value: &str) -> StudioResult<()> {
    if valid_public_id(value) {
        Ok(())
    } else {
        Err(StudioCommandError::new(StudioReasonCode::ProtocolInvalid))
    }
}

fn valid_digest(value: &str) -> bool {
    value.strip_prefix("sha256:").is_some_and(|hex| {
        hex.len() == 64
            && hex
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    })
}

fn asset_identity(raw: JsonNode, expected_asset_id: &str) -> StudioResult<AssetIdentity> {
    let value: AssetGetPrivate = serde_json::from_value(raw)
        .map_err(|_| StudioCommandError::new(StudioReasonCode::ProtocolInvalid))?;
    let model_is_bounded_object = value.model.as_object().is_some_and(|model| {
        !model.is_empty()
            && serde_json::to_vec(model).is_ok_and(|bytes| bytes.len() <= 8 * 1024 * 1024)
    });
    if value.asset_id != expected_asset_id
        || value.canonical_toml.is_empty()
        || value.canonical_toml.len() > 8 * 1024 * 1024
        || value.canonical_svg.is_empty()
        || value.canonical_svg.len() > 8 * 1024 * 1024
        || !model_is_bounded_object
        || !valid_digest(&value.digests.raw_toml)
        || !valid_digest(&value.digests.semantic)
        || !valid_digest(&value.digests.svg)
    {
        return Err(StudioCommandError::new(StudioReasonCode::ProtocolInvalid));
    }
    Ok(AssetIdentity {
        asset_id: value.asset_id,
        canonical_asset_digest: value.digests.semantic,
        svg_digest: value.digests.svg,
    })
}

fn page_params(nonce: &str, request: &PageRequest) -> StudioResult<JsonNode> {
    require_id(&request.project_handle)?;
    if !(1..=128).contains(&request.page_size)
        || request.cursor.as_ref().is_some_and(|value| {
            value.is_empty() || value.len() > MAX_CURSOR_BYTES || !value.is_ascii()
        })
    {
        return Err(StudioCommandError::new(StudioReasonCode::ProtocolInvalid));
    }
    Ok(match &request.cursor {
        Some(cursor) => {
            json!({"sessionNonce": nonce, "projectHandle": request.project_handle, "pageSize": request.page_size, "cursor": cursor})
        }
        None => {
            json!({"sessionNonce": nonce, "projectHandle": request.project_handle, "pageSize": request.page_size})
        }
    })
}

fn require_sources(project_handle: &str, source_handles: &[String]) -> StudioResult<()> {
    require_id(project_handle)?;
    if source_handles.len() > 8
        || source_handles
            .iter()
            .any(|value| require_id(value).is_err())
        || source_handles.iter().collect::<BTreeSet<_>>().len() != source_handles.len()
    {
        return Err(StudioCommandError::new(StudioReasonCode::ProtocolInvalid));
    }
    Ok(())
}

fn visual_params(nonce: &str, request: &VisualEvidenceReadRequest) -> StudioResult<JsonNode> {
    let value = match request {
        VisualEvidenceReadRequest::ProjectRender {
            project_handle,
            target,
            width,
            height,
            background,
        } => {
            require_id(project_handle)?;
            validate_visual_request(target, *width, *height, background)?;
            json!({"kind":"project-render", "sessionNonce":nonce, "projectHandle":project_handle, "target":target, "width":width, "height":height, "background":background})
        }
        VisualEvidenceReadRequest::QaBaseline {
            project_handle,
            profile_id,
            case_id,
        } => {
            require_id(project_handle)?;
            require_id(profile_id)?;
            require_id(case_id)?;
            json!({"kind":"qa-baseline", "sessionNonce":nonce, "projectHandle":project_handle, "profileId":profile_id, "caseId":case_id})
        }
        VisualEvidenceReadRequest::BrandDiff {
            project_handle,
            source_handle,
            target,
            width,
            height,
            background,
        } => {
            require_id(project_handle)?;
            require_id(source_handle)?;
            validate_visual_request(target, *width, *height, background)?;
            json!({"kind":"brand-diff", "sessionNonce":nonce, "projectHandle":project_handle, "sourceHandle":source_handle, "target":target, "width":width, "height":height, "background":background})
        }
    };
    Ok(value)
}

fn validate_visual_request(
    target: &VisualTarget,
    width: u16,
    height: u16,
    background: &str,
) -> StudioResult<()> {
    match target {
        VisualTarget::Asset { asset_id } => require_id(asset_id)?,
        VisualTarget::Binding {
            family,
            role,
            variant,
        } => {
            require_id(family)?;
            require_id(role)?;
            require_id(variant)?;
        }
    }
    if !(16..=1_024).contains(&width)
        || !(16..=1_024).contains(&height)
        || u32::from(width) * u32::from(height) > 1_048_576
        || background.len() > 256
        || !(background == "transparent"
            || background.strip_prefix('#').is_some_and(|hex| {
                hex.len() == 8
                    && hex
                        .bytes()
                        .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_lowercase())
            })
            || background
                .strip_prefix("token:")
                .is_some_and(valid_public_id))
    {
        return Err(StudioCommandError::new(StudioReasonCode::ProtocolInvalid));
    }
    Ok(())
}

impl StudioBrandReadRequest {
    pub(crate) fn prepare(&self, nonce: &str) -> StudioResult<PreparedBrandRead> {
        let (method, params) = match self {
            Self::AssetIdentity {
                project_handle,
                asset_id,
            } => {
                require_id(project_handle)?;
                require_id(asset_id)?;
                (
                    "asset.get",
                    json!({"sessionNonce":nonce,"scope":{"kind":"project","projectHandle":project_handle,"assetId":asset_id}}),
                )
            }
            Self::Status { project_handle } => {
                require_id(project_handle)?;
                (
                    "brand.status",
                    json!({"sessionNonce":nonce,"projectHandle":project_handle}),
                )
            }
            Self::FamilyPage(request) => ("brand.family.list", page_params(nonce, request)?),
            Self::TokenPage(request) => ("brand.token.list", page_params(nonce, request)?),
            Self::RecipeGraph { project_handle } => {
                require_id(project_handle)?;
                (
                    "brand.recipe.graph",
                    json!({"sessionNonce":nonce,"projectHandle":project_handle}),
                )
            }
            Self::QaProfilePage(request) => ("brand.qa.profile.list", page_params(nonce, request)?),
            Self::QaProfile(request) | Self::QaResult(request) => {
                require_id(&request.project_handle)?;
                require_id(&request.profile_id)?;
                (
                    if matches!(self, Self::QaProfile(_)) {
                        "brand.qa.profile.get"
                    } else {
                        "brand.qa.result.get"
                    },
                    json!({"sessionNonce":nonce,"projectHandle":request.project_handle,"profileId":request.profile_id}),
                )
            }
            Self::SemanticDiff(request) => {
                require_id(&request.project_handle)?;
                require_id(&request.source_handle)?;
                (
                    "brand.diff",
                    json!({"sessionNonce":nonce,"projectHandle":request.project_handle,"sourceHandle":request.source_handle}),
                )
            }
            Self::ConsumerProfilePage(request) => {
                require_sources(&request.project_handle, &request.source_handles)?;
                let page = PageRequest {
                    project_handle: request.project_handle.clone(),
                    page_size: request.page_size,
                    cursor: request.cursor.clone(),
                };
                let mut params = page_params(nonce, &page)?;
                params
                    .as_object_mut()
                    .ok_or_else(|| StudioCommandError::new(StudioReasonCode::ProtocolInvalid))?
                    .insert("sourceHandles".to_owned(), json!(request.source_handles));
                ("brand.consumer.profile.list", params)
            }
            Self::ConsumerLockStatus { project_handle } => {
                require_id(project_handle)?;
                (
                    "brand.consumer.lock.status",
                    json!({"sessionNonce":nonce,"projectHandle":project_handle}),
                )
            }
            Self::ExportCapability { project_handle } => {
                require_id(project_handle)?;
                (
                    "brand.export.capability",
                    json!({"sessionNonce":nonce,"projectHandle":project_handle}),
                )
            }
            Self::ExportStatusPage(request) => {
                ("brand.export.status", page_params(nonce, request)?)
            }
            Self::VisualEvidence { request } => {
                ("brand.visual.evidence.get", visual_params(nonce, request)?)
            }
        };
        Ok(PreparedBrandRead { method, params })
    }

    pub(crate) fn wrap_response(&self, raw: JsonNode) -> StudioResult<StudioBrandReadResponse> {
        if matches!(self, Self::VisualEvidence { .. }) {
            let visual: VisualEvidenceResult = serde_json::from_value(raw)
                .map_err(|_| StudioCommandError::new(StudioReasonCode::ProtocolInvalid))?;
            validate_visual_evidence(&visual)?;
            return Ok(StudioBrandReadResponse::VisualEvidence(Box::new(visual)));
        }
        Ok(match self {
            Self::AssetIdentity { asset_id, .. } => {
                StudioBrandReadResponse::AssetIdentity(asset_identity(raw, asset_id)?)
            }
            Self::Status { .. } => StudioBrandReadResponse::Status(brand_types::status(raw)?),
            Self::FamilyPage(_) => {
                StudioBrandReadResponse::FamilyPage(brand_types::family_page(raw)?)
            }
            Self::TokenPage(_) => StudioBrandReadResponse::TokenPage(brand_types::token_page(raw)?),
            Self::RecipeGraph { .. } => {
                StudioBrandReadResponse::RecipeGraph(brand_types::recipe_graph(raw)?)
            }
            Self::QaProfilePage(_) => {
                StudioBrandReadResponse::QaProfilePage(brand_types::qa_profile_page(raw)?)
            }
            Self::QaProfile(_) => StudioBrandReadResponse::QaProfile(brand_types::qa_profile(raw)?),
            Self::QaResult(_) => StudioBrandReadResponse::QaResult(brand_types::qa_result(raw)?),
            Self::SemanticDiff(_) => {
                StudioBrandReadResponse::SemanticDiff(Box::new(brand_types::semantic_diff(raw)?))
            }
            Self::ConsumerProfilePage(_) => StudioBrandReadResponse::ConsumerProfilePage(
                brand_types::consumer_profile_page(raw)?,
            ),
            Self::ConsumerLockStatus { .. } => {
                StudioBrandReadResponse::ConsumerLockStatus(brand_types::consumer_lock_status(raw)?)
            }
            Self::ExportCapability { .. } => {
                StudioBrandReadResponse::ExportCapability(brand_types::export_capability(raw)?)
            }
            Self::ExportStatusPage(_) => {
                StudioBrandReadResponse::ExportStatusPage(brand_types::export_status_page(raw)?)
            }
            Self::VisualEvidence { .. } => {
                return Err(StudioCommandError::new(StudioReasonCode::ProtocolInvalid));
            }
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_request_maps_to_one_fixed_method_without_public_nonce() {
        let page = || PageRequest {
            project_handle: "project_opaque".to_owned(),
            page_size: 64,
            cursor: None,
        };
        let profile = || ProfileRequest {
            project_handle: "project_opaque".to_owned(),
            profile_id: "release".to_owned(),
        };
        let cases = [
            (
                StudioBrandReadRequest::AssetIdentity {
                    project_handle: "project_opaque".to_owned(),
                    asset_id: "brand-mark".to_owned(),
                },
                "asset.get",
            ),
            (
                StudioBrandReadRequest::Status {
                    project_handle: "project_opaque".to_owned(),
                },
                "brand.status",
            ),
            (
                StudioBrandReadRequest::FamilyPage(page()),
                "brand.family.list",
            ),
            (
                StudioBrandReadRequest::TokenPage(page()),
                "brand.token.list",
            ),
            (
                StudioBrandReadRequest::RecipeGraph {
                    project_handle: "project_opaque".to_owned(),
                },
                "brand.recipe.graph",
            ),
            (
                StudioBrandReadRequest::QaProfilePage(page()),
                "brand.qa.profile.list",
            ),
            (
                StudioBrandReadRequest::QaProfile(profile()),
                "brand.qa.profile.get",
            ),
            (
                StudioBrandReadRequest::QaResult(profile()),
                "brand.qa.result.get",
            ),
            (
                StudioBrandReadRequest::SemanticDiff(SourceReadRequest {
                    project_handle: "project_opaque".to_owned(),
                    source_handle: "source_opaque".to_owned(),
                }),
                "brand.diff",
            ),
            (
                StudioBrandReadRequest::ConsumerProfilePage(SourcePageRequest {
                    project_handle: "project_opaque".to_owned(),
                    source_handles: vec![],
                    page_size: 64,
                    cursor: None,
                }),
                "brand.consumer.profile.list",
            ),
            (
                StudioBrandReadRequest::ConsumerLockStatus {
                    project_handle: "project_opaque".to_owned(),
                },
                "brand.consumer.lock.status",
            ),
            (
                StudioBrandReadRequest::ExportCapability {
                    project_handle: "project_opaque".to_owned(),
                },
                "brand.export.capability",
            ),
            (
                StudioBrandReadRequest::ExportStatusPage(page()),
                "brand.export.status",
            ),
            (
                StudioBrandReadRequest::VisualEvidence {
                    request: VisualEvidenceReadRequest::ProjectRender {
                        project_handle: "project_opaque".to_owned(),
                        target: VisualTarget::Asset {
                            asset_id: "mark".to_owned(),
                        },
                        width: 16,
                        height: 16,
                        background: "transparent".to_owned(),
                    },
                },
                "brand.visual.evidence.get",
            ),
        ];
        for (request, method) in cases {
            let prepared = request.prepare("n".repeat(43).as_str());
            assert!(prepared.is_ok());
            let prepared = prepared.unwrap_or_else(|_| unreachable!());
            assert_eq!(prepared.method, method);
            assert_eq!(
                prepared.params.get("sessionNonce"),
                Some(&JsonNode::String("n".repeat(43)))
            );
            if method == "brand.diff" {
                assert_eq!(
                    prepared.params.get("sourceHandle"),
                    Some(&JsonNode::String("source_opaque".to_owned()))
                );
                assert!(prepared.params.get("sourceHandles").is_none());
            }
        }
    }

    #[test]
    fn unknown_request_keys_and_private_result_fields_fail() {
        assert!(
            serde_json::from_value::<StudioBrandReadRequest>(
                json!({"kind":"status","projectHandle":"project_opaque","method":"shutdown"})
            )
            .is_err()
        );
        let status = StudioBrandReadRequest::Status {
            project_handle: "project_opaque".to_owned(),
        };
        assert!(
            status
                .wrap_response(
                    json!({"present":false,"raster":{"available":false},"requestId":"private"})
                )
                .is_err()
        );

        let asset = StudioBrandReadRequest::AssetIdentity {
            project_handle: "project_opaque".to_owned(),
            asset_id: "brand-mark".to_owned(),
        };
        let valid = json!({
            "assetId":"brand-mark",
            "canonicalToml":"schema_version = 2",
            "model":{"schemaVersion":2,"id":"brand-mark"},
            "canonicalSvg":"<svg></svg>",
            "digests":{"rawToml":format!("sha256:{}", "1".repeat(64)),"semantic":format!("sha256:{}", "2".repeat(64)),"svg":format!("sha256:{}", "3".repeat(64))}
        });
        assert!(matches!(
            asset.wrap_response(valid.clone()),
            Ok(StudioBrandReadResponse::AssetIdentity(_))
        ));
        let mut private = valid;
        private
            .as_object_mut()
            .unwrap_or_else(|| unreachable!())
            .insert("projectHandle".to_owned(), json!("private"));
        assert!(asset.wrap_response(private).is_err());

        let qa = StudioBrandReadRequest::QaResult(ProfileRequest {
            project_handle: "project_opaque".to_owned(),
            profile_id: "release".to_owned(),
        });
        let examples: JsonNode = serde_json::from_str(include_str!(
            "../../../protocol/tfsb-studio-v1/examples/1.2/results.json"
        ))
        .unwrap_or_default();
        let mut qa_result = examples
            .get("brand.qa.result.get")
            .cloned()
            .unwrap_or(JsonNode::Null);
        qa_result
            .as_object_mut()
            .unwrap_or_else(|| unreachable!())
            .insert(
                "baselinePath".to_owned(),
                JsonNode::String(".tfsb/brand-baselines/release/golden.png".to_owned()),
            );
        let projected = qa.wrap_response(qa_result);
        assert!(projected.is_ok());
        let encoded = serde_json::to_string(&projected.unwrap_or_else(|_| unreachable!()))
            .unwrap_or_default();
        assert!(!encoded.contains("baselinePath"));
        assert!(!encoded.contains("brand-baselines"));
    }

    #[test]
    fn every_nonvisual_method_accepts_its_canonical_result_and_rejects_extra_fields() {
        let examples: JsonNode = serde_json::from_str(include_str!(
            "../../../protocol/tfsb-studio-v1/examples/1.2/results.json"
        ))
        .unwrap_or_default();
        let page = || PageRequest {
            project_handle: "project_opaque".to_owned(),
            page_size: 64,
            cursor: None,
        };
        let profile = || ProfileRequest {
            project_handle: "project_opaque".to_owned(),
            profile_id: "release".to_owned(),
        };
        let cases = [
            (
                StudioBrandReadRequest::Status {
                    project_handle: "project_opaque".to_owned(),
                },
                "brand.status",
            ),
            (
                StudioBrandReadRequest::FamilyPage(page()),
                "brand.family.list",
            ),
            (
                StudioBrandReadRequest::TokenPage(page()),
                "brand.token.list",
            ),
            (
                StudioBrandReadRequest::RecipeGraph {
                    project_handle: "project_opaque".to_owned(),
                },
                "brand.recipe.graph",
            ),
            (
                StudioBrandReadRequest::QaProfilePage(page()),
                "brand.qa.profile.list",
            ),
            (
                StudioBrandReadRequest::QaProfile(profile()),
                "brand.qa.profile.get",
            ),
            (
                StudioBrandReadRequest::QaResult(profile()),
                "brand.qa.result.get",
            ),
            (
                StudioBrandReadRequest::SemanticDiff(SourceReadRequest {
                    project_handle: "project_opaque".to_owned(),
                    source_handle: "source_opaque".to_owned(),
                }),
                "brand.diff",
            ),
            (
                StudioBrandReadRequest::ConsumerProfilePage(SourcePageRequest {
                    project_handle: "project_opaque".to_owned(),
                    source_handles: vec![],
                    page_size: 64,
                    cursor: None,
                }),
                "brand.consumer.profile.list",
            ),
            (
                StudioBrandReadRequest::ConsumerLockStatus {
                    project_handle: "project_opaque".to_owned(),
                },
                "brand.consumer.lock.status",
            ),
            (
                StudioBrandReadRequest::ExportCapability {
                    project_handle: "project_opaque".to_owned(),
                },
                "brand.export.capability",
            ),
            (
                StudioBrandReadRequest::ExportStatusPage(page()),
                "brand.export.status",
            ),
        ];
        for (request, method) in cases {
            let raw = examples.get(method).cloned().unwrap_or(JsonNode::Null);
            let response = request.wrap_response(raw.clone());
            assert!(response.is_ok(), "{method}");
            if method != "brand.diff" {
                let projected = serde_json::to_value(response.unwrap_or_else(|_| unreachable!()))
                    .unwrap_or(JsonNode::Null);
                assert_eq!(projected.get("data"), Some(&raw), "{method}");
            }
            let mut extra = raw;
            extra
                .as_object_mut()
                .unwrap_or_else(|| unreachable!())
                .insert(
                    "requestId".to_owned(),
                    JsonNode::String("private".to_owned()),
                );
            assert!(request.wrap_response(extra).is_err(), "{method}");

            let mut missing = examples.get(method).cloned().unwrap_or(JsonNode::Null);
            let first_key = missing
                .as_object()
                .and_then(|fields| fields.keys().next().cloned())
                .unwrap_or_default();
            missing
                .as_object_mut()
                .unwrap_or_else(|| unreachable!())
                .remove(&first_key);
            assert!(request.wrap_response(missing).is_err(), "{method}");

            let mut wrong_type = examples.get(method).cloned().unwrap_or(JsonNode::Null);
            wrong_type
                .as_object_mut()
                .unwrap_or_else(|| unreachable!())
                .insert(first_key, JsonNode::Null);
            assert!(request.wrap_response(wrong_type).is_err(), "{method}");
        }
    }
}
