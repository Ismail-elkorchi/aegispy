import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { generateEvidenceMatrices } from "./evidence_matrix_generate.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");
const outPath = path.join(
  repoRoot,
  "artifacts",
  "gates",
  "evidence-claims-check.json",
);

function ensureDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function read(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), "utf8");
}

function extractBlock(text, startMarker, endMarker) {
  const start = text.indexOf(startMarker);
  const end = text.indexOf(endMarker);
  if (start === -1 || end === -1 || end < start) {
    throw new Error(`claim_block_missing:${startMarker}`);
  }
  return text
    .slice(start + startMarker.length, end)
    .trim()
    .replace(/\r\n/g, "\n");
}

function normalizeMarkdownTable(block) {
  return block
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("|"))
    .map((line) =>
      line
        .split("|")
        .slice(1, -1)
        .map((cell) => cell.trim()),
    )
    .filter(
      (cells) => !cells.every((cell) => cell.length > 0 && /^-+$/.test(cell)),
    )
    .map((cells) => cells.join("|"))
    .join("\n");
}

function formatServerClaimRows(rows) {
  const lines = [
    "| Host | OS | Arch | Runtime family | Package class | Capability family | Isolation floor | Status |",
    "| ---- | -- | ---- | -------------- | ------------- | ----------------- | --------------- | ------ |",
  ];
  for (const row of rows) {
    lines.push(
      `| ${row.host} | ${row.os} | ${row.arch} | ${row.runtimeFamily} | ${row.packageClass} | ${row.capabilityFamily} | ${row.isolationFloorVersion} | ${row.evidenceStatus} |`,
    );
  }
  return lines.join("\n");
}

function formatBrowserClaimRows(rows) {
  const lines = [
    "| Engine | Version band | Capability family | Feature state | Permission state | Package class | Status |",
    "| ------ | ------------ | ----------------- | ------------- | ---------------- | ------------- | ------ |",
  ];
  for (const row of rows) {
    lines.push(
      `| ${row.browserEngine} | ${row.browserVersionBand} | ${row.capabilityFamily} | ${row.featureState} | ${row.permissionState} | ${row.packageClass} | ${row.evidenceStatus} |`,
    );
  }
  return lines.join("\n");
}

function formatServerPackageClaims(packageClaims) {
  return Object.entries(packageClaims)
    .map(([host, packages]) => {
      const packageList = [...packages]
        .sort()
        .map((name) => `\`${name}\``)
        .join(", ");
      return `- \`${host}\`: ${packageList}`;
    })
    .join("\n");
}

function formatBrowserFixtureClaims(families) {
  return [...families].map((family) => `- \`${family}\``).join("\n");
}

function main() {
  const { serverDoc, browserDoc } = generateEvidenceMatrices();
  const supportMatrix = read("docs/support-matrix.md");
  const compatibilityMatrix = read("docs/reference/compatibility-matrix.md");

  const failures = [];
  if (
    normalizeMarkdownTable(
      extractBlock(
        supportMatrix,
        "<!-- server-claim-rows:start -->",
        "<!-- server-claim-rows:end -->",
      ),
    ) !== normalizeMarkdownTable(formatServerClaimRows(serverDoc.supportedRows))
  ) {
    failures.push({ error: "server_claim_rows_out_of_sync" });
  }
  if (
    normalizeMarkdownTable(
      extractBlock(
        supportMatrix,
        "<!-- browser-claim-rows:start -->",
        "<!-- browser-claim-rows:end -->",
      ),
    ) !==
    normalizeMarkdownTable(formatBrowserClaimRows(browserDoc.supportedRows))
  ) {
    failures.push({ error: "browser_claim_rows_out_of_sync" });
  }
  if (
    extractBlock(
      compatibilityMatrix,
      "<!-- server-package-claims:start -->",
      "<!-- server-package-claims:end -->",
    ) !== formatServerPackageClaims(serverDoc.supportedPurePythonImports)
  ) {
    failures.push({ error: "server_package_claims_out_of_sync" });
  }
  if (
    extractBlock(
      compatibilityMatrix,
      "<!-- browser-fixture-claims:start -->",
      "<!-- browser-fixture-claims:end -->",
    ) !== formatBrowserFixtureClaims(browserDoc.browserExecutedFixtureFamilies)
  ) {
    failures.push({ error: "browser_fixture_claims_out_of_sync" });
  }

  const payload = {
    ok: failures.length === 0,
    serverMatrix: "artifacts/compat/server-compatibility-matrix.json",
    browserMatrix: "artifacts/compat/browser-capability-matrix.json",
    failures,
  };
  ensureDir(outPath);
  fs.writeFileSync(outPath, JSON.stringify(payload, null, 2) + "\n", "utf8");
  if (failures.length > 0) process.exitCode = 1;
}

Promise.resolve()
  .then(() => main())
  .catch((error) => {
    ensureDir(outPath);
    fs.writeFileSync(
      outPath,
      JSON.stringify({ ok: false, error: String(error) }, null, 2) + "\n",
      "utf8",
    );
    process.exitCode = 1;
  });
