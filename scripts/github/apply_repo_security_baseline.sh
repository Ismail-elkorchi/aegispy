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
tmp_json="$(mktemp)"
cat > "$tmp_json" <<JSON
{
  "required_status_checks": {
    "strict": true,
    "contexts": [
      "ci / check",
      "pr-policy / enforce",
      "dependency-review / dependency-review",
      "codeql / analyze (javascript-typescript)",
      "codeql / analyze (rust)"
    ]
  },
  "enforce_admins": true,
  "required_pull_request_reviews": {
    "dismiss_stale_reviews": true,
    "require_code_owner_reviews": true,
    "required_approving_review_count": 1,
    "require_last_push_approval": true
  },
  "restrictions": null,
  "required_linear_history": true,
  "allow_force_pushes": false,
  "allow_deletions": false,
  "block_creations": false,
  "required_conversation_resolution": true,
  "lock_branch": false,
  "allow_fork_syncing": false
}
JSON

gh api \
  "repos/${OWNER}/${REPO}/branches/main/protection" \
  -X PUT \
  -H "Accept: application/vnd.github+json" \
  --input "$tmp_json" >/dev/null

rm -f "$tmp_json"

echo "security baseline applied for ${OWNER}/${REPO}"
