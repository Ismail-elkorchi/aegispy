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

`packageLockfile` is currently metadata-only. It does not yet enforce browser
package integrity at runtime, so callers must not treat it as an active
security boundary.

## Host Kinds

- `node`
- `deno`
- `bun`
- `browser`

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
