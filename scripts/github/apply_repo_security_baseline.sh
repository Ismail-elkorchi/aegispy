#!/usr/bin/env bash
set -euo pipefail

OWNER="${1:-Ismail-elkorchi}"
REPO="${2:-aegispy}"

# Repository merge policy and security defaults.
gh api \
  "repos/${OWNER}/${REPO}" \
  -X PATCH \
  -F allow_merge_commit=false \
  -F allow_rebase_merge=false \
  -F allow_squash_merge=true \
  -F delete_branch_on_merge=true \
  -F web_commit_signoff_required=true >/dev/null

# Dependabot alert surfaces.
gh api "repos/${OWNER}/${REPO}/vulnerability-alerts" -X PUT >/dev/null
gh api "repos/${OWNER}/${REPO}/automated-security-fixes" -X PUT >/dev/null

# Branch protection baseline for main.
gh api \
  "repos/${OWNER}/${REPO}/branches/main/protection" \
  -X PUT \
  -H "Accept: application/vnd.github+json" \
  -f required_status_checks.strict=true \
  -f required_status_checks.contexts[]='ci / check' \
  -f required_status_checks.contexts[]='pr-policy / enforce' \
  -f required_status_checks.contexts[]='dependency-review / dependency-review' \
  -f required_status_checks.contexts[]='codeql / analyze (javascript-typescript)' \
  -f required_status_checks.contexts[]='codeql / analyze (rust)' \
  -f enforce_admins=true \
  -f required_pull_request_reviews.required_approving_review_count=1 \
  -f required_pull_request_reviews.dismiss_stale_reviews=true \
  -f required_pull_request_reviews.require_code_owner_reviews=true \
  -f required_pull_request_reviews.require_last_push_approval=true \
  -f required_conversation_resolution=true \
  -f required_linear_history=true \
  -f allow_force_pushes=false \
  -f allow_deletions=false \
  -f block_creations=false \
  -f required_signatures=false \
  -f lock_branch=false \
  -f allow_fork_syncing=false \
  -f restrictions= >/dev/null

echo "security baseline applied for ${OWNER}/${REPO}"
