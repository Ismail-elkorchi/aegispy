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
- `scripts/component_artifact_check`
- `scripts/native_host_import_check`
- `scripts/supply_chain_check`
- `scripts/provenance_verify_check`
- `scripts/kernel_isolation_check`
- `scripts/profile_conformance_check`
- `scripts/compat_check`
- `scripts/native_abi_adversarial_check`
- `scripts/native_abi_fuzz_check`

## Release Claim Gate

- `bash scripts/release_claims_check` runs:

1. `node scripts/release_evidence.mjs`
2. `pnpm component:build`
3. `scripts/component_artifact_check`
4. `AEGISPY_NATIVE_HOST_IMPORT_GATE_MODE=strict scripts/native_host_import_check`
5. `scripts/supply_chain_check`
6. `AEGISPY_PROVENANCE_VERIFY_REQUIRED=1 scripts/provenance_verify_check`
7. `scripts/kernel_isolation_check`
8. `scripts/claim_alignment_check`
9. `scripts/benchmarks_check`
10. `scripts/security_claims_check`
11. `scripts/runtime_guest_abi_probe.mjs`
12. `scripts/runtime_native_abi_gap_probe.mjs`
13. `scripts/real_execution_check`
14. `scripts/profile_conformance_check`
15. `scripts/compat_check`
16. `scripts/native_abi_adversarial_check`
17. `scripts/native_abi_fuzz_check`

- Output artifact: `artifacts/gates/release-claims.json`.

## Required Evidence Files

- `artifacts/benchmarks/core-run.json`
- `artifacts/compat/stdlib-smoke.json`
- `artifacts/compat/profile-conformance.json`
- `artifacts/compat/agent-workload-corpus.json`
- `artifacts/security/runtime-policy-denials.json`
- `artifacts/security/isolation-profile.json`
- `artifacts/security/native-abi-adversarial.json`
- `artifacts/security/native-abi-fuzz.json`
- `artifacts/security/supply-chain-sbom.json`
- `artifacts/security/supply-chain-attestation.json`
- `artifacts/security/provenance-verification.json`
- `artifacts/security/kernel-isolation-runtime.json`
- `artifacts/tests/real-engine-default.json`
- `artifacts/component/build.json`
- `artifacts/gates/component-artifact-check.json`
- `artifacts/gates/native-host-import-check.json`
- `artifacts/gates/claim-alignment-check.json`
- `artifacts/gates/real-execution-check.json`
- `artifacts/gates/profile-conformance-check.json`
- `artifacts/gates/native-abi-adversarial-check.json`
- `artifacts/gates/native-abi-fuzz-check.json`
- `artifacts/gates/supply-chain-check.json`
- `artifacts/gates/provenance-verify-check.json`
- `artifacts/gates/kernel-isolation-check.json`
- `artifacts/research/runtime-native-abi-gap.json`

## Invariants

- INV-QUAL-0001
- INV-QUAL-0002
- INV-QUAL-0003
- INV-QUAL-0004
- INV-QUAL-0005
- INV-QUAL-0006
