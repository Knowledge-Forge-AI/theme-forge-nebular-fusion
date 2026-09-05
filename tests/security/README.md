# Security checks

Machine-enforced capability, CSP, plugin, command, private-import, Rust policy,
and platform-boundary checks live in `src/test/security-contract.studio.ts` so
they run in the independently locked Studio test graph.
