# Hardening Roadmap

## Current Position

AegisPy currently validates contracts and policy behavior, but default execution
paths still rely on simulation and stub engine artifacts.

## Target

A real hardened Python engine suitable for hostile agent workloads.

## Required Engineering Tracks

1. Real engine execution by default

- Replace simulation-default paths with real CPython WASI/browser engine execution.
- Exit criteria: runtime tests execute against real engine artifacts.

2. Isolation hardening for server hosts

- Enforce seccomp, namespaces, cgroup v2 limits, rlimits, and no-new-privs.
- Provide optional microVM isolation profile for high-risk tenants.
- Exit criteria: adversarial escape suite blocked by enforced profile.

3. Capability enforcement at runtime boundary

- Bind policy decisions to concrete filesystem/network/environment operations.
- Exit criteria: denied operations are blocked by runtime, not only pre-check logic.

4. Deterministic replay and attestation

- Runtime-level deterministic clock/RNG controls and stable replay hashes.
- Exit criteria: replay corpus produces matching hashes under fixed seed/epoch.

5. Supply-chain security and release integrity

- Generate SBOM and signed provenance attestation for release artifacts.
- Exit criteria: release gate verifies signatures and provenance before publish.

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
