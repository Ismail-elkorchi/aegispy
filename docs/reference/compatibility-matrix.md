# Compatibility Matrix

## Generated Proof

The compatibility surface is generated from automated host runs and written to:

- `artifacts/compat/workload-compatibility-matrix.json`
- `artifacts/compat/agent-workload-corpus.json`
- `artifacts/compat/package-fixture-lockfiles.json`
- `artifacts/compat/server-compatibility-matrix.json`
- `artifacts/compat/browser-capability-matrix.json`

Those artifacts are the canonical source for workload-family coverage, host
profiles, and stable reason codes.

Compatibility claims are host-specific. Any workload marked as `supported` for
`node`, `deno`, `bun`, or `browser` must pass on that host in the generated
artifacts. Unsupported-by-profile cases are only valid when the artifact
records the expected rejection reason for that host.

The compatibility gate currently requires 28 generated workloads in the
cross-host matrix, 5 pinned package fixtures, and 3 `browser-executed`
package fixtures.

## Workload Families

| Family            | Meaning                                                                  |
| ----------------- | ------------------------------------------------------------------------ |
| `core-stdlib`     | deterministic execution with basic stdlib coverage                       |
| `text-stdlib`     | text, regex, and Unicode processing                                      |
| `data-stdlib`     | JSON, hashing, and structured-data workloads                             |
| `numeric-stdlib`  | exact-arithmetic and numeric stdlib workloads                            |
| `capability-fs`   | workloads that require explicit filesystem grants                        |
| `capability-http` | workloads that require explicit HTTP grants without live network traffic |
| `capability-env`  | workloads that require explicit environment grants                       |
| `policy`          | deny-by-default and traversal-denial workloads                           |
| `resource-limits` | output and resource-enforcement workloads                                |

## Reason Codes

| Reason Code                            | Meaning                                                                   |
| -------------------------------------- | ------------------------------------------------------------------------- |
| `supported`                            | the host satisfied the workload contract                                  |
| `unsupported_browser_capability`       | the browser profile correctly rejected an unsupported capability workload |
| `policy_denied_expected`               | the runtime correctly denied the workload through policy enforcement      |
| `output_limit_expected`                | the runtime correctly enforced the configured output limit                |
| `stdout_missing`                       | expected stdout was missing                                               |
| `deterministic_lines_missing`          | deterministic time or RNG lines were missing                              |
| `stdlib_digest_missing`                | the expected digest output was missing                                    |
| `env_value_missing`                    | the expected environment value was missing                                |
| `browser_engine_timeout`               | the browser real-engine path timed out                                    |
| `browser_engine_error`                 | the browser real-engine path returned an engine error                     |
| `capability_channel_not_component_wit` | a server host failed to expose the required capability channel            |
| `timeout_expected`                     | the runtime correctly enforced the configured wall-clock timeout          |

## Browser Truth

The browser profile is now `browser-real-engine`, but it remains experimental
and capability-limited:

- `fs` workloads are unsupported by profile
- `http` workloads are unsupported by profile
- `env` workloads are unsupported by profile

That unsupported status is expected and recorded in the generated matrix via
`unsupported_browser_capability`.

The generated corpus also records `supportedFailures` and
`unsupportedByProfileFailures`. Both lists must stay empty for the compatibility
gate to remain green.

## Package Fixture Metadata

`artifacts/compat/package-fixture-lockfiles.json` contains pinned lockfile
proof for representative pure-Python package families. That artifact now mixes
`metadata-only` fixtures with `browser-executed` fixtures when the
`browser-real-engine` runtime can import the package through a verified
`packageLockfile`.

The current browser-executed fixture families cover:

<!-- browser-fixture-claims:start -->

- `micropip`
- `packaging`
- `jinja2+markupsafe`
<!-- browser-fixture-claims:end -->

Current server package-layer proof is narrower and remains target-scoped:

- `node`, `deno`, and `bun` can import locked `pure_python` package layers
  when requests supply a verified `packageLockfile`
- current proven server pure-Python imports are:
<!-- server-package-claims:start -->
- `node`: `attrs`, `jinja2`, `jsonschema`, `packaging`
- `deno`: `attrs`, `jinja2`, `jsonschema`, `packaging`
- `bun`: `attrs`, `jinja2`, `jsonschema`, `packaging`
<!-- server-package-claims:end -->
- native package classes remain outside the supported server package-layer
  surface until target-specific proof is published
