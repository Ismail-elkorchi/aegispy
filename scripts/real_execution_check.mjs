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
    denoParity: "artifacts/e2e/deno-parity.json",
    bunParity: "artifacts/e2e/bun-parity.json",
    componentBuild: "artifacts/component/build.json",
    guestCapabilityProbe:
      "artifacts/research/runtime-guest-capability-probe.json",
    nativeAbiGapProbe: "artifacts/research/runtime-native-abi-gap.json",
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
    if (realEngine.executionMode !== "process")
      failures.push({ error: "real_engine_not_process_execution_mode" });
    if (realEngine.executionBackend?.available !== true)
      failures.push({ error: "real_engine_backend_not_available" });
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
    if (isolation.executionMode !== "process")
      failures.push({ error: "isolation_not_process_execution_mode" });
    if (isolation.executionBackend?.available !== true)
      failures.push({ error: "isolation_backend_not_available" });
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
    if (runtimeDenials.executionMode !== "process")
      failures.push({ error: "runtime_denials_not_process_execution_mode" });
    if (runtimeDenials.executionBackend?.available !== true)
      failures.push({ error: "runtime_denials_backend_not_available" });
    if (runtimeDenials.capabilityChannel !== "component-wit")
      failures.push({ error: "runtime_denials_not_component_wit_channel" });
    if (runtimeDenials.fsDenied !== true)
      failures.push({ error: "runtime_denials_missing_fs" });
    if (runtimeDenials.httpDenied !== true)
      failures.push({ error: "runtime_denials_missing_http" });
    if (runtimeDenials.isolationDenied !== true)
      failures.push({ error: "runtime_denials_missing_isolation" });
  }

  const denoParity = readJsonOrNull(proofs.denoParity);
  if (!denoParity) {
    failures.push({
      error: "missing_deno_parity_artifact",
      path: proofs.denoParity,
    });
  } else {
    if (denoParity.ok !== true) failures.push({ error: "deno_parity_not_ok" });
    if (denoParity.transport !== "process")
      failures.push({ error: "deno_parity_not_process_transport" });
    if (denoParity.executionMode !== "process")
      failures.push({ error: "deno_parity_not_process_execution_mode" });
    if (denoParity.executionBackend?.available !== true)
      failures.push({ error: "deno_parity_backend_not_available" });
    if (denoParity.capabilityChannel !== "component-wit")
      failures.push({ error: "deno_parity_not_component_wit_channel" });
  }

  const bunParity = readJsonOrNull(proofs.bunParity);
  if (!bunParity) {
    failures.push({
      error: "missing_bun_parity_artifact",
      path: proofs.bunParity,
    });
  } else {
    if (bunParity.ok !== true) failures.push({ error: "bun_parity_not_ok" });
    if (bunParity.transport !== "process")
      failures.push({ error: "bun_parity_not_process_transport" });
    if (bunParity.executionMode !== "process")
      failures.push({ error: "bun_parity_not_process_execution_mode" });
    if (bunParity.executionBackend?.available !== true)
      failures.push({ error: "bun_parity_backend_not_available" });
    if (bunParity.capabilityChannel !== "component-wit")
      failures.push({ error: "bun_parity_not_component_wit_channel" });
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
    if (
      componentBuild.runtimeBridge !==
      "component-host-guest-runtime-native-abi-dispatch"
    )
      failures.push({
        error:
          "component_bridge_not_component_host_guest_runtime_native_abi_dispatch",
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

  const guestCapabilityProbe = readJsonOrNull(proofs.guestCapabilityProbe);
  if (!guestCapabilityProbe) {
    failures.push({
      error: "missing_guest_capability_probe_artifact",
      path: proofs.guestCapabilityProbe,
    });
  } else {
    if (guestCapabilityProbe.ok !== true)
      failures.push({ error: "guest_capability_probe_not_ok" });
    if (guestCapabilityProbe.transport !== "process")
      failures.push({ error: "guest_capability_probe_not_process_transport" });
    if (guestCapabilityProbe.capabilityChannel !== "component-wit")
      failures.push({
        error: "guest_capability_probe_not_component_wit_channel",
      });
    if (guestCapabilityProbe.guestCapabilityModuleDetected !== true)
      failures.push({
        error: "guest_capability_probe_module_not_detected",
      });
    if (guestCapabilityProbe.guestCapabilityExecutionDetected !== true)
      failures.push({
        error: "guest_capability_probe_execution_not_detected",
      });
    if (guestCapabilityProbe.builtinBridgeRuntimePathDetected !== true)
      failures.push({
        error: "guest_capability_probe_builtin_bridge_path_not_detected",
      });
    if (
      guestCapabilityProbe.bridgeDispatchMode !==
      "host-native-abi-direct-dispatch"
    )
      failures.push({
        error: "guest_capability_probe_unexpected_dispatch_mode",
      });
  }

  const nativeAbiGapProbe = readJsonOrNull(proofs.nativeAbiGapProbe);
  if (!nativeAbiGapProbe) {
    failures.push({
      error: "missing_native_abi_gap_probe_artifact",
      path: proofs.nativeAbiGapProbe,
    });
  } else {
    if (nativeAbiGapProbe.ok !== true)
      failures.push({ error: "native_abi_gap_probe_not_ok" });
    if (nativeAbiGapProbe.transport !== "process")
      failures.push({ error: "native_abi_gap_probe_not_process_transport" });
    if (nativeAbiGapProbe.capabilityChannel !== "component-wit")
      failures.push({
        error: "native_abi_gap_probe_not_component_wit_channel",
      });
    if (nativeAbiGapProbe.runtimeNativeAbiAvailable !== true)
      failures.push({ error: "native_abi_probe_native_abi_not_available" });
    if (nativeAbiGapProbe.dlopenDependencyRequired !== false)
      failures.push({ error: "native_abi_probe_still_requires_dlopen" });
    if (nativeAbiGapProbe.fsRoundTripDetected !== true)
      failures.push({ error: "native_abi_probe_fs_roundtrip_missing" });
    if (nativeAbiGapProbe.envRoundTripDetected !== true)
      failures.push({ error: "native_abi_probe_env_roundtrip_missing" });
    if (nativeAbiGapProbe.builtinBridgeRuntimePathDetected !== true)
      failures.push({
        error: "native_abi_probe_builtin_bridge_runtime_path_missing",
      });
    if (nativeAbiGapProbe.bridgeKind !== "builtin-capability-bridge")
      failures.push({ error: "native_abi_probe_unexpected_bridge_kind" });
    if (
      nativeAbiGapProbe.bridgeDispatchMode !== "host-native-abi-direct-dispatch"
    )
      failures.push({ error: "native_abi_probe_unexpected_dispatch_mode" });
  }

  const coreFactory = readText("packages/aegispy-core/src/runtime/factory.ts");
  const nodeRuntime = readText(
    "packages/aegispy-node/src/runtime/node-runtime.ts",
  );
  const denoRuntime = readText("packages/aegispy-deno/src/create-runtime.ts");
  const bunRuntime = readText("packages/aegispy-bun/src/create-runtime.ts");
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
    denoTransportDefaultsToProcess: denoRuntime.includes(
      'AEGISPY_DENO_TRANSPORT ?? "process"',
    ),
    denoTransportSupportsExplicitSimulation: denoRuntime.includes(
      'if (raw === "simulation") return "simulation";',
    ),
    denoRuntimeUsesRustWorkerTransportDefault: denoRuntime.includes(
      "const transport = new RustWorkerTransport();",
    ),
    bunTransportDefaultsToProcess: bunRuntime.includes(
      'AEGISPY_BUN_TRANSPORT ?? "process"',
    ),
    bunTransportSupportsExplicitSimulation: bunRuntime.includes(
      'if (raw === "simulation") return "simulation";',
    ),
    bunRuntimeUsesRustWorkerTransportDefault: bunRuntime.includes(
      "const transport = new RustWorkerTransport();",
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
    workerCapabilityGuestPlanBindingPresent: workerMain.includes(
      "build_guest_runtime_capability_plan",
    ),
    workerCapabilityNativeAbiDispatchPresent: workerMain.includes(
      "CAPABILITY_NATIVE_REQ_PREFIX",
    ),
    workerCapabilityBridgePollingPresent:
      workerMain.includes("dispatch_capability_bridge_runtime_loop") ||
      workerMain.includes("process_bridge_request_file"),
    workerCapabilityBridgeDirEnvPresent: workerMain.includes(
      "AEGISPY_CAP_BRIDGE_GUEST_DIR",
    ),
    workerCapabilityBootstrapBindingPresent: workerMain.includes(
      "build_guest_runtime_bootstrap_code",
    ),
    workerCapabilityBootstrapUsesBuiltinImport: workerMain.includes(
      "import aegispy as _aegispy",
    ),
    workerCapabilitySourceInjectionBridgePresent: workerMain.includes(
      'include_str!("../../../engine/python/aegispy/__init__.py")',
    ),
    workerCapabilityRewriteBindingPresent: workerMain.includes(
      "rewrite_capability_bindings_wit_host_abi",
    ),
    workerRuntimeUsesRewriteAsOnlyPath: workerMain.includes(
      "let runtime_code = match rewrite_capability_bindings_wit_host_abi(",
    ),
    workerCapabilityBindingModeEnvPresent: workerMain.includes(
      "AEGISPY_WORKER_CAPABILITY_BINDING_MODE",
    ),
    workerCapabilityBindingModeDefaultGuestRuntimeAbi: workerMain.includes(
      'unwrap_or_else(|_| "guest-runtime-abi".to_string())',
    ),
    workerCapabilityBindingModeSupportsGuestRuntimeAbi:
      workerMain.includes('"guest-runtime-abi"') &&
      workerMain.includes('"guest-abi"') &&
      workerMain.includes("Ok(Self::GuestRuntimeAbi)"),
    workerCapabilityBindingModeSupportsRewriteDispatch:
      workerMain.includes('"rewrite"') &&
      workerMain.includes('"rewrite-dispatch"') &&
      workerMain.includes("Ok(Self::RewriteDispatch)"),
    workerCapabilityStreamBridgePresent:
      workerMain.includes("process_wit_line") ||
      workerMain.includes("CAPABILITY_WIT_REQ_PREFIX") ||
      workerMain.includes("CAPABILITY_WIT_RES_PREFIX"),
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
  if (!simulationSignals.denoTransportDefaultsToProcess) {
    failures.push({ error: "deno_transport_default_not_process" });
  }
  if (!simulationSignals.denoTransportSupportsExplicitSimulation) {
    failures.push({ error: "deno_transport_explicit_simulation_missing" });
  }
  if (!simulationSignals.denoRuntimeUsesRustWorkerTransportDefault) {
    failures.push({ error: "deno_runtime_default_process_transport_missing" });
  }
  if (!simulationSignals.bunTransportDefaultsToProcess) {
    failures.push({ error: "bun_transport_default_not_process" });
  }
  if (!simulationSignals.bunTransportSupportsExplicitSimulation) {
    failures.push({ error: "bun_transport_explicit_simulation_missing" });
  }
  if (!simulationSignals.bunRuntimeUsesRustWorkerTransportDefault) {
    failures.push({ error: "bun_runtime_default_process_transport_missing" });
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
  if (simulationSignals.workerRuntimeSupportModulePresent) {
    failures.push({ error: "worker_runtime_support_module_present" });
  }
  if (simulationSignals.workerCapabilityGuestPlanBindingPresent) {
    failures.push({
      error: "worker_capability_guest_plan_binding_still_present",
    });
  }
  if (!simulationSignals.workerCapabilityNativeAbiDispatchPresent) {
    failures.push({ error: "worker_capability_native_abi_dispatch_missing" });
  }
  if (simulationSignals.workerCapabilityBridgePollingPresent) {
    failures.push({ error: "worker_capability_bridge_polling_still_present" });
  }
  if (simulationSignals.workerCapabilityBridgeDirEnvPresent) {
    failures.push({ error: "worker_capability_bridge_dir_env_still_present" });
  }
  if (!simulationSignals.workerCapabilityBootstrapBindingPresent) {
    failures.push({ error: "worker_capability_bootstrap_binding_missing" });
  }
  if (!simulationSignals.workerCapabilityBootstrapUsesBuiltinImport) {
    failures.push({
      error: "worker_capability_bootstrap_builtin_import_missing",
    });
  }
  if (simulationSignals.workerCapabilitySourceInjectionBridgePresent) {
    failures.push({
      error: "worker_capability_source_injection_bridge_present",
    });
  }
  if (!simulationSignals.workerCapabilityBindingModeEnvPresent) {
    failures.push({ error: "worker_capability_binding_mode_env_missing" });
  }
  if (!simulationSignals.workerCapabilityBindingModeDefaultGuestRuntimeAbi) {
    failures.push({
      error: "worker_capability_binding_mode_default_not_guest_runtime_abi",
    });
  }
  if (!simulationSignals.workerCapabilityBindingModeSupportsGuestRuntimeAbi) {
    failures.push({
      error: "worker_capability_binding_mode_guest_runtime_abi_missing",
    });
  }
  if (simulationSignals.workerCapabilityBindingModeSupportsRewriteDispatch) {
    failures.push({
      error: "worker_capability_binding_mode_rewrite_dispatch_still_present",
    });
  }
  if (simulationSignals.workerCapabilityRewriteBindingPresent) {
    failures.push({ error: "worker_capability_rewrite_binding_still_present" });
  }
  if (simulationSignals.workerRuntimeUsesRewriteAsOnlyPath) {
    failures.push({
      error: "worker_runtime_default_rewrite_dispatch_detected",
    });
  }
  if (simulationSignals.workerCapabilityStreamBridgePresent) {
    failures.push({ error: "worker_capability_stream_bridge_present" });
  }
  if (!simulationSignals.workerNativeHostImportBindingPresent) {
    failures.push({ error: "worker_native_host_import_binding_missing" });
  }
  if (simulationSignals.workerSitecustomizeBindingPresent) {
    failures.push({ error: "worker_sitecustomize_binding_present" });
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
