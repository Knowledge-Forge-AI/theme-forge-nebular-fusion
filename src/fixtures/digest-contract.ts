import type {
  CandidateEvidence,
  CandidateGeometryIdentity,
  CandidateReviewFixture,
  RenderBackground,
  RenderThumbnail,
} from "../protocol/contracts";

const REQUIRED_BACKGROUNDS = ["light", "dark", "transparent"] as const;
const GEOMETRIES = new Set<CandidateGeometryIdentity>(["nova-orbit-v1", "nova-pulse-v1"]);
const ACCENTS = new Set(["#4b2ee8", "#8f7cff", "#ff4f9a", "#652ee8", "#aa7cff", "#ff6a4f"]);
const SHA256 = /^sha256:[0-9a-f]{64}$/;
const KEBAB_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

class FixtureValidationError extends Error {
  constructor() {
    super("Studio candidate-review fixture is invalid");
    this.name = "FixtureValidationError";
  }
}

function exactRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new FixtureValidationError();
  const record = value as Record<string, unknown>;
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new FixtureValidationError();
  }
  return record;
}

function boundedString(value: unknown, maximumBytes: number, pattern?: RegExp): string {
  if (typeof value !== "string" || value.length === 0 || new TextEncoder().encode(value).length > maximumBytes) {
    throw new FixtureValidationError();
  }
  if (pattern && !pattern.test(value)) throw new FixtureValidationError();
  return value;
}

function boundedStringArray(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 8) throw new FixtureValidationError();
  return value.map((entry) => boundedString(entry, 200));
}

function nonNegativeCount(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > 10_000) {
    throw new FixtureValidationError();
  }
  return value as number;
}

function parseRender(value: unknown, geometry: CandidateGeometryIdentity): RenderThumbnail {
  const record = exactRecord(value, ["accent", "background", "renderIdentity"]);
  if (!REQUIRED_BACKGROUNDS.includes(record.background as RenderBackground)) throw new FixtureValidationError();
  const background = record.background as RenderBackground;
  const accent = boundedString(record.accent, 7, /^#[0-9a-f]{6}$/);
  if (!ACCENTS.has(accent)) throw new FixtureValidationError();
  const renderIdentity = boundedString(record.renderIdentity, 96);
  if (renderIdentity !== `${geometry}:${background}`) throw new FixtureValidationError();
  return { background, accent, renderIdentity };
}

function parseCandidate(value: unknown): CandidateEvidence {
  const record = exactRecord(value, [
    "accessibilityFindings", "candidateDigest", "evidenceDigest", "geometry", "id", "name",
    "paletteFindings", "pixelSummary", "qa", "renders", "semanticSummary", "target",
  ]);
  const geometry = boundedString(record.geometry, 32) as CandidateGeometryIdentity;
  if (!GEOMETRIES.has(geometry)) throw new FixtureValidationError();
  const qa = exactRecord(record.qa, ["fail", "pass", "unavailable"]);
  if (!Array.isArray(record.renders) || record.renders.length !== 3) throw new FixtureValidationError();
  const renders = record.renders.map((render) => parseRender(render, geometry));
  const backgrounds = renders.map((render) => render.background);
  if (new Set(backgrounds).size !== 3 || REQUIRED_BACKGROUNDS.some((entry) => !backgrounds.includes(entry))) {
    throw new FixtureValidationError();
  }
  const candidateDigest = boundedString(record.candidateDigest, 71, SHA256);
  const evidenceDigest = boundedString(record.evidenceDigest, 71, SHA256);
  return {
    id: boundedString(record.id, 64, KEBAB_ID),
    name: boundedString(record.name, 80),
    target: boundedString(record.target, 256),
    semanticSummary: boundedString(record.semanticSummary, 512),
    pixelSummary: boundedString(record.pixelSummary, 512),
    geometry,
    qa: {
      pass: nonNegativeCount(qa.pass),
      fail: nonNegativeCount(qa.fail),
      unavailable: nonNegativeCount(qa.unavailable),
    },
    accessibilityFindings: boundedStringArray(record.accessibilityFindings),
    paletteFindings: boundedStringArray(record.paletteFindings),
    candidateDigest,
    evidenceDigest,
    renders,
  };
}

async function sha256(canonicalJson: string): Promise<string> {
  if (!globalThis.crypto?.subtle) throw new FixtureValidationError();
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalJson));
  return `sha256:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

// JSON property order below is the contract. Arrays retain declared order;
// protocol identities are always 1.0 then 1.1 and render tuples are light,
// dark, then transparent.
export async function computeCandidateDigest(candidate: CandidateEvidence): Promise<string> {
  return sha256(JSON.stringify({
    contract: "tfsb-studio-fixture-candidate-v1",
    id: candidate.id,
    target: candidate.target,
    semanticSummary: candidate.semanticSummary,
    geometry: candidate.geometry,
  }));
}

export async function computeEvidenceDigest(
  candidate: CandidateEvidence,
  protocolInventoryDigests: Readonly<Record<"1.0" | "1.1", string>>,
): Promise<string> {
  return sha256(JSON.stringify({
    contract: "tfsb-studio-fixture-evidence-v1",
    candidateDigest: candidate.candidateDigest,
    renderTuples: candidate.renders.map(({ background, accent, renderIdentity }) => ({
      background,
      accent,
      renderIdentity,
    })),
    pixelSummary: candidate.pixelSummary,
    qa: {
      pass: candidate.qa.pass,
      fail: candidate.qa.fail,
      unavailable: candidate.qa.unavailable,
    },
    accessibilityFindings: candidate.accessibilityFindings,
    paletteFindings: candidate.paletteFindings,
    protocolInventory: [
      { version: "1.0", digest: protocolInventoryDigests["1.0"] },
      { version: "1.1", digest: protocolInventoryDigests["1.1"] },
    ],
  }));
}

export async function validateCandidateReviewFixture(value: unknown): Promise<CandidateReviewFixture> {
  const record = exactRecord(value, ["brand", "candidates", "fixtureId", "project", "protocolInventoryDigests", "schemaVersion"]);
  if (record.schemaVersion !== 1 || !Array.isArray(record.candidates) || record.candidates.length !== 2) {
    throw new FixtureValidationError();
  }
  const protocol = exactRecord(record.protocolInventoryDigests, ["1.0", "1.1"]);
  const protocolInventoryDigests = {
    "1.0": boundedString(protocol["1.0"], 71, SHA256),
    "1.1": boundedString(protocol["1.1"], 71, SHA256),
  } as const;
  const candidates = [parseCandidate(record.candidates[0]), parseCandidate(record.candidates[1])] as const;
  if (new Set(candidates.map((candidate) => candidate.id)).size !== candidates.length) throw new FixtureValidationError();
  for (const candidate of candidates) {
    if (candidate.candidateDigest !== await computeCandidateDigest(candidate)) throw new FixtureValidationError();
    if (candidate.evidenceDigest !== await computeEvidenceDigest(candidate, protocolInventoryDigests)) throw new FixtureValidationError();
  }
  return {
    schemaVersion: 1,
    fixtureId: boundedString(record.fixtureId, 96),
    project: boundedString(record.project, 160),
    brand: boundedString(record.brand, 80),
    protocolInventoryDigests,
    candidates,
  };
}
