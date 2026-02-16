# Contributing

## Pull Request Rules

- Use pull requests for all repository changes.
- Pass `bash scripts/check` before review.
- Pass `bash scripts/release_claims_check` for release claim updates.
- Use branch format `<type>/<slug>`.
- Use title format `<type>(<scope>): <summary>`.
- Use commit subject format `<type>(<scope>)!: <summary>` and keep ASCII.
- Add evidence artifact paths for active invariants.

## Code Quality

- TypeScript: lint, format, typecheck, tests.
- Rust: fmt, clippy, tests.

## Control-Plane Separation

- Product files must not contain control-plane path tokens.
