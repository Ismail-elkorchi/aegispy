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
  "claim-alignment-check.json",
);

function read(rel) {
  const full = path.join(repoRoot, rel);
  return fs.existsSync(full) ? fs.readFileSync(full, "utf8") : "";
}

function ensureDir(full) {
  fs.mkdirSync(path.dirname(full), { recursive: true });
}

function main() {
  const docs = {
    readme: read("README.md"),
    security: read("docs/security.md"),
    support: read("docs/support-matrix.md"),
  };

  const runtimeSignals = {
    coreUsesSimulation: read(
      "packages/aegispy-core/src/runtime/factory.ts",
    ).includes("simulateRun"),
    nodeDefaultsToInProcess: read(
      "packages/aegispy-node/src/runtime/node-runtime.ts",
    ).includes("return new InProcessTransport();"),
    wasiArtifactStub: read("scripts/engine/build-wasi.mjs").includes(
      "aegispy-wasi-engine-v1",
    ),
    emscriptenArtifactStub: read(
      "scripts/engine/build-emscripten.mjs",
    ).includes("aegispy-emscripten-engine-v1"),
  };

  const simulationActive = Object.values(runtimeSignals).some(Boolean);

  const overclaimPatterns = [
    /\breal hardened python engine\b/i,
    /\bproduction\s+ready\s+sandbox\b/i,
    /\bfully hardened engine\b/i,
    /\benterprise grade sandbox\b/i,
  ];

  const failures = [];
  if (simulationActive) {
    for (const [name, text] of Object.entries(docs)) {
      for (const pattern of overclaimPatterns) {
        if (pattern.test(text)) {
          failures.push({
            file: name,
            pattern: pattern.source,
            reason: "overclaim_detected_while_simulation_signals_present",
          });
        }
      }
    }
  }

  const payload = {
    ok: failures.length === 0,
    simulation_signals: runtimeSignals,
    simulation_active: simulationActive,
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
