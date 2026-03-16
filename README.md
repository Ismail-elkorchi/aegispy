# AegisPy

AegisPy provides a capability-gated Python runtime API across Node, Deno, Bun, and browser hosts.

## Status

- Contract, runtime, and release gates are implemented and passing.
- `node`, `deno`, and `bun` default to the real process/WASI/component path.
- `browser` remains a restricted subset profile with simulated execution semantics.
- Hardening is still in progress; see `docs/hardening-roadmap.md`.

## Getting Started

1. Read `docs/tutorial/first-run.md`.
2. Choose the host profile in `docs/how-to/choose-a-host.md`.
3. Check supported behavior in `docs/support-matrix.md`.
4. Use `docs/how-to/troubleshoot-common-failures.md` when the runtime contract
   does not match your expectations.

## API

- `createRuntime({ host })`
- `runtime.run(RunRequest)`
- `runtime.close()`

## Docs

- `docs/index.md`
- `docs/tutorial/first-run.md`
- `docs/how-to/choose-a-host.md`
- `docs/reference/runtime-api.md`
- `docs/support-matrix.md`

## Contributing

- `CONTRIBUTING.md`
- `docs/maintainers/ci-and-governance.md`
- `docs/maintainers/security-controls.md`
- `docs/maintainers/release.md`
- `docs/gates.md`
- `docs/runbook.md`
