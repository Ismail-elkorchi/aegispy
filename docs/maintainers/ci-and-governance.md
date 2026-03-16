# CI And Governance

## CI Lanes

- `linux-floor-check`
  - portable docs, workflow policy, lint, format, typecheck, and portable tests
- `host-contracts`
  - explicit host-oriented test suites for `node`, `deno`, `bun`, and
    `browser-subset`
- `linux-check`
  - full Linux truth lane with Rust build, component build, compatibility,
    hardening, and provenance verification
- `macos-smoke`
  - portable smoke on macOS
- `windows-smoke`
  - portable smoke on Windows
- `runtime-latest`
  - non-blocking latest Node, Deno, and Bun canary for the portable and
    host-contract surface

## Runtime Policy

- runtime/toolchain policy lives in `tools/runtime-versions.json`
- CI reads that file instead of hardcoding versions inside workflow steps

## Workflow Hardening

- every workflow must declare top-level `permissions`
- every third-party action ref must be pinned to a full commit SHA
- `pull_request_target` is not allowed for this repository
- the gate lives at `node scripts/workflow_policy_check.mjs`

## GitHub Governance Surface

- review ownership lives in `.github/CODEOWNERS`
- PR scaffolding lives in `.github/pull_request_template.md`
- issue intake lives in `.github/ISSUE_TEMPLATE/`
- release note categorization lives in `.github/release.yml`
- contributor-facing verification commands live in `docs/gates.md`
- repository-admin automation is intentionally maintained outside the product
  repo

## Scope

This document covers the current CI and GitHub governance surface for the
repository. Release automation is documented separately in
`docs/maintainers/release.md`.
