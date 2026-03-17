import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);

export function resolveChangelogTag({
  envRefName = process.env.GITHUB_REF_NAME,
  cliArgs = process.argv.slice(2),
} = {}) {
  const cliValue = firstCliValue(cliArgs);
  return normalizeTag(cliValue || envRefName || "");
}

const run = async () => {
  const tagName = resolveChangelogTag();
  if (!tagName.startsWith("v")) {
    throw new Error(
      `changelog-section: expected v-prefixed tag, received "${tagName}"`,
    );
  }
  const version = tagName.slice(1);

  const source = (await readFile("CHANGELOG.md", "utf8")).replace(
    /\r\n/g,
    "\n",
  );
  const lines = source.split("\n");
  const start = findSectionStart(lines, version);
  if (!start) {
    throw new Error(`changelog-section: did not find section for ${version}`);
  }

  const sectionLines = [];
  for (let index = start.index; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (index > start.index && isHeadingAtLevel(line, start.level)) {
      break;
    }
    sectionLines.push(line);
  }

  const section = trimTrailingBlankLines(sectionLines).join("\n").trimEnd();
  if (section.length === 0) {
    throw new Error(
      `changelog-section: extracted section for ${version} is empty`,
    );
  }

  process.stdout.write(`${section}\n`);
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

function findSectionStart(lines, version) {
  const matcher = new RegExp(
    `^\\s*(#{2,3})\\s+v?${escapeRegExp(version)}(?:\\b|\\s|\\(|-|$)`,
  );
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const match = line.match(matcher);
    if (!match) continue;
    return { index, level: match[1].length };
  }
  return null;
}

function isHeadingAtLevel(line, level) {
  const expected = "#".repeat(level);
  return new RegExp(`^\\s*${escapeRegExp(expected)}\\s+`).test(line);
}

function trimTrailingBlankLines(lines) {
  let end = lines.length;
  while (end > 0 && (lines[end - 1] ?? "").trim().length === 0) {
    end -= 1;
  }
  return lines.slice(0, end);
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
