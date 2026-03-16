# Claim Validity Matrix

Date: 2026-03-16

| Claim                                      | Current State                                         | Required Evidence Before Publication                                    |
| ------------------------------------------ | ----------------------------------------------------- | ----------------------------------------------------------------------- |
| Capability-gated API                       | Valid                                                 | Contract validation plus runtime-bound deny tests with audit artifacts  |
| Real interpreter execution on server hosts | Valid for `node` / `deno` / `bun`                     | Real-execution and profile-conformance artifacts                        |
| Real interpreter execution in the browser  | Not valid                                             | Browser runtime tests against a real browser engine artifact            |
| Engine artifact integrity                  | Valid for hashed artifacts and provenance metadata    | Mandatory release-mode provenance verification plus SBOM evidence       |
| Runtime-bound policy enforcement           | Valid for current `fs` / `http` / `env` server claims | Capability-binding and denial artifacts for each supported capability   |
| Deterministic replay                       | Partial                                               | Stable replay hashes across a broader real-runtime compatibility corpus |
| High-risk tenant isolation                 | Not valid                                             | Enforced seccomp depth and optional microVM isolation evidence          |
| Enterprise security readiness              | Not valid                                             | Vulnerability SLA metrics and incident runbook drill artifacts          |
