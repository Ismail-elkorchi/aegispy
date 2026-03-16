# Hardening Roadmap

## Current Position

AegisPy now ships a real server-side execution path for `node`, `deno`, and
`bun` using process transport, a Rust worker, WASI Python, and the
`component-wit` capability channel.

The browser profile still uses a simulated subset execution path, and deeper
hardening work remains open for isolation depth, package compatibility breadth,
release-attestation enforcement, and high-risk tenant isolation.

## Target

A real hardened Python engine suitable for hostile agent workloads.

## Required Engineering Tracks

1. Browser real-engine execution

- Replace the browser simulated subset with a real browser Python engine path.
- Exit criteria: browser runtime tests execute against a real browser engine artifact.

2. Isolation hardening for server hosts

- Deepen seccomp, namespace, cgroup v2, rlimit, and no-new-privs enforcement.
- Provide optional microVM isolation profile for high-risk tenants.
- Exit criteria: adversarial escape suite blocked by enforced profile.

3. Capability enforcement at runtime boundary

- Extend policy decisions across the full supported resource surface with stable audit semantics.
- Exit criteria: denied operations are blocked by runtime, not only pre-check logic.

4. Deterministic replay and attestation

- Runtime-level deterministic clock/RNG controls and stable replay hashes.
- Exit criteria: replay corpus produces matching hashes under fixed seed/epoch.

5. Supply-chain security and release integrity

- Keep SBOM and provenance attestation generation in the mandatory release path.
- Exit criteria: release gate verifies signatures and provenance before publish in required mode.

6. Security assurance and operations

- Continuous fuzzing and adversarial regression suites.
- Vulnerability SLA, disclosure process, and incident runbook.
- Exit criteria: security gates and operational runbooks are release blockers.

## Claim Publication Rule

No security or hardening claim may be published unless it is:

- implemented in default paths,
- validated by automated tests,
- backed by generated artifacts under `artifacts/`,
- enforced by release claim checks.
