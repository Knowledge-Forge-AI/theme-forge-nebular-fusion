use std::collections::BTreeMap;
use std::fs;

use super::exchange::{
    BRIEF_SCHEMA, BriefPacketEnvelope, CANDIDATE_SCHEMA, CandidatePacketEnvelope,
    EXCHANGE_SCHEMA_VERSION, REVIEW_SCHEMA, ReviewPacketEnvelope, parse_exchange_packet,
};
use super::io::{
    get_parent_identity, publish_absent_only_bytes, read_selected_bytes, validate_parent_identity,
};
use super::protocol_dto::{
    SceneExpected, SceneMetricsDto, SceneReceiptDto, SceneReviewAnnotationDto,
};
use super::session::{SceneSession, compute_sha256};
use super::types::{
    Artboard, ArtboardPolicy, CardinalAnchor, ConnectorEndpoint, ConnectorRouting, Paint,
    Presentation, SCENE_COMPATIBILITY, SCENE_COMPILER_LEVEL, SCENE_SCHEMA, SceneAccessibility,
    SceneEditOperation, SceneElement, SceneProfile, VectorScene,
};
use crate::errors::StudioReasonCode;

fn sample_scene() -> VectorScene {
    VectorScene {
        schema: SCENE_SCHEMA.to_owned(),
        compatibility: SCENE_COMPATIBILITY,
        compiler_level: SCENE_COMPILER_LEVEL,
        profile: SceneProfile::Illustration,
        artboard: Artboard {
            width: 1440.0,
            height: 720.0,
            view_box: [0.0, 0.0, 1440.0, 720.0],
            policy: Some(ArtboardPolicy::Contain),
        },
        accessibility: SceneAccessibility::Decorative { focusable: None },
        elements: vec![
            SceneElement::Rect {
                id: Some("rect-1".to_owned()),
                presentation: Some(Presentation {
                    fill: Some(Paint::Solid {
                        color: "#ff00aa".to_owned(),
                    }),
                    ..Default::default()
                }),
                transform: None,
                bounds: Some([10.0, 10.0, 100.0, 50.0]),
                x: 10.0,
                y: 10.0,
                width: 100.0,
                height: 50.0,
                rx: Some(4.0),
                ry: Some(4.0),
            },
            SceneElement::Connector {
                id: Some("conn-1".to_owned()),
                presentation: None,
                transform: None,
                bounds: None,
                routing: ConnectorRouting::Straight,
                from: ConnectorEndpoint::Point { x: 0.0, y: 0.0 },
                to: ConnectorEndpoint::ElementAnchor {
                    element_id: "rect-1".to_owned(),
                    anchor: CardinalAnchor::Left,
                },
                waypoints: None,
                start_arrowhead: None,
                end_arrowhead: None,
                arrowhead_size: None,
            },
        ],
        definitions: None,
        token_bindings: None,
        layout: None,
        provenance: None,
    }
}

#[test]
fn typed_scene_model_round_trip() -> Result<(), Box<dyn std::error::Error>> {
    let original = sample_scene();
    let json = serde_json::to_string(&original)?;
    let deserialized: VectorScene = serde_json::from_str(&json)?;
    assert_eq!(original, deserialized);
    Ok(())
}

#[test]
fn typed_scene_denies_unknown_fields() -> Result<(), Box<dyn std::error::Error>> {
    let json = r#"{
        "schema": "tfsb.vector-scene-v1",
        "compatibility": 1,
        "compilerLevel": 1,
        "profile": "illustration",
        "artboard": { "width": 100, "height": 100, "viewBox": [0,0,100,100] },
        "accessibility": { "mode": "decorative" },
        "elements": [],
        "unknownMaliciousField": "evil"
    }"#;
    let result: Result<VectorScene, _> = serde_json::from_str(json);
    assert!(result.is_err());
    Ok(())
}

#[test]
fn session_monotonic_revision_and_edits() -> Result<(), Box<dyn std::error::Error>> {
    let mut session = SceneSession::new();
    assert_eq!(session.revision, 0);
    assert!(!session.dirty);

    let initial_digest = session.draft_input_digest.clone();

    // Apply insert edit
    let op = SceneEditOperation::InsertElement {
        index: None,
        element: SceneElement::Circle {
            id: Some("circle-1".to_owned()),
            presentation: None,
            transform: None,
            bounds: None,
            cx: 50.0,
            cy: 50.0,
            r: 25.0,
        },
    };
    session.apply_edits(vec![op])?;

    assert_eq!(session.revision, 1);
    assert!(session.dirty);
    assert_ne!(session.draft_input_digest, initial_digest);
    assert_eq!(session.current_scene.elements.len(), 2);

    // Apply update edit
    let update_op = SceneEditOperation::UpdateElement {
        id: "circle-1".to_owned(),
        element: SceneElement::Circle {
            id: Some("circle-1".to_owned()),
            presentation: None,
            transform: None,
            bounds: None,
            cx: 100.0,
            cy: 100.0,
            r: 50.0,
        },
    };
    session.apply_edits(vec![update_op])?;
    assert_eq!(session.revision, 2);

    // Apply remove edit
    let remove_op = SceneEditOperation::RemoveElement {
        id: "circle-1".to_owned(),
    };
    session.apply_edits(vec![remove_op])?;
    assert_eq!(session.revision, 3);
    assert_eq!(session.current_scene.elements.len(), 1);
    Ok(())
}

#[test]
fn transactional_apply_edits_leaves_scene_untouched_on_failure()
-> Result<(), Box<dyn std::error::Error>> {
    let mut session = SceneSession::new();
    let initial_scene = session.current_scene.clone();
    let initial_revision = session.revision;
    let initial_digest = session.draft_input_digest.clone();

    // Valid insert followed by an invalid update to non-existent element
    let op1 = SceneEditOperation::InsertElement {
        index: None,
        element: SceneElement::Circle {
            id: Some("circle-valid".to_owned()),
            presentation: None,
            transform: None,
            bounds: None,
            cx: 10.0,
            cy: 10.0,
            r: 5.0,
        },
    };
    let op2 = SceneEditOperation::UpdateElement {
        id: "non-existent-element-id".to_owned(),
        element: SceneElement::Circle {
            id: Some("non-existent-element-id".to_owned()),
            presentation: None,
            transform: None,
            bounds: None,
            cx: 20.0,
            cy: 20.0,
            r: 10.0,
        },
    };

    let result = session.apply_edits(vec![op1, op2]);
    assert_eq!(
        result.err().ok_or("expected rejection")?.reason_code(),
        StudioReasonCode::SelectionRejected
    );

    // Transactional rollback check: scene must be 100% untouched!
    assert_eq!(session.current_scene, initial_scene);
    assert_eq!(session.revision, initial_revision);
    assert_eq!(session.draft_input_digest, initial_digest);
    assert!(!session.dirty);
    Ok(())
}

#[test]
fn checked_add_revisions_no_saturating() -> Result<(), Box<dyn std::error::Error>> {
    let mut session = SceneSession::new();
    session.revision = u64::MAX;

    let res = session.next_revision();
    assert_eq!(
        res.err().ok_or("expected rejection")?.reason_code(),
        StudioReasonCode::ContextStale
    );
    assert_eq!(session.revision, u64::MAX);
    Ok(())
}

#[test]
fn session_stale_expected_checks() -> Result<(), Box<dyn std::error::Error>> {
    let session = SceneSession::new();

    let valid_expected = SceneExpected {
        session_id: session.session_id.clone(),
        revision: session.revision,
        draft_input_digest: Some(session.draft_input_digest.clone()),
        source_id: None,
        token_snapshot_id: None,
        engine_identity: None,
    };
    assert!(session.check_expected(&valid_expected).is_ok());

    let invalid_session_id = SceneExpected {
        session_id: "other-session".to_owned(),
        revision: session.revision,
        draft_input_digest: None,
        source_id: None,
        token_snapshot_id: None,
        engine_identity: None,
    };
    assert_eq!(
        session
            .check_expected(&invalid_session_id)
            .err()
            .ok_or("expected rejection")?
            .reason_code(),
        StudioReasonCode::ContextInvalid
    );

    let stale_revision = SceneExpected {
        session_id: session.session_id.clone(),
        revision: 999,
        draft_input_digest: None,
        source_id: None,
        token_snapshot_id: None,
        engine_identity: None,
    };
    assert_eq!(
        session
            .check_expected(&stale_revision)
            .err()
            .ok_or("expected rejection")?
            .reason_code(),
        StudioReasonCode::Stale
    );

    let wrong_digest = SceneExpected {
        session_id: session.session_id.clone(),
        revision: session.revision,
        draft_input_digest: Some("bad-digest".to_owned()),
        source_id: None,
        token_snapshot_id: None,
        engine_identity: None,
    };
    assert_eq!(
        session
            .check_expected(&wrong_digest)
            .err()
            .ok_or("expected rejection")?
            .reason_code(),
        StudioReasonCode::DigestMismatch
    );
    Ok(())
}

#[test]
fn native_replacement_intent_reservation() -> Result<(), Box<dyn std::error::Error>> {
    let mut session = SceneSession::new();
    assert!(session.is_initial_untouched());

    // Untouched scene can begin replacement without expected
    let res = session.begin_replacement_intent(None, None)?;
    assert!(session.validate_replacement_intent(&res).is_ok());

    // Once touched, expected is required
    session.dirty = true;
    session.revision = 1;
    let err = session.begin_replacement_intent(None, None);
    assert_eq!(
        err.err().ok_or("expected rejection")?.reason_code(),
        StudioReasonCode::ContextInvalid
    );

    let expected = SceneExpected {
        session_id: session.session_id.clone(),
        revision: session.revision,
        draft_input_digest: Some(session.draft_input_digest.clone()),
        source_id: None,
        token_snapshot_id: None,
        engine_identity: None,
    };
    let res2 = session.begin_replacement_intent(Some(&expected), None)?;
    assert!(session.validate_replacement_intent(&res2).is_ok());

    // Stale client intent rejected
    let stale_err = session.begin_replacement_intent(Some(&expected), Some("unowned-stale-id"));
    assert_eq!(
        stale_err.err().ok_or("expected rejection")?.reason_code(),
        StudioReasonCode::Stale
    );
    Ok(())
}

#[test]
fn session_disposal_tombstone_no_resurrection() -> Result<(), Box<dyn std::error::Error>> {
    let mut session = SceneSession::new();
    let expected = SceneExpected {
        session_id: session.session_id.clone(),
        revision: session.revision,
        draft_input_digest: None,
        source_id: None,
        token_snapshot_id: None,
        engine_identity: None,
    };
    assert!(session.check_expected(&expected).is_ok());

    session.dispose();
    assert!(session.disposed);

    // Any expected check on disposed session fails
    assert_eq!(
        session
            .check_expected(&expected)
            .err()
            .ok_or("expected rejection")?
            .reason_code(),
        StudioReasonCode::ContextStale
    );

    // Edits on disposed session fail
    let edit_res = session.apply_edits(vec![SceneEditOperation::SetProfile {
        profile: SceneProfile::Diagram,
    }]);
    assert_eq!(
        edit_res.err().ok_or("expected rejection")?.reason_code(),
        StudioReasonCode::ContextStale
    );

    // No replacement intent on disposed session
    let res = session.begin_replacement_intent(None, None);
    assert_eq!(
        res.err().ok_or("expected rejection")?.reason_code(),
        StudioReasonCode::ContextStale
    );
    Ok(())
}

#[test]
fn token_binding_alpha_rejection() -> Result<(), Box<dyn std::error::Error>> {
    let mut session = SceneSession::new();

    let mut valid_tokens = BTreeMap::new();
    valid_tokens.insert("brand-primary".to_owned(), "#112233".to_owned());
    assert!(session.bind_tokens(1, valid_tokens).is_ok());

    let mut ff_tokens = BTreeMap::new();
    ff_tokens.insert("brand-secondary".to_owned(), "#112233ff".to_owned());
    assert!(session.bind_tokens(2, ff_tokens).is_ok());

    let mut non_ff_tokens = BTreeMap::new();
    non_ff_tokens.insert("brand-accent".to_owned(), "#11223380".to_owned());
    let err = session.bind_tokens(3, non_ff_tokens);
    assert_eq!(
        err.err().ok_or("expected rejection")?.reason_code(),
        StudioReasonCode::DomainFailed
    );
    Ok(())
}

#[test]
fn save_disabled_for_uncompiled_draft() -> Result<(), Box<dyn std::error::Error>> {
    let mut session = SceneSession::new();
    let target =
        std::env::temp_dir().join(format!("test-plan-uncompiled-{}.json", std::process::id()));

    // When session has no compiled preview, retain_save_plan must fail
    assert!(session.compiled_svg.is_none());
    let plan_res = session.retain_save_plan(target.clone());
    assert_eq!(
        plan_res.err().ok_or("expected rejection")?.reason_code(),
        StudioReasonCode::PlanInvalid
    );

    // When compiled preview and receipt are present and match, retain_save_plan succeeds
    session.validated_json = Some(session.canonical_json.clone());
    session.compiled_svg = Some("<svg></svg>".to_owned());
    session.compiled_svg_digest = Some(compute_sha256(b"<svg></svg>"));
    session.receipt = Some(SceneReceiptDto {
        schema: "tfsb.scene-compile-receipt-v1".to_owned(),
        diagnostics: Vec::new(),
        source_snapshot_digest: "snap".to_owned(),
        scene_schema: SCENE_SCHEMA.to_owned(),
        scene_compatibility: 1,
        scene_compiler_level: 1,
        source_digest: format!("sha256:{}", session.draft_input_digest),
        svg_digest: compute_sha256(b"<svg></svg>"),
        profile: SceneProfile::Illustration,
        artboard: session.current_scene.artboard.clone(),
        glyph_catalog_digest: "glyph".to_owned(),
        token_digest: "tok".to_owned(),
        metrics: SceneMetricsDto {
            expanded_element_count: 0,
            authored_element_count: 0,
            path_segment_count: 0,
            glyph_count: 0,
            max_nesting_depth: 0,
            gradient_stop_count: 0,
        },
    });

    let plan_res = session.retain_save_plan(target)?;
    assert!(plan_res.plan_id.is_some());
    Ok(())
}

#[test]
fn save_and_export_plan_expiry_and_one_shot() -> Result<(), Box<dyn std::error::Error>> {
    let mut session = SceneSession::new();
    session.validated_json = Some(session.canonical_json.clone());
    session.compiled_svg = Some("<svg></svg>".to_owned());
    session.compiled_svg_digest = Some(compute_sha256(b"<svg></svg>"));
    session.receipt = Some(SceneReceiptDto {
        schema: "tfsb.scene-compile-receipt-v1".to_owned(),
        diagnostics: Vec::new(),
        source_snapshot_digest: "snap".to_owned(),
        scene_schema: SCENE_SCHEMA.to_owned(),
        scene_compatibility: 1,
        scene_compiler_level: 1,
        source_digest: format!("sha256:{}", session.draft_input_digest),
        svg_digest: compute_sha256(b"<svg></svg>"),
        profile: SceneProfile::Illustration,
        artboard: session.current_scene.artboard.clone(),
        glyph_catalog_digest: "glyph".to_owned(),
        token_digest: "tok".to_owned(),
        metrics: SceneMetricsDto {
            expanded_element_count: 0,
            authored_element_count: 0,
            path_segment_count: 0,
            glyph_count: 0,
            max_nesting_depth: 0,
            gradient_stop_count: 0,
        },
    });

    let target = std::env::temp_dir().join(format!("test-plan-{}.json", std::process::id()));
    let plan_res = session.retain_save_plan(target)?;
    let plan_id = plan_res.plan_id.ok_or("plan id missing")?;

    let plan = session.take_save_plan(&plan_id)?;
    assert_eq!(plan.plan_id, plan_id);

    let second_take = session.take_save_plan(&plan_id);
    assert_eq!(
        second_take.err().ok_or("expected rejection")?.reason_code(),
        StudioReasonCode::PlanInvalid
    );
    Ok(())
}

#[test]
fn save_apply_validates_stored_parent_identity() -> Result<(), Box<dyn std::error::Error>> {
    let dir = std::env::temp_dir().join(format!("test-parent-id-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir(&dir)?;

    let target = dir.join("test-file.json");
    let initial_parent_id = get_parent_identity(&target)?;
    assert!(validate_parent_identity(&target, initial_parent_id).is_ok());

    // If parent identity changes or does not match
    let bogus_identity = (initial_parent_id.0, initial_parent_id.1 + 9999);
    let err = validate_parent_identity(&target, bogus_identity);
    assert_eq!(
        err.err().ok_or("expected rejection")?.reason_code(),
        StudioReasonCode::PlanInvalid
    );

    let _ = fs::remove_dir_all(dir);
    Ok(())
}

#[test]
fn absent_only_publication_atomicity() -> Result<(), Box<dyn std::error::Error>> {
    let dir = std::env::temp_dir().join(format!("test-pub-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir(&dir)?;

    let target = dir.join("test-published.json");
    let content = b"{\"hello\":\"scene\"}";

    let written = publish_absent_only_bytes(&target, content)?;
    assert_eq!(written, content.len());
    assert!(target.is_file());

    let second = publish_absent_only_bytes(&target, content);
    assert_eq!(
        second.err().ok_or("expected rejection")?.reason_code(),
        StudioReasonCode::SelectionRejected
    );

    let read_back = read_selected_bytes(&target, 1024)?;
    assert_eq!(read_back, content);

    let _ = fs::remove_dir_all(dir);
    Ok(())
}

#[test]
fn read_selected_bytes_fstat_and_length_checks() -> Result<(), Box<dyn std::error::Error>> {
    let dir = std::env::temp_dir().join(format!("test-read-fstat-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir(&dir)?;

    let target = dir.join("test.json");
    fs::write(&target, b"12345678")?;

    // Reading with sufficient max_bytes succeeds
    let read_bytes = read_selected_bytes(&target, 10)?;
    assert_eq!(read_bytes, b"12345678");

    // Reading with smaller max_bytes fails with ResultTooLarge
    let small_read = read_selected_bytes(&target, 4);
    assert_eq!(
        small_read.err().ok_or("expected rejection")?.reason_code(),
        StudioReasonCode::ResultTooLarge
    );

    let _ = fs::remove_dir_all(dir);
    Ok(())
}

#[test]
fn packet_retention_bounds() -> Result<(), Box<dyn std::error::Error>> {
    let mut session = SceneSession::new();
    for i in 0..6 {
        let packet_id = format!("packet-{i}");
        let json = format!("{{\"packet\":{i}}}");
        session.retain_packet(packet_id, "brief".to_owned(), json, Vec::new())?;
    }

    assert_eq!(session.retained_packets.len(), 4);
    assert_eq!(session.retained_packets[0].packet_id, "packet-2");
    assert_eq!(session.retained_packets[3].packet_id, "packet-5");
    Ok(())
}

#[test]
fn exchange_envelopes_deny_unknown_fields() -> Result<(), Box<dyn std::error::Error>> {
    // Brief envelope with unknown field
    let brief_with_unknown = r#"{
        "schema": "tfsb.scene-brief-v1",
        "schemaVersion": 1,
        "briefId": "b-1",
        "title": "Title",
        "objective": "Obj",
        "scene": {
            "schema": "tfsb.vector-scene-v1",
            "compatibility": 1,
            "compilerLevel": 1,
            "profile": "illustration",
            "artboard": { "width": 100, "height": 100, "viewBox": [0,0,100,100] },
            "accessibility": { "mode": "decorative" },
            "elements": []
        },
        "canonicalDigest": "dig",
        "extraIllegalField": "bad"
    }"#;
    assert!(parse_exchange_packet(brief_with_unknown, None).is_err());

    // Candidate envelope with unknown field
    let candidate_with_unknown = r#"{
        "schema": "tfsb.scene-candidate-v1",
        "schemaVersion": 1,
        "candidateId": "c-1",
        "briefId": "b-1",
        "briefDigest": "bd",
        "canonicalSceneDigest": "cd",
        "svgDigest": "sd",
        "profile": "illustration",
        "artboard": { "width": 100, "height": 100, "viewBox": [0,0,100,100] },
        "sceneSchema": "tfsb.vector-scene-v1",
        "sceneCompatibility": 1,
        "sceneCompilerLevel": 1,
        "glyphCatalogDigest": "gd",
        "tokenDigest": "td",
        "scene": {
            "schema": "tfsb.vector-scene-v1",
            "compatibility": 1,
            "compilerLevel": 1,
            "profile": "illustration",
            "artboard": { "width": 100, "height": 100, "viewBox": [0,0,100,100] },
            "accessibility": { "mode": "decorative" },
            "elements": []
        },
        "maliciousExtraField": "bad"
    }"#;
    assert!(parse_exchange_packet(candidate_with_unknown, None).is_err());

    // Unknown schema string has no fallback
    let unknown_schema = r#"{
        "schema": "tfsb.unknown-packet-v1",
        "schemaVersion": 1
    }"#;
    let err = parse_exchange_packet(unknown_schema, None);
    assert_eq!(
        err.err().ok_or("expected rejection")?.reason_code(),
        StudioReasonCode::ProtocolInvalid
    );
    Ok(())
}

#[test]
fn exchange_envelopes_round_trip() -> Result<(), Box<dyn std::error::Error>> {
    let brief = BriefPacketEnvelope {
        source_id: None,
        token_snapshot_id: None,
        schema: BRIEF_SCHEMA.to_owned(),
        schema_version: EXCHANGE_SCHEMA_VERSION,
        brief_id: "brief-test-1".to_owned(),
        title: "Test Brief".to_owned(),
        objective: "Test Objective".to_owned(),
        acceptance_criteria: vec!["Criterion 1".to_owned()],
        prohibited_changes: vec!["No breaking colors".to_owned()],
        scene: sample_scene(),
        canonical_digest: "digest-123".to_owned(),
    };
    let brief_json = serde_json::to_string(&brief)?;
    let parsed_brief = parse_exchange_packet(&brief_json, Some("brief"))?;
    assert_eq!(parsed_brief.packet_id(), "brief-test-1");
    assert_eq!(parsed_brief.kind(), "brief");

    let candidate = CandidatePacketEnvelope {
        source_id: None,
        token_snapshot_id: None,
        schema: CANDIDATE_SCHEMA.to_owned(),
        schema_version: EXCHANGE_SCHEMA_VERSION,
        candidate_id: "cand-test-1".to_owned(),
        brief_id: "brief-test-1".to_owned(),
        brief_digest: "brief-digest-1".to_owned(),
        canonical_scene_digest: "scene-digest-1".to_owned(),
        svg_digest: "svg-digest-1".to_owned(),
        profile: SceneProfile::Illustration,
        artboard: Artboard {
            width: 1440.0,
            height: 720.0,
            view_box: [0.0, 0.0, 1440.0, 720.0],
            policy: Some(ArtboardPolicy::Contain),
        },
        scene_schema: SCENE_SCHEMA.to_owned(),
        scene_compatibility: SCENE_COMPATIBILITY,
        scene_compiler_level: SCENE_COMPILER_LEVEL,
        glyph_catalog_digest: "glyph-1".to_owned(),
        token_digest: "token-1".to_owned(),
        sender_provenance: None,
        scene: sample_scene(),
    };
    let candidate_json = serde_json::to_string(&candidate)?;
    let parsed_cand = parse_exchange_packet(&candidate_json, Some("candidate"))?;
    assert_eq!(parsed_cand.packet_id(), "cand-test-1");
    assert_eq!(parsed_cand.kind(), "candidate");

    let review = ReviewPacketEnvelope {
        schema: REVIEW_SCHEMA.to_owned(),
        schema_version: EXCHANGE_SCHEMA_VERSION,
        review_id: "review-test-1".to_owned(),
        brief_packet_id: "brief-test-1".to_owned(),
        candidate_packet_ids: vec!["cand-test-1".to_owned()],
        overall_disposition: "APPROVED".to_owned(),
        summary: "Looks good".to_owned(),
        annotations: vec![SceneReviewAnnotationDto {
            annotation_id: "ann-1".to_owned(),
            candidate_id: "cand-test-1".to_owned(),
            comment: "Nice rect".to_owned(),
            severity: "info".to_owned(),
            element_id: Some("rect-1".to_owned()),
        }],
    };
    let review_json = serde_json::to_string(&review)?;
    let parsed_review = parse_exchange_packet(&review_json, Some("review"))?;
    assert_eq!(parsed_review.packet_id(), "review-test-1");
    assert_eq!(parsed_review.kind(), "review");
    Ok(())
}

#[test]
fn candidate_verification_and_adopt() -> Result<(), Box<dyn std::error::Error>> {
    let mut session = SceneSession::new();
    assert_eq!(session.revision, 0);

    let candidate_scene = sample_scene();
    let candidate_digest = compute_sha256(b"candidate-bytes");

    let handle = session.retain_verification(
        "cand-1".to_owned(),
        candidate_digest.clone(),
        Some("svg-digest-123".to_owned()),
        candidate_scene.clone(),
        None,
        Vec::new(),
    );

    let verification = session.take_verification(&handle)?;
    assert_eq!(verification.candidate_packet_id, "cand-1");

    session.current_scene = verification.verified_scene;
    session.dirty = true;
    session.source_id = None;
    session.next_revision()?;
    session.update_canonical()?;

    assert_eq!(session.revision, 1);
    assert!(session.dirty);
    assert_eq!(session.current_scene, candidate_scene);
    Ok(())
}

#[test]
fn draft_edit_invalidates_retained_candidate_verification() -> Result<(), Box<dyn std::error::Error>>
{
    let mut session = SceneSession::new();
    let handle = session.retain_verification(
        "candidate-before-edit".to_owned(),
        compute_sha256(b"candidate"),
        None,
        sample_scene(),
        None,
        Vec::new(),
    );
    session.apply_edits(vec![SceneEditOperation::SetProfile {
        profile: SceneProfile::Diagram,
    }])?;
    assert_eq!(
        session
            .take_verification(&handle)
            .err()
            .ok_or("expected invalidation")?
            .reason_code(),
        StudioReasonCode::PlanInvalid
    );
    assert_eq!(session.revision, 1);
    assert_eq!(session.current_scene.profile, SceneProfile::Diagram);
    Ok(())
}
