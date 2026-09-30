import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, copyFile, access, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

const repository = fileURLToPath(new URL("../../../", import.meta.url));
const membershipPath = join(repository, "tools/public-composition/product-membership.json");
test("public source without git or generated preseed identifies its first external prerequisite", { skip: !existsSync(membershipPath) }, async () => {
  const scratch = await mkdtemp(join(tmpdir(), "nebular clean public source "));
  try {
    const membership = JSON.parse(await readFile(membershipPath, "utf8"));
    for (const member of membership.products.nebularFusion.members) {
      const destination = join(scratch, member.destination);
      await mkdir(dirname(destination), { recursive: true });
      await copyFile(join(repository, member.source), destination);
    }
    for (const path of [".git", "node_modules", "src-tauri/sidecar-payload", "src-tauri/scene-payload", "src-tauri/binaries"]) {
      await assert.rejects(access(join(scratch, path)));
    }
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(TFSB_STUDIO_|TFSL_|TFSS_|SCENE_)/.test(key)));
    const result = spawnSync(process.execPath, ["tools/prepare-app-resources.mjs"], { cwd: scratch, env, encoding: "utf8", timeout: 10000 });
    assert.equal(result.status, 1);
    assert.equal(result.stderr.trim(), "FATAL: [PREPARE_APP_RESOURCES_FAIL] Missing authenticated Node runtime: TFSB_STUDIO_NODE_BINARY");
    assert.equal(existsSync(join(scratch, "src-tauri/sidecar-payload")), false);
  } finally { await rm(scratch, { recursive: true, force: true }); }
});
