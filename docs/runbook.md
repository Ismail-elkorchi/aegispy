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
- Runtime bridge: `component-host-guest-runtime-module-plan-dispatch` (guest module runtime path; no stream bridge).
- Component artifact now includes a typed `aegispy:runtime/capability` import contract and worker host-linker bindings.
- File-bridge fallback channel is removed.
- Capability calls are served by a host-built runtime plan consumed by the guest `aegispy` module imported from the shipped WASI Python runtime path.
- Runtime source-injection bridge loading is not used by the default hardened path.
- Worker capability binding mode is controlled by `AEGISPY_WORKER_CAPABILITY_BINDING_MODE`:
- `guest-runtime-abi` is default and enforced.
- `rewrite` and `rewrite-dispatch` select explicit legacy rewrite mode.
- Native host-import gate command: `AEGISPY_NATIVE_HOST_IMPORT_GATE_MODE=strict bash scripts/native_host_import_check`.
- Native dynamic extension loader gap probe: `node scripts/runtime_native_abi_gap_probe.mjs`.
- Current blocker evidence: `artifacts/research/runtime-native-abi-gap.json` reports `dlopen_not_implemented`.
