# Architecture

## Repository Layout

- `packages/aegispy-core` contains contracts, validation, policy evaluation, limits, determinism logic, and runtime factory.
- `packages/aegispy-node` contains protocol framing, Node runtime wiring, and self-test logic.
- `packages/aegispy-browser` contains browser runtime wiring with worker-style timeout behavior.
- `packages/aegispy-deno` and `packages/aegispy-bun` contain host wrappers with contract parity.
- `packages/aegispy-pack` contains package lockfile resolution and registry policy checks.
- `rust/aegispy-worker` contains framed protocol worker code.
- `wit/aegispy.wit` defines capability interface source.

## Runtime Flow

1. Host calls `createRuntime` with a host kind.
2. Runtime validates `RunRequest` shape.
3. Runtime evaluates policy grants for each capability access attempt.
4. Runtime enforces limits for wall time, memory marker, and output bytes.
5. Runtime returns `RunResult` with `meta` and `audit`.

## Worker Protocol

- Frame format: 4-byte unsigned big-endian length prefix plus UTF-8 JSON bytes.
- Request envelope: `type=run`, `requestId`, `run` payload.
- Response envelope: `type=run_result`, `requestId`, `result` payload.

## Evidence Map

- `artifacts/tests/protocol-framing.json`
- `artifacts/tests/node-adapter.json`
- `artifacts/e2e/node-run.json`
- `artifacts/e2e/browser-run.json`

## Invariants

- INV-ARCH-0001
- INV-ARCH-0002
- INV-ARCH-0003
- INV-ARCH-0004
- INV-ARCH-0005
- INV-ARCH-0006
