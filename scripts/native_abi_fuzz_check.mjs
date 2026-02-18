import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");
const artifactPath = path.join(
  repoRoot,
  "artifacts",
  "security",
  "native-abi-fuzz.json",
);
const outPath = path.join(
  repoRoot,
  "artifacts",
  "gates",
  "native-abi-fuzz-check.json",
);

function ensureDir(p) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
}

function runFuzzTest() {
  const command = [
    "if ! command -v cc >/dev/null 2>&1; then",
    '  cc_wrapper="$(bash scripts/setup_zig_cc)"',
    '  export CC="$cc_wrapper"',
    '  export CXX="$(dirname "$cc_wrapper")/cxx"',
    '  export CARGO_TARGET_X86_64_UNKNOWN_LINUX_GNU_LINKER="$cc_wrapper"',
    "fi",
    "cargo test -q -p aegispy_worker tests::native_abi_mutation_fuzz_gate -- --exact",
  ].join("\n");
  const result = spawnSync("bash", ["-lc", command], {
    cwd: repoRoot,
    stdio: "inherit",
  });
  return (result.status ?? 1) === 0;
}

function main() {
  const failures = [];

  const runOk = runFuzzTest();
  if (!runOk) failures.push({ error: "native_abi_fuzz_test_failed" });

  if (!fs.existsSync(artifactPath)) {
    failures.push({
      error: "missing_native_abi_fuzz_artifact",
      path: "artifacts/security/native-abi-fuzz.json",
    });
  } else {
    const doc = JSON.parse(fs.readFileSync(artifactPath, "utf8"));
    if (doc.ok !== true) failures.push({ error: "native_abi_fuzz_not_ok" });
    if (doc.transport !== "process")
      failures.push({ error: "native_abi_fuzz_transport_not_process" });
    if (doc.capabilityChannel !== "component-wit")
      failures.push({ error: "native_abi_fuzz_not_component_wit" });
    if (doc.dispatchMode !== "host-native-abi-direct-dispatch")
      failures.push({ error: "native_abi_fuzz_dispatch_mode_invalid" });
    if (typeof doc.iterations !== "number" || doc.iterations < 600)
      failures.push({ error: "native_abi_fuzz_iterations_too_low" });
    if (
      typeof doc?.cases?.validRequestFrames !== "number" ||
      doc.cases.validRequestFrames < 300
    ) {
      failures.push({ error: "native_abi_fuzz_valid_frames_too_low" });
    }
    if (
      typeof doc?.cases?.malformedFrames !== "number" ||
      doc.cases.malformedFrames < 100
    ) {
      failures.push({ error: "native_abi_fuzz_malformed_frames_too_low" });
    }
    if (typeof doc?.responses?.ok !== "number" || doc.responses.ok <= 0)
      failures.push({ error: "native_abi_fuzz_missing_ok_responses" });
    if (
      typeof doc?.responses?.denied !== "number" ||
      doc.responses.denied <= 0
    ) {
      failures.push({ error: "native_abi_fuzz_missing_denied_responses" });
    }
    if (
      typeof doc?.audit?.parseFailures !== "number" ||
      doc.audit.parseFailures <= 0
    ) {
      failures.push({ error: "native_abi_fuzz_missing_parse_failures" });
    }
    if (
      typeof doc?.audit?.policyDenials !== "number" ||
      doc.audit.policyDenials <= 0
    ) {
      failures.push({ error: "native_abi_fuzz_missing_policy_denials" });
    }
  }

  const payload =
    failures.length === 0
      ? { ok: true }
      : {
          ok: false,
          checked: ["artifacts/security/native-abi-fuzz.json"],
          failures,
        };
  ensureDir(outPath);
  fs.writeFileSync(outPath, JSON.stringify(payload, null, 2) + "\n", "utf8");
  if (failures.length > 0) process.exitCode = 1;
}

Promise.resolve()
  .then(() => main())
  .catch((error) => {
    ensureDir(outPath);
    fs.writeFileSync(
      outPath,
      JSON.stringify({ ok: false, error: String(error) }, null, 2) + "\n",
      "utf8",
    );
    process.exitCode = 1;
  });
