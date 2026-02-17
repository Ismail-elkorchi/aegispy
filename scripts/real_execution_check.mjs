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
    componentBuild: "artifacts/component/build.json",
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
    if (realEngine.capabilityChannel !== "component-wit")
      failures.push({ error: "real_engine_not_component_wit_channel" });
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
    if (isolation.capabilityChannel !== "component-wit")
      failures.push({ error: "isolation_not_component_wit_channel" });
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
    if (runtimeDenials.capabilityChannel !== "component-wit")
      failures.push({ error: "runtime_denials_not_component_wit_channel" });
    if (runtimeDenials.fsDenied !== true)
      failures.push({ error: "runtime_denials_missing_fs" });
    if (runtimeDenials.httpDenied !== true)
      failures.push({ error: "runtime_denials_missing_http" });
    if (runtimeDenials.isolationDenied !== true)
      failures.push({ error: "runtime_denials_missing_isolation" });
  }

  const componentBuild = readJsonOrNull(proofs.componentBuild);
  if (!componentBuild) {
    failures.push({
      error: "missing_component_build_artifact",
      path: proofs.componentBuild,
    });
  } else {
    if (componentBuild.ok !== true)
      failures.push({ error: "component_build_not_ok" });
    if (componentBuild.runtimeBridge !== "component-wit-json-request-stream")
      failures.push({
        error: "component_bridge_not_json_request_stream_runtime",
      });
    if (
      componentBuild.requiredHostImportContract !== "aegispy:runtime/capability"
    )
      failures.push({ error: "component_required_host_import_contract_unset" });
    if (componentBuild.nativeHostImportDetected !== true)
      failures.push({ error: "component_native_host_import_not_detected" });
    const imports = Array.isArray(componentBuild.worldImports)
      ? componentBuild.worldImports
      : [];
    const exports = Array.isArray(componentBuild.worldExports)
      ? componentBuild.worldExports
      : [];
    if (!imports.includes("wasi:cli/stdin@0.2.6"))
      failures.push({ error: "component_missing_wasi_cli_stdin_import" });
    if (!exports.includes("wasi:cli/run@0.2.6"))
      failures.push({ error: "component_missing_wasi_cli_run_export" });
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
    workerCapabilityChannelFixedComponentWit: workerMain.includes(
      '"capability_channel:component-wit"',
    ),
    workerCapabilityPreludeInjectionPresent: workerMain.includes(
      "build_runtime_capability_prelude_wit_host_abi",
    ),
    workerRuntimeSupportModulePresent: workerMain.includes(
      "prepare_runtime_support_bindings",
    ),
    workerNativeHostImportBindingPresent: workerMain.includes(
      "AegispyRuntime::add_to_linker",
    ),
    workerSitecustomizeBindingPresent: workerMain.includes("sitecustomize.py"),
    workerWasiExecutorPresent: workerMain.includes("impl WasiExecutor"),
    workerUsesComponentModel: workerMain.includes("WasmComponent::from_file"),
    workerUsesComponentCommandBinding: workerMain.includes(
      "WasiCommand::instantiate",
    ),
    workerStillUsesCoreModuleExecution:
      workerMain.includes("Module::from_file"),
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
  if (!simulationSignals.workerCapabilityChannelFixedComponentWit) {
    failures.push({ error: "worker_capability_channel_not_component_wit" });
  }
  if (simulationSignals.workerCapabilityPreludeInjectionPresent) {
    failures.push({ error: "worker_capability_prelude_injection_present" });
  }
  if (!simulationSignals.workerRuntimeSupportModulePresent) {
    failures.push({ error: "worker_runtime_support_module_missing" });
  }
  if (!simulationSignals.workerNativeHostImportBindingPresent) {
    failures.push({ error: "worker_native_host_import_binding_missing" });
  }
  if (!simulationSignals.workerSitecustomizeBindingPresent) {
    failures.push({ error: "worker_sitecustomize_binding_missing" });
  }
  if (!simulationSignals.workerWasiExecutorPresent) {
    failures.push({ error: "worker_wasi_executor_missing" });
  }
  if (!simulationSignals.workerUsesComponentModel) {
    failures.push({ error: "worker_component_model_execution_missing" });
  }
  if (!simulationSignals.workerUsesComponentCommandBinding) {
    failures.push({ error: "worker_component_command_binding_missing" });
  }
  if (simulationSignals.workerStillUsesCoreModuleExecution) {
    failures.push({ error: "worker_core_module_execution_still_present" });
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
