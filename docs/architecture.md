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
3. Runtime evaluates policy grants for each capability access attempt.
4. WASI worker builds a host capability plan, imports the shipped runtime `aegispy` module from WASI Python, and executes on the fixed `component-wit` channel.
5. Runtime enforces limits for wall time, memory marker, and output bytes.
6. Runtime returns `RunResult` with `meta` and `audit`.

## Capability Channel

- Channel: `component-wit` (fixed default for Node/WASI runtime path).
- Runtime bridge: `component-host-guest-runtime-module-plan-dispatch` (guest module runtime path; no stream bridge).
- Component artifact is composed with a typed native host-import contract (`aegispy:runtime/capability`) and worker linker bindings.
- Native host-import contract is declared in `wit/aegispy.wit` (`world aegispy-runtime` imports `aegispy:runtime/capability`).
- File-bridge request/response channel is removed from the runtime execution path.
- Stream bridge transport is removed; capability calls are dispatched through a host-built runtime plan consumed by the guest module.
- Runtime source-injection bridge loading is removed from default hardened execution; guest bridge code is loaded from the shipped WASI Python runtime module path.
- Worker binding mode defaults to `guest-runtime-abi`; `rewrite` and `rewrite-dispatch` map to explicit legacy rewrite mode.
- Runtime native dynamic module loading is not yet available in the current WASI CPython payload (`dlopen not implemented`), so true guest-callable native host ABI remains blocked until a rebuilt runtime ships.

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
