import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");
const architectureModelPath = path.join(
  repoRoot,
  "tools",
  "architecture-model.v1.json",
);

function normalizeOs(platform) {
  if (platform === "darwin") return "macos";
  if (platform === "win32") return "windows";
  return platform;
}

function main() {
  const architecture = JSON.parse(
    fs.readFileSync(architectureModelPath, "utf8"),
  );
  const os = normalizeOs(process.platform);
  const artifactPath = path.join(
    repoRoot,
    "artifacts",
    "security",
    `portable-isolation-floor-${os}.json`,
  );

  const commonFloor = Object.fromEntries(
    architecture.portableCommonIsolationFloor.map((term) => [term, true]),
  );
  const payload = {
    ok: true,
    os,
    arch: process.arch,
    portableIsolationFloorVersion: "portable-floor-draft-v1",
    evidenceStatus: "prototype",
    commonFloor,
    hostStrengthening: [],
    generatedAt: new Date().toISOString(),
  };

  fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
  fs.writeFileSync(
    artifactPath,
    `${JSON.stringify(payload, null, 2)}\n`,
    "utf8",
  );
}

Promise.resolve()
  .then(() => main())
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
