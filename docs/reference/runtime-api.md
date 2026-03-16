# Runtime API

## Core Entry Points

- `createRuntime({ host })`
- `createBrowserRuntime(options?)` from `@aegispy/browser`
- `runtime.capabilities()`
- `runtime.run(RunRequest)`
- `runtime.close()`

## Browser Runtime Options

`createBrowserRuntime(options?)` accepts:

- `engine?: "pyodide"`
- `assetBaseUrl?: string`
- `packages?: string[]`
- `packageLockfile?: Lockfile`

When `packages` are requested in `browser-real-engine`, `packageLockfile`
becomes an active runtime boundary:

- requested browser packages must be backed by verified lockfile entries
- lockfile hash mismatches fail closed with `AEG-ENGINE`
- when `assetBaseUrl` is set, the browser runtime also verifies pinned Pyodide
  asset hashes before guest code runs

## Host Kinds

- `node`
- `deno`
- `bun`
- `browser`

## Server Execution Mode

The server hosts keep the same public transport surface while exposing one
shared execution-mode switch through the environment:

- `AEGISPY_WORKER_EXECUTION_MODE=process` keeps the default native process path
- `AEGISPY_WORKER_EXECUTION_MODE=microvm` selects the experimental launcher-backed
  microVM path for `node`, `deno`, and `bun`

When `microvm` mode is selected without a compatible launcher, the runtime
fails closed with `AEG-ENGINE` before guest code runs.

## Request Shape

`RunRequest` includes:

- `host`
- `code`
- `argv`
- `stdinUtf8`
- `permissions`
- `limits`
- `determinism`

## Result Shape

`RunResult` includes:

- `status`
- `exitCode`
- `stdoutUtf8`
- `stderrUtf8`
- `meta`
- `error` when `status === "error"`

## Boundary Denials

- server-host capability denials keep `AEG-POLICY-DENIED` with
  `termination=policy_denied`
- `browser-real-engine` rejects filesystem, HTTP, and environment permission
  grants with `AEG-UNSUPPORTED-HOST` and `termination=policy_denied`
- `browser-real-engine` returns `AEG-ENGINE` before execution when browser
  package integrity or pinned engine-asset verification fails
- runtime-bound deny results start with runtime-boundary audit entries before
  the terminal denial event
  - `runtime_channel`
  - `runtime_binding`

## Capability Introspection

`runtime.capabilities()` returns the effective host contract, including:

- `profile`
- `transport`
- `capabilityChannel`
- `fs`
- `http`
- `env`
- `deterministic`
- `hardened`

See `docs/reference/profiles.md` and `docs/support-matrix.md` for the current
host-specific behavior.
