# Architecture

## Compatibility Foundation

`aegispy` keeps one public runtime API across `node`, `deno`, `bun`, and
`browser`, while separating current implementation truth from the frozen
compatibility vocabulary that future work must follow.

Current implementation truth:

- `server-hardened` remains the current server profile
- `browser-real-engine` remains the current browser profile
- `runtime.capabilities()` still exposes `fs/http/env` booleans

Frozen compatibility-model truth:

- long-term server claim family: `server bundled compatibility runtime`
- long-term browser claim family: `browser native capability runtime`
- future support claims must be matrix-backed
- future cross-OS claims must start from a portable common isolation floor with
  OS-specific strengthening claims above it
- future package evidence must be grouped by explicit package classes:
  - `base_interpreter`
  - `pure_python`
  - `native_platform`
  - `project_overlay`

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
5. The server-hardened path enforces runtime-bound capability policy plus the
   strict-profile limit envelope for wall, CPU, memory, stdout, stderr, and
   environment access.
6. The browser real-engine path uses the same request/response contract, runs a
   worker-backed Python engine, and keeps filesystem, HTTP, and environment
   access denied at the runtime boundary.
   Browser package requests are bound to verified lockfile entries, and
   `assetBaseUrl` verifies pinned browser engine assets before execution.
7. Runtime returns `RunResult` with `meta` and `audit`.

## Compatibility Matrices

The frozen architecture model defines future evidence rows for:

- server:
  - `host`
  - `os`
  - `arch`
  - `runtimeFamily`
  - `packageClass`
  - `capabilityFamily`
  - `isolationFloorVersion`
  - `evidenceStatus`
- browser:
  - `browserEngine`
  - `browserVersionBand`
  - `capabilityFamily`
  - `featureState`
  - `permissionState`
  - `packageClass`
  - `evidenceStatus`

Only `supported` matrix rows may feed public support claims.

## Isolation Claims

The contributor-facing architecture now distinguishes:

- portable common isolation floor
- OS-specific strengthening claims

The portable common isolation floor is frozen around:

- `process_boundary`
- `immutable_runtime_image`
- `projected_roots`
- `guest_temp_root`
- `environment_allowlist`
- `resource_ceilings`
- `brokered_capabilities`
- `audit_trail`
- `artifact_integrity`

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

## Frozen Capability Families

The current public booleans remain current implementation truth. Future work is
constrained by frozen capability families:

- server:
  - `storage`
  - `network`
  - `environment`
  - `process`
  - `handles`
- browser:
  - `storage`
  - `network`
  - `fileAccess`
  - `worker`
  - `handles`

## Evidence Map

- `artifacts/tests/protocol-framing.json`
- `artifacts/tests/node-adapter.json`
- `artifacts/e2e/node-run.json`
- `artifacts/e2e/browser-run.json`
- `artifacts/security/runtime-policy-denials.json`
- `artifacts/security/isolation-profile.json`
- `artifacts/security/isolation-limit-denials.json`
- `artifacts/security/kernel-isolation-runtime.json`
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
