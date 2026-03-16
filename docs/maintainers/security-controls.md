# Security Controls

This maintainer-facing document covers the repository controls that protect the
public source and release surface.

## Repository Baseline

- pull-request-only changes to `main`
- required CI and security checks
- squash-only merges
- dependency alerting and automated fixes
- code scanning and scorecard analysis workflows
- pinned action SHAs in workflows
- explicit workflow `permissions` declarations
- `CODEOWNERS` review ownership for protected paths
- tracked-file churn detection in CI

## Workflow Hardening Gate

Run:

```bash
node scripts/workflow_policy_check.mjs
```

The workflow policy gate fails when:

- a workflow omits top-level `permissions`
- an action reference is not pinned to a full commit SHA
- a workflow uses `pull_request_target`

## Repository Governance

- `main` is expected to stay behind protected-branch governance
- contributor-facing verification commands live in `docs/gates.md`
- repository-admin automation and operator baselines are maintained separately
  from the product repo
