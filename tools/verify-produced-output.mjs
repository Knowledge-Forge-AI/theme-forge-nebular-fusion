import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { candidateProvenance, inventoryTree, identity } from "./candidate-provenance.mjs";
import { targetForTriple } from "./platform-targets.mjs";

// Integrity check inside the externally selected source derivation's output.
// This does not grant publication authority or accept an arbitrary producer.
export async function verifyProducedOutput(root, system) {
  const directory = join(root, "share/nebular");
  const json = async name => JSON.parse(await readFile(join(directory, name + ".json"), "utf8"));
  const [receipt, provenance, manifest] = await Promise.all([
    json("build-receipt"), json("candidate-provenance"), json("native-payload"),
  ]);
  if (targetForTriple(receipt.target).system !== system || receipt.mode !== "nix-source") throw new Error("Produced target or mode mismatch");
  const expected = candidateProvenance(provenance.source, receipt);
  if (identity(expected) !== identity(provenance)) throw new Error("Produced provenance mismatch");
  const actual = await inventoryTree(join(directory, "native"));
  if (actual.identity !== receipt.nativePayload || identity(actual) !== identity(manifest)) throw new Error("Produced payload mismatch");
  return { sourceCandidate: provenance.source.identity, buildReceipt: receipt.identity, nativePayload: actual.identity };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length !== 4) throw new Error("Expected package-root system");
  console.log(JSON.stringify(await verifyProducedOutput(resolve(process.argv[2]), process.argv[3])));
}
