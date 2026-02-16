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
  "control-plane-refs.json",
);
const controlPlaneToken = ".aegispy" + "_pack";

function ensureDir(p) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
}

function isIgnoredDirName(name) {
  return (
    name === ".git" ||
    name === "node_modules" ||
    name === "dist" ||
    name === "target" ||
    name === "artifacts" ||
    name === ".tools" ||
    name === controlPlaneToken
  );
}

function walkDir(rootDir) {
  const out = [];
  const stack = [rootDir];
  while (stack.length > 0) {
    const cur = stack.pop();
    const entries = fs.readdirSync(cur, { withFileTypes: true });
    for (const ent of entries) {
      const full = path.join(cur, ent.name);
      if (ent.isDirectory()) {
        if (!isIgnoredDirName(ent.name)) stack.push(full);
      } else if (ent.isFile()) {
        out.push(full);
      }
    }
  }
  return out;
}

function main() {
  const failures = [];
  const files = walkDir(repoRoot);

  for (const full of files) {
    const rel = path.relative(repoRoot, full).replaceAll("\\", "/");
    const text = fs.readFileSync(full, "utf8");
    if (text.includes(controlPlaneToken)) {
      failures.push({ file: rel, token: controlPlaneToken });
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
