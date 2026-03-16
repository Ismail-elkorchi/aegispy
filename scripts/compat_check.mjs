import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");
const stdlibPath = path.join(
  repoRoot,
  "artifacts",
  "compat",
  "stdlib-smoke.json",
);
const profilePath = path.join(
  repoRoot,
  "artifacts",
  "compat",
  "profile-conformance.json",
);
const agentCorpusPath = path.join(
  repoRoot,
  "artifacts",
  "compat",
  "agent-workload-corpus.json",
);
const workloadMatrixPath = path.join(
  repoRoot,
  "artifacts",
  "compat",
  "workload-compatibility-matrix.json",
);
const packageFixturesPath = path.join(
  repoRoot,
  "artifacts",
  "compat",
  "package-fixture-lockfiles.json",
);
const outPath = path.join(repoRoot, "artifacts", "gates", "compat-check.json");

function ensureDir(p) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
}

function pushFailureEntries(failures, doc, key, error) {
  const entries = doc?.[key];
  if (!Array.isArray(entries)) {
    failures.push({ error: `${error}_missing` });
    return;
  }
  for (const entry of entries) {
    failures.push({
      error,
      caseId: entry?.caseId ?? null,
      host: entry?.host ?? null,
      reasonCode: entry?.reasonCode ?? null,
    });
  }
}

function main() {
  const failures = [];
  if (!fs.existsSync(stdlibPath)) {
    failures.push({
      error: "missing_compat_artifact",
      path: "artifacts/compat/stdlib-smoke.json",
    });
  } else {
    const doc = JSON.parse(fs.readFileSync(stdlibPath, "utf8"));
    if (doc.passed !== true) failures.push({ error: "compat_smoke_failed" });
    if (!Array.isArray(doc.executed) || doc.executed.length === 0)
      failures.push({ error: "compat_executed_list_missing" });
  }

  if (!fs.existsSync(profilePath)) {
    failures.push({
      error: "missing_profile_conformance_artifact",
      path: "artifacts/compat/profile-conformance.json",
    });
  } else {
    const doc = JSON.parse(fs.readFileSync(profilePath, "utf8"));
    if (doc.ok !== true) failures.push({ error: "profile_conformance_not_ok" });
  }

  if (!fs.existsSync(agentCorpusPath)) {
    failures.push({
      error: "missing_agent_workload_corpus_artifact",
      path: "artifacts/compat/agent-workload-corpus.json",
    });
  } else {
    const doc = JSON.parse(fs.readFileSync(agentCorpusPath, "utf8"));
    if (doc.ok !== true)
      failures.push({ error: "agent_workload_corpus_not_ok" });
    const hosts = doc?.hosts ?? {};
    for (const host of ["node", "deno", "bun", "browser"]) {
      const passRate = hosts?.[host]?.passRate;
      if (typeof passRate !== "number" || !Number.isFinite(passRate)) {
        failures.push({
          error: "agent_workload_corpus_pass_rate_missing",
          host,
        });
      }
    }
    if (hosts?.browser?.profile !== "browser-real-engine") {
      failures.push({
        error: "agent_workload_corpus_browser_profile_invalid",
      });
    }
    if (!Array.isArray(doc?.families) || doc.families.length === 0) {
      failures.push({ error: "agent_workload_corpus_families_missing" });
    }
    if (!Array.isArray(doc?.reasonCodes) || doc.reasonCodes.length === 0) {
      failures.push({ error: "agent_workload_corpus_reason_codes_missing" });
    }
    pushFailureEntries(
      failures,
      doc,
      "supportedFailures",
      "agent_workload_corpus_supported_failure",
    );
    pushFailureEntries(
      failures,
      doc,
      "unsupportedByProfileFailures",
      "agent_workload_corpus_unsupported_by_profile_failure",
    );
  }

  if (!fs.existsSync(workloadMatrixPath)) {
    failures.push({
      error: "missing_workload_compatibility_matrix_artifact",
      path: "artifacts/compat/workload-compatibility-matrix.json",
    });
  } else {
    const doc = JSON.parse(fs.readFileSync(workloadMatrixPath, "utf8"));
    if (doc.ok !== true)
      failures.push({ error: "workload_compatibility_matrix_not_ok" });
    if (
      typeof doc.reasonCodes !== "object" ||
      doc.reasonCodes === null ||
      Object.keys(doc.reasonCodes).length === 0
    ) {
      failures.push({ error: "workload_compatibility_reason_codes_missing" });
    }
    if (
      typeof doc.families !== "object" ||
      doc.families === null ||
      Object.keys(doc.families).length === 0
    ) {
      failures.push({ error: "workload_compatibility_families_missing" });
    }
    if (!Array.isArray(doc.workloads) || doc.workloads.length === 0) {
      failures.push({ error: "workload_compatibility_workloads_missing" });
    } else {
      for (const workload of doc.workloads) {
        if (
          typeof workload?.workloadId !== "string" ||
          workload.workloadId.length === 0
        ) {
          failures.push({
            error: "workload_compatibility_workload_id_missing",
          });
          continue;
        }
        const hosts = workload?.hosts ?? {};
        for (const host of ["node", "deno", "bun", "browser"]) {
          const hostResult = hosts?.[host];
          if (!hostResult) {
            failures.push({
              error: "workload_compatibility_host_result_missing",
              workloadId: workload.workloadId,
              host,
            });
            continue;
          }
          if (
            typeof hostResult.reasonCode !== "string" ||
            hostResult.reasonCode.length === 0
          ) {
            failures.push({
              error: "workload_compatibility_reason_code_missing",
              workloadId: workload.workloadId,
              host,
            });
          }
          if (
            hostResult.expectation !== "supported" &&
            hostResult.expectation !== "unsupported-by-profile"
          ) {
            failures.push({
              error: "workload_compatibility_expectation_invalid",
              workloadId: workload.workloadId,
              host,
            });
          }
        }
      }
    }
    if (doc?.hosts?.browser?.profile !== "browser-real-engine") {
      failures.push({
        error: "workload_compatibility_browser_profile_invalid",
      });
    }
    pushFailureEntries(
      failures,
      doc,
      "supportedFailures",
      "workload_compatibility_supported_failure",
    );
    pushFailureEntries(
      failures,
      doc,
      "unsupportedByProfileFailures",
      "workload_compatibility_unsupported_by_profile_failure",
    );
  }

  if (!fs.existsSync(packageFixturesPath)) {
    failures.push({
      error: "missing_package_fixture_lockfiles_artifact",
      path: "artifacts/compat/package-fixture-lockfiles.json",
    });
  } else {
    const doc = JSON.parse(fs.readFileSync(packageFixturesPath, "utf8"));
    if (doc.ok !== true)
      failures.push({ error: "package_fixture_lockfiles_not_ok" });
    if (!Array.isArray(doc.fixtures) || doc.fixtures.length === 0) {
      failures.push({ error: "package_fixture_lockfiles_missing_entries" });
    } else {
      for (const fixture of doc.fixtures) {
        if (fixture?.coverageBasis !== "metadata-only") {
          failures.push({
            error: "package_fixture_coverage_basis_invalid",
            fixtureId: fixture?.fixtureId ?? null,
          });
        }
        if (fixture?.verification?.ok !== true) {
          failures.push({
            error: "package_fixture_verification_failed",
            fixtureId: fixture?.fixtureId ?? null,
          });
        }
      }
    }
  }

  const payload =
    failures.length === 0 ? { ok: true } : { ok: false, failures };
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
