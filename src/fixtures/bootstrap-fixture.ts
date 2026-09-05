import { validateCandidateReviewFixture } from "./digest-contract";

export const candidateReviewFixtureInput: unknown = {
  schemaVersion: 1,
  fixtureId: "studio-candidate-review-v1",
  project: "Terminal Nova synthetic public fixture",
  brand: "Terminal Nova",
  protocolInventoryDigests: {
    "1.0": "sha256:96fdbcf0c56c1890d44363c34c80d8dacfccb37196de8050ab2d1afc7a3e0f70",
    "1.1": "sha256:9d58e954e62169e87648814372a381653e9e69df5a0ce722251e6e46951dfe8a",
  },
  candidates: [
    {
      id: "nova-orbit",
      name: "Nova Orbit",
      target: "terminal-nova / mark / primary-light",
      semanticSummary: "Tightens the starburst aperture and preserves the canonical family binding.",
      pixelSummary: "2.8% changed pixels at 128 px; no clipping at the tested sizes.",
      geometry: "nova-orbit-v1",
      qa: { pass: 12, fail: 0, unavailable: 2 },
      accessibilityFindings: ["Accessible name retained", "Small-size silhouette remains distinct"],
      paletteFindings: ["Uses only primary-violet and signal-pink fixture tokens"],
      candidateDigest: "sha256:e226001c046d92f1a5846f21b0c523cdc74d20b8911d49ad9636475c82451173",
      evidenceDigest: "sha256:ce780565bd9e6617e7e6507fb7b48e8b18a034b72cb9555eed15eb63f6f193ac",
      renders: [
        { background: "light", accent: "#4b2ee8", renderIdentity: "nova-orbit-v1:light" },
        { background: "dark", accent: "#8f7cff", renderIdentity: "nova-orbit-v1:dark" },
        { background: "transparent", accent: "#ff4f9a", renderIdentity: "nova-orbit-v1:transparent" },
      ],
    },
    {
      id: "nova-pulse",
      name: "Nova Pulse",
      target: "terminal-nova / mark / primary-light",
      semanticSummary: "Widens the center pulse while leaving recipe and role identities unchanged.",
      pixelSummary: "4.1% changed pixels at 128 px; one low-contrast fixture finding remains.",
      geometry: "nova-pulse-v1",
      qa: { pass: 10, fail: 1, unavailable: 3 },
      accessibilityFindings: ["Accessible name retained", "Dark-background contrast needs review"],
      paletteFindings: ["One accent reaches the fixture contrast warning threshold"],
      candidateDigest: "sha256:11877d46243e7849535301f2b67a93f1deebbe0aabe37a2c7bf996dee8e4bb06",
      evidenceDigest: "sha256:ff3f0c510dc559fdfe72d80b54fbd734e30fdbe47052a5124891ac5c4cc2efb9",
      renders: [
        { background: "light", accent: "#652ee8", renderIdentity: "nova-pulse-v1:light" },
        { background: "dark", accent: "#aa7cff", renderIdentity: "nova-pulse-v1:dark" },
        { background: "transparent", accent: "#ff6a4f", renderIdentity: "nova-pulse-v1:transparent" },
      ],
    },
  ],
};

export function loadCandidateReviewFixture() {
  return validateCandidateReviewFixture(candidateReviewFixtureInput);
}
