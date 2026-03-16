import fs from "node:fs";
import { spawnSync } from "node:child_process";
import process from "node:process";

const TYPE_PART =
  "(feat|fix|refactor|perf|test|docs|build|ci|chore|revert|security)";
const SCOPE_PART =
  "(repo|core|node|deno|bun|browser|worker|pack|runtime|docs|release|deps|deps-dev|ci|security)";
const BRANCH_RE = new RegExp(`^${TYPE_PART}\\/([a-z0-9]+(?:-[a-z0-9]+)*)$`);
const TITLE_RE = new RegExp(`^${TYPE_PART}\\(${SCOPE_PART}\\)(!)?: (.+)$`);
const COMMIT_RE = new RegExp(`^${TYPE_PART}\\(${SCOPE_PART}\\)(!)?: (.+)$`);
const ASCII_RE = /^[\x20-\x7E]+$/;
const BREAKING_TRAILER_RE = /^BREAKING CHANGE: .+/m;
const CONTROL_PLANE_DIR = ".aegispy" + "_pack/";

function runGit(args) {
  const res = spawnSync("git", args, { encoding: "utf8" });
  return {
    ok: (res.status ?? 1) === 0,
    status: res.status ?? 1,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
  };
}

function readEventPayload() {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventPath) return {};
  if (!fs.existsSync(eventPath)) return {};
  return JSON.parse(fs.readFileSync(eventPath, "utf8"));
}

async function githubGetJson(repoFullName, path, failures) {
  let options = {};
  if (
    failures &&
    typeof failures === "object" &&
    !Array.isArray(failures) &&
    "failures" in failures
  ) {
    options = failures;
    failures = options.failures;
  }

  const recordFailures = options.recordFailures ?? true;

  if (typeof fetch !== "function") {
    if (recordFailures) {
      failures.push({ error: "fetch_unavailable_for_github_audit" });
    }
    return null;
  }

  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || "";
  if (!token) {
    if (recordFailures) {
      failures.push({ error: "missing_github_token_for_push_audit" });
    }
    return null;
  }

  if (!repoFullName) {
    if (recordFailures) {
      failures.push({ error: "missing_github_repository_for_push_audit" });
    }
    return null;
  }

  const response = await fetch(
    `https://api.github.com/repos/${repoFullName}${path}`,
    {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "User-Agent": "aegispy-pr-policy-check",
      },
    },
  );

  if (!response.ok) {
    if (recordFailures) {
      failures.push({
        error: "github_push_audit_request_failed",
        path,
        status: response.status,
        status_text: response.statusText,
      });
    }
    return null;
  }

  return response.json();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getCurrentBranch() {
  const res = runGit(["rev-parse", "--abbrev-ref", "HEAD"]);
  if (!res.ok) return "";
  return res.stdout.trim();
}

function parseCommitMessages(raw) {
  return raw
    .split("\x1e")
    .map((x) => x.trim())
    .filter((x) => x.length > 0)
    .map((record) => {
      const [hash, subject, ...bodyParts] = record.split("\x1f");
      return {
        hash: (hash ?? "").trim(),
        subject: (subject ?? "").trim(),
        body: bodyParts.join("\x1f").trim(),
      };
    })
    .filter((x) => x.subject.length > 0);
}

function listCommitMessages(baseSha, headSha) {
  if (!baseSha || !headSha) return [];
  const res = runGit([
    "log",
    "--format=%H%x1f%s%x1f%b%x1e",
    `${baseSha}..${headSha}`,
  ]);
  if (!res.ok) return [];
  return parseCommitMessages(res.stdout);
}

function listChangedFiles(baseSha, headSha) {
  if (!baseSha || !headSha) return [];
  const res = runGit(["diff", "--name-only", `${baseSha}..${headSha}`]);
  if (!res.ok) return [];
  return res.stdout
    .split(/\r?\n/)
    .map((x) => x.trim())
    .filter((x) => x.length > 0);
}

function listLocalCommitMessages() {
  const res = runGit(["log", "--format=%H%x1f%s%x1f%b%x1e", "-n", "20"]);
  if (!res.ok) return [];
  return parseCommitMessages(res.stdout);
}

function readCommitMessage(sha) {
  if (!sha) return "";
  const res = runGit(["show", "-s", "--format=%s%n%b", sha]);
  if (!res.ok) return "";
  return res.stdout.trim();
}

function extractPullNumberFromCommitMessage(message) {
  if (!message) return null;
  const mergeCommitMatch = message.match(/^Merge pull request #(\d+)\b/m);
  if (mergeCommitMatch) {
    return Number.parseInt(mergeCommitMatch[1], 10);
  }

  const squashMergeMatch = message.match(/\(#(\d+)\)\s*$/m);
  if (squashMergeMatch) {
    return Number.parseInt(squashMergeMatch[1], 10);
  }

  return null;
}

function validateBranch(headRef, failures) {
  const match = headRef.match(BRANCH_RE);
  if (!match) {
    failures.push({ error: "invalid_branch_name", value: headRef });
    return null;
  }
  return {
    type: match[1],
    slug: match[2],
  };
}

function validatePrTitle(title, failures) {
  const match = title.match(TITLE_RE);
  if (!match) {
    failures.push({ error: "invalid_pr_title", value: title });
    return null;
  }
  const summary = match[4];
  if (title.length > 72) {
    failures.push({
      error: "pr_title_too_long",
      value: title,
      length: title.length,
    });
  }
  if (summary.endsWith(".")) {
    failures.push({
      error: "pr_title_summary_must_not_end_with_period",
      value: title,
    });
  }
  return {
    type: match[1],
  };
}

function validateCommitMessage(commit, failures, index) {
  const subject = commit.subject;
  const body = commit.body;

  if (subject.length > 72) {
    failures.push({
      error: "invalid_commit_subject_length",
      index,
      value: subject,
      length: subject.length,
    });
  }
  if (!ASCII_RE.test(subject)) {
    failures.push({
      error: "invalid_commit_subject_ascii",
      index,
      value: subject,
    });
  }
  if (subject.startsWith("Merge ")) {
    failures.push({
      error: "merge_commit_subject_prohibited",
      index,
      value: subject,
    });
  }

  const match = subject.match(COMMIT_RE);
  if (!match) {
    failures.push({
      error: "invalid_commit_subject_format",
      index,
      value: subject,
    });
    return;
  }

  const hasBreakingBang = Boolean(match[3]);
  const summary = match[4];
  if (summary.endsWith(".")) {
    failures.push({
      error: "commit_subject_summary_must_not_end_with_period",
      index,
      value: subject,
    });
  }

  if (hasBreakingBang && !BREAKING_TRAILER_RE.test(body)) {
    failures.push({
      error: "missing_breaking_change_trailer",
      index,
      value: subject,
      hash: commit.hash,
    });
  }
}

async function auditPushToMain(event, failures) {
  const repoFullName =
    process.env.GITHUB_REPOSITORY || event.repository?.full_name || "";
  const sha = process.env.GITHUB_SHA || event.after || "";

  if (!sha) {
    failures.push({ error: "missing_push_sha_for_main_audit" });
    return [];
  }

  const normalizeMergedMainPulls = (pulls) =>
    pulls
      .filter(
        (pull) =>
          pull &&
          pull.base?.ref === "main" &&
          typeof pull.merged_at === "string" &&
          pull.merged_at.length > 0,
      )
      .map((pull) => ({
        number: pull.number,
        title: pull.title,
        merged_at: pull.merged_at,
        head_ref: pull.head?.ref || "",
        merge_commit_sha: pull.merge_commit_sha || "",
      }));

  let mergedMainPulls = [];
  const retryDelaysMs = [0, 3000, 7000, 15000];
  for (let idx = 0; idx < retryDelaysMs.length; idx += 1) {
    if (retryDelaysMs[idx] > 0) {
      await sleep(retryDelaysMs[idx]);
    }

    const pulls = await githubGetJson(
      repoFullName,
      `/commits/${sha}/pulls?per_page=10`,
      {
        failures,
        recordFailures: idx === retryDelaysMs.length - 1,
      },
    );
    if (!Array.isArray(pulls)) {
      if (idx === retryDelaysMs.length - 1) {
        failures.push({
          error: "invalid_commit_pulls_response_for_main_audit",
          sha,
        });
      }
      continue;
    }

    mergedMainPulls = normalizeMergedMainPulls(pulls);
    if (mergedMainPulls.length > 0) {
      break;
    }
  }

  if (mergedMainPulls.length === 0) {
    const fallbackPullNumber = extractPullNumberFromCommitMessage(
      readCommitMessage(sha),
    );
    if (fallbackPullNumber !== null) {
      const fallbackPull = await githubGetJson(
        repoFullName,
        `/pulls/${fallbackPullNumber}`,
        failures,
      );
      if (
        fallbackPull &&
        fallbackPull.base?.ref === "main" &&
        typeof fallbackPull.merged_at === "string" &&
        fallbackPull.merged_at.length > 0 &&
        fallbackPull.merge_commit_sha === sha
      ) {
        mergedMainPulls = normalizeMergedMainPulls([fallbackPull]);
      } else if (fallbackPull) {
        failures.push({
          error: "fallback_pull_mismatch_for_main_audit",
          sha,
          pull_number: fallbackPullNumber,
          base_ref: fallbackPull.base?.ref || "",
          merge_commit_sha: fallbackPull.merge_commit_sha || "",
        });
      }
    }
  }

  if (mergedMainPulls.length === 0) {
    failures.push({
      error: "main_push_commit_not_linked_to_merged_pr",
      sha,
    });
  }

  return mergedMainPulls;
}

async function main() {
  const failures = [];
  const eventName = process.env.GITHUB_EVENT_NAME || "";
  const event = readEventPayload();
  const isPullRequestEvent =
    eventName === "pull_request" || eventName === "pull_request_target";
  const isMergeGroupEvent = eventName === "merge_group";
  const refNameFromEvent =
    typeof event.ref === "string"
      ? event.ref.replace("refs/heads/", "")
      : undefined;
  const refName = process.env.GITHUB_REF_NAME || refNameFromEvent || "";
  const isPushToMain = eventName === "push" && refName === "main";
  const isDependabotPr =
    isPullRequestEvent && event.pull_request?.user?.login === "dependabot[bot]";
  let mainPushPulls = [];

  const headRef =
    process.env.GITHUB_HEAD_REF ||
    process.env.GITHUB_REF_NAME ||
    event.pull_request?.head?.ref ||
    getCurrentBranch();
  const prTitle = event.pull_request?.title || "";

  if (isPullRequestEvent) {
    const baseSha = event.pull_request?.base?.sha || "";
    const prHeadSha = event.pull_request?.head?.sha || "";
    const changedFiles = listChangedFiles(baseSha, prHeadSha);
    for (const file of changedFiles) {
      if (file.startsWith(CONTROL_PLANE_DIR)) {
        failures.push({ error: "control_plane_path_in_pr_diff", file });
      }
    }

    if (!isDependabotPr) {
      const branchMeta = validateBranch(headRef, failures);
      const titleMeta = validatePrTitle(prTitle, failures);

      if (branchMeta && titleMeta) {
        if (branchMeta.type !== titleMeta.type) {
          failures.push({
            error: "type_mismatch_between_branch_and_pr_title",
            branch_type: branchMeta.type,
            pr_title_type: titleMeta.type,
          });
        }
      }

      const commits = listCommitMessages(baseSha, prHeadSha);
      if (commits.length === 0) {
        failures.push({
          error: "unable_to_collect_pr_commit_subjects",
          base_sha: baseSha,
          head_sha: prHeadSha,
        });
      } else {
        commits.forEach((commit, idx) =>
          validateCommitMessage(commit, failures, idx),
        );
      }
    }
  } else if (isPushToMain) {
    mainPushPulls = await auditPushToMain(event, failures);
  } else if (!isMergeGroupEvent && !isPushToMain) {
    validateBranch(headRef, failures);
    const commits = listLocalCommitMessages();
    if (commits.length > 0) {
      validateCommitMessage(commits[0], failures, 0);
    }
  }

  if (failures.length > 0) {
    console.error(
      JSON.stringify(
        { ok: false, event: eventName || "local", failures },
        null,
        2,
      ),
    );
    process.exitCode = 1;
    return;
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        event: eventName || "local",
        branch: headRef,
        merge_group_bypass: isMergeGroupEvent,
        push_main_bypass: false,
        push_main_audited: isPushToMain,
        push_main_pull_requests: mainPushPulls,
        dependabot_bypass: isDependabotPr,
      },
      null,
      2,
    ),
  );
}

Promise.resolve()
  .then(() => main())
  .catch((e) => {
    console.error(String(e));
    process.exitCode = 1;
  });
