# Claim Validity Matrix

Date: 2026-02-16

| Claim                         | Current State                        | Required Evidence Before Publication                           |
| ----------------------------- | ------------------------------------ | -------------------------------------------------------------- |
| Capability-gated API          | Valid for contract and policy checks | Runtime-bound deny tests with audit artifacts                  |
| Hardened Python engine        | Not valid                            | Real interpreter execution and isolation evidence              |
| Engine artifact integrity     | Partial                              | Signed provenance and SBOM verification logs                   |
| Deterministic replay          | Prototype-level                      | Stable replay hashes from real runtime corpus                  |
| Enterprise security readiness | Not valid                            | Vulnerability SLA metrics and incident runbook drill artifacts |

## Software Position Baseline

- RestrictedPython explicitly states it is not a full sandbox model and receives security restriction updates.
- CodeJail documents AppArmor/process isolation requirements and operational caveats.
- Wasmtime and Firecracker provide stronger isolation primitives than current AegisPy runtime paths.

Sources:

- https://restrictedpython.readthedocs.io/en/latest/usage/policy.html
- https://restrictedpython.readthedocs.io/en/stable/changes.html
- https://github.com/openedx/codejail
- https://docs.wasmtime.dev/security.html
- https://raw.githubusercontent.com/firecracker-microvm/firecracker/main/docs/design.md
