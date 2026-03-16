import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");
const workflowDir = path.join(repoRoot, ".github", "workflows");
const outPath = path.join(
  repoRoot,
  "artifacts",
  "gates",
  "workflow-policy-check.json",
);

function ensureDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function writePayload(payload) {
  ensureDir(outPath);
  fs.writeFileSync(outPath, JSON.stringify(payload, null, 2) + "\n", "utf8");
}

function main() {
  const failures = [];
  const workflows = [];

  const workflowFiles = fs
    .readdirSync(workflowDir)
    .filter((name) => name.endsWith(".yml"))
    .sort();

  for (const fileName of workflowFiles) {
    const relPath = path.posix.join(".github/workflows", fileName);
    const fullPath = path.join(workflowDir, fileName);
    const text = fs.readFileSync(fullPath, "utf8");
    const lines = text.split(/\r?\n/u);

    workflows.push(relPath);

    if (!/^permissions:\s*$/mu.test(text)) {
      failures.push({
        error: "workflow_missing_top_level_permissions",
        workflow: relPath,
      });
    }

    if (/^\s*pull_request_target\s*:/mu.test(text)) {
      failures.push({
        error: "workflow_uses_pull_request_target",
        workflow: relPath,
      });
    }

    for (const [index, line] of lines.entries()) {
      const match = line.match(/^\s*uses:\s*([^\s#]+)(?:\s+#.*)?\s*$/u);
      if (!match) continue;
      const target = match[1];
      if (target.startsWith("./")) continue;
      if (target.startsWith("docker://")) continue;

      const atIndex = target.lastIndexOf("@");
      if (atIndex < 0) {
        failures.push({
          error: "workflow_action_ref_missing",
          workflow: relPath,
          line: index + 1,
          uses: target,
        });
        continue;
      }

      const ref = target.slice(atIndex + 1);
      if (!/^[0-9a-f]{40}$/u.test(ref)) {
        failures.push({
          error: "workflow_action_ref_not_sha_pinned",
          workflow: relPath,
          line: index + 1,
          uses: target,
        });
      }
    }
  }

  if (failures.length > 0) {
    writePayload({ ok: false, workflows, failures });
    process.exitCode = 1;
    return;
  }

  writePayload({ ok: true, workflows });
}

Promise.resolve()
  .then(() => main())
  .catch((error) => {
    writePayload({ ok: false, error: String(error) });
    process.exitCode = 1;
  });
