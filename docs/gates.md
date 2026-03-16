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
- `pnpm run test:browser-subset`
- `pnpm run test:server-hosts`
- `pnpm run test:host-contracts`

## Release Claim Gate

- `bash scripts/release_claims_check` runs the release-grade claim gate and
  writes `artifacts/gates/release-claims.json`.

## Evidence Output

- Verification writes generated evidence under `artifacts/gates/`,
  `artifacts/security/`, `artifacts/compat/`, `artifacts/e2e/`, and
  `artifacts/tests/`.
- Contributors can treat those artifacts as generated proof of the public
  runtime and security claims rather than as part of the runtime API itself.

## Invariants

- INV-QUAL-0001
- INV-QUAL-0002
- INV-QUAL-0003
- INV-QUAL-0004
- INV-QUAL-0005
- INV-QUAL-0006
