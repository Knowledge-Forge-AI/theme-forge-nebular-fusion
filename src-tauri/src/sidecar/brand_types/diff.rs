use serde::{Deserialize, Serialize};
use serde_json::value::Value as JsonNode;

use super::common::{Digest, DomainValue, Validate, invalid, ordered_unique, valid_id, valid_text};
use crate::errors::StudioResult;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SemanticDiff {
    diff: DiffResult,
    before_binding_digest: Digest,
    after_binding_digest: Digest,
    visual_diff: VisualStatus,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct VisualStatus {
    available: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DiffResult {
    schema: DiffSchema,
    schema_version: u8,
    before_digest: Digest,
    after_digest: Digest,
    status: DiffStatus,
    inventory: InventorySection,
    bindings: RecordsSection,
    tokens: RecordsSection,
    recipes: RecipeSection,
    derived: RecordsSection,
    geometry: GeometrySection,
    qa_impact: QaSection,
    package_and_legal: LegalSection,
    consumer_profiles: StateSection,
    exports: StateSection,
    result_digest: Digest,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
enum DiffSchema {
    #[serde(rename = "tfsb.brand-diff")]
    Value,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
enum DiffStatus {
    Equal,
    Changed,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct InventorySection {
    families: Vec<DiffChange>,
    roles: Vec<DiffChange>,
    variants: Vec<DiffChange>,
    requirements: Vec<DiffChange>,
    completeness: Option<DiffChange>,
}
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RecordsSection {
    records: Vec<DiffChange>,
}
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RecipeSection {
    records: Vec<DiffChange>,
    affected_targets: Vec<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct GeometrySection {
    records: Vec<DiffChange>,
    canonical_typed_geometry_changed: bool,
    equivalence_claim: EquivalenceClaim,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
enum EquivalenceClaim {
    #[serde(rename = "none")]
    None,
}
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct QaSection {
    profiles: Vec<DiffChange>,
    cases: Vec<DiffChange>,
    affected_cases: Vec<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LegalSection {
    package: Option<DiffChange>,
    companions: Vec<DiffChange>,
    bundle_relevant_changed: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StateSection {
    before_state: String,
    after_state: String,
    status: Availability,
    records: Vec<DiffChange>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
enum Availability {
    Available,
    Unavailable,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DiffChange {
    id: String,
    change: ChangeKind,
    before: Option<DomainValue>,
    after: Option<DomainValue>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
enum ChangeKind {
    Added,
    Removed,
    Changed,
}

impl DiffChange {
    fn validate(&self) -> StudioResult<()> {
        let relationship = matches!(self.change, ChangeKind::Added)
            && self.before.is_none()
            && self.after.is_some()
            || matches!(self.change, ChangeKind::Removed)
                && self.before.is_some()
                && self.after.is_none()
            || matches!(self.change, ChangeKind::Changed)
                && self.before.is_some()
                && self.after.is_some();
        if !relationship || !valid_text(&self.id, 512) {
            return invalid();
        }
        if let Some(value) = &self.before {
            value.validate(0)?;
        }
        if let Some(value) = &self.after {
            value.validate(0)?;
        }
        Ok(())
    }
}

fn validate_changes(values: &[DiffChange]) -> StudioResult<()> {
    if values.len() > 4_096 {
        return invalid();
    }
    ordered_unique(values.iter().map(|entry| entry.id.clone()))?;
    values.iter().try_for_each(DiffChange::validate)
}

impl Validate for SemanticDiff {
    fn validate(&self) -> StudioResult<()> {
        let diff = &self.diff;
        if diff.schema_version != 1 {
            return invalid();
        }
        if diff.status == DiffStatus::Equal
            && (diff.before_digest.as_str() != diff.after_digest.as_str()
                || self.before_binding_digest.as_str() != self.after_binding_digest.as_str())
        {
            return invalid();
        }
        validate_changes(&diff.inventory.families)?;
        validate_changes(&diff.inventory.roles)?;
        validate_changes(&diff.inventory.variants)?;
        validate_changes(&diff.inventory.requirements)?;
        if let Some(value) = &diff.inventory.completeness {
            value.validate()?;
        }
        validate_changes(&diff.bindings.records)?;
        validate_changes(&diff.tokens.records)?;
        validate_changes(&diff.recipes.records)?;
        validate_changes(&diff.derived.records)?;
        validate_changes(&diff.geometry.records)?;
        validate_changes(&diff.qa_impact.profiles)?;
        validate_changes(&diff.qa_impact.cases)?;
        validate_changes(&diff.package_and_legal.companions)?;
        validate_changes(&diff.consumer_profiles.records)?;
        validate_changes(&diff.exports.records)?;
        if let Some(value) = &diff.package_and_legal.package {
            value.validate()?;
        }
        if diff.recipes.affected_targets.len() > 128
            || diff.qa_impact.affected_cases.len() > 512
            || diff
                .recipes
                .affected_targets
                .iter()
                .chain(&diff.qa_impact.affected_cases)
                .any(|value| !valid_id(value))
            || !valid_text(&diff.consumer_profiles.before_state, 64)
            || !valid_text(&diff.consumer_profiles.after_state, 64)
            || !valid_text(&diff.exports.before_state, 64)
            || !valid_text(&diff.exports.after_state, 64)
        {
            return invalid();
        }
        ordered_unique(diff.recipes.affected_targets.iter().cloned())?;
        ordered_unique(diff.qa_impact.affected_cases.iter().cloned())?;
        let _ = (
            &diff.schema,
            &diff.geometry.equivalence_claim,
            diff.geometry.canonical_typed_geometry_changed,
            diff.package_and_legal.bundle_relevant_changed,
            &diff.consumer_profiles.status,
            &diff.exports.status,
            &diff.result_digest,
            self.visual_diff.available,
        );
        Ok(())
    }
}

pub(super) fn expand_canonical_placeholder(raw: &mut JsonNode) -> StudioResult<()> {
    let binding_digests_equal = raw.get("beforeBindingDigest") == raw.get("afterBindingDigest");
    let Some(diff) = raw.get_mut("diff").and_then(JsonNode::as_object_mut) else {
        return invalid();
    };
    const SECTIONS: &[&str] = &[
        "inventory",
        "bindings",
        "tokens",
        "recipes",
        "derived",
        "geometry",
        "qaImpact",
        "packageAndLegal",
        "consumerProfiles",
        "exports",
    ];
    let placeholder = SECTIONS.iter().all(|key| {
        diff.get(*key)
            .and_then(JsonNode::as_object)
            .is_some_and(serde_json::Map::is_empty)
    });
    if !placeholder {
        return Ok(());
    }
    if diff.get("status").and_then(JsonNode::as_str) != Some("equal")
        || diff.get("beforeDigest") != diff.get("afterDigest")
        || !binding_digests_equal
    {
        return invalid();
    }
    diff.insert("inventory".into(), serde_json::json!({"families":[],"roles":[],"variants":[],"requirements":[],"completeness":null}));
    for key in ["bindings", "tokens", "derived"] {
        diff.insert(key.into(), serde_json::json!({"records":[]}));
    }
    diff.insert(
        "recipes".into(),
        serde_json::json!({"records":[],"affectedTargets":[]}),
    );
    diff.insert("geometry".into(), serde_json::json!({"records":[],"canonicalTypedGeometryChanged":false,"equivalenceClaim":"none"}));
    diff.insert(
        "qaImpact".into(),
        serde_json::json!({"profiles":[],"cases":[],"affectedCases":[]}),
    );
    diff.insert(
        "packageAndLegal".into(),
        serde_json::json!({"package":null,"companions":[],"bundleRelevantChanged":false}),
    );
    for key in ["consumerProfiles", "exports"] {
        diff.insert(key.into(), serde_json::json!({"beforeState":"unavailable","afterState":"unavailable","status":"unavailable","records":[]}));
    }
    Ok(())
}
