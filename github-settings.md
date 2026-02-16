# GitHub Repository Settings

## Branch Protection For main

- The repository MUST enable branch protection for main.
- Direct pushes to main MUST be PROHIBITED.
- Force pushes to main MUST be PROHIBITED.
- Deletions of main MUST be PROHIBITED.
- The repository MUST require merge queue for `main`.
- The repository MUST require signed commits for `main`.

Required Status Checks:

- The repository MUST require the status check `ci / check`.
- The repository MUST require the status check `pr-policy / enforce`.
- The repository MUST require the status check `dependency-review / dependency-review`.
- The repository MUST require the status check `codeql / analyze (javascript-typescript)`.
- The repository MUST require the status check `codeql / analyze (rust)`.

Additional Controls:

- The repository MUST require pull request reviews before merge.
- The repository MUST require conversation resolution before merge.
- The repository MUST allow squash merge and MUST disable merge commits.
- The repository MUST disable rebase merge for consistency with squash-only history.

## Repository Ruleset For Pull Request Branches

- The repository MUST define a ruleset that restricts branch names to `^(feat|fix|refactor|perf|test|docs|build|ci|chore|revert|security)/[a-z0-9-]+$`.
- The repository MUST define a metadata restriction for pull request titles using `^(feat|fix|refactor|perf|test|docs|build|ci|chore|revert|security)\\([a-z0-9-]+\\)!?: .+$`.
- The repository MUST define a metadata restriction for commit messages using `^(feat|fix|refactor|perf|test|docs|build|ci|chore|revert|security)\\([a-z0-9-]+\\)!?: .+`.

## Required Secrets

- The repository MUST store any registry credentials in GitHub Actions Secrets.
- The repository MUST NOT store credentials in the repository.

## Actions Supply Chain

- GitHub Actions workflow `uses:` entries MUST pin third-party actions to immutable commit SHAs.
- Dependabot MUST be enabled for GitHub Actions, npm, and Cargo dependency update pull requests.
- CodeQL and Scorecard workflows MUST be enabled for continuous security analysis.
