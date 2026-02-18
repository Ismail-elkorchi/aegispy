import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");

const runtimeArtifactPath = path.join(
  repoRoot,
  "artifacts",
  "security",
  "kernel-isolation-runtime.json",
);
const gateOutPath = path.join(
  repoRoot,
  "artifacts",
  "gates",
  "kernel-isolation-check.json",
);

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

function main() {
  const failures = [];

  if (!fs.existsSync(runtimeArtifactPath)) {
    failures.push({
      error: "missing_kernel_isolation_artifact",
      path: "artifacts/security/kernel-isolation-runtime.json",
    });
  } else {
    const doc = JSON.parse(fs.readFileSync(runtimeArtifactPath, "utf8"));
    if (doc.ok !== true) failures.push({ error: "kernel_isolation_not_ok" });
    if (doc.host !== "node")
      failures.push({ error: "kernel_isolation_host_not_node" });
    if (doc.conformanceProfile !== "server-hardened") {
      failures.push({ error: "kernel_isolation_profile_not_server_hardened" });
    }
    if (doc.transport !== "process") {
      failures.push({ error: "kernel_isolation_transport_not_process" });
    }
    if (doc.capabilityChannel !== "component-wit") {
      failures.push({ error: "kernel_isolation_channel_not_component_wit" });
    }
    if (doc.supported !== true) {
      failures.push({ error: "kernel_isolation_not_supported" });
    }
    if (doc.noNewPrivs !== true) {
      failures.push({ error: "kernel_isolation_no_new_privs_not_enforced" });
    }
    if (typeof doc.cgroupPath !== "string" || doc.cgroupPath.length === 0) {
      failures.push({ error: "kernel_isolation_cgroup_missing" });
    }

    const namespaces = doc.namespaces ?? {};
    for (const name of ["pid", "mnt", "net", "uts", "ipc", "cgroup"]) {
      const value = namespaces[name];
      if (typeof value !== "string" || value.length === 0) {
        failures.push({
          error: "kernel_isolation_namespace_missing",
          namespace: name,
        });
      }
    }
  }

  const payload = {
    ok: failures.length === 0,
    checked: [
      "artifacts/security/kernel-isolation-runtime.json",
      "artifacts/gates/kernel-isolation-check.json",
    ],
    failures,
  };
  writeGate(payload);
  if (payload.ok !== true) process.exitCode = 1;
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
