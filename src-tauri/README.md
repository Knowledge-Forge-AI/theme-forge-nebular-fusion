# Rust host checks

The qualified baseline is the macOS-arm64 native Tauri bootstrap. P4 adds
three-target prepared-runtime paths and target-specific no-follow flags, but
Linux runtime authentication and GUI qualification remain incomplete; see
`../../../docs/evaluations/tfsb71p4-nebular-platforms.md`. The crate owns the fixed,
authenticated sidecar process and packet/host boundary, including native
dialog/path mediation, packet I/O, and host/plan state. Native paths remain in
fixed Rust adapters; the crate exposes no generic filesystem, network, shell,
plugin, Swift/FFI, background-task, or `.tfsb` authority.

With Rust 1.98.0 selected by `../rust-toolchain.toml`, run:

```sh
cargo fmt --all -- --check
cargo check --all-targets --all-features
cargo clippy --all-targets --all-features -- -D warnings
cargo test --all-targets --all-features
cargo test --doc
RUSTDOCFLAGS="-D warnings" cargo doc --no-deps
```
