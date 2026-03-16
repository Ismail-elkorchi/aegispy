# Support Matrix

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

## Stable Reason Codes

- `supported` for workloads that satisfy the contract
- `unsupported_browser_capability` for browser workloads that require `fs`,
  `http`, or `env`
- `policy_denied_expected` for correct deny-by-default enforcement
- `output_limit_expected` for correct output-limit enforcement
- failure codes such as `browser_engine_timeout`,
  `capability_channel_not_component_wit`, or `stdlib_digest_missing` when a
  host diverges from the expected contract

## Parity Evidence

- `artifacts/e2e/deno-parity.json`
- `artifacts/e2e/bun-parity.json`
- `artifacts/e2e/host-parity-contract.json`
- `artifacts/compat/profile-conformance.json`
- `artifacts/compat/agent-workload-corpus.json`
- `artifacts/compat/workload-compatibility-matrix.json`
- `artifacts/compat/package-fixture-lockfiles.json`
- `artifacts/security/replay-attestation.json`
- `artifacts/security/browser-integrity-fuzz.json`
- `artifacts/security/native-abi-adversarial.json`
- `artifacts/security/native-abi-fuzz.json`
- `artifacts/security/microvm-execution.json` when a compatible self-hosted
  launcher is present

See `docs/reference/compatibility-matrix.md` for the generated workload-family
and reason-code details.

## Invariants

- INV-FEAT-0017
- INV-FEAT-0018
- INV-FEAT-0025
