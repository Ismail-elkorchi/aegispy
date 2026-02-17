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
- Runtime bridge: `component-wit-stream` for Python capability requests.
- Component artifact now includes a typed `aegispy:runtime/capability` import contract and worker host-linker bindings.
- File-bridge fallback channel is removed.
- Capability bindings are loaded from runtime-mounted `aegispy.py` and `sitecustomize.py` modules, not pre-execution code injection.
- Native host-import gate command: `AEGISPY_NATIVE_HOST_IMPORT_GATE_MODE=strict bash scripts/native_host_import_check`.
