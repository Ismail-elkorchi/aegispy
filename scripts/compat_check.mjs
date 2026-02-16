import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");
const inPath = path.join(repoRoot, "artifacts", "compat", "stdlib-smoke.json");
const outPath = path.join(repoRoot, "artifacts", "gates", "compat-check.json");

function ensureDir(p) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
}

function main() {
  const failures = [];
  if (!fs.existsSync(inPath)) {
    failures.push({
      error: "missing_compat_artifact",
      path: "artifacts/compat/stdlib-smoke.json",
    });
  } else {
    const doc = JSON.parse(fs.readFileSync(inPath, "utf8"));
    if (doc.passed !== true) failures.push({ error: "compat_smoke_failed" });
    if (!Array.isArray(doc.executed) || doc.executed.length === 0)
      failures.push({ error: "compat_executed_list_missing" });
  }

  const payload =
    failures.length === 0 ? { ok: true } : { ok: false, failures };
  ensureDir(outPath);
  fs.writeFileSync(outPath, JSON.stringify(payload, null, 2) + "\n", "utf8");
  if (failures.length > 0) process.exitCode = 1;
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
