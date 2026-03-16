# Claim Validity Matrix

Date: 2026-03-16

| Claim                                      | Current State                                                                           | Required Evidence Before Publication                                           |
| ------------------------------------------ | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Capability-gated API                       | Valid                                                                                   | Contract validation plus runtime-bound deny tests with audit artifacts         |
| Real interpreter execution on server hosts | Valid for `node` / `deno` / `bun`                                                       | Real-execution and profile-conformance artifacts                               |
| Real interpreter execution in the browser  | Valid for the experimental `browser-real-engine` path                                   | Browser runtime tests against the worker-backed real engine artifact           |
| Engine artifact integrity                  | Valid for hashed artifacts, browser asset verification, and provenance metadata         | Mandatory release-mode provenance verification plus SBOM evidence              |
| Runtime-bound policy enforcement           | Valid for current `fs` / `http` / `env` server claims and strict limit-envelope denials | Capability-binding and denial artifacts for each supported capability          |
| Deterministic replay                       | Valid for the current six-workload cross-host replay corpus                             | Stable replay hashes across a broader real-runtime compatibility corpus        |
| High-risk tenant isolation                 | Not valid                                                                               | Broader enforced seccomp policy depth plus optional microVM isolation evidence |
| Enterprise security readiness              | Not valid                                                                               | Vulnerability SLA metrics and incident runbook drill artifacts                 |
