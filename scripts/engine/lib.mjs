import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
export const repoRoot = path.resolve(__dirname, "../..");

function ensureDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function sha256(data) {
  return createHash("sha256").update(data).digest("hex");
}

function loadJson(filePath) {
  if (!fs.existsSync(filePath)) return {};
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

export function writeEngineArtifact(name, payload, sourceTag) {
  const engineDir = path.join(repoRoot, "artifacts", "engine");
  const artifactPath = path.join(engineDir, name);
  const manifestPath = path.join(engineDir, "manifest.json");
  const provenancePath = path.join(engineDir, "provenance.json");

  ensureDir(artifactPath);
  fs.writeFileSync(artifactPath, payload);

  const manifest = loadJson(manifestPath);
  const hash = sha256(payload);
  manifest[name] = {
    sha256: hash,
    bytes: payload.byteLength,
  };
  ensureDir(manifestPath);
  fs.writeFileSync(
    manifestPath,
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );

  const provenance = loadJson(provenancePath);
  provenance[name] = {
    source: sourceTag,
    sha256: hash,
    generatedAt: new Date().toISOString(),
  };
  ensureDir(provenancePath);
  fs.writeFileSync(
    provenancePath,
    `${JSON.stringify(provenance, null, 2)}\n`,
    "utf8",
  );

  return {
    artifactPath,
    hash,
  };
}

export function verifyEngineArtifacts() {
  const engineDir = path.join(repoRoot, "artifacts", "engine");
  const manifestPath = path.join(engineDir, "manifest.json");
  const manifest = loadJson(manifestPath);
  const failures = [];

  for (const [name, entry] of Object.entries(manifest)) {
    const artifactPath = path.join(engineDir, name);
    if (!fs.existsSync(artifactPath)) {
      failures.push({ error: "missing_artifact", name });
      continue;
    }

    const buf = fs.readFileSync(artifactPath);
    const hash = sha256(buf);
    if (hash !== entry.sha256) {
      failures.push({ error: "hash_mismatch", name });
    }
  }

  return {
    ok: failures.length === 0,
    failures,
  };
}
