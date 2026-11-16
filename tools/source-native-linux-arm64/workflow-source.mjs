import { BASE_QUALIFICATION_COMMIT, DRIVER_SCHEMA, NODE_VERSION, QUALIFICATION_BRANCH, REPOSITORY, RETENTION_DAYS, RUST_VERSION, TARGET } from "./driver.mjs";

export const WORKFLOW_SCHEMA = "nebular.linux-arm64-source-rust-workflow-v1";
export const WORKFLOW_PATH = ".github/workflows/native-rc.yml";
export const CHECKOUT_SHA = "11bd71901bbe5b1630ceea73d27597364c9af683";
export const SETUP_NODE_SHA = "39370e3970a6d050c480ffad4ff0ed4d3fdee5af";
export const UPLOAD_ARTIFACT_SHA = "ea165f8d65b6e75b540449e92b4886f43607fa02";
export const LINUX_IMAGE_DIGEST = "3783cc01769c7b2b1b83a5c5ad96c815348e28ed7da68e2e3687004faa906251";

/**
 * Generate the manual, source-only Linux branch workflow.  The generated
 * string is intentionally kept as a source artifact: this proposal does not
 * write the maintained checkout's recognized workflow path.
 */
export function sourceNativeLinuxRustWorkflow() {
  return `name: Nebular Linux AArch64 source checkpoint

on:
  workflow_dispatch:
    inputs:
      confirm_linux_source_rust:
        description: Run the held Linux AArch64 source-only Rust checkpoint
        required: true
        type: boolean
        default: false

permissions:
  contents: read

concurrency:
  group: nebular-linux-source-\${{ github.repository }}-\${{ github.ref }}
  cancel-in-progress: false

jobs:
  linux-arm64-source-rust:
    name: Linux arm64 source-only Rust checkpoint
    if: \${{ github.event_name == 'workflow_dispatch' && inputs.confirm_linux_source_rust == true && github.repository == '${REPOSITORY}' && github.ref == 'refs/heads/${QUALIFICATION_BRANCH}' }}
    runs-on: ubuntu-24.04-arm
    timeout-minutes: 150
    container:
      image: debian:bookworm-slim@sha256:${LINUX_IMAGE_DIGEST}
      options: --init
    steps:
      - name: Establish the owned container evidence path
        run: |
          set -eu
          umask 077
          mkdir "$RUNNER_TEMP/nebular-linux"
          mkdir "$RUNNER_TEMP/nebular-linux/evidence"
          printf 'NEBULAR_LINUX_EVIDENCE=%s\\n' "$RUNNER_TEMP/nebular-linux/evidence" >> "$GITHUB_ENV"

      - name: Install the existing Bookworm build roots and distro Python
        run: |
          set -eu
          apt-get update
          DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends binutils build-essential ca-certificates curl dbus dbus-x11 git libappindicator3-dev libgtk-3-dev libjavascriptcoregtk-4.1-dev librsvg2-dev libsoup-3.0-dev libwebkit2gtk-4.1-dev patchelf pkg-config procps xauth xvfb xz-utils python3

      - name: Check out the exact qualification branch source
        uses: actions/checkout@${CHECKOUT_SHA} # v4.2.2
        with:
          ref: \${{ github.sha }}
          fetch-depth: 2
          persist-credentials: false

      - name: Guard the manual branch and source commit
        env:
          EXPECTED_REPOSITORY: ${REPOSITORY}
          EXPECTED_BRANCH: ${QUALIFICATION_BRANCH}
          EXPECTED_BASE_COMMIT: ${BASE_QUALIFICATION_COMMIT}
        run: |
          test "$GITHUB_REPOSITORY" = "$EXPECTED_REPOSITORY"
          test "$GITHUB_REF" = "refs/heads/$EXPECTED_BRANCH"
          test "$GITHUB_EVENT_NAME" = "workflow_dispatch"
          test "$GITHUB_REF_NAME" = "$EXPECTED_BRANCH"
          test "$(git -c safe.directory="$GITHUB_WORKSPACE" rev-parse --verify HEAD)" = "$GITHUB_SHA"
          test "$(git -c safe.directory="$GITHUB_WORKSPACE" rev-parse --verify HEAD^)" = "$EXPECTED_BASE_COMMIT"
          test "\${{ inputs.confirm_linux_source_rust }}" = "true"
          test "$RUNNER_OS" = Linux
          test "$RUNNER_ARCH" = ARM64

      - name: Verify the base Node authority and bounded source tools
        run: |
          set -eu
          test -f tools/node-runtime-authority.mjs
          test -f tools/source-native/unpack-native-inputs.py
          test -f tools/source-native-linux-arm64/driver.mjs
          test -f tools/source-native-linux-arm64/host-inputs.mjs

      - name: Set up the pinned Node runtime
        uses: actions/setup-node@${SETUP_NODE_SHA} # v4.1.0
        with:
          node-version: ${NODE_VERSION}
          check-latest: false

      - name: Download same-origin Rust and signed Linux Node inputs
        run: |
          set -eu
          umask 077
          mkdir "$RUNNER_TEMP/nebular-linux/rustup-init" "$RUNNER_TEMP/nebular-linux/node-download"
          RUSTUP_DIR="$RUNNER_TEMP/nebular-linux/rustup-init"
          curl --proto '=https' --tlsv1.2 -fsSLo "$RUSTUP_DIR/rustup-init" "https://static.rust-lang.org/rustup/dist/${TARGET}/rustup-init"
          curl --proto '=https' --tlsv1.2 -fsSLo "$RUSTUP_DIR/rustup-init.sha256" "https://static.rust-lang.org/rustup/dist/${TARGET}/rustup-init.sha256"
          test "$(cut -d' ' -f1 "$RUSTUP_DIR/rustup-init.sha256")" = "$(sha256sum "$RUSTUP_DIR/rustup-init" | cut -d' ' -f1)"
          chmod +x "$RUSTUP_DIR/rustup-init"
          NODE_DIR="$RUNNER_TEMP/nebular-linux/node-download"
          ARCHIVE=$(node --input-type=module -e 'import { NODE_RELEASE_IDENTITY } from "./tools/node-runtime-authority.mjs"; process.stdout.write(NODE_RELEASE_IDENTITY.targets["${TARGET}"].archive)')
          curl --proto '=https' --tlsv1.2 -fsSLo "$NODE_DIR/SHASUMS256.txt.asc" "https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt.asc"
          curl --proto '=https' --tlsv1.2 -fsSLo "$NODE_DIR/$ARCHIVE" "https://nodejs.org/dist/v${NODE_VERSION}/$ARCHIVE"

      - name: Authenticate inputs and install Rust 1.98.0
        run: |
          set -eu
          export NEBULAR_PYTHON=/usr/bin/python3
          export NEBULAR_NPM_CLI="$(npm_config_cache="$RUNNER_TEMP/nebular-linux/npm-bootstrap-cache" npm root -g)/npm/bin/npm-cli.js"
          test -x "$NEBULAR_PYTHON"
          test -f "$NEBULAR_NPM_CLI"
          # The driver owns the fixed argv, empty explicit environment and
          # path-free receipt; no SDK/Nix override is admitted.
          mkdir -p "$RUNNER_TEMP/nebular-linux/evidence"
          node tools/source-native-linux-arm64/driver.mjs --bootstrap --output "$RUNNER_TEMP/nebular-linux/evidence/bootstrap.json"

      - name: Prepare source inputs and run the bounded Rust checkpoint
        run: |
          set -eu
          export NEBULAR_PYTHON=/usr/bin/python3
          export NEBULAR_NPM_CLI="$(npm_config_cache="$RUNNER_TEMP/nebular-linux/npm-bootstrap-cache" npm root -g)/npm/bin/npm-cli.js"
          test -x "$NEBULAR_PYTHON"
          test -f "$NEBULAR_NPM_CLI"
          node tools/source-native-linux-arm64/driver.mjs --run --output "$RUNNER_TEMP/nebular-linux/evidence/checkpoint.json"

      - name: Retain path-free JSON evidence for 14 days
        if: \${{ always() && env.NEBULAR_LINUX_EVIDENCE != '' }}
        uses: actions/upload-artifact@${UPLOAD_ARTIFACT_SHA} # v4.6.2
        with:
          name: nebular-linux-arm64-source-evidence
          path: \${{ env.NEBULAR_LINUX_EVIDENCE }}/*.json
          if-no-files-found: error
          retention-days: ${RETENTION_DAYS}
          include-hidden-files: false
`;
}

export const WORKFLOW_EXPECTATIONS = Object.freeze({
  schema: WORKFLOW_SCHEMA,
  path: WORKFLOW_PATH,
  repository: REPOSITORY,
  branch: QUALIFICATION_BRANCH,
  target: TARGET,
  rust: RUST_VERSION,
  node: NODE_VERSION,
  python: "distro python3 (>=3.11)",
  timeoutMinutes: 150,
  retentionDays: RETENTION_DAYS,
  cancelInProgress: false,
  permissions: "contents: read",
  actionPins: Object.freeze({ checkout: CHECKOUT_SHA, setupNode: SETUP_NODE_SHA, uploadArtifact: UPLOAD_ARTIFACT_SHA }),
});
