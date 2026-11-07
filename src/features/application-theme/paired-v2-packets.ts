import {
  PairedV2ValidationError,
  readonlyJsonClone,
} from "./paired-v2-bridge-decoder";

export const PAIRED_V2_PACKET_KINDS = [
  "tf-paired-profile-v2-brief",
  "tf-paired-profile-v2-candidate",
  "tf-paired-profile-v2-review",
] as const;
export type PairedV2PacketKind = (typeof PAIRED_V2_PACKET_KINDS)[number];

export const PAIRED_V2_PACKET_LIMITS = {
  transportBytes: 2_097_152,
  sourceBytes: 131_072,
  sourceBase64Chars: 175_104,
  briefIdBytes: 64,
  candidateIdBytes: 64,
  reviewIdBytes: 64,
  titleBytes: 120,
  goalBytes: 2_048,
  rationaleBytes: 2_048,
  summaryBytes: 4_096,
  criterionBytes: 2_048,
  prohibitedChangeBytes: 2_048,
  commentBytes: 2_048,
  editablePathBytes: 256,
  maxEditablePaths: 64,
  maxCriteria: 16,
  maxProhibitedChanges: 16,
  maxCandidates: 8,
} as const;

export interface PairedV2BriefPacket {
  readonly schema: "tf-paired-profile-v2-brief";
  readonly schemaVersion: 1;
  readonly briefId: string;
  readonly title: string;
  readonly goal: string;
  readonly profileName: string;
  readonly profileVersion: string;
  readonly sourceProfileSha256: string;
  readonly sourceCanonicalDigest: string;
  readonly editablePaths: readonly string[];
  readonly allowedModes: readonly ("light" | "dark")[];
  readonly acceptanceCriteria: readonly string[];
  readonly prohibitedChanges: readonly string[];
  readonly briefDigest: string;
}

export interface PairedV2CandidatePacket {
  readonly schema: "tf-paired-profile-v2-candidate";
  readonly schemaVersion: 1;
  readonly candidateId: string;
  readonly briefDigest: string;
  readonly sourceBytesBase64: string;
  readonly sourceProfileSha256: string;
  readonly sourceCanonicalDigest: string;
  readonly rationale: string;
  readonly candidateDigest: string;
}

export type PairedV2ReviewDisposition = "approve" | "revise" | "reject";

export interface PairedV2ReviewDispositionRecord {
  readonly candidateDigest: string;
  readonly disposition: PairedV2ReviewDisposition;
  readonly comment?: string;
}

export interface PairedV2ReviewPacket {
  readonly schema: "tf-paired-profile-v2-review";
  readonly schemaVersion: 1;
  readonly reviewId: string;
  readonly briefDigest: string;
  readonly candidateDigests: readonly string[];
  readonly dispositions: readonly PairedV2ReviewDispositionRecord[];
  readonly overallDisposition: PairedV2ReviewDisposition;
  readonly summary: string;
  readonly reviewDigest: string;
}

export type PairedV2Packet =
  | PairedV2BriefPacket
  | PairedV2CandidatePacket
  | PairedV2ReviewPacket;

/** Creation inputs contain every typed packet field except the native-owned self digest. */
export type PairedV2BriefCreateInput = Omit<PairedV2BriefPacket, "briefDigest">;
export type PairedV2CandidateCreateInput = Omit<PairedV2CandidatePacket, "candidateDigest">;
export type PairedV2ReviewCreateInput = Omit<PairedV2ReviewPacket, "reviewDigest">;

export type PairedV2PacketCreateRequest =
  | { readonly kind: "tf-paired-profile-v2-brief"; readonly input: PairedV2BriefCreateInput }
  | { readonly kind: "tf-paired-profile-v2-candidate"; readonly input: PairedV2CandidateCreateInput }
  | { readonly kind: "tf-paired-profile-v2-review"; readonly input: PairedV2ReviewCreateInput };

export interface PairedV2NativePacketEnvelope {
  readonly kind: PairedV2PacketKind;
  readonly canonicalJson: string;
  readonly digest: string;
  /** Self-consistency of one native packet only; not source/profile authority. */
  readonly packetDigestVerified: true;
  readonly packet: PairedV2Packet;
}

type UnknownRecord = Record<string, unknown>;

function fail(context: string, detail: string): never {
  throw new PairedV2ValidationError(context + " " + detail);
}

function record(value: unknown, context: string): UnknownRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return fail(context, "must be an object");
  }
  return value as UnknownRecord;
}

function exact(
  value: UnknownRecord,
  allowed: readonly string[],
  required: readonly string[],
  context: string
): void {
  const known = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!known.has(key)) fail(context, "contains unexpected field " + key);
  }
  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) fail(context, "is missing field " + key);
  }
}

function bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function stringValue(value: unknown, context: string, maxBytes: number): string {
  if (typeof value !== "string" || value.length === 0) return fail(context, "must be a non-empty string");
  if (bytes(value) > maxBytes) return fail(context, "exceeds its size bound");
  return value;
}

function hash(value: unknown, context: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) {
    return fail(context, "must be a lowercase SHA-256 claim");
  }
  return value;
}

function safeJsonBytes(value: unknown, context: string): number {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch {
    return fail(context, "must be JSON-serializable");
  }
  if (serialized === undefined) return fail(context, "must be JSON-serializable");
  return bytes(serialized);
}

function base64(value: unknown, context: string): string {
  const source = stringValue(value, context, PAIRED_V2_PACKET_LIMITS.sourceBase64Chars);
  if (
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(source) ||
    source.length > PAIRED_V2_PACKET_LIMITS.sourceBase64Chars
  ) {
    return fail(context, "must be valid base64");
  }
  const padding = source.endsWith("==") ? 2 : source.endsWith("=") ? 1 : 0;
  const decodedBytes = source.length * 3 / 4 - padding;
  if (decodedBytes <= 0 || decodedBytes > PAIRED_V2_PACKET_LIMITS.sourceBytes) {
    return fail(context, "exceeds the 128 KiB source bound");
  }
  return source;
}

function boundedStringArray(
  value: unknown,
  context: string,
  maxCount: number,
  maxItemBytes: number,
  unique: boolean
): readonly string[] {
  if (!Array.isArray(value) || value.length > maxCount) return fail(context, "must be a bounded array");
  const items = value.map((entry, index) => stringValue(entry, context + "[" + index + "]", maxItemBytes));
  if (unique && new Set(items).size !== items.length) return fail(context, "contains duplicate values");
  return items;
}

function editablePath(value: unknown, index: number): string {
  const path = stringValue(value, "editablePaths[" + index + "]", PAIRED_V2_PACKET_LIMITS.editablePathBytes);
  if (
    path !== "color.*" &&
    path !== "typography.*" &&
    path !== "radius.*" &&
    !/^(?:color|typography|radius)\.[A-Za-z][A-Za-z0-9_.-]{0,220}$/.test(path)
  ) {
    return fail("editablePaths[" + index + "]", "is outside color/typography/radius");
  }
  return path;
}

function modes(value: unknown): readonly ("light" | "dark")[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 2) {
    return fail("allowedModes", "must contain one or two modes");
  }
  const result = value.map((entry, index) => {
    if (entry !== "light" && entry !== "dark") return fail("allowedModes[" + index + "]", "is invalid");
    return entry;
  });
  if (new Set(result).size !== result.length) return fail("allowedModes", "contains duplicate modes");
  return result;
}

function criteria(value: unknown, context: string): readonly string[] {
  return boundedStringArray(
    value,
    context,
    PAIRED_V2_PACKET_LIMITS.maxCriteria,
    context === "acceptanceCriteria"
      ? PAIRED_V2_PACKET_LIMITS.criterionBytes
      : PAIRED_V2_PACKET_LIMITS.prohibitedChangeBytes,
    false
  );
}

function decodeBrief(value: UnknownRecord): PairedV2BriefPacket {
  const fields = [
    "schema",
    "schemaVersion",
    "briefId",
    "title",
    "goal",
    "profileName",
    "profileVersion",
    "sourceProfileSha256",
    "sourceCanonicalDigest",
    "editablePaths",
    "allowedModes",
    "acceptanceCriteria",
    "prohibitedChanges",
    "briefDigest",
  ] as const;
  exact(value, fields, fields, "brief");
  if (value.schema !== "tf-paired-profile-v2-brief" || value.schemaVersion !== 1) {
    return fail("brief", "has an unsupported schema or version");
  }
  if (!Array.isArray(value.editablePaths)) return fail("brief.editablePaths", "must be an array");
  const editablePaths = value.editablePaths.map(editablePath);
  if (editablePaths.length > PAIRED_V2_PACKET_LIMITS.maxEditablePaths) {
    return fail("brief.editablePaths", "exceeds its bound");
  }
  if (new Set(editablePaths).size !== editablePaths.length) return fail("brief.editablePaths", "has duplicates");
  const packet: PairedV2BriefPacket = {
    schema: "tf-paired-profile-v2-brief",
    schemaVersion: 1,
    briefId: stringValue(value.briefId, "brief.briefId", PAIRED_V2_PACKET_LIMITS.briefIdBytes),
    title: stringValue(value.title, "brief.title", PAIRED_V2_PACKET_LIMITS.titleBytes),
    goal: stringValue(value.goal, "brief.goal", PAIRED_V2_PACKET_LIMITS.goalBytes),
    profileName: stringValue(value.profileName, "brief.profileName", 256),
    profileVersion: stringValue(value.profileVersion, "brief.profileVersion", 64),
    sourceProfileSha256: hash(value.sourceProfileSha256, "brief.sourceProfileSha256"),
    sourceCanonicalDigest: hash(value.sourceCanonicalDigest, "brief.sourceCanonicalDigest"),
    editablePaths,
    allowedModes: modes(value.allowedModes),
    acceptanceCriteria: criteria(value.acceptanceCriteria, "acceptanceCriteria"),
    prohibitedChanges: criteria(value.prohibitedChanges, "prohibitedChanges"),
    briefDigest: hash(value.briefDigest, "brief.briefDigest"),
  };
  return readonlyJsonClone(packet);
}

function decodeCandidate(value: UnknownRecord): PairedV2CandidatePacket {
  const fields = [
    "schema",
    "schemaVersion",
    "candidateId",
    "briefDigest",
    "sourceBytesBase64",
    "sourceProfileSha256",
    "sourceCanonicalDigest",
    "rationale",
    "candidateDigest",
  ] as const;
  exact(value, fields, fields, "candidate");
  if (value.schema !== "tf-paired-profile-v2-candidate" || value.schemaVersion !== 1) {
    return fail("candidate", "has an unsupported schema or version");
  }
  const packet: PairedV2CandidatePacket = {
    schema: "tf-paired-profile-v2-candidate",
    schemaVersion: 1,
    candidateId: stringValue(value.candidateId, "candidate.candidateId", PAIRED_V2_PACKET_LIMITS.candidateIdBytes),
    briefDigest: hash(value.briefDigest, "candidate.briefDigest"),
    sourceBytesBase64: base64(value.sourceBytesBase64, "candidate.sourceBytesBase64"),
    sourceProfileSha256: hash(value.sourceProfileSha256, "candidate.sourceProfileSha256"),
    sourceCanonicalDigest: hash(value.sourceCanonicalDigest, "candidate.sourceCanonicalDigest"),
    rationale: stringValue(value.rationale, "candidate.rationale", PAIRED_V2_PACKET_LIMITS.rationaleBytes),
    candidateDigest: hash(value.candidateDigest, "candidate.candidateDigest"),
  };
  return readonlyJsonClone(packet);
}

function disposition(value: unknown, index: number): PairedV2ReviewDispositionRecord {
  const context = "review.dispositions[" + index + "]";
  const object = record(value, context);
  exact(object, ["candidateDigest", "disposition", "comment"], ["candidateDigest", "disposition"], context);
  const kind = object.disposition;
  if (kind !== "approve" && kind !== "revise" && kind !== "reject") {
    return fail(context + ".disposition", "is invalid");
  }
  const comment = Object.prototype.hasOwnProperty.call(object, "comment")
    ? stringValue(object.comment, context + ".comment", PAIRED_V2_PACKET_LIMITS.commentBytes)
    : undefined;
  return {
    candidateDigest: hash(object.candidateDigest, context + ".candidateDigest"),
    disposition: kind,
    ...(comment !== undefined ? { comment } : {}),
  };
}

function decodeReview(value: UnknownRecord): PairedV2ReviewPacket {
  const fields = [
    "schema",
    "schemaVersion",
    "reviewId",
    "briefDigest",
    "candidateDigests",
    "dispositions",
    "overallDisposition",
    "summary",
    "reviewDigest",
  ] as const;
  exact(value, fields, fields, "review");
  if (value.schema !== "tf-paired-profile-v2-review" || value.schemaVersion !== 1) {
    return fail("review", "has an unsupported schema or version");
  }
  const candidateDigests = boundedStringArray(
    value.candidateDigests,
    "review.candidateDigests",
    PAIRED_V2_PACKET_LIMITS.maxCandidates,
    64,
    true
  ).map((digest, index) => hash(digest, "review.candidateDigests[" + index + "]"));
  const rawDispositions = value.dispositions;
  if (!Array.isArray(rawDispositions) || rawDispositions.length !== candidateDigests.length) {
    return fail("review.dispositions", "must contain exactly one disposition per candidate digest");
  }
  const dispositions = rawDispositions.map(disposition);
  const dispositionDigests = dispositions.map((entry) => entry.candidateDigest);
  if (
    new Set(dispositionDigests).size !== dispositionDigests.length ||
    dispositionDigests.some((digest) => !candidateDigests.includes(digest))
  ) {
    return fail("review.dispositions", "has a candidate digest association mismatch");
  }
  const overallDisposition = value.overallDisposition;
  if (overallDisposition !== "approve" && overallDisposition !== "revise" && overallDisposition !== "reject") {
    return fail("review.overallDisposition", "is invalid");
  }
  const packet: PairedV2ReviewPacket = {
    schema: "tf-paired-profile-v2-review",
    schemaVersion: 1,
    reviewId: stringValue(value.reviewId, "review.reviewId", PAIRED_V2_PACKET_LIMITS.reviewIdBytes),
    briefDigest: hash(value.briefDigest, "review.briefDigest"),
    candidateDigests,
    dispositions,
    overallDisposition,
    summary: stringValue(value.summary, "review.summary", PAIRED_V2_PACKET_LIMITS.summaryBytes),
    reviewDigest: hash(value.reviewDigest, "review.reviewDigest"),
  };
  return readonlyJsonClone(packet);
}

export function decodePairedV2Packet(value: unknown): PairedV2Packet {
  if (safeJsonBytes(value, "paired packet") > PAIRED_V2_PACKET_LIMITS.transportBytes) {
    return fail("paired packet", "exceeds its 2 MiB transport budget");
  }
  const safeValue = readonlyJsonClone(value);
  const object = record(safeValue, "paired packet");
  if (object.schema === "tf-paired-profile-v2-brief") return decodeBrief(object);
  if (object.schema === "tf-paired-profile-v2-candidate") return decodeCandidate(object);
  if (object.schema === "tf-paired-profile-v2-review") return decodeReview(object);
  return fail("paired packet.schema", "is not one of the three supported paired kinds");
}

export function parsePairedV2PacketJson(json: string): PairedV2Packet {
  if (typeof json !== "string" || bytes(json) > PAIRED_V2_PACKET_LIMITS.transportBytes) {
    return fail("paired packet JSON", "exceeds its 2 MiB transport budget");
  }
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return fail("paired packet JSON", "is not valid JSON");
  }
  return decodePairedV2Packet(value);
}

export function decodePairedV2NativePacketEnvelope(value: unknown): PairedV2NativePacketEnvelope {
  let safeValue: unknown;
  try {
    safeValue = readonlyJsonClone(value);
  } catch {
    return fail("native packet envelope", "must contain bounded JSON data");
  }
  const object = record(safeValue, "native packet envelope");
  exact(
    object,
    ["kind", "canonicalJson", "digest", "packetDigestVerified", "packet"],
    ["kind", "canonicalJson", "digest", "packetDigestVerified", "packet"],
    "native packet envelope"
  );
  const kind = object.kind;
  if (!PAIRED_V2_PACKET_KINDS.includes(kind as PairedV2PacketKind)) {
    return fail("native packet envelope.kind", "is invalid");
  }
  const packetKind = kind as PairedV2PacketKind;
  if (object.packetDigestVerified !== true) {
    return fail("native packet envelope.packetDigestVerified", "must be the literal true");
  }
  const canonicalJson = stringValue(
    object.canonicalJson,
    "native packet envelope.canonicalJson",
    PAIRED_V2_PACKET_LIMITS.transportBytes
  );
  const digest = hash(object.digest, "native packet envelope.digest");
  const packet = decodePairedV2Packet(object.packet);
  if (packet.schema !== packetKind) return fail("native packet envelope", "kind does not match packet schema");
  const ownDigest = packet.schema === "tf-paired-profile-v2-brief"
    ? packet.briefDigest
    : packet.schema === "tf-paired-profile-v2-candidate"
      ? packet.candidateDigest
      : packet.reviewDigest;
  if (digest !== ownDigest) return fail("native packet envelope", "digest does not match packet self-digest");

  let canonicalValue: unknown;
  try {
    canonicalValue = JSON.parse(canonicalJson);
  } catch {
    return fail("native packet envelope.canonicalJson", "must contain valid JSON");
  }
  if (!structurallyEqual(canonicalValue, packet)) {
    return fail("native packet envelope", "canonicalJson does not structurally match packet");
  }

  return readonlyJsonClone({
    kind: packetKind,
    canonicalJson,
    digest,
    packetDigestVerified: true as const,
    packet,
  }) as PairedV2NativePacketEnvelope;
}

function structurallyEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    return left.every((entry, index) => structurallyEqual(entry, right[index]));
  }
  if (
    typeof left !== "object" || left === null ||
    typeof right !== "object" || right === null
  ) return false;
  const leftKeys = Object.keys(left as Record<string, unknown>);
  const rightKeys = Object.keys(right as Record<string, unknown>);
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every((key) =>
    Object.prototype.hasOwnProperty.call(right, key) &&
    structurallyEqual(
      (left as Record<string, unknown>)[key],
      (right as Record<string, unknown>)[key]
    )
  );
}

export function validatePairedV2PacketAssociations(
  brief: PairedV2BriefPacket,
  candidates: readonly PairedV2CandidatePacket[],
  review: PairedV2ReviewPacket
): void {
  if (review.briefDigest !== brief.briefDigest) fail("packet associations", "review does not reference the brief");
  const candidateDigests = candidates.map((candidate) => {
    if (candidate.briefDigest !== brief.briefDigest) {
      fail("packet associations", "candidate does not reference the brief");
    }
    return candidate.candidateDigest;
  });
  if (
    new Set(candidateDigests).size !== candidateDigests.length ||
    candidateDigests.length !== review.candidateDigests.length ||
    candidateDigests.some((digest) => !review.candidateDigests.includes(digest)) ||
    review.candidateDigests.some((digest) => !candidateDigests.includes(digest))
  ) {
    fail("packet associations", "candidate digest association mismatch");
  }
}

export { PairedV2ValidationError };
