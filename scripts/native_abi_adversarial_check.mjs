import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");
const inPath = path.join(
  repoRoot,
  "artifacts",
  "security",
  "native-abi-adversarial.json",
);
const outPath = path.join(
  repoRoot,
  "artifacts",
  "gates",
  "native-abi-adversarial-check.json",
);

const requiredServerCases = {
  "http-policy-deny": { status: "error", termination: "policy_denied" },
  "fs-default-deny": { status: "error", termination: "policy_denied" },
  "fs-traversal-deny": { status: "error", termination: "policy_denied" },
  "env-default-deny": { status: "error", termination: "policy_denied" },
  "output-abuse": { status: "error", termination: "output_limit" },
};

function ensureDir(p) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
}

function isFiniteRate(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function main() {
  const failures = [];
  if (!fs.existsSync(inPath)) {
    failures.push({
      error: "missing_native_abi_adversarial_artifact",
      path: "artifacts/security/native-abi-adversarial.json",
    });
  } else {
    const doc = JSON.parse(fs.readFileSync(inPath, "utf8"));
    if (doc.ok !== true)
      failures.push({ error: "native_abi_adversarial_not_ok" });

    const caseIds = Array.isArray(doc.caseIds) ? doc.caseIds : [];
    const caseCountFloor = doc?.thresholds?.adversarialCaseCountFloor;
    const serverPassRateFloor = doc?.thresholds?.serverPassRateFloor;
    if (!isFiniteRate(caseCountFloor) || caseCountFloor <= 0) {
      failures.push({ error: "adversarial_case_count_floor_invalid" });
    } else if (caseIds.length < caseCountFloor) {
      failures.push({
        error: "adversarial_case_count_below_floor",
        found: caseIds.length,
        floor: caseCountFloor,
      });
    }
    if (
      !isFiniteRate(serverPassRateFloor) ||
      serverPassRateFloor <= 0 ||
      serverPassRateFloor > 1
    ) {
      failures.push({ error: "server_pass_rate_floor_invalid" });
    }

    for (const caseId of Object.keys(requiredServerCases)) {
      if (!caseIds.includes(caseId)) {
        failures.push({
          error: "required_adversarial_case_missing",
          caseId,
        });
      }
    }

    const hosts = doc?.hosts ?? {};
    for (const host of ["node", "deno", "bun"]) {
      const hostDoc = hosts?.[host];
      if (hostDoc?.profile !== "server-hardened") {
        failures.push({
          error: "adversarial_host_profile_invalid",
          host,
          profile: hostDoc?.profile ?? null,
        });
      }
      if (hostDoc?.hardened !== true) {
        failures.push({
          error: "adversarial_host_hardened_flag_invalid",
          host,
        });
      }
      if (hostDoc?.componentWitOnly !== true) {
        failures.push({
          error: "adversarial_host_channel_not_component_wit",
          host,
        });
      }
      if (!isFiniteRate(hostDoc?.passRate)) {
        failures.push({
          error: "adversarial_host_pass_rate_missing",
          host,
        });
      } else if (
        isFiniteRate(serverPassRateFloor) &&
        hostDoc.passRate < serverPassRateFloor
      ) {
        failures.push({
          error: "adversarial_host_pass_rate_below_floor",
          host,
          passRate: hostDoc.passRate,
          floor: serverPassRateFloor,
        });
      }
    }

    if (hosts?.browser?.profile !== "browser-real-engine") {
      failures.push({
        error: "adversarial_browser_profile_invalid",
      });
    }

    const cases = Array.isArray(doc.cases) ? doc.cases : [];
    const caseById = new Map(cases.map((entry) => [entry.caseId, entry]));
    for (const [caseId, expected] of Object.entries(requiredServerCases)) {
      const caseDoc = caseById.get(caseId);
      if (!caseDoc) continue;
      for (const host of ["node", "deno", "bun"]) {
        const hostResult = caseDoc?.results?.[host];
        if (hostResult?.status !== expected.status) {
          failures.push({
            error: "adversarial_case_status_invalid",
            caseId,
            host,
            status: hostResult?.status ?? null,
            expected: expected.status,
          });
        }
        if (hostResult?.termination !== expected.termination) {
          failures.push({
            error: "adversarial_case_termination_invalid",
            caseId,
            host,
            termination: hostResult?.termination ?? null,
            expected: expected.termination,
          });
        }
        if (hostResult?.pass !== true) {
          failures.push({
            error: "adversarial_case_not_passed",
            caseId,
            host,
          });
        }
        if (hostResult?.capabilityChannel !== "component-wit") {
          failures.push({
            error: "adversarial_case_channel_invalid",
            caseId,
            host,
            capabilityChannel: hostResult?.capabilityChannel ?? null,
          });
        }
      }
    }
  }

  const payload =
    failures.length === 0
      ? { ok: true }
      : {
          ok: false,
          checked: ["artifacts/security/native-abi-adversarial.json"],
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
