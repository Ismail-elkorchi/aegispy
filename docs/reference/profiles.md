# Profiles

## `server-hardened`

Hosts:

- `node`
- `deno`
- `bun`

Properties:

- real process/WASI/component runtime path
- capability enforcement at the runtime boundary
- `component-wit` capability channel
- explicit denial semantics for filesystem, HTTP, and environment permissions

## `browser-subset`

Hosts:

- `browser`

Properties:

- same request/result API shape
- simulated timeout-bounded execution path
- no filesystem, HTTP, or environment capabilities
- stable unsupported-host semantics

## Evidence

- `artifacts/e2e/deno-parity.json`
- `artifacts/e2e/bun-parity.json`
- `artifacts/e2e/browser-run.json`
- `artifacts/e2e/host-parity-contract.json`
- `artifacts/compat/profile-conformance.json`
