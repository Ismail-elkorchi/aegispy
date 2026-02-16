# AegisPy

AegisPy provides a capability-gated Python runtime API across Node, Deno, Bun, and browser hosts.

## Status

- Contract and policy behavior are implemented and tested.
- Runtime hardening is in progress; see `docs/hardening-roadmap.md`.

## Quick Start

1. `pnpm install`
2. `pnpm wit:codegen`
3. `pnpm engine:build`
4. `bash scripts/check`

## API

- `createRuntime({ host })`
- `runtime.run(RunRequest)`
- `runtime.close()`

## Docs

- `docs/architecture.md`
- `docs/security.md`
- `docs/gates.md`
- `docs/runbook.md`
- `docs/support-matrix.md`
- `docs/research/README.md`
