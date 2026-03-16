# Hardening Roadmap

## Current Position

AegisPy now ships a real server-side execution path for `node`, `deno`, and
`bun` using process transport, a Rust worker, WASI Python, and the
`component-wit` capability channel. The default execution mode is native
process execution. An experimental `microvm` launcher mode is now available as
an opt-in self-hosted path through `AEGISPY_WORKER_EXECUTION_MODE=microvm`.

The browser profile now uses an experimental real-engine worker runtime with
explicit `fs=false`, `http=false`, and `env=false` capability limits. Deeper
hardening work remains open for compatibility breadth, isolation depth,
release-attestation enforcement, and high-risk tenant isolation.

## Target

A real hardened Python engine suitable for hostile agent workloads.

## Required Engineering Tracks

1. Compatibility corpus and package metadata

- Broaden the generated workload-compatibility matrix across all public hosts.
- Keep pure-Python package fixture metadata pinned through verified lockfiles.
- Exit criteria: workload families and reason codes are generated under
  `artifacts/compat/` and enforced by the compatibility gate.

2. Isolation hardening for server hosts

- Deepen seccomp, namespace, cgroup v2, rlimit, and no-new-privs enforcement.
- Keep the experimental microVM launcher path self-hosted-ready and extend it
  into a stronger isolation profile for high-risk tenants.
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
