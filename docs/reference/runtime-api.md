# Runtime API

## Core Entry Points

- `createRuntime({ host })`
- `createBrowserRuntime(options?)` from `@aegispy/browser`
- `runtime.capabilities()`
- `runtime.run(RunRequest)`
- `runtime.close()`

## Server Runtime Options

`createRuntime(options)` accepts these additive server options on `node`,
`deno`, and `bun`:

- `projectRoots?: string[]`
- `tempRoot?: string`
- `packages?: string[]`
- `packageLockfile?: Lockfile`

When process transport is active:

- `projectRoots` are projected into stable internal guest paths and prepended to
  the guest import path in the order provided
- the writable guest import area is also projected into the guest import path
- `tempRoot`, when provided, becomes the backing host directory for the guest
  temp root exposed as `/tmp`
- requested server packages must be backed by a verified `packageLockfile`
- server package-layer requests fail closed with `AEG-ENGINE` when the
  lockfile is missing, tampered, unpinned, or requests a package class that the
  current server runtime does not support
- the current server package-layer path is limited to locked `pure_python`
  packages projected into read-only guest import roots plus target-specific
  `native_platform` packages on supported targets
- the runtime audit includes:
  - `runtime_projection`
  - `runtime_temp_root`

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
- when `assetBaseUrl` is set, the browser runtime also verifies pinned browser
  engine asset hashes before guest code runs

## Compatibility Vocabulary

Current implementation truth:

- `runtime.capabilities()` still returns `fs`, `http`, and `env` booleans
- `server-hardened` and `browser-real-engine` remain the current profile names

Frozen compatibility vocabulary:

- future additive capability families are frozen for contributor-facing design
  work
- future support claims must be matrix-backed
- only `supported` evidence rows may feed public support claims
- future cross-OS support language must start from the portable common isolation floor and then add host-specific strengthening claims

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
- `runtimeFamily`
- `bundleId`
- `pythonAbi`
- `packageSetVersion`
- `portableIsolationFloorVersion`
- `hostStrengthening`
- `capabilityFamilies`
- `fs`
- `http`
- `env`
- `deterministic`
- `hardened`

These fields remain current implementation truth during the current
compatibility sequence.

Current portable-floor reporting rules:

- server process transport reports `portableIsolationFloorVersion` for the
  current portable common-floor draft
- `hostStrengthening` stays additive:
  - Linux currently reports the strict kernel-control strengthening lane
  - other hosts remain conservative until stronger proof lands publicly

Current browser capability-family reporting:

- `browser-real-engine` now reports `capabilityFamilies` through typed browser
  capability states
- current browser state map:
  - `storage`: `unavailable`
  - `network`: `unavailable`
  - `fileAccess`: `unavailable`
  - `worker`: `available_granted`
  - `handles`: `unavailable`
- `available_denied` remains reserved for future browser features that exist in
  the runtime but are blocked by permission or user gesture
- `hard_limit` remains reserved for browser-impossible categories, not for
  implementation gaps

Future additive capability families are frozen as:

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

The browser capability-state vocabulary is also frozen for future additive
introspection:

- `available_granted`
- `available_denied`
- `unavailable`
- `hard_limit`

See `docs/reference/profiles.md` and `docs/support-matrix.md` for the current
host-specific behavior.
