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
- Output artifact: `artifacts/component/build.json`.

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
