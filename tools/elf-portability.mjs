import { createHash } from "node:crypto";
import { parseElfMetadata } from "./native-runtime.mjs";

export const ELF_PORTABILITY_OBSERVATION_SCHEMA = "nebular-native-elf-portability-observation-v1";
export const ELF_PORTABILITY_READELF_ARGS = ["-h", "-l", "-d", "-V", "-n", "-A", "--wide"];

const SHA256_RE = /^[0-9a-f]{64}$/u;
const X86_ISA_LABELS = new Set(["x86-64-baseline", "x86-64-v2", "x86-64-v3", "x86-64-v4"]);

/**
 * @param {string[]} values
 * @returns {string[]}
 */
function uniqueSorted(values) {
  return [...new Set(values)].sort();
}

/**
 * @param {string} value
 * @param {string} label
 * @returns {string}
 */
function validateRelativePath(value, label) {
  if (typeof value !== "string" || !value || value !== value.normalize("NFC") || value.includes("\0") || value.includes("\\") || value.startsWith("/")) {
    throw new Error(`${label} must be a canonical relative path`);
  }
  if (value.split("/").some(part => !part || part === "." || part === "..")) {
    throw new Error(`${label} must not contain empty, dot, or dotdot path segments`);
  }
  return value;
}

/**
 * @param {string[]} lines
 * @returns {string[]}
 */
function parseIsaValues(lines) {
  return uniqueSorted(lines.flatMap(line => {
    const prefix = line.split(/,\s*x86 feature:/iu, 1)[0] ?? "";
    return prefix.split(",").map(value => value.trim()).filter(Boolean);
  }));
}

/**
 * @param {string} readelfText
 * @param {RegExp} pattern
 * @returns {string[]}
 */
function nonEmptyLines(readelfText, pattern) {
  return readelfText
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => pattern.test(line));
}

/**
 * @param {string} readelfText
 * @param {RegExp} pattern
 * @returns {string[]}
 */
function captureValues(readelfText, pattern) {
  return readelfText
    .split(/\r?\n/u)
    .flatMap((line) => {
      const match = line.match(pattern);
      return match?.[1]?.trim() ? [match[1].trim()] : [];
    });
}

/**
 * @param {string} readelfText
 * @returns {{ status: "present" | "absent" | "unknown", noteSections: string[], propertyLines: string[], x86IsaNeeded: { status: "known" | "unknown", values: string[], levels: string[] }, x86IsaUsed: { status: "known" | "unknown", values: string[], levels: string[] }, x86Features: { status: "known" | "unknown", values: string[] }, aarch64Features: { status: "known" | "unknown", values: string[] } }}
 */
function noteObservation(readelfText) {
  const noteSections = captureValues(readelfText, /^Displaying notes found in:\s*(\S+)/u);
  const propertyLines = nonEmptyLines(readelfText, /(?:Properties:|NT_GNU_PROPERTY_TYPE_0|x86 ISA needed:|x86 feature:|AArch64 feature:)/iu);
  const hasPropertySection = noteSections.includes(".note.gnu.property") || propertyLines.length > 0;
  const hasExplicitNoNotes = /\bNo note sections?\b|\bNo notes\b/iu.test(readelfText);
  const status = hasPropertySection ? "present" : noteSections.length > 0 || hasExplicitNoNotes ? "absent" : "unknown";

  const x86IsaValues = parseIsaValues(captureValues(readelfText, /x86 ISA needed:\s*(.+)$/iu));
  const x86IsaUsedValues = parseIsaValues(captureValues(readelfText, /x86 ISA used:\s*(.+)$/iu));
  const recognizedX86Isa = x86IsaValues.filter((value) => X86_ISA_LABELS.has(value.toLowerCase())).map((value) => value.toLowerCase());
  const unknownX86Isa = x86IsaValues.filter((value) => !X86_ISA_LABELS.has(value.toLowerCase()));
  const recognizedX86IsaUsed = x86IsaUsedValues.filter((value) => X86_ISA_LABELS.has(value.toLowerCase())).map((value) => value.toLowerCase());
  const unknownX86IsaUsed = x86IsaUsedValues.filter((value) => !X86_ISA_LABELS.has(value.toLowerCase()));

  const x86Features = uniqueSorted(captureValues(readelfText, /x86 feature:\s*(.+)$/iu).flatMap((line) => line.split(",").map((value) => value.trim()).filter(Boolean)));
  const aarch64Features = uniqueSorted(captureValues(readelfText, /AArch64 feature:\s*(.+)$/iu).flatMap((line) => line.split(",").map((value) => value.trim()).filter(Boolean)));

  return {
    status,
    noteSections: uniqueSorted(noteSections),
    propertyLines,
    x86IsaNeeded: {
      status: x86IsaValues.length > 0 && unknownX86Isa.length === 0 ? "known" : "unknown",
      values: x86IsaValues,
      levels: uniqueSorted(recognizedX86Isa),
    },
    x86IsaUsed: {
      status: x86IsaUsedValues.length > 0 && unknownX86IsaUsed.length === 0 ? "known" : "unknown",
      values: x86IsaUsedValues,
      levels: uniqueSorted(recognizedX86IsaUsed),
    },
    x86Features: {
      status: x86Features.length > 0 ? "known" : "unknown",
      values: x86Features,
    },
    aarch64Features: {
      status: aarch64Features.length > 0 ? "known" : "unknown",
      values: aarch64Features,
    },
  };
}

/**
 * @param {string} readelfText
 * @returns {{ status: "present" | "absent" | "unknown", lines: string[], cpuArch: string[], cpuProfile: string[], cpuName: string[] }}
 */
function attributeObservation(readelfText) {
  const attributeLines = readelfText
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => /^(?:Attribute Section:|File Attributes|Tag_CPU_|Tag_ABI_|Tag_Virtualization:|Tag_MPextension_use:)/u.test(line));
  const hasAttributeSection = /\bAttribute Section:\s*\S+/u.test(readelfText) || /\bFile Attributes\b/u.test(readelfText);
  const explicitNoAttributes = /\bNo attributes\b/iu.test(readelfText);
  return {
    status: hasAttributeSection ? "present" : explicitNoAttributes ? "absent" : "unknown",
    lines: attributeLines,
    cpuArch: captureValues(readelfText, /^\s*Tag_CPU_arch:\s*(.+)$/mu),
    cpuProfile: captureValues(readelfText, /^\s*Tag_CPU_arch_profile:\s*(.+)$/mu),
    cpuName: captureValues(readelfText, /^\s*Tag_CPU_name:\s*(.+)$/mu),
  };
}

/**
 * Parse one complete readelf stream. The existing ELF parser remains the
 * authority for headers, DT_NEEDED and version needs; this function only adds
 * passive note/attribute observations and never turns them into admission.
 * @param {string} readelfText
 * @param {string | null} [expectedTarget]
 */
export function parseElfPortability(readelfText, expectedTarget = null) {
  const elf = parseElfMetadata(readelfText, expectedTarget);
  const gnuProperty = noteObservation(readelfText);
  const attributes = attributeObservation(readelfText);
  const x86Observed = gnuProperty.x86IsaNeeded.status === "known";
  return {
    schema: ELF_PORTABILITY_OBSERVATION_SCHEMA,
    target: expectedTarget,
    elf,
    versionNeeds: elf.versionNeeds,
    glibcPrivateVersionNeeds: elf.versionNeeds.filter(({ name }) => name === "GLIBC_PRIVATE"),
    gnuProperty,
    attributes,
    cpuBaseline: {
      status: x86Observed ? "observed" : "unresolved",
      x86IsaNeeded: gnuProperty.x86IsaNeeded,
      admission: "not-claimed",
    },
  };
}

/**
 * @typedef {Object} ElfPortabilityInput
 * @property {string} relativePath
 * @property {string} target
 * @property {number} bytes
 * @property {string} sha256
 * @property {string[]} [aliases]
 * @property {string} stdout
 * @property {string} [stderr]
 */

/**
 * Bind the passive parse to the authenticated payload member and the complete
 * bounded readelf stdout/stderr stream. This is intentionally not a CPU or
 * provider admission decision.
 * @param {ElfPortabilityInput} input
 */
export function buildElfPortabilityObservation(input) {
  if (!input || typeof input !== "object") throw new Error("ELF portability input is required");
  validateRelativePath(input.relativePath, "ELF portability relativePath");
  if (typeof input.target !== "string" || !input.target) throw new Error("ELF portability target is required");
  if (!Number.isInteger(input.bytes) || input.bytes <= 0) throw new Error("ELF portability bytes must be positive");
  if (typeof input.sha256 !== "string" || !SHA256_RE.test(input.sha256)) throw new Error("ELF portability sha256 is invalid");
  if (typeof input.stdout !== "string" || typeof (input.stderr ?? "") !== "string") {
    throw new Error("ELF portability readelf streams must be strings");
  }
  if (input.aliases !== undefined && !Array.isArray(input.aliases)) {
    throw new Error("ELF portability aliases must be an array");
  }
  const aliases = (input.aliases ?? []).map((alias, index) => validateRelativePath(alias, `ELF portability alias[${index}]`));
  const stderr = input.stderr ?? "";
  const streamSha256 = createHash("sha256").update(input.stdout).update(stderr).digest("hex");
  return {
    ...parseElfPortability(input.stdout, input.target),
    relativePath: input.relativePath,
    aliases: uniqueSorted(aliases),
    bytes: input.bytes,
    sha256: input.sha256,
    readelf: {
      args: [...ELF_PORTABILITY_READELF_ARGS],
      streamSha256,
      stdoutBytes: Buffer.byteLength(input.stdout),
      stderrBytes: Buffer.byteLength(stderr),
      notesPresent: noteObservation(input.stdout).status === "present",
      notesStatus: noteObservation(input.stdout).status,
    },
  };
}

