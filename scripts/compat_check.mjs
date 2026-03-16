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
const outPath = path.join(repoRoot, "artifacts", "gates", "compat-check.json");

function ensureDir(p) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
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

    const threshold = doc?.thresholds?.serverPassRateMin;
    if (
      typeof threshold !== "number" ||
      !Number.isFinite(threshold) ||
      threshold <= 0 ||
      threshold > 1
    ) {
      failures.push({ error: "agent_workload_corpus_threshold_invalid" });
    } else {
      const hosts = doc?.hosts ?? {};
      for (const host of ["node", "deno", "bun"]) {
        const passRate = hosts?.[host]?.passRate;
        if (typeof passRate !== "number" || !Number.isFinite(passRate)) {
          failures.push({
            error: "agent_workload_corpus_pass_rate_missing",
            host,
          });
          continue;
        }
        if (passRate < threshold) {
          failures.push({
            error: "agent_workload_corpus_pass_rate_below_threshold",
            host,
            passRate,
            threshold,
          });
        }
      }
      if (hosts?.browser?.profile !== "browser-real-engine") {
        failures.push({
          error: "agent_workload_corpus_browser_profile_invalid",
        });
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
