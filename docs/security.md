# Security

## Capability Model

- Default permissions deny filesystem, HTTP, and environment access.
- Filesystem access requires explicit roots plus byte and file budgets.
- HTTP access requires explicit origin grants plus request and byte budgets.

## Denial Outcomes

- Policy denial returns `AEG-POLICY-DENIED` with `termination=policy_denied`.
- The strict server profile denies environment access even when the request
  grants a key.
- The strict server limit envelope denies wall, CPU, memory, stdout, and
  stderr overages with specific `isolation_*` reason text.
- Browser-unavailable capability requests return `AEG-UNSUPPORTED-HOST` with
  `termination=policy_denied`.
- Wall time overflow returns `AEG-TIMEOUT`.
- Memory marker overflow returns `AEG-MEMORY-LIMIT`.
- Output byte overflow returns `AEG-OUTPUT-LIMIT`.

## Denial Audit Ordering

- Runtime-bound deny results start with `runtime_channel` and
  `runtime_binding`.
- The terminal deny event follows those boundary entries.

## Engine Integrity

- Engine artifacts live at `artifacts/engine/`.
- `manifest.json` records SHA-256 hashes.
- `provenance.json` records source script and build timestamp.
- repository verification publishes matching integrity evidence for shipped
  engine artifacts.
- Release rehearsal now stages a source archive, release notes, SBOM, and
  supply-chain attestation in `artifacts/security/release-rehearsal.json`.
- The manual release rehearsal verifies provenance for the source archive plus
  the shipped runtime artifacts before the strict release claim gate accepts
  the rehearsal artifact.
- browser package requests now fail closed unless they match a verified
  `packageLockfile`.
- browser runs with `assetBaseUrl` now verify pinned Pyodide asset hashes
  before guest code runs.

## Kernel Isolation Evidence

- The strict server profile enforces no-new-privs, active seccomp filtering,
  namespace evidence, cgroup evidence, and process-level CPU/address-space
  ceilings in generated artifacts.
- The strict Linux evidence now records blocked `unshare`, `setns`, `mount`,
  and `ptrace` probes alongside the limit envelope.
- High-risk tenant isolation is not published as valid.

## Replay And Adversarial Proof

- Replay attestation now spans six deterministic workload shapes across
  `node`, `deno`, `bun`, and `browser`.
- The adversarial suite now records eight hostile boundary cases:
  filesystem traversal denial, output abuse, strict-profile environment
  denial, strict stdout-envelope denial, strict stderr-envelope denial,
  strict CPU-envelope denial, strict memory-envelope denial, and strict
  wall-envelope denial.

## Fuzz Coverage Depth

- Protocol framing records fixed-seed fuzz iterations and category counts for
  frame decoding and JSON decoding.
- Runtime-envelope validation records fixed-seed fuzz iterations and category
  counts for valid inputs, invalid inputs, preflight-accepted inputs, and
  browser-denied inputs.
- Browser worker input normalization records fixed-seed fuzz iterations and
  category counts for valid inputs, invalid inputs, package inputs,
  `assetBaseUrl` inputs, and malformed package or asset inputs.
- Browser integrity verification records fixed-seed fuzz iterations and
  category counts for clean, tampered, and missing package and asset inputs.
- Native ABI fuzz proof records fixed-seed iterations plus malformed-frame,
  valid-frame, ok-response, denied-response, parse-failure, and
  policy-denial counts.

## Security Evidence

- `artifacts/tests/engine-hash-verify.json`
- `artifacts/security/runtime-policy-denials.json`
- `artifacts/security/isolation-profile.json`
- `artifacts/security/isolation-limit-denials.json`
- `artifacts/tests/real-engine-default.json`
- `artifacts/security/adversarial-suite.json`
- `artifacts/security/native-abi-adversarial.json`
- `artifacts/security/native-abi-fuzz.json`
- `artifacts/security/replay-attestation.json`
- `artifacts/security/browser-input-fuzz.json`
- `artifacts/security/browser-integrity-fuzz.json`
- `artifacts/security/runtime-envelope-fuzz.json`
- `artifacts/security/protocol-framing-fuzz.json`
- `artifacts/security/supply-chain-sbom.json`
- `artifacts/security/supply-chain-attestation.json`
- `artifacts/security/provenance-verification.json`
- `artifacts/security/release-rehearsal.json`
- `artifacts/security/kernel-isolation-runtime.json`
- `artifacts/gates/provenance-verify-check.json`
- `artifacts/gates/kernel-isolation-check.json`

## Invariants

- INV-SECU-0001
- INV-SECU-0002
- INV-SECU-0003
- INV-SECU-0004
- INV-SECU-0005
- INV-SECU-0006
- INV-SECU-0007
- INV-SECU-0008
- INV-SECU-0009
- INV-SECU-0010
- INV-SECU-0011
