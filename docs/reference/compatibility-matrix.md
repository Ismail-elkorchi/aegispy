# Compatibility Matrix

## Generated Proof

The compatibility surface is generated from automated host runs and written to:

- `artifacts/compat/workload-compatibility-matrix.json`
- `artifacts/compat/agent-workload-corpus.json`
- `artifacts/compat/package-fixture-lockfiles.json`

Those artifacts are the canonical source for workload-family coverage, host
profiles, and stable reason codes.

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

## Browser Truth

The browser profile is now `browser-real-engine`, but it remains experimental
and capability-limited:

- `fs` workloads are unsupported by profile
- `http` workloads are unsupported by profile
- `env` workloads are unsupported by profile

That unsupported status is expected and recorded in the generated matrix via
`unsupported_browser_capability`.

## Package Fixture Metadata

`artifacts/compat/package-fixture-lockfiles.json` contains pinned lockfile
metadata for representative pure-Python package families. The compatibility
fixtures remain corpus metadata, and `browser-real-engine` package requests now
fail closed unless they are backed by a verified `packageLockfile`.
