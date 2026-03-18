# ADR-0001 Compatibility Model Foundation

## Status

- accepted

## Context

- Context: `aegispy` currently exposes one public runtime API across `node`,
  `deno`, `bun`, and `browser`, but the implementation truth is still narrower
  than the long-term compatibility direction.
- Context: current public capability introspection is still `fs/http/env`
  booleans, current server execution is still `server-hardened`, and current
  browser execution is still `browser-real-engine`.
- Context: the project needs one frozen vocabulary for:
  - compatibility matrices
  - package classes
  - the portable common isolation floor
  - browser capability states
- Context: future public support claims must be generated or checked from
  explicit evidence rows instead of broad narrative language.
- Context links affected invariants:
  - `INV-ARCH-0001`
  - `INV-ARCH-0002`
  - `INV-ARCH-0003`
  - `INV-FEAT-0017`
  - `INV-FEAT-0018`

## Decision

- Decision date: `2026-03-18`
- Freeze the compatibility-model vocabulary in
  `tools/architecture-model.v1.json`.
- Freeze these server capability families:
  - `storage`
  - `network`
  - `environment`
  - `process`
  - `handles`
- Freeze these browser capability families:
  - `storage`
  - `network`
  - `fileAccess`
  - `worker`
  - `handles`
- Freeze these package classes:
  - `base_interpreter`
  - `pure_python`
  - `native_platform`
  - `project_overlay`
- Freeze these browser capability states for runtime introspection:
  - `available_granted`
  - `available_denied`
  - `unavailable`
  - `hard_limit`
- Freeze these browser matrix feature states:
  - `available`
  - `unavailable`
  - `hard_limit`
- Freeze these browser matrix permission states:
  - `granted`
  - `denied`
  - `not_requested`
  - `not_applicable`
- Freeze this portable common isolation floor vocabulary:
  - `process_boundary`
  - `immutable_runtime_image`
  - `projected_roots`
  - `guest_temp_root`
  - `environment_allowlist`
  - `resource_ceilings`
  - `brokered_capabilities`
  - `audit_trail`
  - `artifact_integrity`
- Freeze this evidence-status vocabulary:
  - `supported`
  - `unsupported`
  - `prototype`
  - `not_proven`
- Freeze this claim rule:
  - only `supported` matrix rows may feed public support claims
- Keep current public profile names and current `fs/http/env` booleans as
  current implementation truth during this sequence.

## Options

- Option A: keep the vocabulary implicit in scattered docs and artifacts.
  - Rejected because drift would remain easy and public claims would outrun
    evidence.
- Option B: freeze one machine-readable vocabulary and align contributor docs to
  it.
  - Accepted because it gives one reviewable source of truth before the next
    implementation wave.

## Consequences

- Security impact:
  - reduces overclaim risk by forcing support language through explicit evidence
    categories
- Performance impact:
  - negligible runtime cost; only adds docs/check validation
- Compatibility impact:
  - no runtime behavior change in this ADR by itself
  - keeps current profile names and booleans stable while freezing future
    vocabulary
- Operability impact:
  - adds one machine-readable model file and one drift-check script to the
    normal portable check path

## Evidence

- `tools/architecture-model.v1.json`
- `scripts/architecture_model_check.mjs`
- `packages/aegispy-core/test/architecture-model.test.ts`
- `pnpm vitest run packages/aegispy-core/test/architecture-model.test.ts`
- `node scripts/architecture_model_check.mjs`
