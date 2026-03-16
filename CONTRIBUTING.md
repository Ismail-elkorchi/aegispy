# Contributing

## Pull Request Rules

- Use pull requests for all repository changes.
- Every `main` update must come from a merged pull request that passed the
  required CI and CodeQL checks under branch protection.
- This repository is kept workable for solo maintainers: once the required
  checks are green, the PR author may self-merge through GitHub.
- Pass `bash scripts/check` before review.
- Pass `bash scripts/release_claims_check` for release claim updates.
- Use branch format `<type>/<slug>`.
- Use title format `<type>(<scope>): <summary>`.
- Use commit subject format `<type>(<scope>)!: <summary>` and keep ASCII.
- Add evidence artifact paths for active invariants.

Direct pushes to `main` are not part of the normal repository workflow.

## Code Quality

- TypeScript: lint, format, typecheck, tests.
- Rust: fmt, clippy, tests.

## Control-Plane Separation

- Product files must not contain control-plane path tokens.
