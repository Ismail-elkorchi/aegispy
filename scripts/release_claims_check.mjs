import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { defaultReleaseRehearsalSubjects } from "./release-rehearsal.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");
const outPath = path.join(
  repoRoot,
  "artifacts",
  "gates",
  "release-claims.json",
);

function run(command) {
  const result = spawnSync("bash", ["-lc", command], {
    cwd: repoRoot,
    stdio: "inherit",
  });
  return (result.status ?? 1) === 0;
}

function ensureDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function isSha256(value) {
  return typeof value === "string" && /^[0-9a-f]{64}$/u.test(value);
}

function sha256File(filePath) {
  return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function readGate(relPath) {
  const fullPath = path.join(repoRoot, relPath);
  if (!fs.existsSync(fullPath)) {
    return { ok: false, missing: true };
  }
  const doc = JSON.parse(fs.readFileSync(fullPath, "utf8"));
  return { ok: doc.ok === true, missing: false };
}

function validateDigestRecord({
  document,
  field,
  expectedPath,
  releaseRepoRoot,
  failures,
}) {
  const entry = document[field];
  if (typeof entry !== "object" || entry === null) {
    failures.push({
      error: "release_rehearsal_artifact_record_missing",
      field,
    });
    return;
  }

  if (entry.path !== expectedPath) {
    failures.push({ error: "release_rehearsal_artifact_path_invalid", field });
    return;
  }

  const artifactPath = path.join(releaseRepoRoot, entry.path);
  if (!fs.existsSync(artifactPath)) {
    failures.push({ error: "release_rehearsal_artifact_missing", field });
    return;
  }

  if (!isSha256(entry.sha256)) {
    failures.push({ error: "release_rehearsal_artifact_hash_invalid", field });
    return;
  }

  const actualSha256 = sha256File(artifactPath);
  if (actualSha256 !== entry.sha256) {
    failures.push({ error: "release_rehearsal_artifact_hash_mismatch", field });
  }
}

export function validateReleaseRehearsalArtifact(document, options = {}) {
  const releaseRepoRoot = options.repoRoot ?? repoRoot;
  const failures = [];

  if (document?.ok !== true) {
    failures.push({ error: "release_rehearsal_not_ok" });
  }
  if (document?.publishSkipped !== true) {
    failures.push({ error: "release_rehearsal_publish_not_skipped" });
  }
  if (typeof document?.version !== "string" || document.version.length === 0) {
    failures.push({ error: "release_rehearsal_version_missing" });
  }
  if (
    typeof document?.tagName !== "string" ||
    document.tagName.length === 0 ||
    document.tagName !== `v${document.version}`
  ) {
    failures.push({ error: "release_rehearsal_tag_mismatch" });
  }

  for (const [field, expectedPath] of [
    ["sourceArchive", "dist/aegispy-source.tar.gz"],
    ["releaseNotes", "dist/release-notes.md"],
    ["sbom", "artifacts/security/supply-chain-sbom.json"],
    [
      "supplyChainAttestation",
      "artifacts/security/supply-chain-attestation.json",
    ],
  ]) {
    validateDigestRecord({
      document,
      field,
      expectedPath,
      releaseRepoRoot,
      failures,
    });
  }

  const provenance = document?.provenanceVerification;
  if (typeof provenance !== "object" || provenance === null) {
    failures.push({ error: "release_rehearsal_provenance_missing" });
  } else {
    if (provenance.ok !== true) {
      failures.push({ error: "release_rehearsal_provenance_not_ok" });
    }
    if (provenance.skipped === true) {
      failures.push({ error: "release_rehearsal_provenance_skipped" });
    }
    if (
      !Array.isArray(provenance.subjects) ||
      defaultReleaseRehearsalSubjects.some(
        (subject) => !provenance.subjects.includes(subject),
      )
    ) {
      failures.push({ error: "release_rehearsal_subjects_invalid" });
    }
  }

  return {
    ok: failures.length === 0,
    present: true,
    failures,
  };
}

export function readReleaseRehearsal(relPath, options = {}) {
  const releaseRepoRoot = options.repoRoot ?? repoRoot;
  const fullPath = path.join(releaseRepoRoot, relPath);
  if (!fs.existsSync(fullPath)) {
    return { ok: true, present: false, failures: [] };
  }

  const document = JSON.parse(fs.readFileSync(fullPath, "utf8"));
  return validateReleaseRehearsalArtifact(document, {
    repoRoot: releaseRepoRoot,
  });
}

function main() {
  const gateFiles = {
    component: "artifacts/gates/component-artifact-check.json",
    nativeHostImport: "artifacts/gates/native-host-import-check.json",
    supplyChain: "artifacts/gates/supply-chain-check.json",
    provenanceVerify: "artifacts/gates/provenance-verify-check.json",
    releaseRehearsal: "artifacts/security/release-rehearsal.json",
  };
  const hasReleaseRehearsal = fs.existsSync(
    path.join(repoRoot, gateFiles.releaseRehearsal),
  );
  const checks = hasReleaseRehearsal
    ? [
        "AEGISPY_PROVENANCE_VERIFY_REQUIRED=1 bash scripts/provenance_verify_check",
      ]
    : [
        "pnpm component:build",
        "bash scripts/component_artifact_check",
        "AEGISPY_NATIVE_HOST_IMPORT_GATE_MODE=strict bash scripts/native_host_import_check",
        "bash scripts/supply_chain_check",
        "AEGISPY_PROVENANCE_VERIFY_REQUIRED=1 bash scripts/provenance_verify_check",
      ];

  let ok = true;
  for (const check of checks) {
    if (!run(check)) {
      ok = false;
    }
  }

  const gateStatus = {
    component: readGate(gateFiles.component),
    nativeHostImport: readGate(gateFiles.nativeHostImport),
    supplyChain: readGate(gateFiles.supplyChain),
    provenanceVerify: readGate(gateFiles.provenanceVerify),
    releaseRehearsal: readReleaseRehearsal(gateFiles.releaseRehearsal),
  };

  if (
    !gateStatus.component.ok ||
    !gateStatus.nativeHostImport.ok ||
    !gateStatus.supplyChain.ok ||
    !gateStatus.provenanceVerify.ok ||
    !gateStatus.releaseRehearsal.ok
  ) {
    ok = false;
  }

  const payload = {
    ok,
    gates: gateStatus,
    artifacts: gateFiles,
  };
  ensureDir(outPath);
  fs.writeFileSync(outPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");

  if (!ok) {
    process.exitCode = 1;
  }
}

const isEntryPoint =
  typeof process.argv[1] === "string" &&
  path.resolve(process.argv[1]) === __filename;

if (isEntryPoint) {
  Promise.resolve()
    .then(() => main())
    .catch((error) => {
      ensureDir(outPath);
      fs.writeFileSync(
        outPath,
        `${JSON.stringify({ ok: false, error: String(error) }, null, 2)}\n`,
        "utf8",
      );
      process.exitCode = 1;
    });
}
