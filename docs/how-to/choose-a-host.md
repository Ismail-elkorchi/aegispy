# Choose A Host

## Use `node`, `deno`, or `bun` for the hardened path

Choose a server host when you need the real runtime path:

- process transport
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

This host maps to the `browser-real-engine` profile.

## Decision Rule

- Use `node`, `deno`, or `bun` when you need real interpreter execution.
- Use `browser` only when the experimental browser limits are acceptable and
  explicitly documented to downstream users.
