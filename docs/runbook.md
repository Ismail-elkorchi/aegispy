# Runbook

## Setup

1. Install Node.js 24.
2. Install pnpm 9.
3. Install Rust stable toolchain.

## Local Verification

1. Run `pnpm install`.
2. Run `pnpm wit:codegen`.
3. Run `pnpm engine:build`.
4. Run `pnpm run check:portable`.
5. Run `pnpm run test:host-contracts`.
6. Run `pnpm run check`.
7. Run `bash scripts/release_claims_check`.
8. Run `bash scripts/profile_conformance_check` when validating profile-scoped claims independently.

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

## CI Topology

- `linux-floor-check` runs the portable verification surface against the floor
  Node policy.
- `host-contracts` runs explicit host-oriented suites for `node`, `deno`,
  `bun`, and `browser-subset`.
- `linux-check` runs the full Linux truth lane and provenance verification.
- `macos-smoke` and `windows-smoke` run the portable smoke surface.
- `runtime-latest` is a non-blocking latest-Node canary.

## Error Taxonomy

- `AEG-POLICY-DENIED`
- `AEG-TIMEOUT`
- `AEG-MEMORY-LIMIT`
- `AEG-OUTPUT-LIMIT`
- `AEG-ENGINE`
- `AEG-INVALID-REQUEST`

## Capability Channel Controls

- Channel: `component-wit` (server-hardened runtime default and enforced path).
- Conformance profiles:
- `server-hardened` for `node`/`deno`/`bun`.
- `browser-subset` for `browser`.
- `browser-subset` is intentionally a simulated timeout-bounded subset and is not described as a real browser Python engine.
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
