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
  "real-execution-check.json",
);

function ensureDir(p) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
}

function readJsonOrNull(relPath) {
  const full = path.join(repoRoot, relPath);
  if (!fs.existsSync(full)) return null;
  return JSON.parse(fs.readFileSync(full, "utf8"));
}

function readText(relPath) {
  const full = path.join(repoRoot, relPath);
  return fs.existsSync(full) ? fs.readFileSync(full, "utf8") : "";
}

function main() {
  const failures = [];
  const proofs = {
    realEngine: "artifacts/tests/real-engine-default.json",
    isolation: "artifacts/security/isolation-profile.json",
    runtimeDenials: "artifacts/security/runtime-policy-denials.json",
  };

  const realEngine = readJsonOrNull(proofs.realEngine);
  if (!realEngine) {
    failures.push({
      error: "missing_real_engine_artifact",
      path: proofs.realEngine,
    });
  } else {
    if (realEngine.ok !== true) failures.push({ error: "real_engine_not_ok" });
    if (realEngine.transport !== "process")
      failures.push({ error: "real_engine_not_process_transport" });
  }

  const isolation = readJsonOrNull(proofs.isolation);
  if (!isolation) {
    failures.push({
      error: "missing_isolation_artifact",
      path: proofs.isolation,
    });
  } else {
    const profileName =
      typeof isolation.profile === "object" && isolation.profile !== null
        ? isolation.profile.name
        : undefined;
    if (isolation.ok !== true) failures.push({ error: "isolation_not_ok" });
    if (isolation.transport !== "process")
      failures.push({ error: "isolation_not_process_transport" });
    if (profileName !== "strict")
      failures.push({ error: "isolation_not_strict_profile" });
  }

  const runtimeDenials = readJsonOrNull(proofs.runtimeDenials);
  if (!runtimeDenials) {
    failures.push({
      error: "missing_runtime_denials_artifact",
      path: proofs.runtimeDenials,
    });
  } else {
    if (runtimeDenials.ok !== true)
      failures.push({ error: "runtime_denials_not_ok" });
    if (runtimeDenials.transport !== "process")
      failures.push({ error: "runtime_denials_not_process_transport" });
    if (runtimeDenials.fsDenied !== true)
      failures.push({ error: "runtime_denials_missing_fs" });
    if (runtimeDenials.httpDenied !== true)
      failures.push({ error: "runtime_denials_missing_http" });
    if (runtimeDenials.isolationDenied !== true)
      failures.push({ error: "runtime_denials_missing_isolation" });
  }

  const coreFactory = readText("packages/aegispy-core/src/runtime/factory.ts");
  const nodeRuntime = readText(
    "packages/aegispy-node/src/runtime/node-runtime.ts",
  );
  const workerMain = readText("rust/aegispy-worker/src/main.rs");
  const simulationSignals = {
    coreFactoryContainsSimulatedRuntimeClass: coreFactory.includes(
      "class SimulatedRuntime",
    ),
    coreFactoryContainsKnownHostsDefault:
      coreFactory.includes("const knownHosts"),
    nodeTransportDefaultsToProcess: nodeRuntime.includes(
      'AEGISPY_NODE_TRANSPORT ?? "process"',
    ),
    nodeRuntimeContainsDefaultInProcessPath: nodeRuntime.includes(
      "return new InProcessTransport();",
    ),
    workerExecutorDefaultsToSimulation: workerMain.includes(
      'unwrap_or_else(|_| "simulation".to_string())',
    ),
    workerExecutorDefaultsToWasi: workerMain.includes(
      'unwrap_or_else(|_| "wasi".to_string())',
    ),
    workerWasiExecutorPresent: workerMain.includes("impl WasiExecutor"),
  };

  if (simulationSignals.coreFactoryContainsSimulatedRuntimeClass) {
    failures.push({ error: "core_factory_simulation_default_detected" });
  }
  if (simulationSignals.coreFactoryContainsKnownHostsDefault) {
    failures.push({ error: "core_factory_default_host_mapping_detected" });
  }
  if (!simulationSignals.nodeTransportDefaultsToProcess) {
    failures.push({ error: "node_transport_default_not_process" });
  }
  if (simulationSignals.nodeRuntimeContainsDefaultInProcessPath) {
    failures.push({ error: "node_runtime_default_inprocess_detected" });
  }
  if (simulationSignals.workerExecutorDefaultsToSimulation) {
    failures.push({ error: "worker_executor_default_simulation_detected" });
  }
  if (!simulationSignals.workerExecutorDefaultsToWasi) {
    failures.push({ error: "worker_executor_default_not_wasi" });
  }
  if (!simulationSignals.workerWasiExecutorPresent) {
    failures.push({ error: "worker_wasi_executor_missing" });
  }

  const payload = {
    ok: failures.length === 0,
    proofs,
    simulationSignals,
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
