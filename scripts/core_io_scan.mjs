import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const repoRoot = path.resolve(__dirname, "..");
const coreRoot = path.join(repoRoot, "packages", "aegispy-core", "src");
const outPath = path.join(repoRoot, "artifacts", "gates", "core-io-scan.json");

function ensureDir(p) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
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
        stack.push(full);
      } else if (ent.isFile()) {
        out.push(full);
      }
    }
  }
  return out;
}

function main() {
  const failures = [];

  if (!fs.existsSync(coreRoot)) {
    const payload = { ok: true, note: "core_root_missing" };
    ensureDir(outPath);
    fs.writeFileSync(outPath, JSON.stringify(payload, null, 2) + "\n", "utf8");
    return;
  }

  const prohibited = [
    /\bfrom\s+["']node:fs["']/,
    /\brequire\(\s*["']node:fs["']\s*\)/,
    /\bfrom\s+["']fs["']/,
    /\brequire\(\s*["']fs["']\s*\)/,
    /\bfrom\s+["']node:child_process["']/,
    /\bfrom\s+["']child_process["']/,
    /\brequire\(\s*["']child_process["']\s*\)/,
    /\bfrom\s+["']node:http["']/,
    /\bfrom\s+["']http["']/,
    /\bfrom\s+["']node:https["']/,
    /\bfrom\s+["']https["']/,
    /\bfetch\s*\(/,
    /\bDeno\b/,
    /\bBun\b/,
    /\bwindow\b/,
    /\bdocument\b/,
  ];

  const files = walkDir(coreRoot).filter(
    (p) =>
      p.endsWith(".ts") ||
      p.endsWith(".tsx") ||
      p.endsWith(".js") ||
      p.endsWith(".mjs"),
  );
  for (const f of files) {
    const rel = path.relative(repoRoot, f).replaceAll("\\", "/");
    const text = fs.readFileSync(f, "utf8");
    for (const re of prohibited) {
      if (re.test(text))
        failures.push({
          file: rel,
          error: "prohibited_host_io_reference",
          pattern: String(re),
        });
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
