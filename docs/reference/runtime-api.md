# Runtime API

## Core Entry Points

- `createRuntime({ host })`
- `runtime.capabilities()`
- `runtime.run(RunRequest)`
- `runtime.close()`

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
