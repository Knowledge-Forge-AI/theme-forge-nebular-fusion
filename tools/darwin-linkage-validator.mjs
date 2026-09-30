// Maintained dynamic linkage validator for Darwin and Linux binaries.
import { spawnSync } from "node:child_process";
import { lstatSync, realpathSync } from "node:fs";

export const PERMITTED_DARWIN_PREFIXES = Object.freeze([
  "/usr/lib/",
  "/System/Library/",
  "@rpath/",
  "@loader_path/",
  "@executable_path/",
]);

export const FORBIDDEN_DARWIN_PREFIXES = Object.freeze([
  "/nix/store/",
  "/nix/store",
  "/Users/",
  "/home/",
  "/private/tmp/",
  "/private/var/",
  "/tmp/",
  "/var/tmp/",
  "/opt/homebrew/",
  "/usr/local/",
  "/opt/local/",
]);

/**
 * Validates dynamic linkage of a Darwin Mach-O binary via `otool -L`.
 * @param {string} binaryPath - Path to the executable or dylib.
 * @param {object} [options]
 * @param {boolean} [options.failOnError=false] - Whether to throw an error if violations are found.
 * @returns {{ status: "pass" | "fail", dependencies: string[], violations: string[] }}
 */
export function validateDarwinLinkage(binaryPath, options = {}) {
  const stat = lstatSync(binaryPath);
  if (!stat.isFile()) {
    throw new Error(`Target is not a regular file: ${binaryPath}`);
  }

  const runner = options.runner || spawnSync;
  const result = runner("otool", ["-L", binaryPath], {
    encoding: "utf8",
    env: { LANG: "C", LC_ALL: "C" },
    timeout: 15_000,
  });

  if (result.status !== 0 || result.error) {
    const msg = result.error ? result.error.message : result.stderr;
    throw new Error(`otool -L failed on ${binaryPath}: ${msg}`);
  }

  const lines = result.stdout.trim().split("\n");
  const dependencies = [];
  const rpaths = [];
  const violations = [];

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i].trim();
    if (!raw || raw.endsWith(":")) {
      // First line is binary heading: e.g. "path/to/binary:"
      continue;
    }
    // Format: "/path/to/lib.dylib (compatibility version 1.0.0, current version 1.0.0)"
    const match = raw.match(/^(.+?)(?:\s+\(compatibility version .*\))?$/);
    const dep = match ? match[1].trim() : raw.trim();
    if (dep) {
      dependencies.push(dep);
      // Check for forbidden prefixes
      const isForbidden = FORBIDDEN_DARWIN_PREFIXES.some(prefix => dep.startsWith(prefix));
      const isPermitted = PERMITTED_DARWIN_PREFIXES.some(prefix => dep.startsWith(prefix));

      if (isForbidden || !isPermitted) {
        violations.push(dep);
      }
    }
  }

  // Inspect LC_RPATH load commands via otool -l
  const lResult = runner("otool", ["-l", binaryPath], {
    encoding: "utf8",
    env: { LANG: "C", LC_ALL: "C" },
    timeout: 15_000,
  });

  if (lResult.status === 0 && lResult.stdout) {
    const lLines = lResult.stdout.split("\n");
    for (let i = 0; i < lLines.length; i++) {
      if (lLines[i].includes("cmd LC_RPATH")) {
        for (let j = i + 1; j < Math.min(i + 5, lLines.length); j++) {
          const pathMatch = lLines[j].match(/^\s*path\s+(.+?)\s+\(offset\s+\d+\)/);
          if (pathMatch) {
            const rpath = pathMatch[1].trim();
            rpaths.push(rpath);
            const isForbidden = FORBIDDEN_DARWIN_PREFIXES.some(prefix => rpath.startsWith(prefix));
            if (isForbidden) {
              violations.push(`LC_RPATH: ${rpath}`);
            }
            break;
          }
        }
      }
    }
  }

  const status = violations.length === 0 ? "pass" : "fail";
  if (status === "fail" && options.failOnError) {
    throw new Error(`Darwin binary ${binaryPath} has ${violations.length} prohibited dynamic dependencies:\n  ${violations.join("\n  ")}`);
  }

  return {
    status,
    valid: status === "pass",
    dependencies,
    rpaths,
    violations,
  };
}

/**
 * Validates dynamic linkage of a Linux ELF binary via `readelf -d` or `objdump -p`.
 * @param {string} binaryPath - Path to the ELF executable.
 * @param {object} [options]
 * @param {boolean} [options.failOnError=false]
 * @returns {{ status: "pass" | "fail", needed: string[], rpaths: string[], violations: string[] }}
 */
export function validateLinuxLinkage(binaryPath, options = {}) {
  const stat = lstatSync(binaryPath);
  if (!stat.isFile()) {
    throw new Error(`Target is not a regular file: ${binaryPath}`);
  }

  // Try readelf first, then objdump
  let result = spawnSync("readelf", ["-d", binaryPath], {
    encoding: "utf8",
    env: { LANG: "C", LC_ALL: "C" },
    timeout: 15_000,
  });

  const needed = [];
  const rpaths = [];
  const violations = [];

  if (result.status === 0) {
    const lines = result.stdout.split("\n");
    for (const line of lines) {
      const neededMatch = line.match(/\(NEEDED\)\s+Shared library:\s+\[([^\]]+)\]/);
      if (neededMatch) needed.push(neededMatch[1]);
      const rpathMatch = line.match(/\((?:RPATH|RUNPATH)\)\s+Library (?:rpath|runpath):\s+\[([^\]]+)\]/);
      if (rpathMatch) {
        const parts = rpathMatch[1].split(":");
        rpaths.push(...parts);
      }
    }
  } else {
    // Fall back to objdump
    result = spawnSync("objdump", ["-p", binaryPath], {
      encoding: "utf8",
      env: { LANG: "C", LC_ALL: "C" },
      timeout: 15_000,
    });
    if (result.status === 0) {
      const lines = result.stdout.split("\n");
      for (const line of lines) {
        const neededMatch = line.match(/\bNEEDED\s+([^\s]+)/);
        if (neededMatch) needed.push(neededMatch[1]);
        const rpathMatch = line.match(/\b(?:RPATH|RUNPATH)\s+([^\s]+)/);
        if (rpathMatch) {
          const parts = rpathMatch[1].split(":");
          rpaths.push(...parts);
        }
      }
    }
  }

  // Check RPATHs and libraries for Nix or private host prefixes
  const forbidden = ["/nix/store", "/Users/", "/home/", "/tmp/", "/var/tmp/"];
  for (const rpath of rpaths) {
    if (forbidden.some(f => rpath.startsWith(f))) {
      violations.push(`RPATH: ${rpath}`);
    }
  }
  for (const lib of needed) {
    if (forbidden.some(f => lib.startsWith(f))) {
      violations.push(`NEEDED: ${lib}`);
    }
  }

  const status = violations.length === 0 ? "pass" : "fail";
  if (status === "fail" && options.failOnError) {
    throw new Error(`Linux binary ${binaryPath} has ${violations.length} prohibited dynamic dependencies:\n  ${violations.join("\n  ")}`);
  }

  return {
    status,
    valid: status === "pass",
    needed,
    rpaths,
    violations,
  };
}
