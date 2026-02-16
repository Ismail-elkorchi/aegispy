# Security Controls

## Repository Baseline

The repository security baseline requires:

- pull-request-only changes to `main`,
- required CI and security checks,
- squash-only merges,
- dependency alerting and automated fixes,
- code scanning and scorecard analysis workflows,
- pinned action SHAs in workflows.

## Automation

Apply repository settings with:

```bash
bash scripts/github/apply_repo_security_baseline.sh <owner> <repo>
```

Example:

```bash
bash scripts/github/apply_repo_security_baseline.sh Ismail-elkorchi aegispy
```

## Verification

Verify settings with GitHub API:

```bash
gh api repos/<owner>/<repo>/branches/main/protection
```

```bash
gh api repos/<owner>/<repo>
```
