import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");
const runtimeDenialsPath = path.join(
  repoRoot,
  "artifacts",
  "security",
  "runtime-policy-denials.json",
);
const isolationProfilePath = path.join(
  repoRoot,
  "artifacts",
  "security",
  "isolation-profile.json",
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
  if (!fs.existsSync(runtimeDenialsPath)) {
    failures.push({
      error: "missing_security_artifact",
      path: "artifacts/security/runtime-policy-denials.json",
    });
  } else {
    const doc = JSON.parse(fs.readFileSync(runtimeDenialsPath, "utf8"));
    if (doc.ok !== true) failures.push({ error: "runtime_denials_not_ok" });
    if (doc.fsDenied !== true)
      failures.push({ error: "missing_fs_denial_proof_runtime" });
    if (doc.httpDenied !== true)
      failures.push({ error: "missing_http_denial_proof_runtime" });
    if (doc.isolationDenied !== true)
      failures.push({ error: "missing_isolation_denial_proof_runtime" });
    if (doc.transport !== "process")
      failures.push({ error: "runtime_denials_not_process_transport" });
  }

  if (!fs.existsSync(isolationProfilePath)) {
    failures.push({
      error: "missing_isolation_profile_artifact",
      path: "artifacts/security/isolation-profile.json",
    });
  } else {
    const doc = JSON.parse(fs.readFileSync(isolationProfilePath, "utf8"));
    const profileName =
      typeof doc.profile === "object" && doc.profile !== null
        ? doc.profile.name
        : undefined;
    if (doc.ok !== true) failures.push({ error: "isolation_profile_not_ok" });
    if (doc.transport !== "process")
      failures.push({ error: "isolation_profile_not_process_transport" });
    if (profileName !== "strict")
      failures.push({ error: "isolation_profile_not_strict" });
  }

  const payload = {
    ok: failures.length === 0,
    checked: [
      "artifacts/security/runtime-policy-denials.json",
      "artifacts/security/isolation-profile.json",
    ],
    failures,
  };
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
