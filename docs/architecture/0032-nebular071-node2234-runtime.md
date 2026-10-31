# ADR 0032: Nebular 0.7.1 embedded Node security update

- Status: Owner-authorized implementation; resulting-source and public native qualification pending.
- Date: 2026-10-31
- Scope: The embedded Node runtime and its current preparation inputs for Nebular 0.7.1.

## Context

The 0.7.1 permission correction passed its four installed-mode regressions on each public native host with Node 22.23.3. The separate supply-chain gate reported seven findings against the shipped runtime: CVE-2026-105481, CVE-2026-105482, CVE-2026-106069, CVE-2026-106072, CVE-2026-106073, CVE-2026-106074 and CVE-2026-111497. The official Node 22.23.4 security release addresses those advisories. Retaining the previous runtime would leave that gate unresolved.

This decision updates the embedded-runtime selection described by ADR 0030. Build-time tools remain a separate role.

## Decision

Select official Node 22.23.4 for the existing Darwin ARM64, Linux ARM64 and Linux x64 targets. The maintained authority, Rust closed-input pins, current expected Scene/Theme Lab bindings, authentic signed fixture and explicit embedded-runtime download paths must agree.

Preserve the existing setup-node build/test harness, standalone shared CI authority and historical fixtures. Preserve runner labels, timeouts, permissions, scanner thresholds, finding baselines and signing identity. The frozen 0.7.0 native-PyPI workflow continues to authenticate its separately checked-out product's runtime; it is not a 0.7.1 universal-wheel producer.

| Target | Official archive SHA-256 | Executable SHA-256 | Executable bytes |
| --- | --- | --- | --- |
| Darwin ARM64 | c9e1dbc748b33ed2d14f42445191ecaf14c56259c7a9a26d0042c49ec2b66428 | 2cc28a1880d0774616959f2210ee739bffa6ac695c887e8988a496a21271f6c0 | 113002944 |
| Linux ARM64 | 6287aa46b6c375d816e63ae66d024fbbfd70404825aabdfdf898a970871d2f4b | 7e48183361053f039294fbbc3ba586722fe756bf296d6cb8195356d10819cd16 | 122293360 |
| Linux x64 | 1805bcd35e6815559bd2eb97db438d3fdb0eb3a5e6a977b7c1badca76337e9ce | 94efd062ed066c1a0b332e18249859c905e920eeada5df55d24c99b919629a90 | 124902584 |

Detached and cleartext official manifest signatures were checked against the committed release-key ring and primary fingerprint 5BE8A3F6C8A5C01D106C0AD820B1A390B168D356. The signed manifest SHA-256 is a662bf8938f1ea15a9ba0017a89a53a28812b8ab179be11dd62d642cb6e33396. The Darwin archive metadata uses the official /dist/ URL, matching the authentication download path.

The full upstream LICENSE is byte-identical across all three archives and to the retained license: 145485 UTF-8 bytes, SHA-256 c738ae413cf561f174e34f6961f8ca458aae2369a73640dda6234c629b98bcc4. No notice is removed. V8 remains 12.4.254.21-node.57; Undici is 6.29.1. A local authenticated Darwin probe observed module ABI 127 and Node-API 10. These observations do not qualify Linux or the complete application.

## Alternatives and consequences

A major Node upgrade has a wider compatibility surface. A private backport introduces a separate build and trust obligation. A scanner waiver has no demonstrated reachability justification. The upstream patch release is the bounded correction.

Keep the accepted Burst 0.7.0, Loom 0.5.0, Solar 0.3.0 and Scene input archive bodies and source identities. Generate new current resources, notices, SBOMs, package bytes and receipts from the selected runtime; do not relabel historical release or qualification evidence. Existing operating-system and system-WebKit support floors remain unchanged.

A later 0.7.1 universal Python launcher must bind newly qualified native release archives through its separate versioned owner. Existing 0.7.0 wheel inputs, asset IDs and publication authority remain historical.

## Acceptance and rollback

GitHub and npm native-artifact publication requires resulting-source/projection verification, authentic OpenPGP fixture checks, native runtime/addon checks on all three public hosts, all four installed-mode regressions on every host, full Rust/frontend/security gates and the fresh corresponding-source offer. Both Linux authenticity receipts must record an actual matching-host probe. Each Python, Homebrew, Nix or OS-repository publisher additionally requires its own source, consumer, metadata and signing gates. Track these publication channels independently, preserving their required failures and existing protections.

The earlier Node 22.23.3 native campaigns qualify only their exact source/runtime candidates. Reverting an unpublished candidate restores those inputs but does not resolve their recorded security findings or admit publication.

## Primary references

- [Node October 2026 security releases](https://nodejs.org/en/blog/vulnerability/october-2026-security-releases)
- [Node 22.23.4 release](https://nodejs.org/en/blog/release/v22.23.4)
- [Node 22.23.4 build and platform requirements](https://github.com/nodejs/node/blob/v22.23.4/BUILDING.md)
