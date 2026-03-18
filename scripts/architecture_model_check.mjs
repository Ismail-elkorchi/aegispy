import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");
const outPath = path.join(
  repoRoot,
  "artifacts",
  "gates",
  "architecture-model-check.json",
);

const architectureModelPath = path.join(
  repoRoot,
  "tools",
  "architecture-model.v1.json",
);

function ensureDir(fullPath) {
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
}

function read(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), "utf8");
}

function expectExactList(failures, actual, expected, field) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    failures.push({
      error: "architecture_model_list_mismatch",
      field,
      expected,
      actual,
    });
  }
}

function main() {
  const failures = [];

  if (!fs.existsSync(architectureModelPath)) {
    failures.push({
      error: "missing_architecture_model",
      path: "tools/architecture-model.v1.json",
    });
  } else {
    const doc = JSON.parse(fs.readFileSync(architectureModelPath, "utf8"));
    if (doc.version !== 1) {
      failures.push({
        error: "architecture_model_version_invalid",
        actual: doc.version ?? null,
      });
    }

    expectExactList(
      failures,
      doc.serverCapabilityFamilies,
      ["storage", "network", "environment", "process", "handles"],
      "serverCapabilityFamilies",
    );
    expectExactList(
      failures,
      doc.browserCapabilityFamilies,
      ["storage", "network", "fileAccess", "worker", "handles"],
      "browserCapabilityFamilies",
    );
    expectExactList(
      failures,
      doc.packageClasses,
      ["base_interpreter", "pure_python", "native_platform", "project_overlay"],
      "packageClasses",
    );
    expectExactList(
      failures,
      doc.nativeProofDepths,
      ["package", "module"],
      "nativeProofDepths",
    );
    expectExactList(
      failures,
      doc.browserCapabilityStates,
      ["available_granted", "available_denied", "unavailable", "hard_limit"],
      "browserCapabilityStates",
    );
    expectExactList(
      failures,
      doc.browserFeatureStates,
      ["available", "unavailable", "hard_limit"],
      "browserFeatureStates",
    );
    expectExactList(
      failures,
      doc.browserPermissionStates,
      ["granted", "denied", "not_requested", "not_applicable"],
      "browserPermissionStates",
    );
    expectExactList(
      failures,
      doc.portableCommonIsolationFloor,
      [
        "process_boundary",
        "immutable_runtime_image",
        "projected_roots",
        "guest_temp_root",
        "environment_allowlist",
        "resource_ceilings",
        "brokered_capabilities",
        "audit_trail",
        "artifact_integrity",
      ],
      "portableCommonIsolationFloor",
    );
    expectExactList(
      failures,
      doc.evidenceStatuses,
      ["supported", "unsupported", "prototype", "not_proven"],
      "evidenceStatuses",
    );
    if (doc?.claimPolicy?.publicSupportRequiresStatus !== "supported") {
      failures.push({
        error: "architecture_model_claim_policy_invalid",
      });
    }
  }

  const docs = {
    architecture: read("docs/architecture.md"),
    runtimeApi: read("docs/reference/runtime-api.md"),
    supportMatrix: read("docs/support-matrix.md"),
    profiles: read("docs/reference/profiles.md"),
    compatibilityMatrix: read("docs/reference/compatibility-matrix.md"),
  };

  for (const [name, text] of Object.entries(docs)) {
    if (!text.includes("portable common isolation floor")) {
      failures.push({
        error: "architecture_doc_phrase_missing",
        file: name,
        phrase: "portable common isolation floor",
      });
    }
  }

  if (!docs.architecture.includes("OS-specific strengthening claims")) {
    failures.push({
      error: "architecture_doc_phrase_missing",
      file: "architecture",
      phrase: "OS-specific strengthening claims",
    });
  }
  for (const phrase of [
    "server bundled compatibility runtime",
    "browser native capability runtime",
  ]) {
    if (!docs.architecture.includes(phrase)) {
      failures.push({
        error: "architecture_doc_phrase_missing",
        file: "architecture",
        phrase,
      });
    }
  }
  for (const phrase of [
    "current implementation truth",
    "capability families",
  ]) {
    if (!docs.runtimeApi.includes(phrase)) {
      failures.push({
        error: "runtime_api_phrase_missing",
        phrase,
      });
    }
  }
  for (const phrase of ["package classes", "matrix-backed"]) {
    if (!docs.supportMatrix.includes(phrase)) {
      failures.push({
        error: "support_matrix_phrase_missing",
        phrase,
      });
    }
  }
  if (!docs.profiles.includes("OS-specific strengthening")) {
    failures.push({
      error: "profiles_phrase_missing",
      phrase: "OS-specific strengthening",
    });
  }
  for (const [file, text] of Object.entries({
    supportMatrix: docs.supportMatrix,
    compatibilityMatrix: docs.compatibilityMatrix,
  })) {
    if (!text.includes("proof depth")) {
      failures.push({
        error: "native_proof_depth_phrase_missing",
        file,
      });
    }
  }

  const payload = {
    ok: failures.length === 0,
    failures,
  };

  ensureDir(outPath);
  fs.writeFileSync(outPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");

  if (failures.length > 0) {
    process.exitCode = 1;
  }
}

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
