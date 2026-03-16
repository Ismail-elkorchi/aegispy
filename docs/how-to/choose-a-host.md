# Choose A Host

## Use `node`, `deno`, or `bun` for the hardened path

Choose a server host when you need the real runtime path:

- process transport
- Rust worker
- WASI Python
- `component-wit` capability channel
- runtime-bound policy enforcement

These hosts map to the `server-hardened` profile.

## Use `browser` only for the documented subset

Choose `browser` when you need the same API shape but can accept the current
restricted browser profile:

- simulated timeout-bounded execution
- no filesystem, HTTP, or environment capability surface
- stable `AEG-UNSUPPORTED-HOST` behavior for unsupported capabilities

This host maps to the `browser-subset` profile.

## Decision Rule

- Use `node`, `deno`, or `bun` when you need real interpreter execution.
- Use `browser` only when the subset constraints are acceptable and
  explicitly documented to downstream users.
