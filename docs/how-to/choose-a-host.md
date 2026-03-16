# Choose A Host

## Use `node`, `deno`, or `bun` for the hardened path

Choose a server host when you need the real runtime path:

- process transport
- default native process execution mode
- optional experimental `microvm` execution mode through `AEGISPY_WORKER_EXECUTION_MODE=microvm`
- Rust worker
- WASI Python
- `component-wit` capability channel
- runtime-bound policy enforcement

These hosts map to the `server-hardened` profile.

## Use `browser` for the experimental real-engine path

Choose `browser` when you need real Python execution in a browser worker and
can accept the current browser limits:

- experimental worker-backed real-engine execution
- no filesystem, HTTP, or environment capability surface
- stable `AEG-UNSUPPORTED-HOST` behavior when those capabilities are requested
- runtime-bound deny audit ordering that starts with `runtime_channel` and
  `runtime_binding`

This host maps to the `browser-real-engine` profile.

## Decision Rule

- Use `node`, `deno`, or `bun` when you need real interpreter execution.
- Use the default process execution mode unless you already operate a
  compatible microVM launcher.
- Use `browser` only when the experimental browser limits are acceptable and
  explicitly documented to downstream users.
