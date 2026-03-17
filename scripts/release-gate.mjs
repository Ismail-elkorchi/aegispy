import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadReleaseVersion } from "./release-version.mjs";

const __filename = fileURLToPath(import.meta.url);

export function resolveReleaseTag({
  envRefName = process.env.GITHUB_REF_NAME,
  cliArgs = process.argv.slice(2),
} = {}) {
  const cliValue = firstCliValue(cliArgs);
  return normalizeTag(cliValue || envRefName || "");
}

const run = async () => {
  const tagName = resolveReleaseTag();
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

const isEntryPoint =
  typeof process.argv[1] === "string" &&
  path.resolve(process.argv[1]) === __filename;

if (isEntryPoint) {
  run().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
