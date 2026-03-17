# Gates

## Main Gate Entrypoint

- `pnpm run check` runs the full Linux truth lane.
- `pnpm run check:portable` runs the portable docs, workflow, lint, format,
  typecheck, and portable test lane.

## Gate Families

- repository shape and docs
- workflow and dependency boundaries
- component and runtime integrity
- host conformance and compatibility
- supply-chain, provenance, and security evidence

## Named Test Commands

- `pnpm run test:portable`
- `pnpm run test:node`
- `pnpm run test:deno`
- `pnpm run test:bun`
- `pnpm run test:browser`
- `pnpm run test:server-hosts`
- `pnpm run test:host-contracts`
  - prepares the real worker/component runtime surface before running the
    host-oriented suites

## Manual Self-Hosted Workflow

- `.github/workflows/microvm-self-hosted.yml` provides a manual self-hosted
  microVM smoke lane.
- That workflow is intentionally non-required and is only meant for runners
  that already expose a compatible microVM launcher.

## Release Claim Gate

- `bash scripts/release_claims_check` runs the release-grade claim gate and
  writes `artifacts/gates/release-claims.json`.
- When `artifacts/security/release-rehearsal.json` is present, the release
  claim gate validates that staged rehearsal artifact instead of restaging new
  release inputs.
- `bash scripts/security_claims_check` runs the security-claim gate and writes
  `artifacts/gates/security-claims-check.json`.

## Release Commands

- `pnpm run release:rehearsal -- --tag v0.0.0`
- `pnpm run release:gate -- v0.0.0`
- `pnpm run release:audit`
- `pnpm run release:claims`

## Evidence Output

- Verification writes generated evidence under `artifacts/gates/`,
  `artifacts/security/`, `artifacts/compat/`, `artifacts/e2e/`, and
  `artifacts/tests/`.
- Compatibility proof specifically writes `artifacts/compat/agent-workload-corpus.json`,
  `artifacts/compat/workload-compatibility-matrix.json`, and
  `artifacts/compat/package-fixture-lockfiles.json`.
- The compatibility gate treats support claims as host-specific proof:
  `supportedFailures` and `unsupportedByProfileFailures` must be empty in the
  generated compatibility artifacts.
- The compatibility gate also enforces a floor of 28 workloads, 5 pinned
  package fixtures, and 3 browser-executed package fixtures.
- Security proof writes `artifacts/security/replay-attestation.json`,
  `artifacts/security/adversarial-suite.json`,
  `artifacts/security/browser-input-fuzz.json`,
  `artifacts/security/browser-integrity-fuzz.json`,
  `artifacts/security/runtime-envelope-fuzz.json`, and
  `artifacts/security/protocol-framing-fuzz.json`.
- Release rehearsal writes `artifacts/security/release-rehearsal.json` and
  pairs it with provenance verification for the source archive plus the shipped
  runtime artifacts.
- The replay artifact records a six-workload cross-host corpus, and the
  adversarial suite records eight strict-profile hostile-boundary denials.
- The security gate also requires fixed-seed iteration metadata and explicit
  category counts for protocol framing, runtime envelopes, browser worker
  inputs, browser integrity inputs, and native ABI fuzzing.
- Contributors can treat those artifacts as generated proof of the public
  runtime and security claims rather than as part of the runtime API itself.

## Invariants

- INV-QUAL-0001
- INV-QUAL-0002
- INV-QUAL-0003
- INV-QUAL-0004
- INV-QUAL-0005
- INV-QUAL-0006
