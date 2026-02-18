import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

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
  const res = spawnSync("bash", ["-lc", command], { stdio: "inherit" });
  return (res.status ?? 1) === 0;
}

function ensureDir(p) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
}

function readGate(relPath) {
  const full = path.join(repoRoot, relPath);
  if (!fs.existsSync(full)) return { ok: false, missing: true };
  const doc = JSON.parse(fs.readFileSync(full, "utf8"));
  return { ok: doc.ok === true, missing: false };
}

function readNativeAbiGap(relPath) {
  const full = path.join(repoRoot, relPath);
  if (!fs.existsSync(full)) return { ok: false, missing: true };
  const doc = JSON.parse(fs.readFileSync(full, "utf8"));
  return {
    ok:
      doc.ok === true &&
      doc.runtimeNativeAbiAvailable === true &&
      doc.dlopenDependencyRequired === false,
    missing: false,
  };
}

function main() {
  const checks = [
    "node scripts/release_evidence.mjs",
    "pnpm component:build",
    "bash scripts/component_artifact_check",
    "AEGISPY_NATIVE_HOST_IMPORT_GATE_MODE=strict bash scripts/native_host_import_check",
    "bash scripts/claim_alignment_check",
    "bash scripts/benchmarks_check",
    "bash scripts/security_claims_check",
    "node scripts/runtime_guest_abi_probe.mjs",
    "node scripts/runtime_native_abi_gap_probe.mjs",
    "bash scripts/real_execution_check",
    "bash scripts/profile_conformance_check",
    "bash scripts/compat_check",
    "bash scripts/native_abi_adversarial_check",
    "bash scripts/native_abi_fuzz_check",
  ];
  const gateFiles = {
    claims: "artifacts/gates/claim-alignment-check.json",
    benchmarks: "artifacts/gates/benchmarks-check.json",
    security: "artifacts/gates/security-claims-check.json",
    realExecution: "artifacts/gates/real-execution-check.json",
    compatibility: "artifacts/gates/compat-check.json",
    component: "artifacts/gates/component-artifact-check.json",
    nativeHostImport: "artifacts/gates/native-host-import-check.json",
    nativeAbiGap: "artifacts/research/runtime-native-abi-gap.json",
    profileConformance: "artifacts/gates/profile-conformance-check.json",
    agentWorkloadCorpus: "artifacts/compat/agent-workload-corpus.json",
    nativeAbiAdversarial: "artifacts/gates/native-abi-adversarial-check.json",
    nativeAbiFuzz: "artifacts/gates/native-abi-fuzz-check.json",
  };

  let ok = true;
  for (const check of checks) {
    if (!run(check)) ok = false;
  }

  const gateStatus = {
    claims: readGate(gateFiles.claims),
    benchmarks: readGate(gateFiles.benchmarks),
    security: readGate(gateFiles.security),
    realExecution: readGate(gateFiles.realExecution),
    compatibility: readGate(gateFiles.compatibility),
    component: readGate(gateFiles.component),
    nativeHostImport: readGate(gateFiles.nativeHostImport),
    nativeAbiGap: readNativeAbiGap(gateFiles.nativeAbiGap),
    profileConformance: readGate(gateFiles.profileConformance),
    nativeAbiAdversarial: readGate(gateFiles.nativeAbiAdversarial),
    nativeAbiFuzz: readGate(gateFiles.nativeAbiFuzz),
  };
  if (
    !gateStatus.claims.ok ||
    !gateStatus.benchmarks.ok ||
    !gateStatus.security.ok ||
    !gateStatus.realExecution.ok ||
    !gateStatus.compatibility.ok ||
    !gateStatus.component.ok ||
    !gateStatus.nativeHostImport.ok ||
    !gateStatus.nativeAbiGap.ok ||
    !gateStatus.profileConformance.ok ||
    !gateStatus.nativeAbiAdversarial.ok ||
    !gateStatus.nativeAbiFuzz.ok
  )
    ok = false;

  const payload = {
    ok,
    gates: gateStatus,
    artifacts: gateFiles,
  };
  ensureDir(outPath);
  fs.writeFileSync(outPath, JSON.stringify(payload, null, 2) + "\n", "utf8");

  if (!ok) process.exitCode = 1;
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
