import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { generateEvidenceMatrices } from "./evidence_matrix_generate.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const repoRoot = path.resolve(__dirname, "..");
const outPath = path.join(repoRoot, "artifacts", "gates", "docs-complete.json");
const serverMatrixPath = path.join(
  repoRoot,
  "artifacts",
  "compat",
  "server-compatibility-matrix.json",
);
const browserMatrixPath = path.join(
  repoRoot,
  "artifacts",
  "compat",
  "browser-capability-matrix.json",
);

function ensureDir(p) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
}

function main() {
  generateEvidenceMatrices();

  const required = [
    "docs/index.md",
    "docs/architecture.md",
    "docs/tutorial/first-run.md",
    "docs/how-to/choose-a-host.md",
    "docs/how-to/troubleshoot-common-failures.md",
    "docs/reference/runtime-api.md",
    "docs/reference/profiles.md",
    "docs/maintainers/ci-and-governance.md",
    "docs/security.md",
    "docs/gates.md",
    "docs/runbook.md",
    "docs/support-matrix.md",
  ];

  const missing = [];
  for (const r of required) {
    const full = path.join(repoRoot, r);
    if (!fs.existsSync(full)) missing.push(r);
  }

  const artifactsMissing = [];
  for (const full of [serverMatrixPath, browserMatrixPath]) {
    if (!fs.existsSync(full)) {
      artifactsMissing.push(path.relative(repoRoot, full));
    }
  }

  const payload =
    missing.length === 0 && artifactsMissing.length === 0
      ? { ok: true }
      : { ok: false, missing, artifactsMissing };
  ensureDir(outPath);
  fs.writeFileSync(outPath, JSON.stringify(payload, null, 2) + "\n", "utf8");
  if (missing.length > 0 || artifactsMissing.length > 0) process.exitCode = 1;
}

Promise.resolve()
  .then(() => main())
  .catch((e) => {
    ensureDir(outPath);
    fs.writeFileSync(
      outPath,
      JSON.stringify({ ok: false, error: String(e) }, null, 2) + "\n",
      "utf8",
    );
    process.exitCode = 1;
  });
