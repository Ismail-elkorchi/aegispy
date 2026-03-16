# Support Matrix

## Conformance Profiles

| Profile               | Hosts                 | Purpose                                                                             |
| --------------------- | --------------------- | ----------------------------------------------------------------------------------- |
| `server-hardened`     | `node`, `deno`, `bun` | Real process/WASI/component runtime path with runtime-bound capability enforcement. |
| `browser-real-engine` | `browser`             | Experimental worker-backed real Python execution with explicit capability limits.   |

## Host Status

| Host    | Profile             | Runtime Path                                    | Status       | Exception Tag                |
| ------- | ------------------- | ----------------------------------------------- | ------------ | ---------------------------- |
| node    | server-hardened     | Process transport with component capability ABI | pass         | none                         |
| deno    | server-hardened     | Process transport with component capability ABI | pass         | none                         |
| bun     | server-hardened     | Process transport with component capability ABI | pass         | none                         |
| browser | browser-real-engine | Worker-backed real Python engine                | experimental | `browser-capability-limited` |

## Capability Status

| Capability             | node                        | deno                        | bun                         | browser                                                       |
| ---------------------- | --------------------------- | --------------------------- | --------------------------- | ------------------------------------------------------------- |
| fs                     | gated by `permissions.fs`   | gated by `permissions.fs`   | gated by `permissions.fs`   | unsupported in `browser-real-engine` (`AEG-UNSUPPORTED-HOST`) |
| http                   | gated by `permissions.http` | gated by `permissions.http` | gated by `permissions.http` | unsupported in `browser-real-engine` (`AEG-UNSUPPORTED-HOST`) |
| env                    | gated by `permissions.env`  | gated by `permissions.env`  | gated by `permissions.env`  | unsupported in `browser-real-engine` (`AEG-UNSUPPORTED-HOST`) |
| deterministic time/rng | supported                   | supported                   | supported                   | supported                                                     |

## Parity Evidence

- `artifacts/e2e/deno-parity.json`
- `artifacts/e2e/bun-parity.json`
- `artifacts/e2e/host-parity-contract.json`
- `artifacts/compat/profile-conformance.json`
- `artifacts/compat/agent-workload-corpus.json`
- `artifacts/security/native-abi-adversarial.json`
- `artifacts/security/native-abi-fuzz.json`

## Invariants

- INV-FEAT-0017
- INV-FEAT-0018
- INV-FEAT-0025
