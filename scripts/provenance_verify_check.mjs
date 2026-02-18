import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");

const defaultSubjects = [
  "artifacts/engine/cpython-wasi.wasm",
  "artifacts/engine/aegispy-capability-bridge.py",
  "artifacts/component/aegispy.component.wasm",
];

const outGatePath = path.join(
  repoRoot,
  "artifacts",
  "gates",
  "provenance-verify-check.json",
);
const outEvidencePath = path.join(
  repoRoot,
  "artifacts",
  "security",
  "provenance-verification.json",
);

function ensureDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function fileRef(filePath) {
  return path.relative(repoRoot, filePath).replaceAll("\\", "/");
}

function toBool(raw, defaultValue) {
  if (raw == null || raw === "") return defaultValue;
  return /^(1|true|yes|on)$/iu.test(raw);
}

function sha256File(filePath) {
  return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function commandExists(cmd) {
  const probe = spawnSync("bash", ["-lc", `command -v ${cmd}`], {
    encoding: "utf8",
  });
  return (probe.status ?? 1) === 0;
}

function inferRepoFromGitRemote() {
  const probe = spawnSync("git", ["config", "--get", "remote.origin.url"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  if ((probe.status ?? 1) !== 0) return "";
  const remote = (probe.stdout || "").trim();
  if (remote.length === 0) return "";
  const sshMatch = remote.match(/[:/]([^/:]+\/[^/]+?)(?:\.git)?$/u);
  return sshMatch ? sshMatch[1] : "";
}

function parseSubjects(raw) {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return [...defaultSubjects];
  }
  const out = [];
  const seen = new Set();
  for (const token of raw.split(/[\n,]/u)) {
    const value = token.trim();
    if (value.length === 0 || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out.length > 0 ? out : [...defaultSubjects];
}

function verifySubject({
  subjectPath,
  repo,
  signerWorkflow,
  sourceRef,
  bundlePath,
}) {
  const args = [
    "attestation",
    "verify",
    subjectPath,
    "--repo",
    repo,
    "--signer-workflow",
    signerWorkflow,
    "--deny-self-hosted-runners",
    "--format",
    "json",
  ];
  if (sourceRef) {
    args.push("--source-ref", sourceRef);
  }
  if (bundlePath) {
    args.push("--bundle", bundlePath);
  }
  const res = spawnSync("gh", args, { encoding: "utf8" });
  if ((res.status ?? 1) !== 0) {
    return {
      ok: false,
      error: "gh_attestation_verify_failed",
      exitCode: res.status ?? 1,
      stderr: (res.stderr || "").trim(),
      stdout: (res.stdout || "").trim(),
      command: ["gh", ...args].join(" "),
    };
  }
  return {
    ok: true,
    output: (res.stdout || "").trim(),
  };
}

function writeResults(payload) {
  ensureDir(outGatePath);
  fs.writeFileSync(outGatePath, `${JSON.stringify(payload, null, 2)}\n`);
  ensureDir(outEvidencePath);
  fs.writeFileSync(outEvidencePath, `${JSON.stringify(payload, null, 2)}\n`);
}

function main() {
  const required = toBool(
    process.env.AEGISPY_PROVENANCE_VERIFY_REQUIRED,
    false,
  );
  const repo =
    process.env.AEGISPY_PROVENANCE_REPO ||
    process.env.GITHUB_REPOSITORY ||
    inferRepoFromGitRemote();
  const signerWorkflow =
    process.env.AEGISPY_PROVENANCE_SIGNER_WORKFLOW ||
    (repo ? `${repo}/.github/workflows/ci.yml` : "");
  const sourceRef = process.env.AEGISPY_PROVENANCE_SOURCE_REF || "";
  const defaultBundlePath = path.join(
    repoRoot,
    "artifacts",
    "security",
    "provenance-bundle.jsonl",
  );
  const bundlePathRaw =
    process.env.AEGISPY_PROVENANCE_BUNDLE_PATH ||
    (fs.existsSync(defaultBundlePath) ? defaultBundlePath : "");
  const bundlePath =
    bundlePathRaw.length > 0
      ? path.resolve(repoRoot, bundlePathRaw)
      : undefined;
  const subjects = parseSubjects(process.env.AEGISPY_PROVENANCE_SUBJECTS);

  const payload = {
    ok: false,
    required,
    repo: repo || null,
    signerWorkflow: signerWorkflow || null,
    sourceRef: sourceRef || null,
    bundlePath: bundlePath ? fileRef(bundlePath) : null,
    generatedAt: new Date().toISOString(),
    subjects: [],
    failures: [],
    skipped: false,
  };

  if (!commandExists("gh")) {
    if (required) {
      payload.failures.push({ error: "gh_cli_missing" });
      writeResults(payload);
      process.exitCode = 1;
      return;
    }
    payload.ok = true;
    payload.skipped = true;
    payload.failures.push({ error: "gh_cli_missing_optional_mode" });
    writeResults(payload);
    return;
  }

  if (!repo || !signerWorkflow) {
    const error = !repo
      ? "provenance_repo_missing"
      : "provenance_signer_missing";
    if (required) {
      payload.failures.push({ error });
      writeResults(payload);
      process.exitCode = 1;
      return;
    }
    payload.ok = true;
    payload.skipped = true;
    payload.failures.push({ error: `${error}_optional_mode` });
    writeResults(payload);
    return;
  }

  if (bundlePath && !fs.existsSync(bundlePath)) {
    payload.failures.push({
      error: "provenance_bundle_missing",
      path: fileRef(bundlePath),
    });
    if (required) {
      writeResults(payload);
      process.exitCode = 1;
    } else {
      payload.ok = true;
      payload.skipped = true;
      writeResults(payload);
    }
    return;
  }

  if (!required && !bundlePath) {
    payload.ok = true;
    payload.skipped = true;
    payload.failures.push({
      error: "provenance_verification_skipped_optional_mode_without_bundle",
    });
    writeResults(payload);
    return;
  }

  for (const subjectRelPath of subjects) {
    const subjectPath = path.join(repoRoot, subjectRelPath);
    if (!fs.existsSync(subjectPath)) {
      payload.failures.push({
        error: "provenance_subject_missing",
        path: subjectRelPath,
      });
      continue;
    }
    const verification = verifySubject({
      subjectPath,
      repo,
      signerWorkflow,
      sourceRef,
      bundlePath,
    });
    const subjectRecord = {
      path: fileRef(subjectPath),
      sha256: sha256File(subjectPath),
      ok: verification.ok === true,
    };
    if (verification.ok) {
      subjectRecord.verificationOutput = verification.output;
    } else {
      subjectRecord.error = verification.error;
      subjectRecord.details = verification;
      payload.failures.push({
        error: "provenance_verification_failed",
        path: subjectRecord.path,
      });
    }
    payload.subjects.push(subjectRecord);
  }

  payload.ok = payload.failures.length === 0;
  writeResults(payload);
  if (!payload.ok && required) {
    process.exitCode = 1;
  }
}

Promise.resolve()
  .then(() => main())
  .catch((error) => {
    const payload = {
      ok: false,
      required: toBool(process.env.AEGISPY_PROVENANCE_VERIFY_REQUIRED, false),
      error: String(error),
      generatedAt: new Date().toISOString(),
    };
    writeResults(payload);
    process.exitCode = 1;
  });
