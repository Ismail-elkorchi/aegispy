# Runbook

## Setup

1. Install Node.js 24.
2. Install pnpm 9.
3. Install Rust stable toolchain.

## Local Verification

1. Run `pnpm install`.
2. Run `pnpm wit:codegen`.
3. Run `pnpm engine:build`.
4. Run `bash scripts/check`.
5. Run `bash scripts/release_claims_check`.
6. Run `bash scripts/profile_conformance_check` when validating profile-scoped claims independently.

## Component Build

- Run `pnpm component:build`.
- Run `bash scripts/component_artifact_check`.
- Output artifacts:
  - `artifacts/component/build.json`
  - `artifacts/component/aegispy.component.wasm`
  - `artifacts/component/interface.wit`
  - `artifacts/gates/component-artifact-check.json`

## Self-Test

- Run `pnpm selftest`.
- Output artifact: `artifacts/tests/selftest.json`.

## Error Taxonomy

- `AEG-POLICY-DENIED`
- `AEG-TIMEOUT`
- `AEG-MEMORY-LIMIT`
- `AEG-OUTPUT-LIMIT`
- `AEG-ENGINE`
- `AEG-INVALID-REQUEST`

## Capability Channel Controls

- Channel: `component-wit` (runtime default and enforced path).
- Conformance profiles:
- `server-hardened` for `node`/`deno`/`bun`.
- `browser-subset` for `browser`.
- Runtime bridge: `component-host-guest-runtime-native-abi-dispatch` (guest module runtime path with native host ABI frame dispatch).
- Component artifact now includes a typed `aegispy:runtime/capability` import contract and worker host-linker bindings.
- Guest runtime dispatch uses native host ABI request/response frames at execution time.
- Runtime source-injection bridge loading is not used by the default hardened path.
- Worker capability binding mode is controlled by `AEGISPY_WORKER_CAPABILITY_BINDING_MODE`:
- `guest-runtime-abi` is default and enforced.
- `rewrite` and `rewrite-dispatch` are rejected (legacy mode removed).
- Native host-import gate command: `AEGISPY_NATIVE_HOST_IMPORT_GATE_MODE=strict bash scripts/native_host_import_check`.
- Native dynamic extension loader gap probe: `node scripts/runtime_native_abi_gap_probe.mjs`.
- Native ABI readiness evidence: `artifacts/research/runtime-native-abi-gap.json` reports `runtimeNativeAbiAvailable: true` and `dlopenDependencyRequired: false`.
- Profile conformance gate output: `artifacts/gates/profile-conformance-check.json`.
