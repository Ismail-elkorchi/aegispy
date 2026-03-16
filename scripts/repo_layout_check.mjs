import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");
const outPath = path.join(repoRoot, "artifacts", "gates", "repo-layout.json");

function ensureDir(p) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
}

function dirExists(relPath) {
  const full = path.join(repoRoot, relPath);
  return fs.existsSync(full) && fs.statSync(full).isDirectory();
}

function main() {
  const requiredDirs = [
    "packages",
    "rust",
    "scripts",
    "tools",
    "docs",
    "docs/tutorial",
    "docs/how-to",
    "docs/reference",
    "docs/maintainers",
    ".github",
  ];
  const missing = requiredDirs.filter((p) => !dirExists(p));

  const payload =
    missing.length === 0
      ? { ok: true, required_dirs: requiredDirs }
      : { ok: false, missing_dirs: missing, required_dirs: requiredDirs };

  ensureDir(outPath);
  fs.writeFileSync(outPath, JSON.stringify(payload, null, 2) + "\n", "utf8");

  if (missing.length > 0) process.exitCode = 1;
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
