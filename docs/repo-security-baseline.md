# Repository Security Baseline

Date: 2026-02-16

## Applied Controls

Applied with:

```bash
bash scripts/github/apply_repo_security_baseline.sh Ismail-elkorchi aegispy
```

## Verified Repository Merge Policy

```json
{
  "allow_merge_commit": false,
  "allow_rebase_merge": false,
  "allow_squash_merge": true,
  "default_branch": "main",
  "delete_branch_on_merge": true,
  "web_commit_signoff_required": true
}
```

## Verified Branch Protection (`main`)

```json
{
  "allow_deletions": { "enabled": false },
  "allow_force_pushes": { "enabled": false },
  "dismiss_stale_reviews": true,
  "require_code_owner_reviews": true,
  "require_last_push_approval": true,
  "required_approvals": 1,
  "required_conversation_resolution": { "enabled": true },
  "required_linear_history": { "enabled": true },
  "required_status_checks": [
    "ci / check",
    "pr-policy / enforce",
    "dependency-review / dependency-review",
    "codeql / analyze (javascript-typescript)",
    "codeql / analyze (rust)"
  ]
}
```

## Security Workflows Required

- `ci / check`
- `pr-policy / enforce`
- `dependency-review / dependency-review`
- `codeql / analyze (javascript-typescript)`
- `codeql / analyze (rust)`
