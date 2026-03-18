import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");

const architectureModelPath = path.join(
  repoRoot,
  "tools",
  "architecture-model.v1.json",
);
const gateOutPath = path.join(
  repoRoot,
  "artifacts",
  "gates",
  "portable-isolation-floor-check.json",
);

function normalizeOs(platform) {
  if (platform === "darwin") return "macos";
  if (platform === "win32") return "windows";
  return platform;
}

function ensureDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function writeGate(payload) {
  ensureDir(gateOutPath);
  fs.writeFileSync(
    gateOutPath,
    `${JSON.stringify(payload, null, 2)}\n`,
    "utf8",
  );
}

function validateCommonFloor(payload, terms, failures, scope) {
  for (const term of terms) {
    if (payload?.commonFloor?.[term] !== true) {
      failures.push({
        error: "portable_isolation_floor_term_missing",
        scope,
        term,
      });
    }
  }
}

function main() {
  const failures = [];
  const architecture = JSON.parse(
    fs.readFileSync(architectureModelPath, "utf8"),
  );
  const os = normalizeOs(process.platform);
  const smokeArtifactPath = path.join(
    repoRoot,
    "artifacts",
    "security",
    `portable-isolation-floor-${os}.json`,
  );
  const checked = [
    "tools/architecture-model.v1.json",
    `artifacts/security/portable-isolation-floor-${os}.json`,
    "artifacts/gates/portable-isolation-floor-check.json",
  ];

  if (!fs.existsSync(smokeArtifactPath)) {
    failures.push({
      error: "missing_portable_isolation_floor_smoke_artifact",
      path: `artifacts/security/portable-isolation-floor-${os}.json`,
    });
  } else {
    const smoke = JSON.parse(fs.readFileSync(smokeArtifactPath, "utf8"));
    if (smoke.ok !== true) {
      failures.push({ error: "portable_isolation_floor_smoke_not_ok" });
    }
    if (smoke.os !== os) {
      failures.push({ error: "portable_isolation_floor_smoke_os_mismatch" });
    }
    if (smoke.portableIsolationFloorVersion !== "portable-floor-draft-v1") {
      failures.push({
        error: "portable_isolation_floor_version_invalid",
      });
    }
    if (smoke.evidenceStatus !== "prototype") {
      failures.push({
        error: "portable_isolation_floor_smoke_status_invalid",
      });
    }
    if (!Array.isArray(smoke.hostStrengthening)) {
      failures.push({
        error: "portable_isolation_floor_smoke_host_strengthening_invalid",
      });
    }
    validateCommonFloor(
      smoke,
      architecture.portableCommonIsolationFloor,
      failures,
      "smoke",
    );
  }

  if (process.env.AEGISPY_PORTABLE_FLOOR_RUNTIME_REQUIRED === "1") {
    const runtimeArtifactPath = path.join(
      repoRoot,
      "artifacts",
      "security",
      "portable-isolation-floor-runtime.json",
    );
    const strengtheningArtifactPath = path.join(
      repoRoot,
      "artifacts",
      "security",
      "host-strengthening-linux.json",
    );
    checked.push(
      "artifacts/security/portable-isolation-floor-runtime.json",
      "artifacts/security/host-strengthening-linux.json",
    );
    if (!fs.existsSync(runtimeArtifactPath)) {
      failures.push({
        error: "missing_portable_isolation_floor_runtime_artifact",
      });
    } else {
      const runtime = JSON.parse(fs.readFileSync(runtimeArtifactPath, "utf8"));
      if (runtime.ok !== true) {
        failures.push({ error: "portable_isolation_floor_runtime_not_ok" });
      }
      if (runtime.os !== "linux") {
        failures.push({ error: "portable_isolation_floor_runtime_not_linux" });
      }
      if (runtime.evidenceStatus !== "supported") {
        failures.push({
          error: "portable_isolation_floor_runtime_status_invalid",
        });
      }
      if (runtime.portableIsolationFloorVersion !== "portable-floor-draft-v1") {
        failures.push({
          error: "portable_isolation_floor_runtime_version_invalid",
        });
      }
      if (!runtime.hostStrengthening?.includes("linux-kernel-controls")) {
        failures.push({
          error: "portable_isolation_floor_linux_strengthening_missing",
        });
      }
      validateCommonFloor(
        runtime,
        architecture.portableCommonIsolationFloor,
        failures,
        "runtime",
      );
    }

    if (!fs.existsSync(strengtheningArtifactPath)) {
      failures.push({
        error: "missing_host_strengthening_linux_artifact",
      });
    } else {
      const strengthening = JSON.parse(
        fs.readFileSync(strengtheningArtifactPath, "utf8"),
      );
      if (strengthening.ok !== true) {
        failures.push({ error: "host_strengthening_linux_not_ok" });
      }
      if (strengthening.strengthening !== "linux-kernel-controls") {
        failures.push({
          error: "host_strengthening_linux_name_invalid",
        });
      }
      if (strengthening.noNewPrivs !== true) {
        failures.push({
          error: "host_strengthening_linux_no_new_privs_missing",
        });
      }
      if (strengthening.seccompActive !== true) {
        failures.push({
          error: "host_strengthening_linux_seccomp_missing",
        });
      }
      if (strengthening.cgroup !== true) {
        failures.push({
          error: "host_strengthening_linux_cgroup_missing",
        });
      }
    }
  }

  const payload = {
    ok: failures.length === 0,
    checked,
    failures,
  };
  writeGate(payload);
  if (payload.ok !== true) {
    process.exitCode = 1;
  }
}

Promise.resolve()
  .then(() => main())
  .catch((error) => {
    writeGate({
      ok: false,
      error: String(error),
    });
    process.exitCode = 1;
  });
