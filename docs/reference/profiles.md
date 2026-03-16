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

## `browser-real-engine`

Hosts:

- `browser`

Properties:

- same request/result API shape
- experimental worker-backed real Python execution
- no filesystem, HTTP, or environment capabilities
- stable unsupported-host semantics for browser-unavailable capabilities
- runtime-boundary audit entries before terminal deny events

## Evidence

- `artifacts/e2e/deno-parity.json`
- `artifacts/e2e/bun-parity.json`
- `artifacts/e2e/browser-run.json`
- `artifacts/e2e/host-parity-contract.json`
- `artifacts/compat/profile-conformance.json`
