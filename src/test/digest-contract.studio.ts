// @vitest-environment node
import { candidateReviewFixtureInput, loadCandidateReviewFixture } from "../fixtures/bootstrap-fixture";
import { validateCandidateReviewFixture } from "../fixtures/digest-contract";

function cloneInput(): Record<string, unknown> {
  const value = structuredClone(candidateReviewFixtureInput);
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("fixture root is unavailable");
  return value as Record<string, unknown>;
}

function candidate(record: Record<string, unknown>, index: number): Record<string, unknown> {
  const candidates = record.candidates;
  if (!Array.isArray(candidates)) throw new Error("fixture candidates are unavailable");
  const value = candidates[index];
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("fixture candidate is unavailable");
  return value as Record<string, unknown>;
}

describe("canonical Studio fixture digest contract", () => {
  it("matches authoritative candidate and evidence vectors", async () => {
    const fixture = await loadCandidateReviewFixture();
    expect(fixture.candidates.map(({ candidateDigest, evidenceDigest }) => ({ candidateDigest, evidenceDigest }))).toEqual([
      {
        candidateDigest: "sha256:e226001c046d92f1a5846f21b0c523cdc74d20b8911d49ad9636475c82451173",
        evidenceDigest: "sha256:ce780565bd9e6617e7e6507fb7b48e8b18a034b72cb9555eed15eb63f6f193ac",
      },
      {
        candidateDigest: "sha256:11877d46243e7849535301f2b67a93f1deebbe0aabe37a2c7bf996dee8e4bb06",
        evidenceDigest: "sha256:ff3f0c510dc559fdfe72d80b54fbd734e30fdbe47052a5124891ac5c4cc2efb9",
      },
    ]);
  });

  it.each([
    ["geometry", (root: Record<string, unknown>) => { candidate(root, 0).geometry = "nova-pulse-v1"; }],
    ["target", (root: Record<string, unknown>) => { candidate(root, 0).target = "changed target"; }],
    ["qa", (root: Record<string, unknown>) => {
      const qa = candidate(root, 0).qa;
      if (typeof qa !== "object" || qa === null || Array.isArray(qa)) throw new Error("qa unavailable");
      (qa as Record<string, unknown>).pass = 13;
    }],
    ["findings", (root: Record<string, unknown>) => { candidate(root, 0).paletteFindings = ["changed finding"]; }],
    ["render tuple", (root: Record<string, unknown>) => {
      const renders = candidate(root, 0).renders;
      if (!Array.isArray(renders) || typeof renders[0] !== "object" || renders[0] === null) throw new Error("renders unavailable");
      (renders[0] as Record<string, unknown>).accent = "#652ee8";
    }],
  ])("rejects %s drift against the embedded vectors", async (_label, mutate) => {
    const root = cloneInput();
    mutate(root);
    await expect(validateCandidateReviewFixture(root)).rejects.toThrow("fixture is invalid");
  });

  it.each([
    ["duplicate candidate IDs", (root: Record<string, unknown>) => { candidate(root, 1).id = candidate(root, 0).id; }],
    ["duplicate backgrounds", (root: Record<string, unknown>) => {
      const renders = candidate(root, 0).renders;
      if (!Array.isArray(renders) || typeof renders[1] !== "object" || renders[1] === null) throw new Error("renders unavailable");
      const first = renders[0] as Record<string, unknown>;
      const second = renders[1] as Record<string, unknown>;
      second.background = first.background;
      second.renderIdentity = "nova-orbit-v1:light";
    }],
    ["missing backgrounds", (root: Record<string, unknown>) => { candidate(root, 0).renders = []; }],
    ["invalid SHA-256", (root: Record<string, unknown>) => { candidate(root, 0).candidateDigest = "sha256:no"; }],
    ["negative counts", (root: Record<string, unknown>) => {
      const qa = candidate(root, 0).qa as Record<string, unknown>;
      qa.fail = -1;
    }],
    ["unbounded strings", (root: Record<string, unknown>) => { candidate(root, 0).target = "x".repeat(257); }],
  ])("rejects %s", async (_label, mutate) => {
    const root = cloneInput();
    mutate(root);
    await expect(validateCandidateReviewFixture(root)).rejects.toThrow("fixture is invalid");
  });
});
