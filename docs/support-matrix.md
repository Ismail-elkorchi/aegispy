# Support Matrix

## Conformance Profiles

| Profile           | Hosts                 | Purpose                                                                            |
| ----------------- | --------------------- | ---------------------------------------------------------------------------------- |
| `server-hardened` | `node`, `deno`, `bun` | Hardened runtime path with real worker execution and component capability channel. |
| `browser-subset`  | `browser`             | Same API surface with a strict subset execution model for browser constraints.     |

## Host Status

| Host    | Profile         | Runtime Path                                    | Status | Exception Tag    |
| ------- | --------------- | ----------------------------------------------- | ------ | ---------------- |
| node    | server-hardened | Process transport with component capability ABI | pass   | none             |
| deno    | server-hardened | Process transport with component capability ABI | pass   | none             |
| bun     | server-hardened | Process transport with component capability ABI | pass   | none             |
| browser | browser-subset  | Browser worker timeout boundary                 | pass   | `browser-subset` |

## Capability Status

| Capability             | node                        | deno                        | bun                         | browser                                                  |
| ---------------------- | --------------------------- | --------------------------- | --------------------------- | -------------------------------------------------------- |
| fs                     | gated by `permissions.fs`   | gated by `permissions.fs`   | gated by `permissions.fs`   | unsupported in `browser-subset` (`AEG-UNSUPPORTED-HOST`) |
| http                   | gated by `permissions.http` | gated by `permissions.http` | gated by `permissions.http` | unsupported in `browser-subset` (`AEG-UNSUPPORTED-HOST`) |
| env                    | gated by `permissions.env`  | gated by `permissions.env`  | gated by `permissions.env`  | unsupported in `browser-subset` (`AEG-UNSUPPORTED-HOST`) |
| deterministic time/rng | supported                   | supported                   | supported                   | supported                                                |

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
