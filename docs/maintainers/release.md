# Release

## Purpose

This repository now keeps a repo-level release surface for tags, GitHub
releases, changelog sections, and release audits.

## Local Checks

Before cutting a release tag:

1. Run `pnpm install --frozen-lockfile`.
2. Run `pnpm run check`.
3. Run `pnpm run release:gate -- v0.0.0` with the tag you intend to cut.
4. Run `pnpm run release:rehearsal -- --tag v0.0.0` to stage a non-publishing
   release rehearsal.
5. Run `pnpm run release:audit`.

## Rehearsal

- `.github/workflows/release-rehearsal.yml` is a manual, non-publishing
  release rehearsal.
- It stages release notes, a source archive, SBOM and supply-chain evidence,
  attests the source archive plus the shipped runtime artifacts, verifies the
  provenance bundle, finalizes `artifacts/security/release-rehearsal.json`,
  and runs `pnpm run release:claims`.
- `pnpm run release:claims` is strict about provenance. It is expected to pass
  in the rehearsal workflow after the provenance bundle is staged and verified.

## Files

- `CHANGELOG.md`
- `.github/release.yml`
- `.github/workflows/release-rehearsal.yml`
- `.github/workflows/release.yml`
- `.github/workflows/release-audit.yml`
- `scripts/release-version.mjs`
- `scripts/release-gate.mjs`
- `scripts/release-rehearsal.mjs`
- `scripts/changelog-section.mjs`
- `scripts/release-audit.mjs`

## Release Flow

1. Update `CHANGELOG.md`.
2. Ensure the repo release version remains aligned across the root package,
   workspace packages, and the worker crate.
3. Run the manual release rehearsal to verify the release path without
   publishing.
4. Create a `v`-prefixed tag that matches that shared version.
5. Let `release.yml` rerun the full truth lane and create the GitHub release.

## Audit

- `release-audit.yml` runs on a schedule and manual dispatch.
- The audit is intentionally quiet before the first real release exists.
- Once releases exist, it verifies tag, changelog, and GitHub release parity.
