import {
  ILLUSTRATION_FIXED_FACTS, ILLUSTRATION_STEPS,
  REQUIRED_LEGACY_RUST_TESTS, REQUIRED_LEGACY_POLICY_TESTS,
  REQUIRED_ILLUSTRATION_RUST_TESTS, REQUIRED_SCENE_INVENTORY_TESTS,
  buildIllustrationEvidence,
} from "./illustration-orchestration.mjs";
export const gates = names => ({status:"passed-process-observation",expected:names.length,passed:names.length,failed:0,
  tests:names.map(name=>({name,passed:1,failed:0}))});
export function illustrationFixture(executableSha256="a".repeat(64)) {
 return buildIllustrationEvidence({
  requiredRustTests:gates(REQUIRED_LEGACY_RUST_TESTS),requiredPolicyTests:gates(REQUIRED_LEGACY_POLICY_TESTS),
  additionalRustTests:gates(REQUIRED_ILLUSTRATION_RUST_TESTS),sceneInventoryTests:gates(REQUIRED_SCENE_INVENTORY_TESTS),
  legacyRealUserState:{method:"fixed-app-namespace-absence-metadata",locations:63,observations:7,status:"passed"},
  runs:["raw-archive","npm-package"].map((source,index)=>({source,receiptSha256:String(index+1).repeat(64),executableSha256,
   steps:ILLUSTRATION_STEPS.map(x=>x.id),facts:ILLUSTRATION_FIXED_FACTS.map(x=>[...x]),
   namespaceBefore:{locations:63,changed:0},namespaceAfter:{locations:63,changed:0}})),
 });
}
