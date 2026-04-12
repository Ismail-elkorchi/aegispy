# Server Engine Protocol v1 Candidate

`server-engine-protocol-v1` is the candidate language-neutral boundary between
host adapters and process-launched server engines. It is freeze-ready only after
the conformance gates pass; it is not frozen yet.

## Scope

The protocol is server-only and applies to engines launched by the `node`,
`deno`, and `bun` host adapters. The browser worker protocol is not part of
this freeze-readiness boundary.

## Framing

Frames are encoded as:

- 4-byte unsigned big-endian length
- UTF-8 JSON payload

The v1 candidate maximum frame size is 1,048,576 bytes. Oversized frames fail
closed with `frame_too_large`. Invalid JSON is reported as `invalid_json` when a
protocol error frame can be returned. Unknown message types are reported as
`unknown_message_type`.

## Messages

Every protocol message includes:

- `protocolVersion: "1"`
- `type`
- `requestId`

The server message types are:

- `hello` / `hello_result`
- `run` / `run_result`
- `cancel` / `cancel_result`
- `shutdown` / `shutdown_result`
- `error`

`hello_result` reports engine identity, supported protocol versions, bundle
metadata, server capability families, limit metadata, and `maxFrameBytes`.

`run` preserves the current `RunRequest` payload without the public `host`
field. `run_result` preserves the current `RunResult` payload.

`cancel` is best-effort. The current worker returns `cancel_result` with
`accepted: false` and `reason: "not_cancelable"` when it cannot interrupt a
request safely.

`shutdown` is terminal. After `shutdown_result`, the engine stops reading new
work and exits cleanly.

## Capability Model

The external server protocol uses capability families as the conceptual model:

- `storage`
- `network`
- `environment`
- `process`
- `handles`

Legacy `fs`, `http`, and `env` booleans remain JS SDK compatibility fields, not
the conceptual center of the external engine protocol.

## Schema And Fixtures

The language-neutral source of truth is:

- `artifacts/protocol/server-engine-protocol.v1.schema.json`
- `artifacts/protocol/fixtures/server-engine-v1/*.json`
