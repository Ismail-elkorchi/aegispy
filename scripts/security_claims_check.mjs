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
const nativeAbiAdversarialPath = path.join(
  repoRoot,
  "artifacts",
  "security",
  "native-abi-adversarial.json",
);
const isolationLimitDenialsPath = path.join(
  repoRoot,
  "artifacts",
  "security",
  "isolation-limit-denials.json",
);
const nativeAbiFuzzPath = path.join(
  repoRoot,
  "artifacts",
  "security",
  "native-abi-fuzz.json",
);
const replayAttestationPath = path.join(
  repoRoot,
  "artifacts",
  "security",
  "replay-attestation.json",
);
const browserInputFuzzPath = path.join(
  repoRoot,
  "artifacts",
  "security",
  "browser-input-fuzz.json",
);
const browserIntegrityFuzzPath = path.join(
  repoRoot,
  "artifacts",
  "security",
  "browser-integrity-fuzz.json",
);
const runtimeEnvelopeFuzzPath = path.join(
  repoRoot,
  "artifacts",
  "security",
  "runtime-envelope-fuzz.json",
);
const protocolFramingFuzzPath = path.join(
  repoRoot,
  "artifacts",
  "security",
  "protocol-framing-fuzz.json",
);
const kernelIsolationRuntimePath = path.join(
  repoRoot,
  "artifacts",
  "security",
  "kernel-isolation-runtime.json",
);
const kernelIsolationGatePath = path.join(
  repoRoot,
  "artifacts",
  "gates",
  "kernel-isolation-check.json",
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

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function isPositiveNumber(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
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
    if (doc.envDenied !== true)
      failures.push({ error: "missing_env_denial_proof_runtime" });
    if (doc.isolationDenied !== true)
      failures.push({ error: "missing_isolation_denial_proof_runtime" });
    if (doc?.limitReasons?.wall !== "isolation_wall_limit_exceeded") {
      failures.push({ error: "missing_wall_limit_reason_runtime" });
    }
    if (doc.transport !== "process")
      failures.push({ error: "runtime_denials_not_process_transport" });
    if (doc.capabilityChannel !== "component-wit")
      failures.push({ error: "runtime_denials_not_component_wit_channel" });
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
    if (doc.capabilityChannel !== "component-wit")
      failures.push({ error: "isolation_profile_not_component_wit_channel" });
    if (profileName !== "strict")
      failures.push({ error: "isolation_profile_not_strict" });
    if (doc?.limitEnvelope?.denyEnvCapability !== true) {
      failures.push({ error: "isolation_profile_env_guard_missing" });
    }
    for (const field of [
      "wallMs",
      "cpuMs",
      "memoryBytes",
      "stdoutBytes",
      "stderrBytes",
    ]) {
      if (!isPositiveNumber(doc?.limitEnvelope?.[field])) {
        failures.push({
          error: "isolation_profile_limit_invalid",
          field,
        });
      }
    }
    const controlStatus = doc?.controlStatus ?? {};
    if (controlStatus.noNewPrivs !== true) {
      failures.push({ error: "isolation_profile_no_new_privs_missing" });
    }
    if (controlStatus.cgroup !== true) {
      failures.push({ error: "isolation_profile_cgroup_missing" });
    }
    for (const field of ["pid", "mnt", "net", "uts", "ipc", "cgroup"]) {
      if (controlStatus?.namespaces?.[field] !== true) {
        failures.push({
          error: "isolation_profile_namespace_missing",
          field,
        });
      }
    }
    if (typeof controlStatus?.seccomp?.mode !== "string") {
      failures.push({ error: "isolation_profile_seccomp_mode_missing" });
    }
    if (typeof controlStatus?.seccomp?.filters !== "string") {
      failures.push({ error: "isolation_profile_seccomp_filters_missing" });
    }
    if (typeof controlStatus?.seccomp?.active !== "boolean") {
      failures.push({ error: "isolation_profile_seccomp_state_missing" });
    }
  }

  if (!fs.existsSync(isolationLimitDenialsPath)) {
    failures.push({
      error: "missing_isolation_limit_denials_artifact",
      path: "artifacts/security/isolation-limit-denials.json",
    });
  } else {
    const doc = readJson(isolationLimitDenialsPath);
    if (doc.ok !== true) {
      failures.push({ error: "isolation_limit_denials_not_ok" });
    }
    if (doc.transport !== "process") {
      failures.push({ error: "isolation_limit_denials_not_process_transport" });
    }
    if (doc.executionMode !== "process") {
      failures.push({ error: "isolation_limit_denials_not_process_mode" });
    }
    if (doc?.executionBackend?.available !== true) {
      failures.push({ error: "isolation_limit_denials_backend_unavailable" });
    }
    if (doc.conformanceProfile !== "server-hardened") {
      failures.push({
        error: "isolation_limit_denials_not_server_hardened",
      });
    }
    for (const [field, reason] of [
      ["cpu", "isolation_cpu_limit_exceeded"],
      ["memory", "isolation_memory_limit_exceeded"],
      ["stdout", "isolation_stdout_limit_exceeded"],
      ["stderr", "isolation_stderr_limit_exceeded"],
    ]) {
      if (doc?.cases?.[field]?.denied !== true) {
        failures.push({
          error: "isolation_limit_denial_missing",
          field,
        });
      }
      if (doc?.cases?.[field]?.reason !== reason) {
        failures.push({
          error: "isolation_limit_reason_invalid",
          field,
          reason: doc?.cases?.[field]?.reason ?? null,
        });
      }
    }
  }

  if (!fs.existsSync(nativeAbiAdversarialPath)) {
    failures.push({
      error: "missing_native_abi_adversarial_artifact",
      path: "artifacts/security/native-abi-adversarial.json",
    });
  } else {
    const doc = JSON.parse(fs.readFileSync(nativeAbiAdversarialPath, "utf8"));
    if (doc.ok !== true)
      failures.push({ error: "native_abi_adversarial_not_ok" });
    if (doc?.hosts?.node?.componentWitOnly !== true)
      failures.push({ error: "native_abi_adversarial_node_not_component_wit" });
    if (doc?.hosts?.deno?.componentWitOnly !== true)
      failures.push({ error: "native_abi_adversarial_deno_not_component_wit" });
    if (doc?.hosts?.bun?.componentWitOnly !== true)
      failures.push({ error: "native_abi_adversarial_bun_not_component_wit" });
  }

  if (!fs.existsSync(nativeAbiFuzzPath)) {
    failures.push({
      error: "missing_native_abi_fuzz_artifact",
      path: "artifacts/security/native-abi-fuzz.json",
    });
  } else {
    const doc = JSON.parse(fs.readFileSync(nativeAbiFuzzPath, "utf8"));
    if (doc.ok !== true) failures.push({ error: "native_abi_fuzz_not_ok" });
    if (doc.transport !== "process")
      failures.push({ error: "native_abi_fuzz_transport_not_process" });
    if (doc.capabilityChannel !== "component-wit")
      failures.push({ error: "native_abi_fuzz_not_component_wit_channel" });
    if (doc.dispatchMode !== "host-native-abi-direct-dispatch")
      failures.push({ error: "native_abi_fuzz_dispatch_mode_invalid" });
    if (
      typeof doc?.audit?.parseFailures !== "number" ||
      doc.audit.parseFailures <= 0
    )
      failures.push({ error: "native_abi_fuzz_parse_failures_missing" });
    if (
      typeof doc?.audit?.policyDenials !== "number" ||
      doc.audit.policyDenials <= 0
    )
      failures.push({ error: "native_abi_fuzz_policy_denials_missing" });
  }

  if (!fs.existsSync(replayAttestationPath)) {
    failures.push({
      error: "missing_replay_attestation_artifact",
      path: "artifacts/security/replay-attestation.json",
    });
  } else {
    const doc = readJson(replayAttestationPath);
    if (doc.ok !== true) failures.push({ error: "replay_attestation_not_ok" });
    if (!Array.isArray(doc.hosts) || doc.hosts.length !== 4) {
      failures.push({ error: "replay_attestation_host_coverage_invalid" });
    } else {
      for (const hostDoc of doc.hosts) {
        if (!Array.isArray(hostDoc.cases)) {
          failures.push({ error: "replay_attestation_cases_invalid" });
          continue;
        }
        const sameSeed = hostDoc.cases.find(
          (entry) => entry.caseId === "same-seed",
        );
        const differentSeed = hostDoc.cases.find(
          (entry) => entry.caseId === "different-seed",
        );
        if (sameSeed?.match !== true) {
          failures.push({
            error: "replay_attestation_same_seed_mismatch",
            host: hostDoc.host,
          });
        }
        if (differentSeed?.match !== false) {
          failures.push({
            error: "replay_attestation_different_seed_mismatch",
            host: hostDoc.host,
          });
        }
      }
    }
  }

  if (!fs.existsSync(browserInputFuzzPath)) {
    failures.push({
      error: "missing_browser_input_fuzz_artifact",
      path: "artifacts/security/browser-input-fuzz.json",
    });
  } else {
    const doc = readJson(browserInputFuzzPath);
    if (doc.ok !== true) failures.push({ error: "browser_input_fuzz_not_ok" });
    if (typeof doc.validCases !== "number" || doc.validCases <= 0) {
      failures.push({ error: "browser_input_fuzz_valid_cases_missing" });
    }
    if (typeof doc.invalidCases !== "number" || doc.invalidCases <= 0) {
      failures.push({ error: "browser_input_fuzz_invalid_cases_missing" });
    }
  }

  if (!fs.existsSync(browserIntegrityFuzzPath)) {
    failures.push({
      error: "missing_browser_integrity_fuzz_artifact",
      path: "artifacts/security/browser-integrity-fuzz.json",
    });
  } else {
    const doc = readJson(browserIntegrityFuzzPath);
    if (doc.ok !== true)
      failures.push({ error: "browser_integrity_fuzz_not_ok" });
    if (typeof doc.packageRuns !== "number" || doc.packageRuns <= 0) {
      failures.push({ error: "browser_integrity_fuzz_package_runs_missing" });
    }
    if (typeof doc.assetRuns !== "number" || doc.assetRuns <= 0) {
      failures.push({ error: "browser_integrity_fuzz_asset_runs_missing" });
    }
  }

  if (!fs.existsSync(runtimeEnvelopeFuzzPath)) {
    failures.push({
      error: "missing_runtime_envelope_fuzz_artifact",
      path: "artifacts/security/runtime-envelope-fuzz.json",
    });
  } else {
    const doc = readJson(runtimeEnvelopeFuzzPath);
    if (doc.ok !== true)
      failures.push({ error: "runtime_envelope_fuzz_not_ok" });
    if (typeof doc.validCases !== "number" || doc.validCases <= 0) {
      failures.push({ error: "runtime_envelope_fuzz_valid_cases_missing" });
    }
    if (typeof doc.invalidCases !== "number" || doc.invalidCases <= 0) {
      failures.push({ error: "runtime_envelope_fuzz_invalid_cases_missing" });
    }
  }

  if (!fs.existsSync(protocolFramingFuzzPath)) {
    failures.push({
      error: "missing_protocol_framing_fuzz_artifact",
      path: "artifacts/security/protocol-framing-fuzz.json",
    });
  } else {
    const doc = readJson(protocolFramingFuzzPath);
    if (doc.ok !== true)
      failures.push({ error: "protocol_framing_fuzz_not_ok" });
    if (typeof doc.runs !== "number" || doc.runs <= 0) {
      failures.push({ error: "protocol_framing_fuzz_runs_missing" });
    }
  }

  if (!fs.existsSync(kernelIsolationRuntimePath)) {
    failures.push({
      error: "missing_kernel_isolation_runtime_artifact",
      path: "artifacts/security/kernel-isolation-runtime.json",
    });
  } else {
    const doc = JSON.parse(fs.readFileSync(kernelIsolationRuntimePath, "utf8"));
    if (doc.ok !== true)
      failures.push({ error: "kernel_isolation_runtime_not_ok" });
    if (doc.supported !== true)
      failures.push({ error: "kernel_isolation_runtime_not_supported" });
    if (doc.transport !== "process")
      failures.push({
        error: "kernel_isolation_runtime_not_process_transport",
      });
    if (doc.executionMode !== "process")
      failures.push({ error: "kernel_isolation_runtime_not_process_mode" });
    if (doc?.executionBackend?.available !== true)
      failures.push({ error: "kernel_isolation_runtime_backend_unavailable" });
    if (doc.noNewPrivs !== true)
      failures.push({ error: "kernel_isolation_runtime_no_new_privs_missing" });
    if (doc?.limitEnvelope?.denyEnvCapability !== true)
      failures.push({ error: "kernel_isolation_runtime_env_guard_missing" });
    for (const field of [
      "wallMs",
      "cpuMs",
      "memoryBytes",
      "stdoutBytes",
      "stderrBytes",
    ]) {
      if (!isPositiveNumber(doc?.limitEnvelope?.[field])) {
        failures.push({
          error: "kernel_isolation_runtime_limit_invalid",
          field,
        });
      }
    }
    const controlStatus = doc?.controlStatus ?? {};
    if (controlStatus.noNewPrivs !== true) {
      failures.push({
        error: "kernel_isolation_runtime_control_no_new_privs_missing",
      });
    }
    if (controlStatus.cgroup !== true) {
      failures.push({
        error: "kernel_isolation_runtime_control_cgroup_missing",
      });
    }
  }

  if (!fs.existsSync(kernelIsolationGatePath)) {
    failures.push({
      error: "missing_kernel_isolation_gate_artifact",
      path: "artifacts/gates/kernel-isolation-check.json",
    });
  } else {
    const doc = JSON.parse(fs.readFileSync(kernelIsolationGatePath, "utf8"));
    if (doc.ok !== true)
      failures.push({ error: "kernel_isolation_gate_not_ok" });
  }

  const payload = {
    ok: failures.length === 0,
    checked: [
      "artifacts/security/runtime-policy-denials.json",
      "artifacts/security/isolation-profile.json",
      "artifacts/security/isolation-limit-denials.json",
      "artifacts/security/native-abi-adversarial.json",
      "artifacts/security/native-abi-fuzz.json",
      "artifacts/security/replay-attestation.json",
      "artifacts/security/browser-input-fuzz.json",
      "artifacts/security/browser-integrity-fuzz.json",
      "artifacts/security/runtime-envelope-fuzz.json",
      "artifacts/security/protocol-framing-fuzz.json",
      "artifacts/security/kernel-isolation-runtime.json",
      "artifacts/gates/kernel-isolation-check.json",
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
