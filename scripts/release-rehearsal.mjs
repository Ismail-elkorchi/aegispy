import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { loadReleaseVersion } from "./release-version.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");

const paths = {
  releaseNotes: path.join(repoRoot, "dist", "release-notes.md"),
  sourceArchive: path.join(repoRoot, "dist", "aegispy-source.tar.gz"),
  sbom: path.join(repoRoot, "artifacts", "security", "supply-chain-sbom.json"),
  supplyChainAttestation: path.join(
    repoRoot,
    "artifacts",
    "security",
    "supply-chain-attestation.json",
  ),
  provenanceVerification: path.join(
    repoRoot,
    "artifacts",
    "security",
    "provenance-verification.json",
  ),
  outPath: path.join(
    repoRoot,
    "artifacts",
    "security",
    "release-rehearsal.json",
  ),
};

export const defaultReleaseRehearsalSubjects = [
  "dist/aegispy-source.tar.gz",
  "artifacts/engine/cpython-wasi.wasm",
  "artifacts/engine/aegispy-capability-bridge.py",
  "artifacts/component/aegispy.component.wasm",
];

function ensureDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function fileRef(filePath) {
  return path.relative(repoRoot, filePath).replaceAll("\\", "/");
}

function sha256File(filePath) {
  return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function run(command, args, env = process.env) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    env,
    encoding: "utf8",
  });
  if ((result.status ?? 1) !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim();
    throw new Error(
      `${command} ${args.join(" ")} failed${detail ? `: ${detail}` : ""}`,
    );
  }
  return result.stdout;
}

function runShell(command, env = process.env) {
  return run("bash", ["-lc", command], env);
}

function parseCli(args) {
  let finalize = false;
  let tagName = null;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--") continue;
    if (arg === "--finalize") {
      finalize = true;
      continue;
    }
    if (arg === "--tag") {
      const value = args[index + 1];
      if (!value) {
        throw new Error("release-rehearsal: --tag expects a value");
      }
      tagName = value;
      index += 1;
      continue;
    }
    throw new Error(`release-rehearsal: unknown argument ${arg}`);
  }

  return { finalize, tagName };
}

function normalizeTag(value) {
  if (!value) return "";
  if (value.startsWith("refs/tags/")) {
    return value.slice("refs/tags/".length);
  }
  return value;
}

function writeJson(filePath, payload) {
  ensureDir(filePath);
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function buildReleaseNotes(tagName) {
  const notes = run("node", ["scripts/changelog-section.mjs", tagName]);
  ensureDir(paths.releaseNotes);
  fs.writeFileSync(paths.releaseNotes, notes.trimEnd() + "\n", "utf8");
}

function buildSourceArchive() {
  ensureDir(paths.sourceArchive);
  run("git", [
    "archive",
    "--format=tar.gz",
    "--output",
    paths.sourceArchive,
    "HEAD",
  ]);
}

function buildDigestRecord(filePath) {
  return {
    path: fileRef(filePath),
    sha256: sha256File(filePath),
  };
}

function buildInitialProvenanceVerification() {
  return {
    ok: null,
    skipped: true,
    bundlePath: null,
    signerWorkflow: null,
    subjects: [...defaultReleaseRehearsalSubjects],
  };
}

export function buildReleaseRehearsalRecord({
  version,
  tagName,
  sourceArchive,
  releaseNotes,
  sbom,
  supplyChainAttestation,
  provenanceVerification,
}) {
  return {
    ok: true,
    generatedAt: new Date().toISOString(),
    version,
    tagName,
    publishSkipped: true,
    sourceArchive,
    releaseNotes,
    sbom,
    supplyChainAttestation,
    provenanceVerification,
  };
}

async function stageReleaseRehearsal(tagName) {
  const release = await loadReleaseVersion();
  const normalizedTag = normalizeTag(tagName || `v${release.version}`);

  run("node", ["scripts/release-gate.mjs", normalizedTag]);
  run("node", ["scripts/release_evidence.mjs"]);
  runShell("pnpm component:build");
  runShell("bash scripts/component_artifact_check");
  runShell(
    "AEGISPY_NATIVE_HOST_IMPORT_GATE_MODE=strict bash scripts/native_host_import_check",
  );
  runShell("bash scripts/supply_chain_check");

  buildReleaseNotes(normalizedTag);
  buildSourceArchive();

  const record = buildReleaseRehearsalRecord({
    version: release.version,
    tagName: normalizedTag,
    sourceArchive: buildDigestRecord(paths.sourceArchive),
    releaseNotes: buildDigestRecord(paths.releaseNotes),
    sbom: buildDigestRecord(paths.sbom),
    supplyChainAttestation: buildDigestRecord(paths.supplyChainAttestation),
    provenanceVerification: buildInitialProvenanceVerification(),
  });

  writeJson(paths.outPath, record);
  return record;
}

function finalizeReleaseRehearsal() {
  if (!fs.existsSync(paths.outPath)) {
    throw new Error("release-rehearsal: missing staged release-rehearsal.json");
  }

  const record = readJson(paths.outPath);
  const provenance = fs.existsSync(paths.provenanceVerification)
    ? readJson(paths.provenanceVerification)
    : null;

  const finalized = {
    ...record,
    generatedAt: new Date().toISOString(),
    provenanceVerification: provenance
      ? {
          ok: provenance.ok === true,
          skipped: provenance.skipped === true,
          bundlePath: provenance.bundlePath ?? null,
          signerWorkflow: provenance.signerWorkflow ?? null,
          subjects: Array.isArray(provenance.subjects)
            ? provenance.subjects
                .map((entry) =>
                  typeof entry?.path === "string" ? entry.path : null,
                )
                .filter((value) => value !== null)
            : [...defaultReleaseRehearsalSubjects],
        }
      : buildInitialProvenanceVerification(),
  };

  finalized.ok =
    record.ok === true && finalized.provenanceVerification.ok === true;
  writeJson(paths.outPath, finalized);
  return finalized;
}

async function main() {
  const cli = parseCli(process.argv.slice(2));
  if (cli.finalize) {
    const finalized = finalizeReleaseRehearsal();
    process.stdout.write(
      `release-rehearsal: finalized tag=${finalized.tagName} provenance=${finalized.provenanceVerification.ok}\n`,
    );
    return;
  }

  const staged = await stageReleaseRehearsal(cli.tagName);
  process.stdout.write(
    `release-rehearsal: staged tag=${staged.tagName} archive=${staged.sourceArchive.path}\n`,
  );
}

const isEntryPoint =
  typeof process.argv[1] === "string" &&
  path.resolve(process.argv[1]) === __filename;

if (isEntryPoint) {
  main().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
