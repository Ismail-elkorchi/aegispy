# Gates

## Main Gate Entrypoint

- `bash scripts/check` runs lint, format check, typecheck, tests, Rust checks, and gate scripts.

## Gate Scripts

- `scripts/banned_token_scan`
- `scripts/req_coverage_check`
- `scripts/entrypoint_check`
- `scripts/core_io_scan`
- `scripts/docs_check`
- `scripts/claim_alignment_check`
- `scripts/repo_layout_check`
- `scripts/dependency_boundary_check`
- `scripts/no_control_plane_ref_check`
- `scripts/no_stub_path_check`

## Release Claim Gate

- `bash scripts/release_claims_check` runs:

1. `node scripts/release_evidence.mjs`
2. `scripts/claim_alignment_check`
3. `scripts/benchmarks_check`
4. `scripts/security_claims_check`
5. `scripts/real_execution_check`
6. `scripts/compat_check`

- Output artifact: `artifacts/gates/release-claims.json`.

## Required Evidence Files

- `artifacts/benchmarks/core-run.json`
- `artifacts/compat/stdlib-smoke.json`
- `artifacts/security/runtime-policy-denials.json`
- `artifacts/security/isolation-profile.json`
- `artifacts/tests/real-engine-default.json`
- `artifacts/gates/claim-alignment-check.json`
- `artifacts/gates/real-execution-check.json`

## Invariants

- INV-QUAL-0001
- INV-QUAL-0002
- INV-QUAL-0003
- INV-QUAL-0004
- INV-QUAL-0005
- INV-QUAL-0006
