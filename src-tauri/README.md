# Rust host checks

The crate is the macOS-arm64 native Tauri bootstrap. It owns the fixed,
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
