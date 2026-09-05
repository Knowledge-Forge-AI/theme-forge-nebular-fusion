import { readFileSync } from "node:fs";
import {
  validateBrandStatus, validateConsumerLockStatus, validateConsumerProfilePage,
  validateExportCapability, validateExportStatusPage, validateFamilyPage,
  validateQaProfile, validateQaProfilePage, validateQaResult, validateRecipeGraph,
  validateSemanticDiff, validateTokenPage,
} from "../brand-read/validators";

const examples = JSON.parse(readFileSync("protocol/tfsb-studio-v1/examples/1.2/results.json", "utf8")) as Record<string, unknown>;
const vectors = [
  ["brand.status", "status", validateBrandStatus],
  ["brand.family.list", "family-page", validateFamilyPage],
  ["brand.token.list", "token-page", validateTokenPage],
  ["brand.recipe.graph", "recipe-graph", validateRecipeGraph],
  ["brand.qa.profile.list", "qa-profile-page", validateQaProfilePage],
  ["brand.qa.profile.get", "qa-profile", validateQaProfile],
  ["brand.qa.result.get", "qa-result", validateQaResult],
  ["brand.diff", "semantic-diff", validateSemanticDiff],
  ["brand.consumer.profile.list", "consumer-profile-page", validateConsumerProfilePage],
  ["brand.consumer.lock.status", "consumer-lock-status", validateConsumerLockStatus],
  ["brand.export.capability", "export-capability", validateExportCapability],
  ["brand.export.status", "export-status-page", validateExportStatusPage],
] as const;

describe("method-specific brand read validators", () => {
  it.each(vectors)("accepts the canonical %s result", (method, kind, validate) => {
    expect(validate({ kind, data: structuredClone(examples[method]) })).toBeTruthy();
  });

  it.each(vectors)("rejects an extra top-level field for %s", (method, kind, validate) => {
    const data = structuredClone(examples[method]) as Record<string, unknown>; data.requestId = "private";
    expect(() => validate({ kind, data })).toThrow();
  });

  it.each(vectors)("rejects a missing top-level field for %s", (method, kind, validate) => {
    const data = structuredClone(examples[method]) as Record<string, unknown>; delete data[Object.keys(data)[0] as string];
    expect(() => validate({ kind, data })).toThrow();
  });

  it.each(vectors)("rejects the wrong tagged result for %s", (method, _kind, validate) => {
    expect(() => validate({ kind: "wrong-kind", data: structuredClone(examples[method]) })).toThrow();
  });

  it.each(vectors)("rejects a wrong top-level field type for %s", (method, kind, validate) => {
    const data = structuredClone(examples[method]) as Record<string, unknown>;
    data[Object.keys(data)[0] as string] = null;
    expect(() => validate({ kind, data })).toThrow();
  });

  it.each([
    ["brand.family.list", "family-page", validateFamilyPage],
    ["brand.token.list", "token-page", validateTokenPage],
    ["brand.qa.profile.list", "qa-profile-page", validateQaProfilePage],
    ["brand.consumer.profile.list", "consumer-profile-page", validateConsumerProfilePage],
    ["brand.export.status", "export-status-page", validateExportStatusPage],
  ] as const)("rejects an out-of-bound page for %s", (method, kind, validate) => {
    const data = structuredClone(examples[method]) as { page: { size: number } };
    data.page.size = 0;
    expect(() => validate({ kind, data })).toThrow();
  });
});
