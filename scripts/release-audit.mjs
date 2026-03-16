import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { loadReleaseVersion } from "./release-version.mjs";

const execFileAsync = promisify(execFile);
const prHashReferencePattern = /#([0-9]+)/g;
const prLinkReferencePattern = /\/pull\/([0-9]+)/g;
const maxBootstrapCommitPages = 50;

const run = async () => {
  const cli = parseCli(process.argv.slice(2));
  const repository = await resolveRepository();

  if (cli.printPrSection) {
    const tagName = normalizeTag(cli.tag ?? process.env.GITHUB_REF_NAME ?? "");
    if (!tagName.startsWith("v")) {
      throw new Error(
        `[release-audit] expected v-prefixed tag for --print-pr-section, received "${tagName}"`,
      );
    }
    const tags = await loadRepositoryTags(repository);
    const previousTag = resolvePreviousTag(tags, tagName);
    const expectedPullRequests = await loadExpectedPullRequestIds({
      repository,
      latestTag: tagName,
      previousTag,
    });
    process.stdout.write(formatPullRequestSection(expectedPullRequests));
    return;
  }

  await runStrictAudit(repository);
};

async function runStrictAudit(repository) {
  const latestRelease = await ghApiJsonOrNull(
    `repos/${repository}/releases/latest`,
  );
  const tags = await loadRepositoryTags(repository);
  const latestTag = tags[0]?.name ?? null;

  if (latestRelease === null || latestTag === null) {
    process.stdout.write(
      `[release-audit] no releases yet; audit skipped for ${repository}\n`,
    );
    return;
  }

  if (latestRelease.tag_name !== latestTag) {
    throw new Error(
      `[release-audit] latest release/tag mismatch (release=${latestRelease.tag_name}, tag=${latestTag})`,
    );
  }

  const release = await loadReleaseVersion();
  const expectedTag = `v${release.version}`;
  if (latestTag !== expectedTag) {
    throw new Error(
      `[release-audit] version/tag mismatch (release=${release.version}, tag=${latestTag})`,
    );
  }

  const changelog = await readFile("CHANGELOG.md", "utf8");
  if (!hasChangelogSection(changelog, release.version)) {
    throw new Error(
      `[release-audit] CHANGELOG.md missing section for version ${release.version}`,
    );
  }

  const previousTag = resolvePreviousTag(tags, latestTag);
  const expectedPullRequests = await loadExpectedPullRequestIds({
    repository,
    latestTag,
    previousTag,
  });
  const actualPullRequests = parsePullRequestReferences(
    String(latestRelease.body ?? ""),
  );
  if (expectedPullRequests.size > 0) {
    const missing = difference(expectedPullRequests, actualPullRequests);
    const unexpected = difference(actualPullRequests, expectedPullRequests);
    if (missing.length > 0 || unexpected.length > 0) {
      const segments = [];
      if (missing.length > 0) {
        segments.push(`missing=${missing.map((id) => `#${id}`).join(",")}`);
      }
      if (unexpected.length > 0) {
        segments.push(
          `unexpected=${unexpected.map((id) => `#${id}`).join(",")}`,
        );
      }
      throw new Error(
        `[release-audit] release body PR set mismatch for ${latestTag} (${segments.join(" ")})`,
      );
    }
  }

  process.stdout.write(
    `[release-audit] ok repo=${repository} tag=${latestTag} version=${release.version} prs=${expectedPullRequests.size}\n`,
  );
}

async function ghApiJson(pathname) {
  const args = ["api", pathname];
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  const env = token ? { ...process.env, GH_TOKEN: token } : process.env;
  const { stdout } = await execFileAsync("gh", args, { encoding: "utf8", env });
  return JSON.parse(stdout);
}

async function ghApiJsonOrNull(pathname) {
  return ghApiJson(pathname).catch((error) => {
    const stderr =
      error instanceof Error && "stderr" in error
        ? String(error.stderr ?? "")
        : "";
    if (stderr.includes("HTTP 404")) {
      return null;
    }
    throw error;
  });
}

async function resolveRepository() {
  const explicit = process.env.GITHUB_REPOSITORY?.trim();
  if (explicit) return explicit;

  const { stdout } = await execFileAsync(
    "git",
    ["remote", "get-url", "origin"],
    {
      encoding: "utf8",
    },
  );
  return normalizeRepositoryFromRemote(stdout.trim());
}

function normalizeRepositoryFromRemote(remote) {
  const noGitSuffix = remote.endsWith(".git") ? remote.slice(0, -4) : remote;
  if (noGitSuffix.startsWith("git@github.com:")) {
    return noGitSuffix.slice("git@github.com:".length);
  }
  if (noGitSuffix.startsWith("https://github.com/")) {
    return noGitSuffix.slice("https://github.com/".length);
  }
  throw new Error(
    `[release-audit] unsupported origin remote format: ${remote}`,
  );
}

function parseCli(args) {
  let printPrSection = false;
  let tag = null;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--") {
      continue;
    }
    if (arg === "--print-pr-section") {
      printPrSection = true;
      continue;
    }
    if (arg === "--tag") {
      const value = args[index + 1];
      if (!value) {
        throw new Error("[release-audit] --tag expects a value");
      }
      tag = value;
      index += 1;
      continue;
    }
    throw new Error(`[release-audit] unknown argument: ${arg}`);
  }

  return { printPrSection, tag };
}

function normalizeTag(value) {
  if (!value) return "";
  if (value.startsWith("refs/tags/")) {
    return value.slice("refs/tags/".length);
  }
  return value;
}

async function loadRepositoryTags(repository) {
  const tags = await ghApiJson(`repos/${repository}/tags?per_page=100`);
  if (!Array.isArray(tags)) {
    throw new Error("[release-audit] failed to load repository tags");
  }
  return tags;
}

function resolvePreviousTag(tags, latestTag) {
  const index = tags.findIndex((entry) => entry?.name === latestTag);
  if (index === -1) {
    throw new Error(
      `[release-audit] tag ${latestTag} not found in repository tag list`,
    );
  }
  for (let cursor = index + 1; cursor < tags.length; cursor += 1) {
    const candidate = tags[cursor]?.name;
    if (typeof candidate === "string" && candidate.length > 0) {
      return candidate;
    }
  }
  return null;
}

async function loadExpectedPullRequestIds({
  repository,
  latestTag,
  previousTag,
}) {
  const commits = previousTag
    ? await loadCommitsBetweenTags(repository, previousTag, latestTag)
    : await loadCommitsThroughTag(repository, latestTag);
  const ids = new Set();
  const unresolvedShas = [];

  for (const commit of commits) {
    const fromMessage = parsePullRequestReferences(commit.message);
    if (fromMessage.size > 0) {
      for (const id of fromMessage) {
        ids.add(id);
      }
    } else {
      unresolvedShas.push(commit.sha);
    }
  }

  for (const sha of unresolvedShas) {
    const pulls = await ghApiJsonOrNull(
      `repos/${repository}/commits/${sha}/pulls`,
    );
    if (!Array.isArray(pulls)) continue;
    for (const pull of pulls) {
      const number = Number.parseInt(String(pull?.number ?? ""), 10);
      if (Number.isInteger(number) && number > 0) {
        ids.add(number);
      }
    }
  }

  return ids;
}

async function loadCommitsBetweenTags(repository, previousTag, latestTag) {
  const compare = await ghApiJson(
    `repos/${repository}/compare/${encodeURIComponent(previousTag)}...${encodeURIComponent(latestTag)}`,
  );
  if (compare?.too_large) {
    throw new Error(
      `[release-audit] compare payload too large for ${previousTag}...${latestTag}; cut a smaller release interval`,
    );
  }
  const commits = Array.isArray(compare?.commits) ? compare.commits : [];
  return commits.map((commit) => ({
    sha: String(commit?.sha ?? ""),
    message: String(commit?.commit?.message ?? ""),
  }));
}

async function loadCommitsThroughTag(repository, latestTag) {
  const tagCommitSha = await resolveTagCommitSha(repository, latestTag);
  const commits = [];

  for (let page = 1; page <= maxBootstrapCommitPages; page += 1) {
    const batch = await ghApiJson(
      `repos/${repository}/commits?sha=${encodeURIComponent(tagCommitSha)}&per_page=100&page=${page}`,
    );
    if (!Array.isArray(batch) || batch.length === 0) break;

    for (const commit of batch) {
      commits.push({
        sha: String(commit?.sha ?? ""),
        message: String(commit?.commit?.message ?? ""),
      });
    }

    if (batch.length < 100) break;
  }

  return commits;
}

async function resolveTagCommitSha(repository, tag) {
  const ref = await ghApiJson(
    `repos/${repository}/git/ref/tags/${encodeURIComponent(tag)}`,
  );
  const refType = String(ref?.object?.type ?? "");
  const refSha = String(ref?.object?.sha ?? "");

  if (refType === "commit" && refSha.length > 0) {
    return refSha;
  }
  if (refType === "tag" && refSha.length > 0) {
    const tagObject = await ghApiJson(`repos/${repository}/git/tags/${refSha}`);
    const tagType = String(tagObject?.object?.type ?? "");
    const tagSha = String(tagObject?.object?.sha ?? "");
    if (tagType === "commit" && tagSha.length > 0) {
      return tagSha;
    }
  }
  throw new Error(`[release-audit] unable to resolve commit for tag ${tag}`);
}

function hasChangelogSection(changelog, version) {
  const normalized = changelog.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!(line.startsWith("## ") || line.startsWith("### "))) continue;
    const heading = line.replace(/^#{2,3}\s+/, "").trim();
    const withoutV = heading.startsWith("v") ? heading.slice(1) : heading;
    if (withoutV === version) return true;
    if (withoutV.startsWith(`${version} `)) return true;
    if (withoutV.startsWith(`${version} (`)) return true;
    if (withoutV.startsWith(`${version}-`)) return true;
  }
  return false;
}

function parsePullRequestReferences(value) {
  const ids = new Set();
  for (const match of value.matchAll(prHashReferencePattern)) {
    const number = Number.parseInt(match[1] ?? "", 10);
    if (Number.isInteger(number) && number > 0) {
      ids.add(number);
    }
  }
  for (const match of value.matchAll(prLinkReferencePattern)) {
    const number = Number.parseInt(match[1] ?? "", 10);
    if (Number.isInteger(number) && number > 0) {
      ids.add(number);
    }
  }
  return ids;
}

function difference(left, right) {
  return [...left].filter((value) => !right.has(value)).sort((a, b) => a - b);
}

function formatPullRequestSection(ids) {
  const lines = ["## Pull requests", ""];
  const sorted = [...ids].sort((a, b) => a - b);
  if (sorted.length === 0) {
    lines.push("- None linked.");
  } else {
    for (const id of sorted) {
      lines.push(`- #${id}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

run().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
