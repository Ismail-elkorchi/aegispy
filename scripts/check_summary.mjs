import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");
const outPath = path.join(repoRoot, "artifacts", "gates", "check-summary.json");

function ensureDir(p) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
}

function main() {
  const statusArg = process.argv[2] ?? "1";
  const status = Number.parseInt(statusArg, 10);
  const ok = Number.isFinite(status) && status === 0;
  const payload = {
    ok,
    exit_code: Number.isFinite(status) ? status : 1,
  };
  ensureDir(outPath);
  fs.writeFileSync(outPath, JSON.stringify(payload, null, 2) + "\n", "utf8");
}

Promise.resolve()
  .then(() => main())
  .catch(() => {
    process.exitCode = 1;
  });
