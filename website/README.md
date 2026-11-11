# Nebular Fusion static site

This directory is the static public site for Nebular Fusion / Theme Forge. It
does not contain a framework runtime or a deployment client.

This source carries release guidance for Nebular Fusion 0.8.0. The release is
published through the GitHub native archives, npm wrapper, and the Homebrew
Apple Silicon formula; PyPI, Nix, APT, DNF, and pacman remain on the verified
0.7.1 channel records. The 0.8.0 source includes paired-v2 authoring/packet
exchange and application appearance controls, and its automated native checks
on all three supported targets plus persistence/paired workflow checks have
passed; the macOS build targets 13.3 or later. Channel availability below is
kept per-channel rather than inferred from source metadata.

### Getting started by release boundary

- Published install: use the npm, Homebrew, or native archive examples for
  0.8.0. The GitHub release record is
  `https://github.com/Knowledge-Forge-AI/theme-forge-nebular-fusion/releases/tag/v0.8.0`;
  the exact npm registry readback is
  `https://registry.npmjs.org/@knowledge-forge-ai/theme-forge-nebular-fusion/-/theme-forge-nebular-fusion-0.8.0.tgz`;
  and the merged Homebrew formula proof is
  `https://github.com/Knowledge-Forge-AI/homebrew-tap/pull/4`.
- Held-channel install: PyPI, Nix, APT, DNF, and pacman examples remain on
  their verified 0.7.1 channel records. PyPI carries an explicit version, Nix
  uses its pinned release ref, and APT, DNF, and pacman retain their
  repository-managed commands. Keep those commands and release links unchanged
  until their own matching receipts exist.
- Source review: start from the maintained Nebular Fusion repository
  (`https://github.com/Knowledge-Forge-AI/theme-forge-nebular-fusion`) and its
  current source README. Automated native checks are separate from channel
  availability; the macOS target floor is 13.3 or later.

## Build the public artifact

Use a Node 22 runtime from this directory:

```sh
node tools/build-static-site.mjs --output dist
```

The output directory must not already exist. The builder never removes or
overwrites an existing output; choose a fresh sibling directory for each
build. It stages the files beside the requested output and publishes the stage
with one directory rename after source and provenance checks pass.

The generated directory contains 30 fixed public payload files, including the
website-only Orihime mascot, and a
generated `manifest.json`. The manifest is sorted by public relative path and
records each payload's byte count, SHA-256, and `0644` mode. It contains no
local source path, timestamp, username, or release-version decision. The
manifest describes the payload and intentionally does not self-hash.

## Fixed public allowlist

The builder copies only the following public members:

- `index.html`, `styles.css`, `favicon.svg`, `social-preview.svg`, `social-preview.png`, `404.html`, and `robots.txt`;
- `src/main.mjs` and `src/state.mjs`;
- `brand/README-BRAND.md` and `brand/BRAND-ASSETS.md`;
- `screenshots/gamer-dark-shell.jpg` and its exact-byte
  `screenshots/screenshot-provenance.json` receipt;
- `appearances/specimen.html`, `appearances/catalog.json`, and
  `appearances/provenance.json`;
- the six appearance sheets: `terminal-nova.css`, `nebular.css`,
  `developer.css`, `graphic-designer.css`, `anime.css`, and `gamer.css`.
- the six exact v2 development-preview source profiles under
  `appearances/profiles/`, plus `appearances/source-profiles.json`.

The appearance provenance record remains closed to the admitted seven-member
catalog-plus-CSS projection. The source-profile manifest separately binds the
six exact maintained profile bytes to their public paths, schema, names,
versions, sizes, and hashes. The profiles are development-preview inputs; the
maintained 0.8.0 source contains the paired-v2 authoring and
application-appearance work, while this static site still projects read-only
specimens and source-profile downloads. Automated native checks on all three
supported targets and the macOS 13.3-or-later target floor are recorded
separately. The published GitHub/npm/Homebrew surfaces do not turn this static
preview into an interactive editor or claim PyPI/Nix/APT/DNF/pacman 0.8.0
availability.
The browser proof is a source-projected, exact-byte application preview from the
Theme Forge App/external CSSOM fixture; its receipt binds the image size, hash,
and source-app manifest digest using public identifiers only. It retains the
visible mock boundary and does not claim native, hosted, deployment, rights,
release, or final visual acceptance.
Every member's recorded byte count and SHA-256 must match the source before
staging. Symlinked or non-regular source entries are rejected; the final source
file open uses `O_NOFOLLOW` where the runtime provides it. Tools, tests, notes,
caches, and unrelated repository files are not site artifacts.

## Checks

The focused builder tests use fresh temporary fixtures outside the site and do
not create `dist`:

```sh
node --test test/static-build.test.mjs
node --check tools/build-static-site.mjs
node --test test/*.test.mjs
```

The tests cover deterministic manifests and modes, appearance and source-profile
provenance hash drift, symlink rejection, and preservation of foreign
directories and symlinks at the requested output path.

The configured metadata origin is `https://tfnf.knowledge-forge.ai/`. This
source and build boundary does not deploy or configure hosting; release and
native receipts are linked above, while a host may serve the generated
directory as a static root after its own review.
