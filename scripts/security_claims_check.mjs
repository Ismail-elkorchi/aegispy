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
const nativeAbiFuzzPath = path.join(
  repoRoot,
  "artifacts",
  "security",
  "native-abi-fuzz.json",
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
    if (doc.noNewPrivs !== true)
      failures.push({ error: "kernel_isolation_runtime_no_new_privs_missing" });
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
      "artifacts/security/native-abi-adversarial.json",
      "artifacts/security/native-abi-fuzz.json",
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
