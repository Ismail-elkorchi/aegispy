# Profiles

## `server-hardened`

Hosts:

- `node`
- `deno`
- `bun`

Properties:

- real process/WASI/component runtime path
- manifest-defined server bundle selection with shared bundle metadata across
  `node`, `deno`, and `bun`
- locked server package-layer projection for verified `pure_python` packages
  through read-only guest import roots
- capability enforcement at the runtime boundary
- `component-wit` capability channel
- explicit denial semantics for filesystem, HTTP, and environment permissions
- projected server project roots under stable internal guest paths when
  configured through `createRuntime`
- dedicated guest temp-root semantics exposed as `/tmp`
- strict-profile evidence for no-new-privs, active seccomp filtering,
  namespace, cgroup, process-level CPU/address-space ceilings, and
  limit-envelope controls
- blocked kernel-control probes for `unshare`, `setns`, `mount`, and `ptrace`
  without a published high-risk tenant claim

Contributor-facing compatibility model notes:

- `server-hardened` remains the current implementation profile name
- future cross-OS claims must start from the portable common isolation floor
- stronger host claims remain OS-specific strengthening claims
- future server capability families are frozen as:
  - `storage`
  - `network`
  - `environment`
  - `process`
  - `handles`
- future package classes are frozen as:
  - `base_interpreter`
  - `pure_python`
  - `native_platform`
  - `project_overlay`

## `browser-real-engine`

Hosts:

- `browser`

Properties:

- same request/result API shape
- experimental worker-backed real Python execution
- no filesystem, HTTP, or environment capabilities
- stable unsupported-host semantics for browser-unavailable capabilities
- runtime-boundary audit entries before terminal deny events

Contributor-facing compatibility model notes:

- `browser-real-engine` remains the current implementation profile name
- future browser claim family is `browser native capability runtime`
- future browser capability families are frozen as:
  - `storage`
  - `network`
  - `fileAccess`
  - `worker`
  - `handles`
- future browser capability states are frozen as:
  - `available_granted`
  - `available_denied`
  - `unavailable`
  - `hard_limit`

## Portable Common Isolation Floor

The portable common isolation floor vocabulary is frozen as:

- `process_boundary`
- `immutable_runtime_image`
- `projected_roots`
- `guest_temp_root`
- `environment_allowlist`
- `resource_ceilings`
- `brokered_capabilities`
- `audit_trail`
- `artifact_integrity`

Future host-specific hardening language must be written as OS-specific
strengthening rather than implied equivalence.

## Evidence

- `artifacts/e2e/deno-parity.json`
- `artifacts/e2e/bun-parity.json`
- `artifacts/e2e/browser-run.json`
- `artifacts/e2e/host-parity-contract.json`
- `artifacts/compat/profile-conformance.json`
