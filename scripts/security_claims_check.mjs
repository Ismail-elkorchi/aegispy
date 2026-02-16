import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");
const inPath = path.join(
  repoRoot,
  "artifacts",
  "security",
  "policy-denials.json",
);
const outPath = path.join(
  repoRoot,
  "artifacts",
  "gates",
  "security-claims-check.json",
);

function ensureDir(p) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
}

function main() {
  const failures = [];
  if (!fs.existsSync(inPath)) {
    failures.push({
      error: "missing_security_artifact",
      path: "artifacts/security/policy-denials.json",
    });
  } else {
    const doc = JSON.parse(fs.readFileSync(inPath, "utf8"));
    if (doc.fsDenied !== true)
      failures.push({ error: "missing_fs_denial_proof" });
    if (doc.httpDenied !== true)
      failures.push({ error: "missing_http_denial_proof" });
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
