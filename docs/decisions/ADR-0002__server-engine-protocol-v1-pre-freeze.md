# ADR-0002: Server Engine Protocol v1 Pre-Freeze Scope

## Status

Accepted as a freeze-readiness target. The protocol is not frozen yet.

## Decision

The first external engine protocol freeze target is
`server-engine-protocol-v1` only.

This boundary covers process-launched server engines used by the `node`,
`deno`, and `bun` host adapters, plus future non-JS SDKs. The browser worker
protocol is not part of this freeze-readiness boundary.

## Protocol Shape

Version 1 uses a 4-byte unsigned big-endian frame length followed by UTF-8 JSON.
Every message carries `protocolVersion: "1"` and a `type` value from this
server-only vocabulary:

- `hello`
- `hello_result`
- `run`
- `run_result`
- `cancel`
- `cancel_result`
- `shutdown`
- `shutdown_result`
- `error`

The v1 candidate keeps the existing `run` / `run_result` payload shape and adds
explicit handshake, cancellation, shutdown, and structured protocol-error
semantics.

## Non-Goals

- No browser worker protocol freeze in this phase.
- No full CPython parity claim.
- No blanket package-support claim.
- No host-specific public API fork for `node`, `deno`, or `bun`.

## Gates

The protocol is freeze-ready only when schemas, golden fixtures, docs, JS host
adapters, and a non-JS reference client pass the same language-neutral
contract.
