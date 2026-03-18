# Support Matrix

This page keeps two truths separate:

- current implementation truth
- frozen compatibility-model vocabulary for future matrix-backed claims

## Conformance Profiles

| Profile               | Hosts                 | Purpose                                                                             |
| --------------------- | --------------------- | ----------------------------------------------------------------------------------- |
| `server-hardened`     | `node`, `deno`, `bun` | Real process/WASI/component runtime path with runtime-bound capability enforcement. |
| `browser-real-engine` | `browser`             | Experimental worker-backed real Python execution with explicit capability limits.   |

## Host Status

| Host    | Profile             | Runtime Path                                                                       | Status       | Exception Tag                |
| ------- | ------------------- | ---------------------------------------------------------------------------------- | ------------ | ---------------------------- |
| node    | server-hardened     | Process transport with native-process default and optional `microvm` launcher mode | pass         | none                         |
| deno    | server-hardened     | Process transport with native-process default and optional `microvm` launcher mode | pass         | none                         |
| bun     | server-hardened     | Process transport with native-process default and optional `microvm` launcher mode | pass         | none                         |
| browser | browser-real-engine | Worker-backed real Python engine                                                   | experimental | `browser-capability-limited` |

## Capability Status

| Capability             | node                        | deno                        | bun                         | browser                                                       |
| ---------------------- | --------------------------- | --------------------------- | --------------------------- | ------------------------------------------------------------- |
| fs                     | gated by `permissions.fs`   | gated by `permissions.fs`   | gated by `permissions.fs`   | unsupported in `browser-real-engine` (`AEG-UNSUPPORTED-HOST`) |
| http                   | gated by `permissions.http` | gated by `permissions.http` | gated by `permissions.http` | unsupported in `browser-real-engine` (`AEG-UNSUPPORTED-HOST`) |
| env                    | gated by `permissions.env`  | gated by `permissions.env`  | gated by `permissions.env`  | unsupported in `browser-real-engine` (`AEG-UNSUPPORTED-HOST`) |
| deterministic time/rng | supported                   | supported                   | supported                   | supported                                                     |

These booleans remain current implementation truth while the contributor-facing
compatibility model expands through additive capability families.

## Frozen Package Classes

Future package evidence and support rows are grouped by package classes:

- `base_interpreter`
- `pure_python`
- `native_platform`
- `project_overlay`

Current implementation truth for server package layers:

- locked `pure_python` package layers are supported on `node`, `deno`, and
  `bun` when the request includes a verified `packageLockfile`
- current proven server pure-Python import set is:
  - `attrs`
  - `jinja2`
  - `jsonschema`
  - `packaging`
- native package classes remain outside the current supported server package
  layer surface

## Portable Common Isolation Floor

Future cross-OS claims must start from the portable common isolation floor:

- `process_boundary`
- `immutable_runtime_image`
- `projected_roots`
- `guest_temp_root`
- `environment_allowlist`
- `resource_ceilings`
- `brokered_capabilities`
- `audit_trail`
- `artifact_integrity`

Stronger host-specific claims remain additive OS-specific strengthening claims.

## Workload Classification

Generated workload coverage is grouped into:

- `core-stdlib`
- `text-stdlib`
- `data-stdlib`
- `numeric-stdlib`
- `capability-fs`
- `capability-http`
- `capability-env`
- `policy`
- `resource-limits`

The compatibility gate currently enforces a 28-workload cross-host corpus plus
5 pinned package fixtures, with 3 of those fixtures executed through the
browser real-engine path.

## Stable Reason Codes

- `supported` for workloads that satisfy the contract
- `unsupported_browser_capability` for browser workloads that require `fs`,
  `http`, or `env`
- `policy_denied_expected` for correct deny-by-default enforcement
- `output_limit_expected` for correct output-limit enforcement
- `timeout_expected` for correct wall-clock timeout enforcement
- failure codes such as `browser_engine_timeout`,
  `capability_channel_not_component_wit`, or `stdlib_digest_missing` when a
  host diverges from the expected contract

## Matrix-Backed Claims

Future contributor-facing support statements must be matrix-backed.

The frozen evidence status vocabulary is:

- `supported`
- `unsupported`
- `prototype`
- `not_proven`

Only `supported` rows may feed public support claims.

## Parity Evidence

- `artifacts/e2e/deno-parity.json`
- `artifacts/e2e/bun-parity.json`
- `artifacts/e2e/host-parity-contract.json`
- `artifacts/compat/profile-conformance.json`
- `artifacts/compat/agent-workload-corpus.json`
- `artifacts/compat/workload-compatibility-matrix.json`
- `artifacts/compat/package-fixture-lockfiles.json` now mixes
  `metadata-only` proof with browser-executed fixture families for `micropip`,
  `packaging`, and `jinja2` plus `markupsafe`
- `artifacts/security/replay-attestation.json`
- `artifacts/security/browser-integrity-fuzz.json`
- `artifacts/security/native-abi-adversarial.json`
- `artifacts/security/native-abi-fuzz.json`
- `artifacts/security/kernel-isolation-runtime.json`
- `artifacts/security/microvm-execution.json` when a compatible self-hosted
  launcher is present

See `docs/reference/compatibility-matrix.md` for the generated workload-family
and reason-code details.

## Invariants

- INV-FEAT-0017
- INV-FEAT-0018
- INV-FEAT-0025
