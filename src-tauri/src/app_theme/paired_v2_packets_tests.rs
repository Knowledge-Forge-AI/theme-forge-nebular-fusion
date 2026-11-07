use super::paired_v2_packets::*;
use crate::errors::StudioReasonCode;

const BRIEF_DIGEST: &str = "1cc589e2ce6eee22302ca75d98b80cdc2b0034943b72ee2db96bafc9ea99b9d5";
const CANDIDATE_DIGEST: &str = "874562de93f4f5268f8e6d8bfb11e5b65b4272bb3559bd66c805d8751648b699";
const REVIEW_DIGEST: &str = "bd7d0eb48bf6c2f2a1fa8a54cd6f4c4a81c50687ff420ae7e7a012fa14c74d42";
const SOURCE_SHA256: &str = "8a5edab282632443219e051e4ade2d1d5bbc671c781051bf1437897cbdfea0f1";
const SOURCE_CANONICAL_DIGEST: &str =
    "5555555555555555555555555555555555555555555555555555555555555555";
const BRIEF_CANONICAL: &str = r#"{
  "acceptanceCriteria": [
    "Keep /"
  ],
  "allowedModes": [
    "light"
  ],
  "briefDigest": "1cc589e2ce6eee22302ca75d98b80cdc2b0034943b72ee2db96bafc9ea99b9d5",
  "briefId": "brief-ø",
  "editablePaths": [],
  "goal": "Keep / exact\u001f",
  "profileName": "nebular",
  "profileVersion": "0.1.0",
  "prohibitedChanges": [],
  "schema": "tf-paired-profile-v2-brief",
  "schemaVersion": 1,
  "sourceCanonicalDigest": "2222222222222222222222222222222222222222222222222222222222222222",
  "sourceProfileSha256": "1111111111111111111111111111111111111111111111111111111111111111",
  "title": "Café / brief"
}
"#;
const CANDIDATE_CANONICAL: &str = r#"{
  "briefDigest": "1cc589e2ce6eee22302ca75d98b80cdc2b0034943b72ee2db96bafc9ea99b9d5",
  "candidateDigest": "874562de93f4f5268f8e6d8bfb11e5b65b4272bb3559bd66c805d8751648b699",
  "candidateId": "candidate-1",
  "rationale": "Raison / Café",
  "schema": "tf-paired-profile-v2-candidate",
  "schemaVersion": 1,
  "sourceBytesBase64": "Lw==",
  "sourceCanonicalDigest": "5555555555555555555555555555555555555555555555555555555555555555",
  "sourceProfileSha256": "8a5edab282632443219e051e4ade2d1d5bbc671c781051bf1437897cbdfea0f1"
}
"#;
const REVIEW_CANONICAL: &str = r#"{
  "briefDigest": "1cc589e2ce6eee22302ca75d98b80cdc2b0034943b72ee2db96bafc9ea99b9d5",
  "candidateDigests": [
    "874562de93f4f5268f8e6d8bfb11e5b65b4272bb3559bd66c805d8751648b699",
    "7777777777777777777777777777777777777777777777777777777777777777"
  ],
  "dispositions": [
    {
      "candidateDigest": "874562de93f4f5268f8e6d8bfb11e5b65b4272bb3559bd66c805d8751648b699",
      "comment": "ok / Café",
      "disposition": "approve"
    },
    {
      "candidateDigest": "7777777777777777777777777777777777777777777777777777777777777777",
      "disposition": "revise"
    }
  ],
  "overallDisposition": "revise",
  "reviewDigest": "bd7d0eb48bf6c2f2a1fa8a54cd6f4c4a81c50687ff420ae7e7a012fa14c74d42",
  "reviewId": "review-1",
  "schema": "tf-paired-profile-v2-review",
  "schemaVersion": 1,
  "summary": "Summary / Café"
}
"#;

fn brief_input() -> PairedV2BriefCreateInput {
    PairedV2BriefCreateInput {
        schema: "tf-paired-profile-v2-brief".to_owned(),
        schema_version: 1,
        brief_id: "brief-ø".to_owned(),
        title: "Café / brief".to_owned(),
        goal: "Keep / exact\u{001f}".to_owned(),
        profile_name: "nebular".to_owned(),
        profile_version: "0.1.0".to_owned(),
        source_profile_sha256: "1".repeat(64),
        source_canonical_digest: "2".repeat(64),
        editable_paths: vec![],
        allowed_modes: vec!["light".to_owned()],
        acceptance_criteria: vec!["Keep /".to_owned()],
        prohibited_changes: vec![],
    }
}

fn candidate_input(brief_digest: &str) -> PairedV2CandidateCreateInput {
    PairedV2CandidateCreateInput {
        schema: "tf-paired-profile-v2-candidate".to_owned(),
        schema_version: 1,
        candidate_id: "candidate-1".to_owned(),
        brief_digest: brief_digest.to_owned(),
        source_bytes_base64: "Lw==".to_owned(),
        source_profile_sha256: SOURCE_SHA256.to_owned(),
        source_canonical_digest: SOURCE_CANONICAL_DIGEST.to_owned(),
        rationale: "Raison / Café".to_owned(),
    }
}

fn review_input(brief_digest: &str, candidate_digest: &str) -> PairedV2ReviewCreateInput {
    PairedV2ReviewCreateInput {
        schema: "tf-paired-profile-v2-review".to_owned(),
        schema_version: 1,
        review_id: "review-1".to_owned(),
        brief_digest: brief_digest.to_owned(),
        candidate_digests: vec![candidate_digest.to_owned(), "7".repeat(64)],
        dispositions: vec![
            PairedV2ReviewDisposition {
                candidate_digest: candidate_digest.to_owned(),
                disposition: PairedV2ReviewDispositionKind::Approve,
                comment: Some("ok / Café".to_owned()),
            },
            PairedV2ReviewDisposition {
                candidate_digest: "7".repeat(64),
                disposition: PairedV2ReviewDispositionKind::Revise,
                comment: None,
            },
        ],
        overall_disposition: PairedV2ReviewDispositionKind::Revise,
        summary: "Summary / Café".to_owned(),
    }
}

fn create_brief() -> PairedV2PacketEnvelope {
    create_packet(PairedV2PacketCreateRequest::Brief(brief_input())).expect("brief packet")
}

fn create_candidate() -> PairedV2PacketEnvelope {
    create_packet(PairedV2PacketCreateRequest::Candidate(candidate_input(
        BRIEF_DIGEST,
    )))
    .expect("candidate packet")
}

fn create_review() -> PairedV2PacketEnvelope {
    create_packet(PairedV2PacketCreateRequest::Review(review_input(
        BRIEF_DIGEST,
        CANDIDATE_DIGEST,
    )))
    .expect("review packet")
}

#[test]
fn exact_golden_vectors_cover_brief_candidate_and_review() {
    let brief = create_brief();
    assert_eq!(brief.kind, "tf-paired-profile-v2-brief");
    assert_eq!(brief.digest, BRIEF_DIGEST);
    assert!(brief.packet_digest_verified);
    assert_eq!(brief.canonical_json, BRIEF_CANONICAL);

    let candidate = create_candidate();
    assert_eq!(candidate.kind, "tf-paired-profile-v2-candidate");
    assert_eq!(candidate.digest, CANDIDATE_DIGEST);
    assert!(candidate.packet_digest_verified);
    assert_eq!(candidate.canonical_json, CANDIDATE_CANONICAL);

    let review = create_review();
    assert_eq!(review.kind, "tf-paired-profile-v2-review");
    assert_eq!(review.digest, REVIEW_DIGEST);
    assert!(review.packet_digest_verified);
    assert_eq!(review.canonical_json, REVIEW_CANONICAL);
}

#[test]
fn canonical_goldens_round_trip_with_native_identity() {
    for (json, kind) in [
        (BRIEF_CANONICAL, "tf-paired-profile-v2-brief"),
        (CANDIDATE_CANONICAL, "tf-paired-profile-v2-candidate"),
        (REVIEW_CANONICAL, "tf-paired-profile-v2-review"),
    ] {
        let parsed = parse_packet(json.as_bytes(), Some(kind)).expect("canonical packet");
        assert_eq!(parsed.kind, kind);
        assert_eq!(parsed.canonical_json, json);
        assert!(parsed.packet_digest_verified);
    }
}

#[test]
fn packet_self_digest_is_not_a_signature_or_source_custody_claim() {
    let candidate = create_candidate();
    let PairedV2Packet::Candidate(packet) = candidate.packet else {
        panic!("candidate kind");
    };
    assert_eq!(packet.source_profile_sha256, SOURCE_SHA256);
    assert_eq!(packet.source_canonical_digest, SOURCE_CANONICAL_DIGEST);
    assert_eq!(candidate.digest, CANDIDATE_DIGEST);
}

#[test]
fn strict_unknown_duplicate_version_and_digest_inputs_fail() {
    let unknown = BRIEF_CANONICAL.replace(
        "  \"title\": \"Café / brief\",\n",
        "  \"title\": \"Café / brief\",\n  \"unknown\": true,\n",
    );
    assert!(parse_packet(unknown.as_bytes(), Some("tf-paired-profile-v2-brief")).is_err());

    let duplicate = BRIEF_CANONICAL.replacen(
        "  \"schemaVersion\": 1,\n",
        "  \"schemaVersion\": 1,\n  \"schemaVersion\": 1,\n",
        1,
    );
    assert!(parse_packet(duplicate.as_bytes(), Some("tf-paired-profile-v2-brief")).is_err());

    let non_integer_version =
        BRIEF_CANONICAL.replace("  \"schemaVersion\": 1,\n", "  \"schemaVersion\": 1.0,\n");
    assert!(
        parse_packet(
            non_integer_version.as_bytes(),
            Some("tf-paired-profile-v2-brief")
        )
        .is_err()
    );

    let wrong_digest = CANDIDATE_CANONICAL.replace(CANDIDATE_DIGEST, &"0".repeat(64));
    assert!(
        parse_packet(
            wrong_digest.as_bytes(),
            Some("tf-paired-profile-v2-candidate")
        )
        .is_err()
    );
    let wrong_base64 = CANDIDATE_CANONICAL.replace("Lw==", "Lw");
    assert!(
        parse_packet(
            wrong_base64.as_bytes(),
            Some("tf-paired-profile-v2-candidate")
        )
        .is_err()
    );

    let null_comment = REVIEW_CANONICAL.replace("\"comment\": \"ok / Café\"", "\"comment\": null");
    assert!(parse_packet(null_comment.as_bytes(), Some("tf-paired-profile-v2-review")).is_err());
}

#[test]
fn bounds_and_association_shape_are_closed() {
    let mut brief = brief_input();
    brief.profile_version = "a".repeat(65);
    assert!(create_packet(PairedV2PacketCreateRequest::Brief(brief)).is_err());

    let mut brief = brief_input();
    brief.acceptance_criteria = (0..17).map(|index| format!("criterion-{index}")).collect();
    assert!(create_packet(PairedV2PacketCreateRequest::Brief(brief)).is_err());

    let mut candidate = candidate_input(BRIEF_DIGEST);
    candidate.source_bytes_base64 = "A".repeat(PAIRED_V2_SOURCE_BASE64_MAX_BYTES + 4);
    assert!(create_packet(PairedV2PacketCreateRequest::Candidate(candidate)).is_err());

    let mut review = review_input(BRIEF_DIGEST, CANDIDATE_DIGEST);
    review.candidate_digests = (0..9).map(|index| format!("{index:064x}")).collect();
    review.dispositions = review
        .candidate_digests
        .iter()
        .map(|digest| PairedV2ReviewDisposition {
            candidate_digest: digest.clone(),
            disposition: PairedV2ReviewDispositionKind::Approve,
            comment: None,
        })
        .collect();
    assert!(create_packet(PairedV2PacketCreateRequest::Review(review)).is_err());

    let mut mismatched = candidate_input(BRIEF_DIGEST);
    mismatched.source_profile_sha256 = "0".repeat(64);
    assert!(create_packet(PairedV2PacketCreateRequest::Candidate(mismatched)).is_err());
}

#[test]
fn tri_state_family_fence_preserves_generic_and_rejects_paired_fallbacks() {
    assert_eq!(
        classify_packet(br#"{"schema":"tfsl.theme-candidate","schemaVersion":2}"#),
        PairedV2PacketClassification::NonPaired
    );
    assert_eq!(
        classify_packet(br#"{"schema":"tf-paired-profile-v2-future"}"#),
        PairedV2PacketClassification::Paired {
            schema: "tf-paired-profile-v2-future".to_owned()
        }
    );
    assert_eq!(
        classify_packet(br#"{"schema":"tf-paired-profile-v3-future"}"#),
        PairedV2PacketClassification::Paired {
            schema: "tf-paired-profile-v3-future".to_owned()
        }
    );
    assert_eq!(
        classify_packet(br#"{"schema":"tf-paired-profile-v2-candidate","schema":"tf-paired-profile-v2-candidate"}"#),
        PairedV2PacketClassification::Paired {
            schema: "tf-paired-profile-v2-candidate".to_owned()
        }
    );
    assert_eq!(
        classify_packet(b"{"),
        PairedV2PacketClassification::Indeterminate
    );

    assert!(parse_packet(BRIEF_CANONICAL.as_bytes(), None).is_err());
    assert!(
        parse_packet(
            BRIEF_CANONICAL.as_bytes(),
            Some("tf-paired-profile-v2-candidate")
        )
        .is_err()
    );
    assert!(
        parse_packet(
            BRIEF_CANONICAL.as_bytes(),
            Some("tf-paired-profile-v2-brief")
        )
        .is_ok()
    );

    let too_large = vec![b' '; PAIRED_V2_PACKET_MAX_BYTES + 1];
    let error =
        parse_packet(&too_large, Some("tf-paired-profile-v2-brief")).expect_err("size refusal");
    assert_eq!(error.reason_code(), StudioReasonCode::ResultTooLarge);
}

#[test]
fn transport_bounded_probe_fences_oversized_paired_packets_before_parse() {
    let mut oversized = Vec::with_capacity(PAIRED_V2_PACKET_MAX_BYTES + 64);
    oversized.extend_from_slice(br#"{"schema":"tf-paired-profile-v2-brief","padding":""#);
    oversized.extend(std::iter::repeat_n(b'x', PAIRED_V2_PACKET_MAX_BYTES));
    oversized.extend_from_slice(br#""}"#);

    assert!(oversized.len() > PAIRED_V2_PACKET_MAX_BYTES);
    assert!(oversized.len() <= PAIRED_V2_PACKET_PROBE_MAX_BYTES);
    assert_eq!(
        classify_packet(&oversized),
        PairedV2PacketClassification::Paired {
            schema: "tf-paired-profile-v2-brief".to_owned()
        }
    );
    let error = parse_packet(&oversized, Some("tf-paired-profile-v2-brief"))
        .expect_err("paired size cap must run after family classification");
    assert_eq!(error.reason_code(), StudioReasonCode::ResultTooLarge);
}

#[test]
fn create_request_is_adjacent_and_closed() {
    let request = PairedV2PacketCreateRequest::Brief(brief_input());
    let encoded = serde_json::to_string(&request).expect("create request");
    assert!(encoded.starts_with(
        r#"{"kind":"tf-paired-profile-v2-brief","input":{"schema":"tf-paired-profile-v2-brief""#
    ));
    let decoded: PairedV2PacketCreateRequest =
        serde_json::from_str(&encoded).expect("adjacent request");
    assert_eq!(decoded, request);

    let unknown = encoded.trim_end_matches('}').to_owned() + ",\"extra\":true}";
    assert!(serde_json::from_str::<PairedV2PacketCreateRequest>(&unknown).is_err());

    let duplicate_input = encoded.replacen(
        "\"input\":{",
        "\"input\":{\"schema\":\"tf-paired-profile-v2-brief\",",
        1,
    );
    assert!(serde_json::from_str::<PairedV2PacketCreateRequest>(&duplicate_input).is_err());

    let duplicate_kind = encoded.replacen(
        "\"kind\":\"tf-paired-profile-v2-brief\",",
        "\"kind\":\"tf-paired-profile-v2-brief\",\"kind\":\"tf-paired-profile-v2-brief\",",
        1,
    );
    assert!(serde_json::from_str::<PairedV2PacketCreateRequest>(&duplicate_kind).is_err());

    let duplicate_nested = encoded.replacen(
        "\"schemaVersion\":1,",
        "\"schemaVersion\":1,\"schemaVersion\":1,",
        1,
    );
    assert!(serde_json::from_str::<PairedV2PacketCreateRequest>(&duplicate_nested).is_err());
}
