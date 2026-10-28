# Theme Forge Nebular Fusion

Theme Forge Nebular Fusion 0.7.0 is a native desktop GUI distributed through a
small npm wrapper. The wrapper selects exactly one optional platform package:
`darwin-arm64` (Apple Silicon), `linux-arm64`, or `linux-x64` (AMD64). The
wrapper owns the `tfnf` command; platform packages do not install competing
bins.

## Install and use

Install the wrapper with npm. npm selects the optional native package for the
host when the matching package is available:

```console
$ npm install --global @knowledge-forge-ai/theme-forge-nebular-fusion@0.7.0
$ tfnf --version
theme-forge-nebular-fusion 0.7.0 (<host-target>)
$ tfnf --help
Theme Forge Nebular Fusion 0.7.0
Usage: tfnf [--version|--help|--path]
Normal invocation launches the installed GUI.
```

`tfnf --path` authenticates the installed platform package and prints the
absolute canonical path of the GUI executable without launching it. A normal
`tfnf [application args...]` invocation verifies the payload immediately
before pathname-based launch and forwards the arguments to the native GUI.
There is no first-launch download, checkout fallback, ambient compiler/runtime
fallback, or foreign-architecture fallback. Unsupported hosts fail closed.

## Platform qualification

Linux requires GNU/glibc; musl and unsupported libc environments fail closed.
The measured compatibility floors are glibc 2.36 for Linux AMD64 and glibc
2.35 for Linux ARM64. See the release receipts for target-specific native
GUI qualification; optional-package presence alone does not establish it.

This package does not assert a macOS minimum version. Use a separately
qualified Darwin ARM64 artifact and its release instructions. The Darwin
developer app archive is ad-hoc-signed; it is not Developer ID signed and no
notarization is claimed. The Homebrew cask remains withheld pending those
distribution gates. Do not bypass Gatekeeper or remove quarantine as an
installation workaround.

## Payload verification

Each platform manifest binds the package identity, complete payload inventory,
regular-file sizes and SHA-256 hashes, file and directory modes, and exact
internal symlink targets. Before launch the verifier enforces:

- manifest size <= 4 MB and <= 20,000 inventory members;
- complete payload status and the target-specific app-bundle or
  Linux-executable-resources payload type;
- package version, OS, CPU, executable path, and payload-root identity;
- path containment with no empty, `.`, `..`, backslash, NUL, or traversal
  segments;
- relative, contained symlinks only, with exact declared targets;
- `0o755` directories, `0o644` or `0o755` regular files, executable GUI
  binary, <= 512 MB per file, and <= 2 GB aggregate payload; and
- changed or missing bindings, manifests, files, executables, or unexpected
  on-disk members rejected closed.

This authenticates installed package input. It is not a substitute for a
release provenance, signing, or notarization receipt.

## Launch boundary and process behavior

The wrapper sanitizes Node and dynamic-linker injection variables before
launch (`NODE_OPTIONS`, `NODE_PATH`, `LD_PRELOAD`, `LD_LIBRARY_PATH`,
`LD_AUDIT`, `DYLD_INSERT_LIBRARIES`, `DYLD_LIBRARY_PATH`,
`DYLD_FALLBACK_LIBRARY_PATH`, `DYLD_FRAMEWORK_PATH`, and
`DYLD_FALLBACK_FRAMEWORK_PATH`) while preserving desktop variables such as
`DISPLAY`, `WAYLAND_DISPLAY`, `XDG_*`, `DBUS_SESSION_BUS_ADDRESS`, `HOME`, and
`PATH`.

For a Linux package carrying an authenticated private-runtime projection, a
normal invocation verifies the complete payload and selects only the
manifest-authenticated `payload/bin/tfnf` launcher. That launcher checks its
private runtime roles, removes every `LD_*` variable and `GLIBC_TUNABLES`,
then sets its own canonical `LD_LIBRARY_PATH` and
`LD_PRELOAD=libwebkit2gtk-4.1.so.0.19.9` before executing the GUI. `tfnf
--path` remains a non-launching query that prints the authenticated GUI
executable path. Darwin and legacy non-private payloads retain direct
authenticated GUI selection and do not use this Linux private-runtime
preload path.

Exit codes and terminating signals are propagated. `SIGTERM` and `SIGINT` are
forwarded to the child; after a fixed 5000 ms termination interval the
launcher escalates to `SIGKILL` if needed.

Verification occurs immediately before pathname-based `child_process.spawn`.
Node does not use `fexecve`; same-user concurrent pathname mutation, symlink
replacement, or file alteration after verification is outside this guarantee.

## Build and release boundary

Platform package assembly consumes explicitly selected, authenticated native
payload directories and external manifest digests. Pending-native-build inputs
are not complete GUI packages; the wrapper does not fabricate completed
payloads. `tools/qualify-nebular-npm-package.mjs` qualifies explicitly
prepared platform packages, packs the selected package set offline, and tests installation
and target selection. Native GUI workflows and release publication are
separate evidence gates.

## License

Theme Forge Nebular Fusion is offered under **AGPL-3.0-or-later**. Review
`LICENSE` and `NOTICE` before use and preserve those notices when conveying
the package.
