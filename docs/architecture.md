# Architecture

## Repository Layout

- `packages/aegispy-core` contains contracts, validation, policy evaluation, limits, determinism logic, and runtime factory.
- `packages/aegispy-node` contains protocol framing, Node runtime wiring, and self-test logic.
- `packages/aegispy-browser` contains browser runtime wiring with worker-style timeout behavior.
- `packages/aegispy-deno` and `packages/aegispy-bun` contain host wrappers with process-worker defaults and explicit simulation fallback modes.
- `packages/aegispy-pack` contains package lockfile resolution and registry policy checks.
- `rust/aegispy-worker` contains process-framed request handling plus component-model WASI execution.
- `wit/aegispy.wit` defines capability interface source.

## Runtime Flow

1. Host calls `createRuntime` with a host kind.
2. Runtime validates `RunRequest` shape.
3. `node`, `deno`, and `bun` default to process transport backed by the Rust worker.
   The default execution mode is native process execution, and the same
   process transport can be switched to an experimental `microvm` launcher
   mode with `AEGISPY_WORKER_EXECUTION_MODE=microvm`.
4. The WASI worker imports the shipped runtime `aegispy` module from WASI Python and serves guest capability calls through runtime request/response dispatch to the host ABI on the fixed `component-wit` channel.
5. The server-hardened path enforces runtime-bound capability policy plus limits for wall time, memory marker, and output bytes.
6. The browser real-engine path uses the same request/response contract, runs a
   worker-backed Python engine, and keeps filesystem, HTTP, and environment
   access denied at the runtime boundary.
   Browser package requests are bound to verified lockfile entries, and
   `assetBaseUrl` runs verify pinned Pyodide asset hashes before execution.
7. Runtime returns `RunResult` with `meta` and `audit`.

## Capability Channel

- Channel: `component-wit` (fixed default for the server-hardened runtime path).
- Runtime bridge: `component-host-guest-runtime-native-abi-dispatch` (guest module runtime path using native host ABI request/response frames).
- Component artifact is composed with a typed native host-import contract (`aegispy:runtime/capability`) and worker linker bindings.
- Native host-import contract is declared in `wit/aegispy.wit` (`world aegispy-runtime` imports `aegispy:runtime/capability`).
- File-bridge request/response transport is removed from the runtime path.
- Guest bridge calls are dispatched through native host ABI request/response frames without polling loops.
- Runtime source-injection bridge loading is removed from the default server-hardened execution path; guest bridge code is loaded from the shipped WASI Python runtime module path.
- Worker binding mode is fixed to `guest-runtime-abi`; legacy `rewrite` modes are removed.
- Guest-callable native host ABI is validated through the shipped builtin bridge module path (`engine/python/aegispy/__init__.py`) without `dlopen` dependency.

## Worker Protocol

- Frame format: 4-byte unsigned big-endian length prefix plus UTF-8 JSON bytes.
- Request envelope: `type=run`, `requestId`, `run` payload.
- Response envelope: `type=run_result`, `requestId`, `result` payload.

## Evidence Map

- `artifacts/tests/protocol-framing.json`
- `artifacts/tests/node-adapter.json`
- `artifacts/e2e/node-run.json`
- `artifacts/e2e/browser-run.json`
- `artifacts/security/replay-attestation.json`
- `artifacts/security/protocol-framing-fuzz.json`
- `artifacts/security/browser-input-fuzz.json`
- `artifacts/security/microvm-execution.json` when a compatible self-hosted
  microVM launcher is configured

## Invariants

- INV-ARCH-0001
- INV-ARCH-0002
- INV-ARCH-0003
- INV-ARCH-0004
- INV-ARCH-0005
- INV-ARCH-0006
