# Security

## Capability Model

- Default permissions deny filesystem, HTTP, and environment access.
- Filesystem access requires explicit roots plus byte and file budgets.
- HTTP access requires explicit origin grants plus request and byte budgets.

## Denial Outcomes

- Policy denial returns `AEG-POLICY-DENIED` with `termination=policy_denied`.
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

## Security Evidence

- `artifacts/tests/engine-hash-verify.json`
- `artifacts/security/runtime-policy-denials.json`
- `artifacts/security/isolation-profile.json`
- `artifacts/tests/real-engine-default.json`
- `artifacts/security/adversarial-suite.json`
- `artifacts/security/native-abi-adversarial.json`
- `artifacts/security/native-abi-fuzz.json`
- `artifacts/security/supply-chain-sbom.json`
- `artifacts/security/supply-chain-attestation.json`
- `artifacts/security/provenance-verification.json`
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
