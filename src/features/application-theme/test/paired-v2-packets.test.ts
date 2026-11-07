import { describe, expect, it } from "vitest";
import {
  decodePairedV2NativePacketEnvelope,
  decodePairedV2Packet,
  parsePairedV2PacketJson,
  validatePairedV2PacketAssociations,
  PairedV2ValidationError,
} from "../paired-v2-packets";

const BRIEF_DIGEST = "a".repeat(64);
const SOURCE_DIGEST = "b".repeat(64);
const CANONICAL_DIGEST = "c".repeat(64);
const CANDIDATE_DIGEST = "d".repeat(64);
const REVIEW_DIGEST = "e".repeat(64);

function brief() {
  return {
    schema: "tf-paired-profile-v2-brief",
    schemaVersion: 1,
    briefId: "developer-brief",
    title: "Developer focused edit",
    goal: "Edit focused palette, typography, and radius fields.",
    profileName: "developer",
    profileVersion: "0.1.0",
    sourceProfileSha256: SOURCE_DIGEST,
    sourceCanonicalDigest: CANONICAL_DIGEST,
    editablePaths: ["color.*", "typography.*", "radius.*"],
    allowedModes: ["light", "dark"],
    acceptanceCriteria: ["Preserve all untouched fields."],
    prohibitedChanges: ["Do not edit targetOverrides."],
    briefDigest: BRIEF_DIGEST,
  };
}

function candidate(briefDigest = BRIEF_DIGEST, candidateDigest = CANDIDATE_DIGEST) {
  return {
    schema: "tf-paired-profile-v2-candidate",
    schemaVersion: 1,
    candidateId: "developer-candidate",
    briefDigest,
    sourceBytesBase64: "eA==",
    sourceProfileSha256: SOURCE_DIGEST,
    sourceCanonicalDigest: CANONICAL_DIGEST,
    rationale: "Human design context only; native compile must rebind the source.",
    candidateDigest,
  };
}

function review(briefDigest = BRIEF_DIGEST, candidateDigest = CANDIDATE_DIGEST) {
  return {
    schema: "tf-paired-profile-v2-review",
    schemaVersion: 1,
    reviewId: "developer-review",
    briefDigest,
    candidateDigests: [candidateDigest],
    dispositions: [{ candidateDigest, disposition: "revise" }],
    overallDisposition: "revise",
    summary: "Revise after source re-verification.",
    reviewDigest: REVIEW_DIGEST,
  };
}

describe("paired v2 human-context packets", () => {
  it("reads all three exact packet kinds without computing or asserting digest validity", () => {
    expect(decodePairedV2Packet(brief()).schema).toBe("tf-paired-profile-v2-brief");
    expect(decodePairedV2Packet(candidate()).schema).toBe("tf-paired-profile-v2-candidate");
    expect(decodePairedV2Packet(review()).schema).toBe("tf-paired-profile-v2-review");
  });

  it("rejects unknown schemas and fields", () => {
    expect(() => decodePairedV2Packet({ ...brief(), schema: "tfsl.theme-v2" })).toThrow(PairedV2ValidationError);
    expect(() => decodePairedV2Packet({ ...candidate(), unknownField: true })).toThrow(PairedV2ValidationError);
    expect(() => decodePairedV2Packet({ ...review(), schemaVersion: 2 })).toThrow(PairedV2ValidationError);
  });

  it("enforces source, criteria, prohibited-change, and candidate-count bounds", () => {
    const oversizedSource = candidate();
    oversizedSource.sourceBytesBase64 = "A".repeat(175_104);
    expect(() => decodePairedV2Packet(oversizedSource)).toThrow(PairedV2ValidationError);

    const tooManyCriteria = brief();
    tooManyCriteria.acceptanceCriteria = Array.from({ length: 17 }, () => "criterion");
    expect(() => decodePairedV2Packet(tooManyCriteria)).toThrow(PairedV2ValidationError);

    const tooManyCandidates = review();
    tooManyCandidates.candidateDigests = Array.from({ length: 9 }, (_, index) => String(index).padStart(64, "0"));
    tooManyCandidates.dispositions = tooManyCandidates.candidateDigests.map((digest) => ({
      candidateDigest: digest,
      disposition: "approve",
    }));
    expect(() => decodePairedV2Packet(tooManyCandidates)).toThrow(PairedV2ValidationError);
  });

  it("requires candidate source identity claims with strict digest formats", () => {
    const missingClaim = candidate() as Record<string, unknown>;
    delete missingClaim.sourceCanonicalDigest;
    expect(() => decodePairedV2Packet(missingClaim)).toThrow(PairedV2ValidationError);

    const wrongClaim = candidate();
    wrongClaim.sourceProfileSha256 = "A".repeat(64);
    expect(() => decodePairedV2Packet(wrongClaim)).toThrow(PairedV2ValidationError);
  });

  it("enforces closed review dispositions and brief/candidate digest associations", () => {
    const parsedBrief = decodePairedV2Packet(brief());
    const parsedCandidate = decodePairedV2Packet(candidate());
    const parsedReview = decodePairedV2Packet(review());
    if (
      parsedBrief.schema !== "tf-paired-profile-v2-brief" ||
      parsedCandidate.schema !== "tf-paired-profile-v2-candidate" ||
      parsedReview.schema !== "tf-paired-profile-v2-review"
    ) {
      throw new Error("unexpected packet kind");
    }
    expect(() => validatePairedV2PacketAssociations(parsedBrief, [parsedCandidate], parsedReview)).not.toThrow();

    const wrongReview = decodePairedV2Packet(review(BRIEF_DIGEST, "f".repeat(64)));
    if (wrongReview.schema !== "tf-paired-profile-v2-review") throw new Error("unexpected review kind");
    expect(() => validatePairedV2PacketAssociations(parsedBrief, [parsedCandidate], wrongReview)).toThrow(
      PairedV2ValidationError
    );

    const duplicateDisposition = review();
    duplicateDisposition.dispositions = [
      { candidateDigest: CANDIDATE_DIGEST, disposition: "approve" },
      { candidateDigest: CANDIDATE_DIGEST, disposition: "reject" },
    ];
    expect(() => decodePairedV2Packet(duplicateDisposition)).toThrow(PairedV2ValidationError);
  });

  it("accepts the closed five-field native envelope and keeps packet self-integrity separate from authority", () => {
    const packet = candidate();
    const reordered = Object.fromEntries(Object.entries(packet).reverse());
    const envelope = decodePairedV2NativePacketEnvelope({
      kind: packet.schema,
      canonicalJson: JSON.stringify(reordered),
      digest: CANDIDATE_DIGEST,
      packetDigestVerified: true,
      packet,
    });
    expect(envelope.packetDigestVerified).toBe(true);
    expect(envelope.canonicalJson).toBe(JSON.stringify(reordered));
    expect(envelope.digest).toBe(CANDIDATE_DIGEST);
    expect(envelope.packet.schema).toBe("tf-paired-profile-v2-candidate");
    expect(Object.isFrozen(envelope)).toBe(true);
    expect(Object.getPrototypeOf(envelope.packet)).toBe(null);
  });

  it("rejects envelope self-integrity drift without computing a browser digest", () => {
    const packet = candidate();
    const base = {
      kind: packet.schema,
      canonicalJson: JSON.stringify(packet),
      digest: CANDIDATE_DIGEST,
      packetDigestVerified: true,
      packet,
    };
    expect(() => decodePairedV2NativePacketEnvelope({ ...base, packetDigestVerified: false })).toThrow(PairedV2ValidationError);
    expect(() => decodePairedV2NativePacketEnvelope({ ...base, digest: "f".repeat(64) })).toThrow(PairedV2ValidationError);
    expect(() => decodePairedV2NativePacketEnvelope({ ...base, canonicalJson: JSON.stringify({ ...packet, rationale: "different" }) })).toThrow(PairedV2ValidationError);
    expect(() => decodePairedV2NativePacketEnvelope({ ...base, extra: true })).toThrow(PairedV2ValidationError);
  });

  it("uses bounded safe copies for prototype-shaped and deeply nested transport data", () => {
    const packet = candidate();
    const shaped = JSON.parse(JSON.stringify(packet)) as Record<string, unknown>;
    shaped.rationale = "safe";
    const parsed = decodePairedV2Packet(shaped);
    expect(Object.getPrototypeOf(parsed)).toBe(null);
    expect(Object.getPrototypeOf((parsed as typeof packet).rationale)).toBe(String.prototype);

    const polluted = candidate() as Record<string, unknown>;
    Object.defineProperty(polluted, "__proto__", {
      configurable: true,
      enumerable: true,
      value: { polluted: true },
    });
    expect(() => decodePairedV2Packet(polluted)).toThrow(PairedV2ValidationError);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();

    const deep = candidate() as Record<string, unknown>;
    let nested: Record<string, unknown> = { leaf: "x" };
    for (let index = 0; index < 70; index += 1) nested = { child: nested };
    deep.rationale = "bounded";
    deep.extra = nested;
    expect(() => decodePairedV2Packet(deep)).toThrow(PairedV2ValidationError);
  });

  it("parses bounded JSON text without routing through generic ThemeLab or TFSB", () => {
    const parsed = parsePairedV2PacketJson(JSON.stringify(candidate()));
    expect(parsed.schema).toBe("tf-paired-profile-v2-candidate");
    expect(() => parsePairedV2PacketJson("{")).toThrow(PairedV2ValidationError);
  });
});
