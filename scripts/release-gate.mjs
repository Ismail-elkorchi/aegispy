import { readFile } from "node:fs/promises";
import { loadReleaseVersion } from "./release-version.mjs";

const run = async () => {
  const tagName = normalizeTag(
    process.env.GITHUB_REF_NAME ?? firstCliValue(process.argv.slice(2)),
  );
  if (!tagName.startsWith("v")) {
    throw new Error(
      `release-gate: expected v-prefixed tag, received "${tagName}"`,
    );
  }

  const version = tagName.slice(1);
  const release = await loadReleaseVersion();
  if (release.version !== version) {
    throw new Error(
      `release-gate: tag/version mismatch (tag=${version}, release=${release.version})`,
    );
  }

  const changelog = await readFile("CHANGELOG.md", "utf8");
  if (!hasChangelogSection(changelog, version)) {
    throw new Error(
      `release-gate: missing CHANGELOG section for version ${version}`,
    );
  }

  process.stdout.write(
    `release-gate: ok tag=${tagName} release=${release.version} changelog=present\n`,
  );
};

function normalizeTag(value) {
  if (!value) return "";
  if (value.startsWith("refs/tags/")) {
    return value.slice("refs/tags/".length);
  }
  return value;
}

function firstCliValue(args) {
  return args.find((arg) => arg !== "--") ?? "";
}

function hasChangelogSection(changelog, version) {
  const sectionPattern = new RegExp(
    `^#{2,3}\\s+v?${escapeRegExp(version)}(?:\\b|\\s|\\(|-|$)`,
    "m",
  );
  return sectionPattern.test(changelog.replace(/\r\n/g, "\n"));
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

run().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
