# Troubleshoot Common Failures

## `AEG-UNSUPPORTED-HOST`

Cause:

- the `browser-real-engine` profile does not expose filesystem, HTTP, or
  environment capabilities
- the runtime records this as a profile-level deny, so `termination` is
  `policy_denied` even though the error code stays `AEG-UNSUPPORTED-HOST`

Fix:

- move the workload to `node`, `deno`, or `bun`
- or narrow the browser workload to the documented subset behavior

## `AEG-POLICY-DENIED`

Cause:

- the request asks for a capability that was not granted in `permissions`

Fix:

- add the required filesystem roots, HTTP origins, or environment keys to the
  request
- or keep the capability disabled and update the workload to avoid it

## `AEG-TIMEOUT`

Cause:

- the workload exceeded the configured wall-clock or CPU budget

Fix:

- raise the time limit when the workload is expected to be longer
- or reduce the amount of Python work done in a single request

## `AEG-MEMORY-LIMIT` or `AEG-OUTPUT-LIMIT`

Cause:

- the workload exceeded configured memory or output byte budgets

Fix:

- raise the relevant byte budget
- or reduce stdout/stderr volume and in-memory working set size

## `AEG-ENGINE`

Cause:

- the worker-backed runtime failed before guest completion
- `browser-real-engine` now also returns `AEG-ENGINE` when browser package
  requests are not backed by a verified `packageLockfile`
- `browser-real-engine` with `assetBaseUrl` also returns `AEG-ENGINE` when a
  pinned Pyodide asset hash does not match

Fix:

- verify the browser lockfile entry set and hashes
- verify that `assetBaseUrl` serves the expected Pyodide asset set
- or remove custom browser package and asset configuration from the request

## Runtime behavior differs by host

Cause:

- `node`, `deno`, and `bun` use the `server-hardened` profile, while `browser`
  uses the experimental `browser-real-engine` profile

Fix:

- confirm the selected host in `docs/reference/profiles.md`
- compare expected support in `docs/support-matrix.md`
