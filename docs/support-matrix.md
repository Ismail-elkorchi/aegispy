# Support Matrix

## Host Status

| Host    | Runtime Path                                   | Status | Exception Tag |
| ------- | ---------------------------------------------- | ------ | ------------- |
| node    | Node adapter with framed worker protocol       | pass   | none          |
| deno    | Deno adapter with framed worker protocol       | pass   | none          |
| bun     | Bun adapter with framed worker protocol        | pass   | none          |
| browser | Browser adapter with worker-style timeout race | pass   | none          |

## Capability Status

| Capability             | node                        | deno                        | bun                         | browser                     |
| ---------------------- | --------------------------- | --------------------------- | --------------------------- | --------------------------- |
| fs                     | gated by `permissions.fs`   | gated by `permissions.fs`   | gated by `permissions.fs`   | gated by `permissions.fs`   |
| http                   | gated by `permissions.http` | gated by `permissions.http` | gated by `permissions.http` | gated by `permissions.http` |
| env                    | gated by `permissions.env`  | gated by `permissions.env`  | gated by `permissions.env`  | gated by `permissions.env`  |
| deterministic time/rng | supported                   | supported                   | supported                   | supported                   |

## Parity Evidence

- `artifacts/e2e/deno-parity.json`
- `artifacts/e2e/bun-parity.json`
- `artifacts/e2e/host-parity-contract.json`

## Invariants

- INV-FEAT-0017
- INV-FEAT-0018
- INV-FEAT-0025
